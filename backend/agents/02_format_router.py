"""Agent 02 - Format Router  (POST /agents/format-router).  Owner: Person A.

README
  Inputs : {source_id}
  Outputs: {source_id, route, units:[{unit_id, page_number, page_class}], warnings[]}
  Route ids (publish in CONTRACT): pdf_native, pdf_scanned, pdf_mixed, image, docx, pptx, xlsx, csv, eml, html
  page_class values: native_text, scanned, mixed, blank, image_only
  Ids   : unit_id = "u_" + sha256(source_id:page)[:16]; page_id (agents 03/05/06/11) == unit_id.
  Algorithm (single pass, PDF opened once, cached for agents 03/04):
    1 load + authorise source meta; return cached route if complete
    2 PDF/DOCX/PPTX (docx/pptx rendered once with LibreOffice): per page words/image-area/vector scan ->
      classify with thresholds from settings (router.*); never loads all pages at once
    3 rotation: declared /Rotate + Tesseract OSD only on pages that need OCR (sampled, threaded, majority-inferred)
    4 script hint (native text unicode ranges / OSD) so OCR picks languages from detection
    5 pre-render page images (PNG, 200 DPI, pixel-capped) for the first N pages and cache them for B/04
    6 XLSX: one unit per sheet; CSV/HTML: one unit; EML: body unit + each attachment registered as a child
      source through agent 01 (origin.type=email_attachment, parent_source_id)
    7 persist route + page_meta (+route_meta), audit format_router_run (fail closed)
  page_meta (store kind "page_meta", id=source_id): {"pages": {"<n>": {...}}} - read by agents 03/04.
  Limits : HTML is not rendered (one unit, no geometry); OSD cannot detect Tamil/Telugu etc. (language then
           comes from settings ocr.default_langs); e-mail attachment units use a coarse page_class.
"""
from __future__ import annotations

import email
import email.policy
import io
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel

from backend.agents._support import (AgentError, Code, IMAGE_MIMES, S, Timer, WarningItem, audit_event, commit,
                                     current_user, dbg, dominant_script, endpoint, get_blob, kind_of, load_agent,
                                     load_meta, normalized_image_png, open_pdf, page_geometry, pdf_loader,
                                     put_blob, render_pdf_page_png, store_get, unit_id, OSD_SCRIPT_ALIASES,
                                     get_original_bytes)

AGENT = "02-format-router"
_PREWARM_WORKERS = 4
PageClass = Literal["native_text", "scanned", "mixed", "blank", "image_only"]


class FormatRouterInput(BaseModel):
    source_id: str


class UnitOut(BaseModel):
    unit_id: str
    page_number: int
    page_class: PageClass


class FormatRouterOutput(BaseModel):
    source_id: str
    route: str
    units: List[UnitOut]
    warnings: List[WarningItem] = []


# ---------------------------------------------------------------------------- classification
def classify_page(chars: int, image_ratio: float, has_vector: bool) -> str:
    r = S("router")
    if chars < int(r["min_text_chars"]):
        if image_ratio >= float(r["scanned_image_ratio"]):
            return "scanned"
        if chars == 0:
            return "image_only" if (image_ratio >= float(r["blank_image_ratio"]) or has_vector) else "blank"
        return "mixed" if image_ratio >= float(r["mixed_image_ratio"]) else "native_text"
    return "mixed" if image_ratio >= float(r["mixed_image_ratio"]) else "native_text"


def _rect_area_in_page(b: Tuple[float, float, float, float], w: float, h: float) -> float:
    x1, y1, x2, y2 = max(b[0], 0), max(b[1], 0), min(b[2], w), min(b[3], h)
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def _osd(img: Any) -> Dict[str, Any]:
    """Tesseract OSD on a PIL image -> {rotation_cw, script, conf} (empty dict when undetectable)."""
    try:
        import pytesseract
        d = pytesseract.image_to_osd(img, config="--psm 0 -c min_characters_to_try=30", output_type=pytesseract.Output.DICT)
        conf = float(d.get("orientation_conf", 0) or 0)
        if conf < float(S("router.osd_min_confidence")):
            return {}
        return {"rotation_cw": int(d.get("rotate", 0)) % 360, "script": OSD_SCRIPT_ALIASES.get(str(d.get("script", "")), None),
                "conf": conf}
    except Exception:
        return {}


def _apply_osd(candidates: List[Tuple[int, Any]], pages: Dict[int, Dict[str, Any]], warnings: List[WarningItem]) -> None:
    """candidates: [(page_number, PIL gray image)] -> fills rotation_correction_cw/script in `pages`."""
    if not candidates:
        return
    with ThreadPoolExecutor(max_workers=int(S("router.osd_workers"))) as ex:
        results = list(ex.map(lambda c: (c[0], _osd(c[1])), candidates))
    votes: Dict[int, int] = {}
    for n, res in results:
        if res:
            pages[n]["rotation_correction_cw"] = res["rotation_cw"]
            pages[n]["rotation_source"] = "osd"
            if res.get("script"):
                pages[n]["script"], pages[n]["script_source"] = res["script"], "osd"
            votes[res["rotation_cw"]] = votes.get(res["rotation_cw"], 0) + 1
    dbg(AGENT, "step3-osd", f"sampled={len(candidates)} detected={sum(votes.values())} votes={votes}")
    if sum(votes.values()) >= 2:
        top, cnt = max(votes.items(), key=lambda kv: kv[1])
        if cnt / sum(votes.values()) > 0.5:
            for n, p in pages.items():
                if p["page_class"] in ("scanned", "image_only") and p.get("rotation_source") is None:
                    p["rotation_correction_cw"], p["rotation_source"] = top, "inferred_majority"
    undetected = [n for n, _ in results if "rotation_source" not in pages[n]]
    if undetected:
        warnings.append(WarningItem(code="ROTATION_UNDETECTED", message="Orientation could not be detected for some pages",
                                    details={"pages": undetected[:50], "count": len(undetected)}))


def _analyze_pdf(doc: Any, source_id: str, meta: dict, warnings: List[WarningItem], deadline: float
                 ) -> Dict[int, Dict[str, Any]]:
    from PIL import Image
    pages: Dict[int, Dict[str, Any]] = {}
    osd_enabled = bool(S("router.osd_enabled"))
    osd_dpi = float(S("router.osd_dpi")) / 72.0
    import fitz
    n_pages = doc.page_count
    timed_out_from: Optional[int] = None
    for i in range(n_pages):
        pno = i + 1
        if time.time() > deadline:
            timed_out_from = pno
            break
        try:
            page = doc.load_page(i)
            w_pt, h_pt = page.rect.width, page.rect.height
            area = max(1.0, w_pt * h_pt)
            words = page.get_text("words")
            chars = sum(len(str(w[4]).strip()) for w in words)
            text_area = sum(max(0.0, (w[2] - w[0]) * (w[3] - w[1])) for w in words)
            img_area = 0.0
            for info in page.get_image_info():
                img_area += _rect_area_in_page(tuple(info["bbox"]), w_pt, h_pt)
            image_ratio = min(1.0, img_area / area)
            has_vector = False
            if chars == 0 and image_ratio < float(S("router.blank_image_ratio")):
                has_vector = len(page.get_cdrawings()) > 0
            cls = classify_page(chars, image_ratio, has_vector)
            scale, wpx, hpx = page_geometry(w_pt, h_pt)
            script = dominant_script(" ".join(str(w[4]) for w in words[:600])) if chars else None
            pages[pno] = {"unit_id": unit_id(source_id, pno), "page_class": cls, "chars": chars,
                          "text_coverage": round(min(1.0, text_area / area), 5), "image_ratio": round(image_ratio, 4),
                          "width_pt": round(w_pt, 3), "height_pt": round(h_pt, 3), "scale": scale, "dpi": round(scale * 72, 2),
                          "width_px": wpx, "height_px": hpx, "declared_rotation": int(page.rotation),
                          "rotation_correction_cw": 0, "rotation_source": None, "script": script,
                          "script_source": "text" if script else None, "image_cached": False}
        except Exception as exc:
            dbg(AGENT, "step2-page-fail", f"page={pno} {type(exc).__name__}")
            pages[pno] = {"unit_id": unit_id(source_id, pno), "page_class": "scanned", "chars": 0, "text_coverage": 0.0,
                          "image_ratio": 0.0, "width_pt": None, "height_pt": None, "scale": float(S("render.dpi")) / 72.0,
                          "dpi": float(S("render.dpi")), "width_px": None, "height_px": None, "declared_rotation": 0,
                          "rotation_correction_cw": 0, "rotation_source": None, "script": None, "script_source": None,
                          "image_cached": False}
            warnings.append(WarningItem(code="PAGE_ANALYSIS_FAILED", message="Page could not be analysed; routed to OCR", page_number=pno))
    if timed_out_from is not None:
        for pno in range(timed_out_from, n_pages + 1):
            pages[pno] = {"unit_id": unit_id(source_id, pno), "page_class": "scanned", "chars": 0, "text_coverage": 0.0,
                          "image_ratio": 0.0, "width_pt": None, "height_pt": None, "scale": float(S("render.dpi")) / 72.0,
                          "dpi": float(S("render.dpi")), "width_px": None, "height_px": None, "declared_rotation": 0,
                          "rotation_correction_cw": 0, "rotation_source": None, "script": None, "script_source": None,
                          "image_cached": False}
        warnings.append(WarningItem(code="ROUTER_TIMEOUT_PARTIAL", message="Routing time budget exceeded; remaining pages routed to OCR",
                                    details={"from_page": timed_out_from}))
    dbg(AGENT, "step2-classify", f"pages={len(pages)} classes={_count_classes(pages)}")
    # step 3: OSD on pages that need OCR (sampled)
    if osd_enabled:
        need = [n for n, p in pages.items() if p["page_class"] in ("scanned", "image_only") and p["width_pt"]]
        cand: List[Tuple[int, Any]] = []
        for n in need[: int(S("router.osd_max_pages"))]:
            pix = doc.load_page(n - 1).get_pixmap(matrix=fitz.Matrix(osd_dpi, osd_dpi), colorspace=fitz.csGRAY, alpha=False)
            cand.append((n, Image.frombytes("L", (pix.width, pix.height), pix.samples)))
        _apply_osd(cand, pages, warnings)
    # step 5: pre-render the page images OCR will need (scanned / mixed / image-only pages), in parallel.
    # Native-text pages are not rendered here: their text and boxes come from the PDF itself, and their image is
    # rendered on first request by get_page_image and cached from then on. This keeps routing fast on long PDFs.
    t0 = time.time()
    cap = int(S("render.prewarm_max_pages"))
    tenant = meta["tenant_id"]
    todo = [pno for pno in sorted(pages)
            if pages[pno]["page_class"] in ("scanned", "mixed", "image_only") and pages[pno]["width_pt"]
            and get_blob("page_image", f"{source_id}:{pno}", tenant) is None][:cap]
    rendered = 0
    if todo:
        data = doc.tobytes() if hasattr(doc, "tobytes") else doc.write()
        chunks = [todo[i::_PREWARM_WORKERS] for i in range(_PREWARM_WORKERS) if todo[i::_PREWARM_WORKERS]]

        def _render_chunk(chunk: List[int]) -> List[Tuple[int, bytes, int, int]]:
            out = []
            local = fitz.open(stream=data, filetype="pdf")  # one document per thread: fitz objects are not shared
            try:
                for pno in chunk:
                    if time.time() > deadline:
                        break
                    png, w, h = render_pdf_page_png(local.load_page(pno - 1), pages[pno]["scale"])
                    out.append((pno, png, w, h))
            finally:
                local.close()
            return out

        with ThreadPoolExecutor(max_workers=len(chunks)) as ex:
            for result in ex.map(_render_chunk, chunks):
                for pno, png, w, h in result:
                    put_blob("page_image", f"{source_id}:{pno}", png, tenant)
                    pages[pno]["width_px"], pages[pno]["height_px"] = w, h
                    pages[pno]["image_cached"] = True
                    rendered += 1
        if rendered < len(todo):
            warnings.append(WarningItem(code="PREWARM_TRUNCATED", message="Page images will be rendered on demand"))
    dbg(AGENT, "step5-prewarm", f"images_cached={rendered} ms={int((time.time() - t0) * 1000)}")
    return pages


def _count_classes(pages: Dict[int, Dict[str, Any]]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for p in pages.values():
        out[p["page_class"]] = out.get(p["page_class"], 0) + 1
    return out


def _pdf_route(pages: Dict[int, Dict[str, Any]]) -> str:
    c = _count_classes(pages)
    if c.get("native_text", 0) == 0 and (c.get("scanned", 0) + c.get("image_only", 0) + c.get("mixed", 0)) == 0:
        return "pdf_native"  # all blank
    if c.get("mixed", 0) or (c.get("native_text", 0) and (c.get("scanned", 0) or c.get("image_only", 0))):
        return "pdf_mixed"
    if c.get("scanned", 0) or c.get("image_only", 0):
        return "pdf_scanned"
    return "pdf_native"


# ---------------------------------------------------------------------------- per-kind builders
def _route_paginated(source_id: str, meta: dict, warnings: List[WarningItem], deadline: float
                     ) -> Tuple[str, Dict[int, Dict[str, Any]], dict]:
    key, loader = pdf_loader(source_id, meta)
    with open_pdf(key, loader) as doc:
        pages = _analyze_pdf(doc, source_id, meta, warnings, deadline)
    k = kind_of(meta["detected_mime"])
    if k == "pptx" and meta.get("page_count") and meta["page_count"] != len(pages):
        warnings.append(WarningItem(code="PAGE_COUNT_MISMATCH", message="Rendered page count differs from slide count",
                                    details={"slides": meta["page_count"], "rendered": len(pages)}))
    return (_pdf_route(pages) if k == "pdf" else k), pages, {}


def _route_image(source_id: str, meta: dict, warnings: List[WarningItem]) -> Tuple[str, Dict[int, Dict[str, Any]], dict]:
    from PIL import Image, ImageStat
    tenant = meta["tenant_id"]
    png, w, h, scale = normalized_image_png(get_original_bytes(source_id))
    put_blob("page_image", f"{source_id}:1", png, tenant)
    with Image.open(io.BytesIO(png)) as im:
        g = im.convert("L")
        g.thumbnail((256, 256))
        std = ImageStat.Stat(g).stddev[0]
        cls = "blank" if std < float(S("router.blank_stddev")) else "scanned"
        page = {"unit_id": unit_id(source_id, 1), "page_class": cls, "chars": 0, "text_coverage": 0.0, "image_ratio": 1.0,
                "width_pt": None, "height_pt": None, "scale": scale, "dpi": None, "width_px": w, "height_px": h,
                "declared_rotation": 0, "rotation_correction_cw": 0, "rotation_source": None, "script": None,
                "script_source": None, "image_cached": True}
        if cls != "blank" and S("router.osd_enabled"):
            small = im.convert("L")
            small.thumbnail((1600, 1600))
            _apply_osd([(1, small)], {1: page}, warnings)
    return "image", {1: page}, {}


def _simple_page(source_id: str, n: int, kind: str) -> Dict[str, Any]:
    return {"unit_id": unit_id(source_id, n), "page_class": "native_text", "kind": kind}


def _route_xlsx(source_id: str, meta: dict) -> Tuple[str, Dict[int, Dict[str, Any]], dict]:
    try:
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(get_original_bytes(source_id)), read_only=True, data_only=True)
        names = list(wb.sheetnames)
        wb.close()
    except Exception as exc:
        raise AgentError(Code.CORRUPT_FILE, "Workbook could not be read") from exc
    if not names:
        raise AgentError(Code.CORRUPT_FILE, "Workbook has no sheets")
    return "xlsx", {i + 1: _simple_page(source_id, i + 1, "sheet") for i in range(len(names))}, {}


def _route_eml(source_id: str, meta: dict, warnings: List[WarningItem], user: dict
               ) -> Tuple[str, Dict[int, Dict[str, Any]], dict]:
    fv = load_agent("01_file_validation")
    msg = email.message_from_bytes(get_original_bytes(source_id), policy=email.policy.default)
    pages: Dict[int, Dict[str, Any]] = {1: _simple_page(source_id, 1, "eml_body")}
    children: List[dict] = []
    rejected: List[dict] = []
    idx = 0
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        disp = part.get_content_disposition()
        fn = part.get_filename()
        is_att = disp == "attachment" or ctype == "message/rfc822" or (fn and ctype not in ("text/plain", "text/html"))
        if not is_att:
            continue
        try:
            payload = part.get_payload()[0].as_bytes() if ctype == "message/rfc822" else part.get_payload(decode=True)
        except Exception:
            payload = None
        if not payload:
            continue
        if disp == "inline" and len(payload) < int(S("router.min_inline_attachment_bytes")):
            continue
        idx += 1
        if idx > int(S("router.max_eml_attachments")):
            warnings.append(WarningItem(code="TOO_MANY_ATTACHMENTS", message="Attachment limit reached",
                                        details={"limit": int(S("router.max_eml_attachments"))}))
            break
        out = fv.run(fv.FileValidationInput(filename=fn or f"attachment_{idx}", stream=io.BytesIO(payload),
                                            origin={"type": "email_attachment", "parent_source_id": source_id,
                                                    "attachment_index": idx}))
        dbg(AGENT, "step6-attachment", f"#{idx} status={out.status}")
        if out.status != "accepted":
            rejected.append({"index": idx, "code": out.error.code if out.error else None})
            warnings.append(WarningItem(code="ATTACHMENT_REJECTED", message="An attachment was rejected by file validation",
                                        details={"index": idx, "code": out.error.code if out.error else None}))
            continue
        n = len(pages) + 1
        pages[n] = {"unit_id": unit_id(source_id, n), "page_class": "scanned" if out.detected_mime in IMAGE_MIMES else "native_text",
                    "kind": "eml_attachment", "child_source_id": out.source_id}
        children.append({"unit_id": pages[n]["unit_id"], "page_number": n, "child_source_id": out.source_id})
    return "eml", pages, {"children": children, "rejected": rejected}


# ---------------------------------------------------------------------------- main
def run(inp: FormatRouterInput) -> FormatRouterOutput:
    timer = Timer()
    user = current_user()
    meta = load_meta(inp.source_id, user)
    sid = inp.source_id
    dbg(AGENT, "step1-load", f"source={sid[:8]} mime={meta['detected_mime']}")
    cached = store_get("route", sid)
    if isinstance(cached, dict) and cached.get("complete"):
        audit_event("format_router_run", "source", sid, details={"cached": True, "duration_ms": timer.ms()}, user=user, fail_closed=True)
        dbg(AGENT, "done", "served from cache")
        return FormatRouterOutput(**cached["output"])
    kind = kind_of(meta["detected_mime"])
    warnings: List[WarningItem] = []
    deadline = time.time() + float(S("router.timeout_s"))
    route_meta: dict = {}
    if kind in ("pdf", "docx", "pptx"):
        route, pages, route_meta = _route_paginated(sid, meta, warnings, deadline)
    elif kind == "image":
        route, pages, route_meta = _route_image(sid, meta, warnings)
    elif kind == "xlsx":
        route, pages, route_meta = _route_xlsx(sid, meta)
    elif kind in ("csv", "html"):
        route, pages = kind, {1: _simple_page(sid, 1, kind)}
    elif kind == "eml":
        route, pages, route_meta = _route_eml(sid, meta, warnings, user)
    else:
        raise AgentError(Code.UNSUPPORTED_FORMAT, "Source format cannot be routed")
    units = [UnitOut(unit_id=pages[n]["unit_id"], page_number=n, page_class=pages[n]["page_class"]) for n in sorted(pages)]
    out = FormatRouterOutput(source_id=sid, route=route, units=units, warnings=warnings)
    complete = not any(w.code == "ROUTER_TIMEOUT_PARTIAL" for w in warnings)
    dbg(AGENT, "step7-persist", f"route={route} units={len(units)} complete={complete}")
    puts: List[Tuple[str, str, Any]] = [
        ("page_meta", sid, {"route": route, "pages": {str(n): p for n, p in pages.items()}}),
        ("route", sid, {"complete": complete, "output": out.model_dump(mode="json")}),
    ]
    if route_meta:
        puts.append(("route_meta", sid, route_meta))
    commit(puts, dict(event_type="format_router_run", object_type="source", object_id=sid,
                      details={"route": route, "units": len(units), "classes": _count_classes(pages) if kind != "eml" else {},
                               "warnings": len(warnings), "cached": False, "duration_ms": timer.ms()}), user)
    dbg(AGENT, "done", f"ms={timer.ms()}")
    return out


try:
    from fastapi import APIRouter, Body, Request
except ImportError:  # fastapi not installed
    APIRouter = None


def build_router():
    r = APIRouter()

    @r.post("/agents/format-router")
    def format_router(request: Request, payload: dict = Body(...)):
        return endpoint(request, lambda: run(FormatRouterInput.model_validate(payload)))

    return r


router = build_router() if APIRouter is not None else None