"""Batches, jobs, sources, pages, cases, actions and metrics: the endpoints that tie the agents into one pipeline.

    POST /batches                    start processing accepted sources -> {batch_id, job_id, status}
    GET  /batches                    list batches
    GET  /batches/{batch_id}         status, stage, progress, per-source summary
    POST /batches/{batch_id}/retry   re-run one source of a batch
    GET  /jobs/{job_id}              job status (one job per batch)
    GET  /sources                    sources that have been processed or are processing
    GET  /sources/{source_id}        SourceDocument with its pages
    GET  /sources/{source_id}/pages/{n}        one PageUnit
    GET  /sources/{source_id}/pages/{n}/image  the page image (PNG) the bounding boxes refer to
    GET/POST /cases, GET /cases/{case_id}
    GET  /actions, GET /actions/{action_id}
    GET  /metrics

Pipeline per source (agents run in-process, the same functions their HTTP endpoints call):
    02 format router -> per unit: 03 native text (native/mixed pages, e-mail, HTML),
                                  04 OCR (scanned/mixed/image pages), 08 spreadsheet (xlsx/csv)
Sources run in parallel and the pages of a source run in parallel; a page that fails is recorded as a warning
and the rest of the document still completes. Everything shown comes from agent output; nothing is invented.
"""
from __future__ import annotations

import importlib
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from backend import page_analysis as pa

router = APIRouter()

# Separate pools so a source never waits for a page slot held by another source's pages.
_SOURCE_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="pf-source")
_PAGE_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="pf-page")

_LOCK = threading.RLock()
_BATCHES: Dict[str, dict] = {}
_JOBS: Dict[str, str] = {}  # job_id -> batch_id
_SOURCES: Dict[str, dict] = {}  # source_id -> processing state
_CASES: Dict[str, dict] = {}

PAGINATED_KINDS = {"pdf", "image", "docx", "pptx"}
OCR_CLASSES = {"scanned", "mixed", "image_only"}
NATIVE_CLASSES = {"native_text", "mixed"}


# ----------------------------------------------------------------------------------------------- helpers
def _ok(data: Any) -> dict:
    return {"ok": True, "data": data, "error": None, "request_id": uuid.uuid4().hex}


def _err(status: int, code: str, message: str, details: Optional[dict] = None) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"ok": False, "data": None, "request_id": uuid.uuid4().hex,
                 "error": {"code": code, "message": message, "details": details or {}}},
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _agent(name: str):
    return importlib.import_module(f"backend.agents.{name}")


def _support():
    return _agent("_support")


def _store():
    return importlib.import_module("backend.common.store")


def _user() -> dict:
    return _support().current_user()


def _meta(source_id: str) -> Optional[dict]:
    meta = _support().store_get("source_meta", source_id)
    if not meta or meta.get("tenant_id") != _user().get("tenant_id"):
        return None
    return meta


def _error_info(exc: Exception) -> dict:
    code = getattr(exc, "code", None) or "ENGINE_FAILED"
    message = getattr(exc, "message", None) or "Processing failed"
    return {"code": str(code), "message": str(message)}


def _review_threshold() -> float:
    """Blocks below the lowest non-'low' confidence band need review (bands come from /config)."""
    try:
        from backend import platform_api
        bands = platform_api._file_settings().get("confidence_bands") or []
        lows = [b for b in bands if b.get("id") == "low"]
        if lows:
            return float(lows[0].get("max", 0.0))
    except Exception:
        pass
    return 0.0


# ----------------------------------------------------------------------------------------------- page building
def _location(loc: dict, fallback_reason: str) -> dict:
    bbox = loc.get("bbox")
    out = {
        "bbox": list(bbox) if bbox else None,
        "coordinate_system": "pixel_top_left",
        "page_width": int(loc.get("page_width") or 0),
        "page_height": int(loc.get("page_height") or 0),
    }
    if not bbox:
        out["bbox_unavailable_reason"] = loc.get("bbox_unavailable_reason") or fallback_reason
    return out


def _warn(w: Any, source_id: str) -> dict:
    d = w if isinstance(w, dict) else (w.model_dump() if hasattr(w, "model_dump") else {"code": "WARNING", "message": str(w)})
    return {"code": str(d.get("code", "WARNING")), "message": str(d.get("message", "")), "source_id": source_id}


def _text_blocks(items: List[dict], source_id: str, page_id: str, method_key: str, start: int, threshold: float) -> List[dict]:
    blocks = []
    for i, it in enumerate(items):
        loc = it.get("location") or {}
        conf = float(it.get("confidence") or 0.0)
        blocks.append({
            "block_id": f"{page_id}_{method_key}_{i}",
            "type": "text",
            "source_id": source_id,
            "page_id": page_id,
            "unit_id": page_id,
            "reading_order_index": start + i,
            "location": _location(loc, "not_located"),
            "confidence": conf,
            "extraction_method": loc.get("extraction_method") or method_key,
            "raw_text": it.get("text", ""),
            "needs_review": conf < threshold,
            "warnings": [],
        })
    return blocks


def _sort_reading(blocks: List[dict]) -> List[dict]:
    def key(b):
        bb = b["location"]["bbox"]
        return (0, round(bb[1] / 10), bb[0]) if bb else (1, b["reading_order_index"], 0)
    blocks = sorted(blocks, key=key)
    for i, b in enumerate(blocks):
        b["reading_order_index"] = i
    return blocks


_REF = re.compile(r"^([A-Z]+)(\d+)$")


def _col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _sheet_table(sheet: dict, source_id: str, page_id: str) -> Optional[dict]:
    cells_in = sheet.get("cells") or []
    parsed = []
    for c in cells_in:
        m = _REF.match(str(c.get("ref", "")).upper())
        if m:
            parsed.append((int(m.group(2)) - 1, _col_index(m.group(1)), c))
    if not parsed:
        return None
    r0 = min(r for r, _, _ in parsed)
    c0 = min(c for _, c, _ in parsed)
    loc = {"bbox": None, "coordinate_system": "pixel_top_left", "page_width": 0, "page_height": 0,
           "bbox_unavailable_reason": "spreadsheet_cell"}
    cells = []
    for r, c, cell in parsed:
        text = cell.get("displayed_value")
        if text is None:
            text = cell.get("raw_value")
        cells.append({"row": r - r0, "col": c - c0, "row_span": 1, "col_span": 1, "is_header": r == r0,
                      "raw_text": "" if text is None else str(text), "location": dict(loc), "confidence": 1.0,
                      "locked": bool(cell.get("hidden"))})
    name = str(sheet.get("name", "sheet"))
    return {
        "block_id": f"{page_id}_table", "type": "table", "table_id": f"{page_id}_table", "caption": name,
        "source_id": source_id, "page_id": page_id, "unit_id": page_id, "reading_order_index": 0,
        # Cell values are read from the file itself (no recognition step), so there is nothing uncertain to score.
        "location": dict(loc), "confidence": 1.0, "confidence_breakdown": {"read_from_file": 1.0},
        "extraction_method": "spreadsheet", "needs_review": False,
        "warnings": [], "n_rows": max(r for r, _, _ in parsed) - r0 + 1, "n_cols": max(c for _, c, _ in parsed) - c0 + 1,
        "cells": cells,
    }


def _run_ocr(source_id: str, n: int, warnings: List[dict], methods: List[str]) -> Optional[List[dict]]:
    try:
        a04 = _agent("04_ocr")
        out = a04.run(a04.OcrInput(source_id=source_id, page_number=n)).model_dump(mode="json")
    except Exception as exc:
        warnings.append({"code": "OCR_FAILED", "message": _error_info(exc)["message"], "source_id": source_id})
        return None
    warnings += [_warn(w, source_id) for w in out.get("warnings") or []]
    methods.append(f"ocr:{out.get('engine')}")
    lines = []
    for ln in out.get("lines") or []:
        loc = ln.get("location") or {}
        if loc.get("bbox") and (ln.get("text") or "").strip():
            lines.append({"text": ln["text"], "bbox": list(loc["bbox"]), "confidence": float(ln.get("confidence") or 0.0),
                          "location": loc})
    return lines


def _run_ocr_region(source_id: str, n: int, region: List[float]) -> List[dict]:
    try:
        a04 = _agent("04_ocr")
        out = a04.run(a04.OcrInput(source_id=source_id, page_number=n, region=region)).model_dump(mode="json")
    except Exception:
        return []
    lines = []
    for ln in out.get("lines") or []:
        loc = ln.get("location") or {}
        if loc.get("bbox") and (ln.get("text") or "").strip():
            lines.append({"text": ln["text"], "bbox": list(loc["bbox"]), "confidence": float(ln.get("confidence") or 0.0),
                          "location": loc, "recheck": True})
    return lines


def _pdf_structures(source_id: str, n: int, scale: float, cfg: dict) -> Tuple[List[dict], List[List[float]]]:
    support = _support()
    meta = _meta(source_id) or {}
    key, loader = support.pdf_loader(source_id, meta)
    with support.open_pdf(key, loader) as doc:
        page = doc.load_page(n - 1)
        return pa.find_tables(page, scale), pa.find_figures(page, scale, float(cfg["min_figure_area"]))


def _process_unit(source_id: str, kind: str, unit: dict, page_meta: dict, threshold: float) -> dict:
    """Runs the extractors one unit needs and returns a PageUnit (without image_url, added when served).

    Native pages: agent 03 text + an OCR cross-check (agent 04) that measures how far the text layer agrees with
    what is printed, + tables and figures from the PDF page. Scanned pages: agent 04 OCR. See page_analysis.py.
    """
    n = int(unit["page_number"])
    page_id = unit["unit_id"]
    pclass = unit.get("page_class", "native_text")
    pm = (page_meta.get("pages") or {}).get(str(n), {}) or {}
    cfg = pa.settings()
    review_below = float(cfg["agreement_review_below"])
    warnings: List[dict] = []
    blocks: List[dict] = []
    methods: List[str] = []
    width = int(pm.get("width_px") or 0)
    height = int(pm.get("height_px") or 0)
    paginated = kind in PAGINATED_KINDS

    def text_block(i: int, method: str, text: str, loc: dict, conf: float, breakdown: dict,
                   alt: Optional[dict], agr: Optional[float]) -> dict:
        b = {
            "block_id": f"{page_id}_{method}_{i}", "type": "text", "source_id": source_id, "page_id": page_id,
            "unit_id": page_id, "reading_order_index": 0, "location": _location(loc, "not_located"),
            "confidence": conf, "confidence_breakdown": breakdown, "extraction_method": method, "raw_text": text,
            "needs_review": conf < threshold or (agr is not None and agr < review_below), "warnings": [],
        }
        if alt:
            b["alternatives"] = [alt]
        return b

    if kind not in ("xlsx", "csv") and pclass != "blank":
        native: List[dict] = []
        if pclass in NATIVE_CLASSES or not paginated:
            try:
                a03 = _agent("03_native_text")
                out = a03.run(a03.NativeTextInput(source_id=source_id, page_number=n)).model_dump(mode="json")
                native = [sp for sp in out.get("spans") or [] if (sp.get("text") or "").strip()]
                warnings += [_warn(w, source_id) for w in out.get("warnings") or []]
                methods.append("native_text")
            except Exception as exc:
                warnings.append({"code": "NATIVE_TEXT_FAILED", "message": _error_info(exc)["message"], "source_id": source_id})

        ocr_lines: Optional[List[dict]] = None
        if paginated and (pclass in OCR_CLASSES or (native and cfg["ocr_cross_check"] and n <= int(cfg["max_cross_check_pages"]))):
            ocr_lines = _run_ocr(source_id, n, warnings, methods)
            if ocr_lines is None and native:
                warnings.append({"code": "CONFIDENCE_NOT_CROSS_CHECKED", "source_id": source_id,
                                 "message": f"Page {n}: OCR was unavailable, so native text confidence is the text-layer quality only"})

        tables: List[dict] = []
        figures: List[List[float]] = []
        if kind in ("pdf", "docx", "pptx") and native:
            scale = float(pm.get("scale") or 0) or (width / max(1.0, float(pm.get("width_pt") or width or 1)))
            try:
                tables, figures = _pdf_structures(source_id, n, scale, cfg)
            except Exception as exc:
                warnings.append({"code": "STRUCTURE_DETECTION_FAILED", "message": _error_info(exc)["message"], "source_id": source_id})
        table_boxes = [t["bbox"] for t in tables]

        # Focused re-reads: full-page OCR often skips ruled table rows or small isolated text. Re-read those regions
        # on their own (agent 04 with a region, upscaled) so every value is checked against what is printed.
        if ocr_lines is not None and paginated:
            regions: List[List[float]] = []
            for t in tables:
                for row in t["rows"]:
                    texts = [c for c in row if c["text"]]
                    if texts and not all(pa.covered(c["bbox"], ocr_lines) for c in texts):
                        regions.append(pa.union([c["bbox"] for c in row]))
            for sp in native:
                box = (sp.get("location") or {}).get("bbox")
                if box and not any(pa.center_inside(box, tb) for tb in table_boxes) and not pa.covered(box, ocr_lines):
                    regions.append(list(box))
            budget = int(cfg["max_region_rechecks_per_page"])
            for region in regions[:budget]:
                ocr_lines += _run_ocr_region(source_id, n, region)
            budget -= min(budget, len(regions))
            # Second, finer pass: any table cell or text line that still disagrees is re-read on its own.
            fine: List[List[float]] = []
            for t in tables:
                for row in t["rows"]:
                    for cell in row:
                        if cell["text"] and pa.agreement(cell["text"], pa.ocr_text_for(cell["bbox"], ocr_lines)[0]) < review_below:
                            # Re-read just the glyphs (the native span boxes), not the whole cell: ruling lines
                            # inside a cell crop confuse OCR on short values such as "500".
                            glyphs = [sp["location"]["bbox"] for sp in native if (sp.get("location") or {}).get("bbox")
                                      and pa.center_inside(sp["location"]["bbox"], cell["bbox"])]
                            fine.append(pa.union(glyphs) if glyphs else cell["bbox"])
            for sp in native:
                box = (sp.get("location") or {}).get("bbox")
                if box and not any(pa.center_inside(box, tb) for tb in table_boxes) \
                        and pa.agreement(sp.get("text", ""), pa.ocr_text_for(box, ocr_lines)[0]) < review_below:
                    fine.append(list(box))
            for region in fine[:budget]:
                ocr_lines += _run_ocr_region(source_id, n, region)

        used: set = set()
        for i, sp in enumerate(native):
            loc = sp.get("location") or {}
            box = loc.get("bbox")
            if box and any(pa.center_inside(box, tb) for tb in table_boxes):
                if ocr_lines is not None:
                    pa.ocr_text_for(box, ocr_lines, used)  # its OCR counterpart belongs to the table, not "OCR-only"
                continue
            conf, bd, alt = pa.score(sp.get("text", ""), float(sp.get("confidence") or 0.0), box, ocr_lines, cfg, used)
            blocks.append(text_block(i, "native_text", sp.get("text", ""), loc, conf, bd, alt, bd.get("ocr_agreement")))

        if ocr_lines is not None:
            min_conf = float(cfg["ocr_only_min_confidence"]) if native else 0.0
            for i, ln in enumerate(ocr_lines):
                if i in used or ln["confidence"] < min_conf:
                    continue
                box = ln["bbox"]
                if native and any(pa.inter(box, sp["location"]["bbox"]) > 0.2 * pa.area(box)
                                  for sp in native if (sp.get("location") or {}).get("bbox")):
                    continue
                if any(pa.center_inside(box, tb) for tb in table_boxes):
                    continue
                bd = {"ocr_engine_confidence": round(ln["confidence"], 4)}
                if native:
                    bd["text_layer_present"] = 0.0  # printed on the page but missing from the text layer (e.g. inside an image)
                blocks.append(text_block(i, "ocr", ln["text"], ln["location"], round(ln["confidence"], 4), bd, None, None))

        loc_px = lambda bb: {"bbox": bb, "coordinate_system": "pixel_top_left", "page_width": width, "page_height": height}
        for t_i, t in enumerate(tables):
            cells, cell_confs = [], []
            for r_i, row in enumerate(t["rows"]):
                for cell in row:
                    native_q = [float(sp.get("confidence") or 0.0) for sp in native
                                if (sp.get("location") or {}).get("bbox") and pa.center_inside(sp["location"]["bbox"], cell["bbox"])]
                    q = sum(native_q) / len(native_q) if native_q else 1.0
                    conf, bd, alt = pa.score(cell["text"], q, cell["bbox"], ocr_lines, cfg)
                    c = {"row": r_i, "col": cell["col"], "row_span": 1, "col_span": cell["col_span"], "is_header": r_i == 0,
                         "raw_text": cell["text"], "location": loc_px(cell["bbox"]), "confidence": conf}
                    if alt:
                        c["alternatives"] = [alt]
                    cells.append(c)
                    if cell["text"]:
                        cell_confs.append(conf)
            tconf = round(sum(cell_confs) / len(cell_confs), 4) if cell_confs else 0.0
            blocks.append({
                "block_id": f"{page_id}_table_{t_i}", "type": "table", "table_id": f"{page_id}_table_{t_i}",
                "source_id": source_id, "page_id": page_id, "unit_id": page_id, "reading_order_index": 0,
                "location": loc_px(t["bbox"]), "confidence": tconf,
                "confidence_breakdown": {"mean_cell_confidence": tconf, "cells": len(cells)},
                "extraction_method": "pdf_table_finder", "needs_review": tconf < threshold,
                "warnings": [], "n_rows": len(t["rows"]), "n_cols": t["n_cols"], "cells": cells,
            })

        for f_i, fb in enumerate(figures):
            inside = [b for b in blocks if b["type"] == "text" and b["location"]["bbox"] and pa.center_inside(b["location"]["bbox"], fb)]
            fid = f"{page_id}_figure_{f_i}"
            blocks.append({
                "block_id": fid, "type": "figure", "figure_id": fid, "source_id": source_id, "page_id": page_id,
                "unit_id": page_id, "reading_order_index": 0, "location": loc_px(fb),
                # The figure's placement comes from the PDF object model (exact); text read inside it is OCR.
                "confidence": 1.0, "confidence_breakdown": {"pdf_image_object": 1.0, "ocr_text_blocks_inside": len(inside)},
                "extraction_method": "pdf_image_object", "needs_review": False, "warnings": [],
                "crop_url": f"/sources/{source_id}/pages/{n}/crop?bbox=" + ",".join(f"{v:.1f}" for v in fb),
                **({"caption": " ".join(b["raw_text"] for b in inside)[:300]} if inside else {}),
            })

    if not width and blocks:
        width = max((b["location"]["page_width"] for b in blocks), default=0)
        height = max((b["location"]["page_height"] for b in blocks), default=0)
    rotation = int(pm.get("rotation_correction_cw") or pm.get("declared_rotation") or 0)

    # Reading order over text and tables; each figure is placed just before the first block read inside it
    # (its caption/OCR text), otherwise by its top edge.
    figs = [b for b in blocks if b["type"] == "figure"]
    located = [(b["location"]["bbox"], b) for b in blocks if b["location"]["bbox"] and b["type"] != "figure"]
    unlocated = [b for b in blocks if not b["location"]["bbox"]]
    ordered, uncertain = pa.xy_cut(located, float(width or 1), float(height or 1)) if located else ([], 0)
    for fb in figs:
        fbox = fb["location"]["bbox"]
        pos = next((i for i, b in enumerate(ordered) if pa.center_inside(b["location"]["bbox"], fbox)), None)
        if pos is None:
            pos = next((i for i, b in enumerate(ordered) if b["location"]["bbox"][1] >= fbox[1]), len(ordered))
        ordered.insert(pos, fb)
    blocks = ordered + unlocated
    for i, b in enumerate(blocks):
        b["reading_order_index"] = i
    ro_conf = round(1.0 - uncertain / len(located), 4) if located else 0.0
    return {
        "page_id": page_id, "source_id": source_id, "unit_id": page_id, "page_number": n,
        "width": width, "height": height, "rotation": rotation, "layout_class": pclass,
        "reading_order_confidence": ro_conf,
        "blocks": blocks, "_warnings": warnings, "_methods": methods,
    }


def _process_spreadsheet(source_id: str, units: List[dict]) -> List[dict]:
    a08 = _agent("08_spreadsheet")
    out = a08.run(a08.SpreadsheetInput(source_id=source_id)).model_dump(mode="json")
    sheets = out.get("sheets") or []
    warnings = [_warn(w, source_id) for w in out.get("warnings") or []]
    pages = []
    for i, sheet in enumerate(sheets):
        unit = units[i] if i < len(units) else {"unit_id": f"{source_id}_sheet{i + 1}", "page_number": i + 1}
        table = _sheet_table(sheet, source_id, unit["unit_id"])
        pages.append({
            "page_id": unit["unit_id"], "source_id": source_id, "unit_id": unit["unit_id"],
            "page_number": int(unit["page_number"]), "width": 0, "height": 0, "rotation": 0,
            "layout_class": "spreadsheet", "reading_order_confidence": 1.0,
            "blocks": [table] if table else [], "_warnings": warnings if i == 0 else [], "_methods": ["spreadsheet"],
        })
    return pages


# ----------------------------------------------------------------------------------------------- case inputs
def _publish_source(source_id: str, meta: dict, page_map: Dict[int, dict]) -> None:
    """Hand a processed source to the case agents (15 fact normalizer, 16 cross-document reasoning) in the
    store kinds they read: the assembled document, its per-block confidences, and its display name."""
    store = _store()
    pages = [page_map[k] for k in sorted(page_map)]
    store.put("source_document", source_id, {
        "source_id": source_id, "tenant_id": meta.get("tenant_id"), "filename": meta.get("sanitized_filename", ""),
        "pages": pages,
    })
    store.put("confidence_validation", source_id, {
        "source_id": source_id,
        "blocks": [{"block_id": b["block_id"], "confidence": b.get("confidence"), "needs_review": b.get("needs_review", False),
                    "confidence_breakdown": b.get("confidence_breakdown")} for p in pages for b in p.get("blocks", [])],
    })
    store.put("sources", source_id, {"source_id": source_id, "display_name": meta.get("sanitized_filename", source_id),
                                     "tenant_id": meta.get("tenant_id")})


def _sync_case(case_id: str) -> None:
    """Case record + links in the shapes agents 15/16 read. Sources a user put into a case themselves (at upload
    or with POST /cases/{id}/sources) are confirmed links; the agent-14 suggestions still need a human decision."""
    with _LOCK:
        case = _CASES.get(case_id)
        if not case:
            return
        record = {**case, "tenant_id": case.get("tenant_id") or _user().get("tenant_id")}
        links = [{"case_id": case_id, "source_id": sid, "human_verified": True, "status": "confirmed",
                  "method": "assigned_by_user"} for sid in case.get("source_ids", [])]
    store = _store()
    store.put("case", case_id, {**record, "links": links})
    store.put("cases", case_id, record)
    store.put("case_links", case_id, links)


# ----------------------------------------------------------------------------------------------- persistence
# Batches, jobs, source states and cases are written to the shared store (SQLite-backed, see common/store.py), so a
# backend restart or a --reload keeps them. Each object is saved whenever it changes state.
_P_BATCH, _P_SOURCE, _P_CASE = "pf_batch", "pf_source_state", "pf_case"


def _save(kind: str, oid: str, obj: Optional[dict]) -> None:
    if obj is None:
        return
    try:
        _store().put(kind, oid, obj)
    except Exception:
        pass  # persistence is best-effort; the in-memory state stays authoritative


def _save_batch(batch_id: str) -> None:
    with _LOCK:
        _save(_P_BATCH, batch_id, _BATCHES.get(batch_id))


def _save_source(source_id: str) -> None:
    with _LOCK:
        _save(_P_SOURCE, source_id, _SOURCES.get(source_id))


def _save_case(case_id: str) -> None:
    with _LOCK:
        _save(_P_CASE, case_id, _CASES.get(case_id))


def _restore() -> None:
    """Load saved state. Work that was running when the backend stopped is marked interrupted, so it can be retried."""
    store = _store()
    if not hasattr(store, "list_by_kind"):
        return
    interrupted = {"code": "INTERRUPTED", "message": "Processing was interrupted by a backend restart. Retry this source."}
    with _LOCK:
        for sid, st in store.list_by_kind(_P_SOURCE):
            if isinstance(st, dict):
                if st.get("status") in ("queued", "running"):
                    st.update(status="failed", stage="failed", error=interrupted, finished_at=time.time())
                    _save(_P_SOURCE, sid, st)
                _SOURCES[sid] = st
        for cid, case in store.list_by_kind(_P_CASE):
            if isinstance(case, dict):
                _CASES[cid] = case
        for bid, b in store.list_by_kind(_P_BATCH):
            if not isinstance(b, dict):
                continue
            _BATCHES[bid] = b
            if b.get("job_id"):
                _JOBS[b["job_id"]] = bid
            if b.get("status") in ("queued", "running"):
                states = [_SOURCES.get(x, {}) for x in b.get("source_ids", [])]
                done = sum(1 for x in states if x.get("status") == "completed")
                failed = len(states) - done
                if b.get("_exports_started") and "exports" not in b:
                    b["exports"] = []
                    b["export_errors"] = [{"format": f, **interrupted} for f in b.get("output_formats") or []]
                b.update(status="failed" if done == 0 else "completed", progress_percent=100,
                         stage="interrupted by backend restart", finished_at=time.time(),
                         sources_summary={"total": len(states), "completed": done, "failed": failed})
                _save(_P_BATCH, bid, b)


# ----------------------------------------------------------------------------------------------- execution
def _set_source(source_id: str, **kw: Any) -> None:
    with _LOCK:
        _SOURCES.setdefault(source_id, {}).update(kw)
    _save_source(source_id)


def _run_source(batch_id: str, source_id: str) -> None:
    support = _support()
    started = time.time()
    _set_source(source_id, status="running", stage="format_router", error=None, units_total=0, units_done=0,
                pages={}, warnings=[], started_at=started, finished_at=None, batch_id=batch_id)
    _refresh_batch(batch_id)  # batch shows "running" as soon as any of its sources starts
    try:
        meta = _meta(source_id)
        if not meta:
            raise support.AgentError(support.Code.NOT_FOUND, "Source not found")
        if meta.get("status") != "accepted":
            raise support.AgentError(support.Code.INVALID_INPUT, "Source was not accepted by file validation")
        kind = support.kind_of(meta.get("detected_mime", ""))

        a02 = _agent("02_format_router")
        route = a02.run(a02.FormatRouterInput(source_id=source_id)).model_dump(mode="json")
        units = route.get("units") or []
        page_meta = support.store_get("page_meta", source_id) or {}
        warnings = [_warn(w, source_id) for w in route.get("warnings") or []]
        _set_source(source_id, stage="extraction", units_total=max(1, len(units)), route=route.get("route"), warnings=warnings)
        _refresh_batch(batch_id)

        if kind in ("xlsx", "csv"):
            pages = _process_spreadsheet(source_id, units)
            _set_source(source_id, units_done=len(units))
        else:
            threshold = _review_threshold()
            futures = {_PAGE_POOL.submit(_process_unit, source_id, kind, u, page_meta, threshold): u for u in units}
            pages = []
            for fut, unit in futures.items():
                try:
                    pages.append(fut.result())
                except Exception as exc:
                    warnings.append({"code": "PAGE_FAILED", "message": f"Page {unit['page_number']}: {_error_info(exc)['message']}",
                                     "source_id": source_id})
                with _LOCK:
                    _SOURCES[source_id]["units_done"] += 1

        page_map = {}
        for p in sorted(pages, key=lambda x: x["page_number"]):
            warnings += p.pop("_warnings", [])
            p.pop("_methods", None)
            page_map[p["page_number"]] = p
        # The same warning from every page (e.g. "used fallback OCR engine") is reported once per document.
        seen_w: set = set()
        warnings = [w for w in warnings if not ((w.get("code"), w.get("message")) in seen_w or seen_w.add((w.get("code"), w.get("message"))))]
        _set_source(source_id, status="completed", stage="completed", pages=page_map, warnings=warnings,
                    finished_at=time.time())
        _publish_source(source_id, meta, page_map)
    except Exception as exc:
        _set_source(source_id, status="failed", stage="failed", error=_error_info(exc), finished_at=time.time())
    finally:
        _refresh_batch(batch_id)


def _generate_batch_exports(batch_id: str) -> None:
    with _LOCK:
        batch = _BATCHES.get(batch_id)
        if not batch:
            return
        source_ids = list(batch["source_ids"])
        formats = list(batch.get("output_formats") or [])

    support = _support()
    user = support.current_user()
    source_data = []
    for source_id in source_ids:
        state = _SOURCES.get(source_id, {})
        if state.get("status") != "completed":
            continue
        meta = _meta(source_id)
        if not meta:
            continue
        source_data.append({
            "source_id": source_id,
            "tenant_id": meta.get("tenant_id"),
            "filename": meta.get("sanitized_filename", ""),
            "mime_type": meta.get("detected_mime", ""),
            "sha256": meta.get("sha256", ""),
            "size_bytes": meta.get("size_bytes", 0),
            "page_count": meta.get("page_count", 0),
            "route": state.get("route"),
            "warnings": state.get("warnings", []),
            "pages": [
                page for _, page in sorted((state.get("pages") or {}).items())
            ],
        })

    exports = []
    errors = []
    try:
        if not source_data:
            raise support.AgentError(
                "ENGINE_FAILED",
                "No successfully processed sources are available to export.",
            )
        support.store_put("batch", batch_id, {
            "batch_id": batch_id,
            "tenant_id": user.get("tenant_id"),
            "source_ids": [source["source_id"] for source in source_data],
            "sources": source_data,
        })
        export_agent = _agent("20_export")
        for output_format in formats:
            try:
                result = export_agent.run(
                    export_agent.ExportIn(
                        scope=export_agent.ExportScope(type="batch", ids=[batch_id]),
                        format=output_format,
                        options=export_agent.ExportOptions(include_evidence=True),
                    ),
                    user,
                )
                exports.append({
                    "export_id": result["export_id"],
                    "format": result["format"],
                    "download_url": result["download_url"],
                    "content_hash": result["content_hash"],
                })
            except Exception as exc:
                info = _error_info(exc)
                errors.append({
                    "format": output_format,
                    "code": info["code"],
                    "message": info["message"],
                })
    except Exception as exc:
        info = _error_info(exc)
        errors.extend({
            "format": output_format,
            "code": info["code"],
            "message": info["message"],
        } for output_format in formats)

    with _LOCK:
        batch = _BATCHES.get(batch_id)
        if not batch:
            return
        batch["exports"] = exports
        batch["export_errors"] = errors
        failed_sources = batch["sources_summary"]["failed"]
        batch["status"] = "failed" if failed_sources == batch["sources_summary"]["total"] else "completed"
        if errors and failed_sources:
            batch["stage"] = f"completed with {failed_sources} failed source(s) and export failures"
        elif errors:
            batch["stage"] = "completed with export failures"
        elif failed_sources:
            batch["stage"] = f"completed with {failed_sources} failed source(s)"
        else:
            batch["stage"] = "completed"
        batch["progress_percent"] = 100
        batch["finished_at"] = batch.get("finished_at") or time.time()
    _save_batch(batch_id)


def _refresh_batch(batch_id: str) -> None:
    generate_exports = False
    with _LOCK:
        b = _BATCHES.get(batch_id)
        if not b:
            return
        states = [_SOURCES.get(s, {}) for s in b["source_ids"]]
        total = len(states)
        done = sum(1 for s in states if s.get("status") == "completed")
        failed = sum(1 for s in states if s.get("status") == "failed")
        units_total = sum(s.get("units_total") or 1 for s in states)
        units_done = sum(s.get("units_done") or 0 for s in states)
        finished = done + failed == total
        if finished:
            if b.get("output_formats") and not b.get("_exports_started"):
                b["_exports_started"] = True
                b["status"] = "running"
                b["stage"] = "exporting"
                b["progress_percent"] = 99
                generate_exports = True
            elif b.get("_exports_started") and "exports" not in b:
                b["status"] = "running"
                b["stage"] = "exporting"
                b["progress_percent"] = 99
            else:
                b["status"] = "failed" if failed == total else "completed"
                b["stage"] = "completed" if failed == 0 else f"completed with {failed} failed source(s)"
                b["progress_percent"] = 100
                b["finished_at"] = b.get("finished_at") or time.time()
        else:
            b["status"] = "running"
            stages = {s.get("stage") for s in states if s.get("status") == "running"}
            b["stage"] = "extraction" if "extraction" in stages else ("format_router" if stages else "queued")
            b["progress_percent"] = int(100 * units_done / max(1, units_total))
        b["sources_summary"] = {"total": total, "completed": done, "failed": failed}
    _save_batch(batch_id)
    if generate_exports:
        _generate_batch_exports(batch_id)


def _batch_view(b: dict) -> dict:
    out = {k: b[k] for k in ("batch_id", "created_at", "status", "source_ids", "progress_percent", "stage",
                             "sources_summary", "output_formats", "exports", "export_errors") if k in b}
    if b.get("case_id"):
        out["case_id"] = b["case_id"]
    out["job_id"] = b["job_id"]
    out["sources"] = [
        {"source_id": s, "status": _SOURCES.get(s, {}).get("status", "queued"),
         "stage": _SOURCES.get(s, {}).get("stage", "queued"), "error": _SOURCES.get(s, {}).get("error")}
        for s in b["source_ids"]
    ]
    return out


# ----------------------------------------------------------------------------------------------- batches & jobs
class CreateBatchIn(BaseModel):
    source_ids: List[str] = Field(min_length=1)
    mode: Optional[str] = None
    output_formats: List[str] = []
    case_id: Optional[str] = None
    instructions: Optional[str] = None
    options: Dict[str, Any] = {}


class RetryIn(BaseModel):
    source_id: str


@router.post("/batches")
def create_batch(body: CreateBatchIn):
    source_ids = list(dict.fromkeys(body.source_ids))
    output_formats = list(dict.fromkeys(body.output_formats))
    missing = [s for s in source_ids if not _meta(s)]
    if missing:
        return _err(404, "NOT_FOUND", "Unknown source_id(s)", {"source_ids": missing})
    not_accepted = [s for s in source_ids if (_meta(s) or {}).get("status") != "accepted"]
    if not_accepted:
        return _err(400, "INVALID_INPUT", "Only accepted sources can be processed", {"source_ids": not_accepted})
    if body.case_id and body.case_id not in _CASES:
        return _err(404, "NOT_FOUND", "Unknown case_id")

    batch_id = f"bat_{uuid.uuid4().hex[:16]}"
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    with _LOCK:
        _BATCHES[batch_id] = {
            "batch_id": batch_id, "job_id": job_id, "created_at": _now(), "created_ts": time.time(),
            "status": "queued", "stage": "queued", "progress_percent": 0, "source_ids": source_ids,
            "case_id": body.case_id, "mode": body.mode, "output_formats": output_formats,
            "sources_summary": {"total": len(source_ids), "completed": 0, "failed": 0},
        }
        _JOBS[job_id] = batch_id
        for s in source_ids:
            _SOURCES[s] = {"status": "queued", "stage": "queued", "batch_id": batch_id}
        if body.case_id:
            case = _CASES[body.case_id]
            case["source_ids"] = list(dict.fromkeys(case["source_ids"] + source_ids))
            case["updated_at"] = _now()
    _save_batch(batch_id)
    for s in source_ids:
        _save_source(s)
    if body.case_id:
        _save_case(body.case_id)
        _sync_case(body.case_id)
    for s in source_ids:
        _SOURCE_POOL.submit(_run_source, batch_id, s)
    return _ok({"batch_id": batch_id, "job_id": job_id, "status": "queued"})


@router.get("/batches")
def list_batches():
    with _LOCK:
        items = sorted(_BATCHES.values(), key=lambda b: b["created_ts"], reverse=True)
        return _ok({"batches": [_batch_view(b) for b in items]})


@router.get("/batches/{batch_id}")
def get_batch(batch_id: str):
    with _LOCK:
        b = _BATCHES.get(batch_id)
        if not b:
            return _err(404, "NOT_FOUND", "Batch not found")
        return _ok(_batch_view(b))


@router.post("/batches/{batch_id}/retry")
def retry_source(batch_id: str, body: RetryIn):
    with _LOCK:
        b = _BATCHES.get(batch_id)
        if not b:
            return _err(404, "NOT_FOUND", "Batch not found")
        if b.get("stage") == "exporting":
            return _err(409, "CONFLICT", "Batch exports are still being generated")
        if body.source_id not in b["source_ids"]:
            return _err(400, "INVALID_INPUT", "Source is not part of this batch")
        if _SOURCES.get(body.source_id, {}).get("status") == "running":
            return _err(409, "CONFLICT", "Source is already running")
        _SOURCES[body.source_id] = {"status": "queued", "stage": "queued", "batch_id": batch_id}
        _save_source(body.source_id)
        b.pop("finished_at", None)
        b.pop("exports", None)
        b.pop("export_errors", None)
        b.pop("_exports_started", None)
        _refresh_batch(batch_id)
    _SOURCE_POOL.submit(_run_source, batch_id, body.source_id)
    return _ok({"job_id": b["job_id"]})


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    with _LOCK:
        batch_id = _JOBS.get(job_id)
        b = _BATCHES.get(batch_id or "")
        if not b:
            return _err(404, "NOT_FOUND", "Job not found")
        data = {"job_id": job_id, "status": b["status"], "stage": b.get("stage"),
                "progress_percent": b.get("progress_percent", 0)}
        if b["status"] in ("completed", "failed"):
            data["result"] = {"batch_id": batch_id, "sources_summary": b.get("sources_summary")}
        return _ok(data)


# ----------------------------------------------------------------------------------------------- sources & pages
def _image_url(request: Request, source_id: str, n: int) -> str:
    return str(request.url_for("get_page_image", source_id=source_id, page_number=str(n)))


def _page_view(request: Request, kind: str, page: dict) -> dict:
    out = dict(page)
    out["image_url"] = _image_url(request, page["source_id"], page["page_number"]) if kind in PAGINATED_KINDS else ""
    base = str(request.base_url).rstrip("/")
    out["blocks"] = [{**b, "crop_url": base + b["crop_url"]} if str(b.get("crop_url", "")).startswith("/") else b
                     for b in page.get("blocks", [])]
    return out


def _source_view(request: Request, source_id: str, meta: dict, with_pages: bool) -> dict:
    support = _support()
    kind = support.kind_of(meta.get("detected_mime", ""))
    st = _SOURCES.get(source_id, {})
    pages = [_page_view(request, kind, p) for _, p in sorted((st.get("pages") or {}).items())]
    status = st.get("status") or meta.get("status")
    origin = meta.get("origin") or {}
    doc = {
        "source_id": source_id,
        "filename": meta.get("sanitized_filename", ""),
        "kind": kind,
        "status": status,
        "sha256": meta.get("sha256", ""),
        "size_bytes": int(meta.get("size_bytes") or 0),
        "page_count": int(meta.get("page_count") or len(pages) or 0),
        "origin": {k: v for k, v in {"type": origin.get("type", "upload"), "url": origin.get("url"),
                                      "parent_source_id": origin.get("parent_source_id")}.items() if v},
        "warnings": st.get("warnings") or [],
        "errors": [st["error"]] if st.get("error") else ([meta["error"]] if meta.get("error") else []),
    }
    all_blocks = [b for p in pages for b in p["blocks"]]
    if all_blocks:
        doc["document_confidence"] = round(sum(b["confidence"] for b in all_blocks) / len(all_blocks), 4)
    if with_pages:
        doc["pages"] = pages
    return doc


@router.get("/sources")
def list_sources(request: Request):
    with _LOCK:
        ids = list(_SOURCES.keys())
    docs = []
    for sid in ids:
        meta = _meta(sid)
        if meta:
            docs.append(_source_view(request, sid, meta, with_pages=False))
    return _ok({"sources": docs})


@router.get("/sources/{source_id}")
def get_source(request: Request, source_id: str):
    meta = _meta(source_id)
    if not meta:
        return _err(404, "NOT_FOUND", "Source not found")
    return _ok(_source_view(request, source_id, meta, with_pages=True))


@router.get("/sources/{source_id}/pages/{page_number}")
def get_page(request: Request, source_id: str, page_number: int):
    meta = _meta(source_id)
    if not meta:
        return _err(404, "NOT_FOUND", "Source not found")
    page = (_SOURCES.get(source_id, {}).get("pages") or {}).get(page_number)
    if not page:
        return _err(404, "NOT_FOUND", "Page not processed")
    kind = _support().kind_of(meta.get("detected_mime", ""))
    return _ok(_page_view(request, kind, page))


@router.get("/sources/{source_id}/pages/{page_number}/crop")
def get_page_crop(source_id: str, page_number: int, bbox: str):
    """A region of the page image (page-image pixel coordinates x1,y1,x2,y2), e.g. a figure."""
    support = _support()
    meta = _meta(source_id)
    if not meta:
        return _err(404, "NOT_FOUND", "Source not found")
    try:
        x1, y1, x2, y2 = (float(v) for v in bbox.split(","))
    except ValueError:
        return _err(400, "INVALID_INPUT", "bbox must be x1,y1,x2,y2")
    try:
        png, w, h = support.get_page_image(source_id, page_number, meta)
    except Exception as exc:
        info = _error_info(exc)
        return _err(404 if info["code"] == "NOT_FOUND" else 500, info["code"], info["message"])
    import io
    from PIL import Image
    box = (max(0, int(x1)), max(0, int(y1)), min(w, int(x2 + 0.999)), min(h, int(y2 + 0.999)))
    if box[2] <= box[0] or box[3] <= box[1]:
        return _err(400, "INVALID_INPUT", "bbox is outside the page")
    with Image.open(io.BytesIO(png)) as im:
        buf = io.BytesIO()
        im.crop(box).save(buf, "PNG")
    return Response(content=buf.getvalue(), media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/sources/{source_id}/pages/{page_number}/image", name="get_page_image")
def get_page_image(source_id: str, page_number: int):
    support = _support()
    meta = _meta(source_id)
    if not meta:
        return _err(404, "NOT_FOUND", "Source not found")
    if support.kind_of(meta.get("detected_mime", "")) not in PAGINATED_KINDS:
        return _err(404, "NOT_FOUND", "This source has no page images")
    try:
        png, _, _ = support.get_page_image(source_id, page_number, meta)
    except Exception as exc:
        info = _error_info(exc)
        return _err(404 if info["code"] == "NOT_FOUND" else 500, info["code"], info["message"])
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "private, max-age=3600"})


# ----------------------------------------------------------------------------------------------- cases
class CreateCaseIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    metadata: Dict[str, Any] = {}


@router.get("/cases")
def list_cases():
    with _LOCK:
        return _ok({"cases": sorted(_CASES.values(), key=lambda c: c["created_at"], reverse=True)})


@router.post("/cases")
def create_case(body: CreateCaseIn):
    case_id = f"case_{uuid.uuid4().hex[:12]}"
    now = _now()
    case = {"case_id": case_id, "title": body.title.strip(), "status": "open", "created_at": now,
            "updated_at": now, "source_ids": [], "metadata": body.metadata}
    with _LOCK:
        _CASES[case_id] = case
    _save_case(case_id)
    _sync_case(case_id)
    return _ok(case)


@router.get("/cases/{case_id}")
def get_case(case_id: str):
    with _LOCK:
        case = _CASES.get(case_id)
        return _ok(case) if case else _err(404, "NOT_FOUND", "Case not found")


# ----------------------------------------------------------------------------------------------- actions
def _actions() -> List[dict]:
    store = _store()
    out = []
    for kind in ("action", "proposed_action"):
        if hasattr(store, "list_by_kind"):
            out += [v for _, v in store.list_by_kind(kind) if isinstance(v, dict)]
    return out


@router.get("/actions")
def list_actions():
    return _ok({"actions": _actions()})


@router.get("/actions/{action_id}")
def get_action(action_id: str):
    for a in _actions():
        if a.get("action_id") == action_id:
            return _ok({"action": a, "events": a.get("events", []), "signature": a.get("signature")})
    return _err(404, "NOT_FOUND", "Action not found")


# ----------------------------------------------------------------------------------------------- metrics
@router.get("/metrics")
def metrics():
    with _LOCK:
        states = [s for s in _SOURCES.values() if s.get("finished_at") and s.get("started_at")]
        done = [s for s in states if s.get("status") == "completed"]
        failed = [s for s in states if s.get("status") == "failed"]
        pages = [p for s in done for p in (s.get("pages") or {}).values()]
        blocks = [b for p in pages for b in p["blocks"]]
        secs = [s["finished_at"] - s["started_at"] for s in done]
    items = [
        {"id": "sources_completed", "label": "Sources processed", "value": len(done)},
        {"id": "sources_failed", "label": "Sources failed", "value": len(failed)},
        {"id": "pages_processed", "label": "Pages processed", "value": len(pages)},
        {"id": "blocks_extracted", "label": "Blocks extracted", "value": len(blocks)},
    ]
    if secs:
        items.append({"id": "avg_source_seconds", "label": "Average time per source", "value": round(sum(secs) / len(secs), 2), "unit": "s"})
    if pages and secs:
        items.append({"id": "pages_per_second", "label": "Throughput", "value": round(len(pages) / max(0.001, sum(secs)), 2), "unit": "pages/s"})
    if blocks:
        items.append({"id": "mean_confidence", "label": "Mean block confidence", "value": round(sum(b["confidence"] for b in blocks) / len(blocks), 4)})
        items.append({"id": "needs_review", "label": "Blocks needing review", "value": sum(1 for b in blocks if b["needs_review"])})
    return _ok({"items": items})


_restore()


# ----------------------------------------------------------------------------------------------- case analysis
class AttachSourcesIn(BaseModel):
    source_ids: List[str] = Field(min_length=1)


@router.post("/cases/{case_id}/sources")
def attach_sources(case_id: str, body: AttachSourcesIn):
    """Put already-processed sources into a case (the user's own assignment, so the links are confirmed)."""
    missing = [s for s in body.source_ids if not _meta(s)]
    if missing:
        return _err(404, "NOT_FOUND", "Unknown source_id(s)", {"source_ids": missing})
    with _LOCK:
        case = _CASES.get(case_id)
        if not case:
            return _err(404, "NOT_FOUND", "Case not found")
        case["source_ids"] = list(dict.fromkeys(case["source_ids"] + list(body.source_ids)))
        case["updated_at"] = _now()
    _save_case(case_id)
    _sync_case(case_id)
    return _ok(_CASES[case_id])


def _source_summary(source_id: str) -> dict:
    """What parsing produced for one source: counts per block type and method, confidence, review load."""
    meta = _meta(source_id) or {}
    st = _SOURCES.get(source_id, {})
    pages = [p for _, p in sorted((st.get("pages") or {}).items())]
    blocks = [b for p in pages for b in p.get("blocks", [])]
    by_type: Dict[str, int] = {}
    by_method: Dict[str, int] = {}
    for b in blocks:
        by_type[b["type"]] = by_type.get(b["type"], 0) + 1
        by_method[b["extraction_method"]] = by_method.get(b["extraction_method"], 0) + 1
    agreements = [b["confidence_breakdown"]["ocr_agreement"] for b in blocks
                  if isinstance(b.get("confidence_breakdown"), dict) and "ocr_agreement" in b["confidence_breakdown"]]
    return {
        "source_id": source_id, "filename": meta.get("sanitized_filename", ""), "status": st.get("status", "not_processed"),
        "route": st.get("route"), "pages": len(pages), "blocks": len(blocks), "blocks_by_type": by_type,
        "blocks_by_method": by_method, "tables": by_type.get("table", 0), "figures": by_type.get("figure", 0),
        "document_confidence": round(sum(b["confidence"] for b in blocks) / len(blocks), 4) if blocks else None,
        "ocr_agreement_mean": round(sum(agreements) / len(agreements), 4) if agreements else None,
        "needs_review": sum(1 for b in blocks if b.get("needs_review")),
        "reading_order_confidence": round(sum(p.get("reading_order_confidence", 0) for p in pages) / len(pages), 4) if pages else None,
        "warnings": st.get("warnings") or [], "error": st.get("error"),
    }


def _with_filenames(evs: List[dict]) -> List[dict]:
    """Evidence references as the UI shows them (adds filename + page_number for hover-to-source)."""
    out = []
    for ev in evs or []:
        ev = dict(ev)
        meta = _meta(ev.get("source_id", "")) or {}
        ev.setdefault("filename", meta.get("sanitized_filename", ""))
        if "page_number" not in ev:
            pages = (_SOURCES.get(ev.get("source_id", ""), {}).get("pages") or {})
            ev["page_number"] = next((n for n, p in pages.items() if p.get("page_id") == ev.get("page_id")), 1)
        ev.setdefault("text_excerpt", ev.get("excerpt", ""))
        out.append(ev)
    return out


@router.post("/cases/{case_id}/analyze")
def analyze_case(case_id: str):
    """Runs the case stages on the case's processed sources and returns every stage's output plus a final result:
         parsing (per source)  ->  agent 15 fact normalizer  ->  agent 16 cross-document reasoning  ->  final
    Final confidence:
         findings present     -> mean confidence of the findings (agent 16: min fact confidence - penalties)
         no findings          -> mean confidence of the comparisons that were made (min of the two facts' confidences)
         nothing comparable   -> 0 (verdict "insufficient_data")"""
    with _LOCK:
        case = _CASES.get(case_id)
    if not case:
        return _err(404, "NOT_FOUND", "Case not found")
    if len(case.get("source_ids") or []) < 2:
        return _err(400, "INVALID_INPUT", "A case needs at least two processed sources for cross-document reasoning")
    pending = [s for s in case["source_ids"] if _SOURCES.get(s, {}).get("status") != "completed"]
    if pending:
        return _err(409, "CONFLICT", "Some sources of this case are not processed yet", {"source_ids": pending})
    _sync_case(case_id)
    started = time.time()
    stages: List[dict] = []

    parsing = [_source_summary(s) for s in case["source_ids"]]
    stages.append({"stage": "parsing", "agents": ["01", "02", "03", "04", "08"], "status": "completed",
                   "output": parsing})

    try:
        a15 = _agent("15_fact_normalizer")
        facts_out = a15.run(a15.FactNormalizerInput(case_id=case_id)).model_dump(mode="json")
    except Exception as exc:
        info = _error_info(exc)
        stages.append({"stage": "fact_normalization", "agents": ["15"], "status": "failed", "error": info})
        return _ok({"case_id": case_id, "stages": stages, "final": {"verdict": "failed", "confidence": 0.0, "error": info}})
    facts = facts_out.get("facts") or []
    for f in facts:
        f["evidence"] = _with_filenames(f.get("evidence") or [])
    stages.append({"stage": "fact_normalization", "agents": ["15"], "status": "completed",
                   "output": {"facts": facts, "warnings": facts_out.get("warnings") or []}})

    try:
        a16 = _agent("16_cross_doc_reasoning")
        r = a16.run(a16.RunInput(case_id=case_id)).model_dump(mode="json")
    except Exception as exc:
        info = _error_info(exc)
        stages.append({"stage": "cross_document_reasoning", "agents": ["16"], "status": "failed", "error": info})
        return _ok({"case_id": case_id, "stages": stages, "final": {"verdict": "failed", "confidence": 0.0, "error": info}})
    fact_conf = {f["fact_id"]: float(f.get("confidence") or 0.0) for f in facts}
    for c in r.get("comparisons") or []:
        confs = [fact_conf[i] for i in c.get("fact_ids", []) if i in fact_conf]
        c["confidence"] = round(min(confs), 4) if confs else None
    for fd in r.get("findings") or []:
        fd["evidence_references"] = _with_filenames(fd.get("evidence_references") or [])
    stages.append({"stage": "cross_document_reasoning", "agents": ["16"], "status": "completed", "output": r})

    findings = r.get("findings") or []
    comps = [c for c in (r.get("comparisons") or []) if c.get("confidence") is not None]
    if findings:
        verdict = "discrepancies_found"
        conf = sum(f["confidence"] for f in findings) / len(findings)
        basis = "mean confidence of the findings"
    elif comps:
        verdict = "consistent"
        conf = sum(c["confidence"] for c in comps) / len(comps)
        basis = "mean confidence of the comparisons (all within tolerance)"
    else:
        verdict = "insufficient_data"
        conf = 0.0
        basis = "no comparable facts across the documents"
    sev: Dict[str, int] = {}
    for f in findings:
        sev[f["severity"]] = sev.get(f["severity"], 0) + 1
    final = {
        "verdict": verdict, "confidence": round(conf, 4), "confidence_basis": basis,
        "documents": len(case["source_ids"]), "facts": len(facts), "comparisons": len(r.get("comparisons") or []),
        "not_comparable": len(r.get("not_comparable") or []), "findings": len(findings), "findings_by_severity": sev,
        "human_review_required": bool(findings) or any(p["needs_review"] for p in parsing),
        "summary": (f"{len(findings)} discrepanc{'y' if len(findings) == 1 else 'ies'} found across {len(case['source_ids'])} documents"
                    if findings else ("All compared values agree within tolerance" if comps
                                      else "No values could be compared across the documents")),
        "duration_ms": int((time.time() - started) * 1000),
    }
    result = {"case_id": case_id, "analyzed_at": _now(), "stages": stages, "final": final}
    _save("pf_case_analysis", case_id, result)
    return _ok(result)


@router.get("/cases/{case_id}/analysis")
def get_case_analysis(case_id: str):
    res = _store().get("pf_case_analysis", case_id)
    return _ok(res) if res else _err(404, "NOT_FOUND", "This case has not been analysed yet")