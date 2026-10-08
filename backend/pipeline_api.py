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
from collections import defaultdict
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
_ANALYSIS_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="pf-analysis")

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
        # Agents 15/16 only see sources whose parsing completed (failed or running ones would break them).
        parsed = [sid for sid in case.get("source_ids", []) if _SOURCES.get(sid, {}).get("status") == "completed"]
        record = {**case, "source_ids": parsed, "tenant_id": case.get("tenant_id") or _user().get("tenant_id")}
        links = [{"case_id": case_id, "source_id": sid, "human_verified": True, "status": "confirmed",
                  "method": "assigned_by_user"} for sid in parsed]
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
            if (b.get("analysis") or {}).get("status") in ("pending", "running"):
                b["analysis"] = {"status": "failed", "case_id": b.get("case_id"),
                                 "error": {"code": "INTERRUPTED", "message": "Cross-document reasoning was interrupted by a backend restart. Run it again."}}
                _save(_P_BATCH, bid, b)
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
    with _LOCK:
        b = _BATCHES.get(batch_id)
        start_analysis = bool(b) and (b.get("analysis") or {}).get("status") == "pending" and all(
            _SOURCES.get(s, {}).get("status") in ("completed", "failed") for s in b["source_ids"])
    if start_analysis:
        _start_batch_analysis(batch_id)


def _batch_view(b: dict) -> dict:
    out = {k: b[k] for k in ("batch_id", "created_at", "status", "source_ids", "progress_percent", "stage",
                             "sources_summary", "output_formats", "exports", "export_errors") if k in b}
    if b.get("case_id"):
        out["case_id"] = b["case_id"]
    out["job_id"] = b["job_id"]
    out["analysis"] = b.get("analysis") or {"status": "not_run"}
    out["sources"] = []
    for s in b["source_ids"]:
        st = _SOURCES.get(s, {})
        item = {"source_id": s, "status": st.get("status", "queued"), "stage": st.get("stage", "queued"),
                "error": st.get("error"), "filename": (_meta(s) or {}).get("sanitized_filename", "")}
        if st.get("pages"):
            # What parsing produced so far (pages, blocks by type/method, confidence, review load, warnings).
            item["parse"] = _source_summary(s)
        out["sources"].append(item)
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
            "analysis": {"status": "pending"},
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


def _start_missing_analyses(batch_ids: List[str]) -> None:
    """Batches that finished before automatic analysis existed (or whose analysis was never started) get it now."""
    todo = []
    with _LOCK:
        for bid in batch_ids:
            b = _BATCHES.get(bid)
            if b and b.get("status") in ("completed", "failed") and "analysis" not in b and b.get("stage") != "exporting":
                b["analysis"] = {"status": "pending", "case_id": b.get("case_id")}
                todo.append(bid)
    for bid in todo:
        _start_batch_analysis(bid)


@router.get("/batches")
def list_batches():
    with _LOCK:
        ids = list(_BATCHES)
    _start_missing_analyses(ids)
    with _LOCK:
        items = sorted(_BATCHES.values(), key=lambda b: b["created_ts"], reverse=True)
        return _ok({"batches": [_batch_view(b) for b in items]})


@router.get("/batches/{batch_id}")
def get_batch(batch_id: str):
    _start_missing_analyses([batch_id])
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
        b["analysis"] = {"status": "pending", "case_id": b.get("case_id")}
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
    warnings = st.get("warnings") or []
    parse_score = _parse_score(blocks, pages, agreements, warnings)
    # Native text that could not be cross-checked against OCR is unverified: it needs review.
    unverified = 0
    if parse_score["cap"]["applied"]:
        unverified = sum(1 for b in blocks if not b.get("needs_review") and b.get("extraction_method") == "native_text"
                         and "ocr_agreement" not in (b.get("confidence_breakdown") or {}))
    return {
        "source_id": source_id, "filename": meta.get("sanitized_filename", ""), "status": st.get("status", "not_processed"),
        "route": st.get("route"), "pages": len(pages), "blocks": len(blocks), "blocks_by_type": by_type,
        "blocks_by_method": by_method, "tables": by_type.get("table", 0), "figures": by_type.get("figure", 0),
        "document_confidence": round(sum(b["confidence"] for b in blocks) / len(blocks), 4) if blocks else None,
        "ocr_agreement_mean": round(sum(agreements) / len(agreements), 4) if agreements else None,
        "needs_review": sum(1 for b in blocks if b.get("needs_review")) + unverified,
        "unverified_blocks": unverified,
        "reading_order_confidence": round(sum(p.get("reading_order_confidence", 0) for p in pages) / len(pages), 4) if pages else None,
        "parse_score": parse_score,
        "warnings": warnings, "warning_counts": _warning_counts(warnings), "error": st.get("error"),
    }


def _union_parse(parsing: List[dict]) -> dict:
    """The final parse: the union of every document's parse, with totals and a block-weighted score."""
    blocks = sum(p["blocks"] for p in parsing)
    by_type: Dict[str, int] = defaultdict(int)
    by_method: Dict[str, int] = defaultdict(int)
    warns: Dict[str, dict] = {}
    for p in parsing:
        for k, v in (p.get("blocks_by_type") or {}).items():
            by_type[k] += v
        for k, v in (p.get("blocks_by_method") or {}).items():
            by_method[k] += v
        for w in p.get("warning_counts") or []:
            e = warns.setdefault(w["code"], {"code": w["code"], "message": w["message"], "count": 0, "documents": []})
            e["count"] += w["count"]
            e["documents"].append(p["filename"])
    scored = [(p["parse_score"]["value"], p["blocks"]) for p in parsing
              if (p.get("parse_score") or {}).get("value") is not None and p["blocks"]]
    value = round(sum(v * n for v, n in scored) / sum(n for _, n in scored), 4) if scored else None
    capped = [p["filename"] for p in parsing if (p.get("parse_score") or {}).get("cap", {}).get("applied")]
    return {
        "documents": [{"source_id": p["source_id"], "filename": p["filename"], "pages": p["pages"], "blocks": p["blocks"],
                       "parse_score": (p.get("parse_score") or {}).get("value"),
                       "unread_pages": p.get("unread_pages", 0)} for p in parsing],
        "pages": sum(p["pages"] for p in parsing), "blocks": blocks,
        "tables": sum(p["tables"] for p in parsing), "figures": sum(p["figures"] for p in parsing),
        "unread_pages": sum(p.get("unread_pages", 0) for p in parsing),
        "blocks_by_type": dict(by_type), "blocks_by_method": dict(by_method),
        "needs_review": sum(p["needs_review"] for p in parsing),
        "parse_score": {"value": value, "formula": "block-weighted mean of the documents' parse scores",
                        "capped_documents": capped},
        "warnings": sorted(warns.values(), key=lambda w: (-w["count"], w["code"])),
    }


def _warning_counts(warnings: List[dict]) -> List[dict]:
    counts: Dict[str, dict] = {}
    for w in warnings:
        c = counts.setdefault(w.get("code", "WARNING"), {"code": w.get("code", "WARNING"), "message": w.get("message", ""), "count": 0})
        c["count"] += 1
    return sorted(counts.values(), key=lambda c: (-c["count"], c["code"]))


def _parse_score(blocks: List[dict], pages: List[dict], agreements: List[float], warnings: List[dict]) -> dict:
    """Document parse score = mean block confidence, capped when a check could not run or the text layer is unusable.
    Caps come from platform_config.json "parse_score.caps" ({warning code: maximum score})."""
    if not blocks:
        return {"value": None, "components": {}, "cap": {"applied": False}, "formula": "mean block confidence"}
    mean = sum(b["confidence"] for b in blocks) / len(blocks)
    components = {"mean_block_confidence": round(mean, 4)}
    if agreements:
        components["mean_ocr_agreement"] = round(sum(agreements) / len(agreements), 4)
    if pages:
        components["mean_reading_order_confidence"] = round(sum(p.get("reading_order_confidence", 0) for p in pages) / len(pages), 4)
    try:
        from backend import platform_api
        caps = (platform_api._file_settings().get("parse_score") or {}).get("caps") or {}
    except Exception:
        caps = {}
    codes = {w.get("code") for w in warnings}
    hits = sorted(((float(caps[c]), c) for c in codes if c in caps))
    cap = {"applied": False}
    value = mean
    if hits:
        mx, code = hits[0]
        cap = {"applied": mean > mx, "max": mx, "reason": f"{code} reported for this document", "code": code,
               "config_key": f"parse_score.caps.{code}"}
        value = min(mean, mx)
    return {"value": round(value, 4), "components": components, "cap": cap,
            "formula": "mean block confidence" + (f", capped at {cap['max']} ({cap['code']})" if cap.get("applied") else "")}


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


class _AnalysisError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Optional[dict] = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details or {}


@router.post("/cases/{case_id}/analyze")
def analyze_case(case_id: str):
    try:
        return _ok(_analyze(case_id))
    except _AnalysisError as e:
        return _err(e.status, e.code, e.message, e.details)


def _analyze(case_id: str) -> dict:
    """Runs the case stages on the case's processed sources and returns every stage's output plus a final result:
         parsing (per source)  ->  agent 15 fact normalizer  ->  agent 16 cross-document reasoning  ->  final
    Final confidence:
         findings present     -> mean confidence of the findings (agent 16: min fact confidence - penalties)
         no findings          -> mean confidence of the comparisons that were made (min of the two facts' confidences)
         nothing comparable   -> 0 (verdict "insufficient_data")"""
    with _LOCK:
        case = _CASES.get(case_id)
    if not case:
        raise _AnalysisError(404, "NOT_FOUND", "Case not found")
    pending = [s for s in case.get("source_ids") or [] if _SOURCES.get(s, {}).get("status") in ("queued", "running", None)]
    if pending:
        raise _AnalysisError(409, "CONFLICT", "Some sources of this case are not processed yet", {"source_ids": pending})
    excluded = [s for s in case.get("source_ids") or [] if _SOURCES.get(s, {}).get("status") != "completed"]
    case = {**case, "source_ids": [s for s in case.get("source_ids") or [] if s not in excluded]}
    if not case["source_ids"]:
        raise _AnalysisError(400, "INVALID_INPUT", "No document of this case was parsed successfully")
    _sync_case(case_id)
    started = time.time()
    stages: List[dict] = []

    parsing = [_source_summary(s) for s in case["source_ids"]]
    stages.append({"stage": "parsing", "agents": ["01", "02", "03", "04", "08"], "status": "completed",
                   "output": parsing, "excluded_sources": [{"source_id": s, "filename": (_meta(s) or {}).get("sanitized_filename", ""),
                                                            "reason": (_SOURCES.get(s, {}).get("error") or {}).get("message", "parsing failed")}
                                                           for s in excluded]})
    stages.append({"stage": "union_parse", "agents": ["pipeline"], "status": "completed", "output": _union_parse(parsing)})

    try:
        a15 = _agent("15_fact_normalizer")
        facts_out = a15.run(a15.FactNormalizerInput(case_id=case_id)).model_dump(mode="json")
    except Exception as exc:
        info = _error_info(exc)
        stages.append({"stage": "fact_normalization", "agents": ["15"], "status": "failed", "error": info})
        result = {"case_id": case_id, "analyzed_at": _now(), "stages": stages, "final": {"verdict": "failed", "confidence": 0.0, "error": info}}
        _save("pf_case_analysis", case_id, result)
        return result
    facts = facts_out.get("facts") or []
    for f in facts:
        f["evidence"] = _with_filenames(f.get("evidence") or [])
    stages.append({"stage": "fact_normalization", "agents": ["15"], "status": "completed",
                   "output": {"facts": facts, "warnings": facts_out.get("warnings") or [],
                              "documents": facts_out.get("documents") or [],
                              "skipped_candidates": facts_out.get("skipped_candidates") or []}})

    try:
        a16 = _agent("16_cross_doc_reasoning")
        r = a16.run(a16.RunInput(case_id=case_id)).model_dump(mode="json")
    except Exception as exc:
        info = _error_info(exc)
        stages.append({"stage": "cross_document_reasoning", "agents": ["16"], "status": "failed", "error": info})
        result = {"case_id": case_id, "analyzed_at": _now(), "stages": stages, "final": {"verdict": "failed", "confidence": 0.0, "error": info}}
        _save("pf_case_analysis", case_id, result)
        return result
    fact_conf = {f["fact_id"]: float(f.get("confidence") or 0.0) for f in facts}
    for c in r.get("comparisons") or []:
        confs = [fact_conf[i] for i in c.get("fact_ids", []) if i in fact_conf]
        c["confidence"] = round(min(confs), 4) if confs else None
    for fd in r.get("findings") or []:
        fd["evidence_references"] = _with_filenames(fd.get("evidence_references") or [])
    stages.append({"stage": "cross_document_reasoning", "agents": ["16"], "status": "completed", "output": r})

    report = _reasoning_report(case, parsing, facts_out, facts, r)
    cs = report["case_score"]
    findings = r.get("findings") or []
    sev: Dict[str, int] = {}
    for f in findings:
        sev[f["severity"]] = sev.get(f["severity"], 0) + 1
    verdict = ("discrepancies_found" if findings else "consistent") if cs["status"] == "scored" else "not_scored"
    counts = report["counts"]
    final = {
        "verdict": verdict, "confidence": cs["value"], "confidence_basis": cs.get("formula_description"),
        "score_status": cs["status"], "not_scored_reason": cs.get("reason_text") or cs.get("reason"),
        "documents": counts["documents"], "facts": counts["facts_accepted"], "facts_skipped": counts["facts_skipped"],
        "pairs_considered": counts["pairs_considered"], "comparisons": counts["comparable"],
        "not_comparable": counts["not_comparable"], "findings": counts["findings"], "findings_by_severity": sev,
        "human_review_required": bool(findings) or any(p["needs_review"] for p in parsing),
        "summary": (f"{len(findings)} potential discrepanc{'y' if len(findings) == 1 else 'ies'} found across "
                    f"{counts['documents']} documents; manual review recommended"
                    if findings else ("Comparisons made; no discrepancy flagged" if cs["status"] == "scored"
                                      else "Not scored")),
        "duration_ms": int((time.time() - started) * 1000),
    }
    result = {"case_id": case_id, "analyzed_at": _now(), "stages": stages, "final": final, "report": report}
    _save("pf_case_analysis", case_id, result)
    return result


def _nc_reason_code(nc: dict) -> str:
    failed = [c.get("name") for c in nc.get("checks") or [] if c.get("status") == "fail"]
    return (failed[0] if failed else "unspecified").upper()


def _reasoning_report(case: dict, parsing: List[dict], facts_out: dict, facts: List[dict], r: dict) -> dict:
    """Everything sections 2-4 need to explain themselves. All values are computed here, none in the UI."""
    sids = list(case["source_ids"])
    by_src: Dict[str, List[dict]] = defaultdict(list)
    for f in facts:
        by_src[(f.get("evidence") or [{}])[0].get("source_id", "")].append(f)
    fdocs = {d["source_id"]: d for d in facts_out.get("documents") or []}
    skipped = facts_out.get("skipped_candidates") or []
    warn_counts: Dict[str, int] = defaultdict(int)
    for w in r.get("warnings") or []:
        warn_counts[w.get("code", "")] += 1

    documents = []
    for p in parsing:
        fd = fdocs.get(p["source_id"], {})
        zero = fd.get("zero_fact_reason")
        if zero and p.get("parse_score", {}).get("cap", {}).get("code") == "UNUSABLE_TEXT_LAYER":
            zero += "; the text layer is unusable (UNUSABLE_TEXT_LAYER)"
        documents.append({
            "source_id": p["source_id"], "filename": p["filename"],
            "parse": {k: p.get(k) for k in ("pages", "blocks", "tables", "figures", "route", "blocks_by_method",
                                            "needs_review", "unverified_blocks", "warning_counts", "error")},
            "parse_score": p.get("parse_score"),
            "facts": {"candidates": fd.get("candidates"), "accepted": len(by_src.get(p["source_id"], [])),
                      "skipped_total": fd.get("skipped_total"), "skipped": fd.get("skipped") or [],
                      "unclassified_numbers": fd.get("unclassified_numbers"), "zero_fact_reason": zero},
        })

    # relatedness: which signals two documents share
    def sig(fs: List[dict]) -> dict:
        return {"subjects": {f["subject"] for f in fs if f.get("subject")},
                "metrics": {f["metric"] for f in fs},
                "periods": {(f.get("period_start"), f.get("period_end")) for f in fs if f.get("period_start")},
                "currencies": {f["currency"] for f in fs if f.get("currency")}}
    sigs = {s: sig(by_src.get(s, [])) for s in sids}
    names = {p["source_id"]: p["filename"] for p in parsing}
    relatedness = []
    for i, a in enumerate(sids):
        for b in sids[i + 1:]:
            A, B = sigs[a], sigs[b]
            if not by_src.get(a) or not by_src.get(b):
                relatedness.append({"source_a": a, "source_b": b, "filename_a": names.get(a), "filename_b": names.get(b),
                                    "score": None, "reason": "a document has no facts", "signals": []})
                continue
            signals = []
            for name, key in (("same subject", "subjects"), ("shared attribute", "metrics"),
                              ("same period", "periods"), ("same currency", "currencies")):
                shared = A[key] & B[key]
                detail = (", ".join(sorted(" to ".join(x for x in v if x) if isinstance(v, tuple) else str(v) for v in shared))[:160]
                          if shared else "none shared")
                signals.append({"name": name, "matched": bool(shared), "detail": detail})
            relatedness.append({"source_a": a, "source_b": b, "filename_a": names.get(a), "filename_b": names.get(b),
                                "score": round(sum(s["matched"] for s in signals) / len(signals), 4), "signals": signals})

    comps = r.get("comparisons") or []
    ncs = [n for n in (r.get("not_comparable") or []) if _nc_reason_code(n) != "CONTENT_SAFETY"]
    quarantined = len(r.get("not_comparable") or []) - len(ncs)
    groups: Dict[str, dict] = {}
    for n in ncs:
        code = _nc_reason_code(n)
        g = groups.setdefault(code, {"reason_code": code, "count": 0, "example": n.get("reason"), "example_fact_ids": []})
        g["count"] += 1
        if len(g["example_fact_ids"]) < 3:
            g["example_fact_ids"].append(n.get("fact_ids"))
    findings = r.get("findings") or []

    # why there are no (more) comparisons, from the data
    unlock: List[str] = []
    zero_docs = [d["filename"] for d in documents if not d["facts"]["accepted"]]
    if zero_docs:
        unlock.append(f"{len(zero_docs)} document(s) produced no facts ({', '.join(zero_docs)}); see each document's reason")
    unnamed = sum(1 for f in facts if not f.get("subject"))
    if unnamed:
        unlock.append(f"{unnamed} fact(s) have no named subject; add a name line (e.g. 'Employee name:', 'Account holder:') "
                      "so values can be matched to the same person or party")
    all_metrics = [sigs[s]["metrics"] for s in sids if by_src.get(s)]
    if len(all_metrics) >= 2 and not any(all_metrics[i] & all_metrics[j] for i in range(len(all_metrics))
                                         for j in range(i + 1, len(all_metrics))):
        unlock.append("no shared attribute across documents: the documents report different things")
    for code, g in groups.items():
        unlock.append(f"{g['count']} pair(s) rejected by the '{code.lower()}' check")
    dropped = {k: v for k, v in warn_counts.items() if k in ("EVIDENCE_UNVERIFIED", "VALUE_NOT_IN_EVIDENCE",
                                                             "CROSS_CASE_SOURCE", "NO_EVIDENCE", "FACT_SCHEMA_INVALID")}

    try:
        from backend import platform_api
        pen = ((platform_api._file_settings().get("agents") or {}).get("reasoning") or {}).get("confidence_penalties") or {}
    except Exception:
        pen = {}
    if findings:
        vals = [f["confidence"] for f in findings]
        case_score = {"status": "scored", "value": round(sum(vals) / len(vals), 4),
                      "components": {f"finding {i + 1} ({f['title'][:60]})": f["confidence"] for i, f in enumerate(findings)},
                      "formula_description": "mean of finding scores; each finding = lower of its two facts' scores minus "
                                             "penalties (agents.reasoning.confidence_penalties: "
                                             + ", ".join(f"{k} {v}" for k, v in pen.items()) + ")"}
    elif comps:
        vals = [c["confidence"] for c in comps if c.get("confidence") is not None]
        case_score = {"status": "scored", "value": round(sum(vals) / len(vals), 4) if vals else None,
                      "components": {f"{c['metric']} ({c['subject']})": c.get("confidence") for c in comps},
                      "formula_description": "mean of comparison scores; each comparison = lower of its two facts' scores"}
    else:
        case_score = {"status": "not_scored", "value": None, "components": {},
                      "reason": "no comparable fact pairs across the documents" + (f" ({unlock[0]})" if unlock else ""),
                      "formula_description": "a case score needs at least one comparable pair"}

    counts = {"documents": len(sids), "facts_accepted": len(facts), "facts_skipped": len(skipped),
              "facts_skipped_by_documents": sum(int(d["facts"]["skipped_total"] or 0) for d in documents),
              "unclassified_numbers": sum(int(d["facts"]["unclassified_numbers"] or 0) for d in documents),
              "facts_dropped_by_reasoning": sum(dropped.values()),
              "pairs_considered": len(comps) + len(ncs), "comparable": len(comps), "not_comparable": len(ncs),
              "quarantined": quarantined, "findings": len(findings)}
    checks = [
        {"check": "facts per document add up to total facts",
         "ok": sum(d["facts"]["accepted"] for d in documents) == counts["facts_accepted"],
         "detail": f"{sum(d['facts']['accepted'] for d in documents)} vs {counts['facts_accepted']}"},
        {"check": "every skipped candidate is listed",
         "ok": counts["facts_skipped"] == counts["facts_skipped_by_documents"],
         "detail": f"{counts['facts_skipped']} listed vs {counts['facts_skipped_by_documents']} counted"},
        {"check": "comparable + not comparable = pairs considered",
         "ok": counts["comparable"] + counts["not_comparable"] == counts["pairs_considered"],
         "detail": f"{counts['comparable']} + {counts['not_comparable']} = {counts['pairs_considered']}"},
        {"check": "findings come from comparisons", "ok": counts["findings"] <= counts["comparable"],
         "detail": f"{counts['findings']} findings, {counts['comparable']} comparisons"},
    ]
    if counts["pairs_considered"] == 0:
        no_pairs = "no pair of facts shared the same attribute across documents" + (
            f": {'; '.join(unlock)}" if unlock else "")
    else:
        no_pairs = None
    report = {"documents": documents, "skipped_candidates": skipped, "relatedness": relatedness,
              "not_comparable_summary": sorted(groups.values(), key=lambda g: -g["count"]),
              "dropped_by_reasoning": [{"code": k, "count": v} for k, v in sorted(dropped.items())],
              "no_pairs_reason": no_pairs, "unlock": unlock, "case_score": case_score, "counts": counts,
              "reconciliation": checks}
    _explain(report, sids, names, facts, r, ncs, comps, findings, pen)
    return report


# ----------------------------------------------------------------------------------------------- explanation trail
_STOP = set("""about above after again against also among because been before being below between both could does
doing down during each from further have having here into itself just more most other over same should some such than
that their them then there these they this those through under until very were what when where which while will with
would your page pages total date name number amount value""".split())


def _norm_key(x: Optional[str]) -> str:
    import unicodedata
    return " ".join(unicodedata.normalize("NFKC", x or "").casefold().split())


def _doc_text(source_id: str) -> str:
    st = _SOURCES.get(source_id, {})
    out = []
    for _, p in sorted((st.get("pages") or {}).items()):
        for b in p.get("blocks", []):
            if b.get("raw_text"):
                out.append(b["raw_text"])
            for c in b.get("cells") or []:
                if c.get("raw_text"):
                    out.append(str(c["raw_text"]))
    return "\n".join(out)


def _content_words(text: str) -> set:
    return {w for w in re.findall(r"[a-z]{4,}", text.casefold()) if w not in _STOP}


def _doc_type_guess(text: str) -> Optional[dict]:
    """Keyword rules from platform_config.json "doc_types" ({label: [phrases]}). Best label by share of its phrases
    found in the document text; null when nothing matches."""
    try:
        from backend import platform_api
        rules = platform_api._file_settings().get("doc_types") or {}
    except Exception:
        rules = {}
    t = text.casefold()
    best = None
    for label, phrases in rules.items():
        hit = [ph for ph in phrases if ph.casefold() in t]
        if hit:
            score = len(hit) / len(phrases)
            if best is None or score > best["confidence"]:
                best = {"label": label, "confidence": round(score, 4), "matched": hit,
                        "method": "share of the type's keyword phrases found in the text (config doc_types)"}
    return best


def _explain(report: dict, sids: List[str], names: Dict[str, str], facts: List[dict], r: dict,
             ncs: List[dict], comps: List[dict], findings: List[dict], pen: dict) -> None:
    """Adds the reasoning trail: pairing funnel, attribute overlap, topic similarity, doc type, unlock hints,
    and an itemised case score. Computed from the same facts agent 16 used."""
    try:
        from backend import platform_api
        rcfg = ((platform_api._file_settings().get("agents") or {}).get("reasoning") or {})
    except Exception:
        rcfg = {}
    max_pairs = int(rcfg.get("max_pairs_per_group", 200))
    src_of = {f["fact_id"]: (f.get("evidence") or [{}])[0].get("source_id", "") for f in facts}
    dropped_ids = {w.get("ref_id") for w in r.get("warnings") or []
                   if w.get("code") in ("EVIDENCE_UNVERIFIED", "VALUE_NOT_IN_EVIDENCE", "CROSS_CASE_SOURCE",
                                         "NO_EVIDENCE", "FACT_SCHEMA_INVALID", "PROMPT_INJECTION_SUSPECTED")}
    verified = [f for f in facts if f["fact_id"] not in dropped_ids]
    named = [f for f in verified if (f.get("subject") or "").strip()]
    unnamed = [f for f in verified if not (f.get("subject") or "").strip()]

    groups: Dict[Tuple[str, str], List[dict]] = defaultdict(list)
    for f in named:
        groups[(_norm_key(f["subject"]), _norm_key(f["metric"]))].append(f)
    spanning = {k: g for k, g in groups.items() if len({src_of[f["fact_id"]] for f in g}) >= 2}
    cand = 0
    for g in spanning.values():
        n = sum(1 for i, a in enumerate(g) for b in g[i + 1:] if src_of[a["fact_id"]] != src_of[b["fact_id"]])
        cand += min(n, max_pairs)
    gate_fail: Dict[str, int] = defaultdict(int)
    named_nc = [n for n in ncs if _nc_reason_code(n) != "SUBJECT_NAMED"]
    for n in named_nc:
        gate_fail[_nc_reason_code(n)] += 1
    within = sum(1 for c in comps if c.get("within_tolerance"))

    def ex(fs: List[dict]) -> List[str]:
        return [f["fact_id"] for f in fs[:3]]

    one_doc = [k for k in groups if k not in spanning]
    funnel = [
        {"stage": "facts accepted (agent 15)", "unit": "facts", "count": len(facts), "note": "facts that passed the fact gate"},
        {"stage": "facts verified against stored evidence (agent 16)", "unit": "facts", "count": len(verified),
         "dropped": len(facts) - len(verified), "reason_code": "EVIDENCE_NOT_VERIFIED" if len(facts) != len(verified) else None,
         "example_ids": sorted(i for i in dropped_ids if i)[:3]},
        {"stage": "facts with a usable attribute", "unit": "facts", "count": sum(1 for f in verified if (f.get("metric") or "").strip()),
         "dropped": sum(1 for f in verified if not (f.get("metric") or "").strip()), "reason_code": None},
        {"stage": "facts with a named entity/subject", "unit": "facts", "count": len(named), "dropped": len(unnamed),
         "reason_code": "SUBJECT_MISSING" if unnamed else None, "example_ids": ex(unnamed),
         "note": "values are only compared for the same person or party"},
        {"stage": "attribute groups (entity + attribute)", "unit": "groups", "count": len(groups)},
        {"stage": "groups found in 2+ documents", "unit": "groups", "count": len(spanning), "dropped": len(one_doc),
         "reason_code": "ATTRIBUTE_IN_ONE_DOCUMENT" if one_doc else None,
         "example_ids": [f"{k[1]} ({k[0]})" for k in sorted(one_doc)[:3]]},
        {"stage": "candidate pairs", "unit": "pairs", "count": cand, "note": f"pairs of facts from different documents (cap {max_pairs} per group)"},
        {"stage": "pairs passing every gate (subject, currency, unit, frequency, period, basis, category)", "unit": "pairs",
         "count": len(comps), "dropped": len(named_nc),
         "reason_code": ", ".join(f"{k} x{v}" for k, v in sorted(gate_fail.items())) or None,
         "example_ids": [n.get("fact_ids") for n in named_nc[:3]]},
        {"stage": "findings (difference beyond tolerance)", "unit": "pairs", "count": len(findings), "dropped": within,
         "reason_code": "WITHIN_TOLERANCE" if within else None,
         "note": f"tolerance {rcfg.get('tolerance_abs', '?')} absolute and {rcfg.get('tolerance_pct', '?')}% (agents.reasoning)"},
    ]
    if unnamed:
        funnel.append({"stage": "unnamed facts paired by attribute only (always rejected)", "unit": "pairs",
                       "count": len(ncs) - len(named_nc), "reason_code": "SUBJECT_NAMED",
                       "note": "shown under Not comparable so they are not lost"})

    overlap: Dict[str, dict] = {}
    for f in facts:  # every accepted fact; ones agent 16 could not verify are marked
        k = _norm_key(f["metric"])
        o = overlap.setdefault(k, {"attribute_normalized": k, "entities": set(), "documents": defaultdict(list)})
        o["entities"].add(f.get("subject") or "(not named)")
        o["documents"][src_of[f["fact_id"]]].append(f["fact_id"])
    attribute_overlap = sorted(({"attribute_normalized": k, "entities": sorted(o["entities"]),
                                 "documents": [{"source_id": s, "filename": names.get(s, s), "fact_ids": ids}
                                               for s, ids in sorted(o["documents"].items())],
                                 "shared_across_documents": len(o["documents"]) >= 2,
                                 "unverified_fact_ids": sorted(i for d in o["documents"].values() for i in d if i in dropped_ids)}
                                for k, o in overlap.items()), key=lambda a: (not a["shared_across_documents"], a["attribute_normalized"]))

    # topic similarity + relation summary
    words = {s: _content_words(_doc_text(s)) for s in sids}
    for d in report["documents"]:
        d["doc_type_guess"] = _doc_type_guess(_doc_text(d["source_id"]))
    by_src: Dict[str, List[dict]] = defaultdict(list)
    for f in verified:
        by_src[src_of[f["fact_id"]]].append(f)
    for rel in report["relatedness"]:
        a, b = rel["source_a"], rel["source_b"]
        A, B = words.get(a, set()), words.get(b, set())
        sim = round(len(A & B) / len(A | B), 4) if A and B else None
        rel["topic_similarity"] = {"value": sim, "method": "Jaccard overlap of content words (4+ letters, common words removed)",
                                   "shared_terms": sorted(A & B)[:12]}
        ents = sorted({f["subject"] for f in by_src[a] if f.get("subject")} & {f["subject"] for f in by_src[b] if f.get("subject")})
        atts = sorted({_norm_key(f["metric"]) for f in by_src[a]} & {_norm_key(f["metric"]) for f in by_src[b]})
        pers = sorted({f"{f['period_start']} to {f.get('period_end') or ''}" for f in by_src[a] if f.get("period_start")}
                      & {f"{f['period_start']} to {f.get('period_end') or ''}" for f in by_src[b] if f.get("period_start")})
        rel.update(shared_entities=ents, shared_attributes_count=len(atts), shared_attributes=atts, shared_periods=pers)
        topic = ("not scored" if sim is None else
                 f"{'high' if sim >= 0.3 else 'some' if sim >= 0.1 else 'little'} topic overlap ({sim:.2f}"
                 + (f"; shared terms: {', '.join(rel['topic_similarity']['shared_terms'][:5])}" if A & B else "") + ")")
        rel["relation_summary"] = (
            f"{names.get(a, a)} and {names.get(b, b)}: {topic}; "
            f"{len(ents)} shared entit{'y' if len(ents) == 1 else 'ies'}{(' (' + ', '.join(ents[:3]) + ')') if ents else ''}, "
            f"{len(atts)} shared attribute(s){(' (' + ', '.join(atts[:3]) + ')') if atts else ''}, "
            f"{len(pers)} shared period(s). "
            + ("Comparable by value." if ents and atts else
               "Related by topic but not comparable by value." if sim is not None and sim >= 0.1 else
               "Not comparable by value."))

    hints = []
    if any(d["facts"]["accepted"] == 0 for d in report["documents"]):
        hints.append({"reason_code": "DOCUMENT_WITHOUT_FACTS",
                      "text": "; ".join(f"{d['filename']}: {d['facts'].get('zero_fact_reason') or 'no facts'}"
                                        for d in report["documents"] if d["facts"]["accepted"] == 0)})
    if unnamed:
        hints.append({"reason_code": "SUBJECT_MISSING",
                      "text": f"{len(unnamed)} fact(s) have no named entity; a name line such as 'Employee name:' or "
                              "'Account holder:' lets values be matched to the same person or party"})
    if groups and not spanning:
        hints.append({"reason_code": "ATTRIBUTE_IN_ONE_DOCUMENT",
                      "text": "no entity + attribute appears in two documents; the documents report different things"})
    if not any(a["shared_across_documents"] for a in attribute_overlap) and len(sids) > 1 and verified:
        hints.append({"reason_code": "NO_SHARED_ATTRIBUTE", "text": "no attribute appears in two documents"})
    for code, n in sorted(gate_fail.items()):
        hints.append({"reason_code": code, "text": f"{n} candidate pair(s) failed the '{code.lower()}' gate"})
    report["unlock_hints"] = hints
    report["unlock"] = [h["text"] for h in hints]
    report["funnel"] = funnel
    report["attribute_overlap"] = attribute_overlap

    cs = report["case_score"]
    if cs["status"] == "scored":
        items = (findings if findings else comps)
        cs["components"] = [{"name": (f"finding: {x['title'][:70]}" if findings else f"comparison: {x['metric']} ({x['subject']})"),
                             "value": x.get("confidence"),
                             "weight": round(1 / len(items), 4), "weight_config_key": None,
                             "detail": ("lower of the two facts' scores minus penalties "
                                        + ", ".join(f"{k} {v}" for k, v in pen.items()) if findings
                                        else "lower of the two facts' scores"),
                             "detail_config_key": "agents.reasoning.confidence_penalties" if findings else None}
                            for x in items]
        cs["reason_code"] = "FINDINGS" if findings else "COMPARISONS_WITHIN_TOLERANCE"
        cs["reason_text"] = (f"{len(findings)} finding(s) for review" if findings else
                             f"{len(comps)} comparison(s), none beyond tolerance")
    else:
        code = hints[0]["reason_code"] if hints else "NO_CANDIDATE_PAIRS"
        cs["components"] = []
        cs["reason_code"] = code
        cs["reason_text"] = ("no comparable pairs: " + hints[0]["text"]) if hints else "no comparable pairs"
        cs["reason"] = cs["reason_text"]
    report["counts"].update(attribute_groups=len(groups), groups_shared=len(spanning), candidate_pairs=cand)
    report["reconciliation"].append({"check": "candidate pairs from shared groups = pairs agent 16 evaluated (named)",
                                     "ok": cand == len(comps) + len(named_nc),
                                     "detail": f"{cand} vs {len(comps)} + {len(named_nc)}"})


@router.get("/cases/{case_id}/reasoning-report")
def get_reasoning_report(case_id: str):
    res = _store().get("pf_case_analysis", case_id)
    if not res or not res.get("report"):
        return _err(404, "NOT_FOUND", "This case has not been analysed yet")
    return _ok({"case_id": case_id, "analyzed_at": res.get("analyzed_at"), **res["report"]})


@router.get("/cases/{case_id}/analysis")
def get_case_analysis(case_id: str):
    res = _store().get("pf_case_analysis", case_id)
    return _ok(res) if res else _err(404, "NOT_FOUND", "This case has not been analysed yet")

# ----------------------------------------------------------------------------------------------- batch -> case analysis
def _start_batch_analysis(batch_id: str) -> None:
    """After every document of a batch is parsed, run fact normalization (15) and cross-document reasoning (16)
    over the batch's documents. A batch started without a case gets its own case, so its documents are compared
    with each other. State is kept in batch["analysis"]: pending -> running -> completed | failed | skipped."""
    created_case = None
    with _LOCK:
        b = _BATCHES.get(batch_id)
        if not b or (b.get("analysis") or {}).get("status") != "pending":
            return  # already started by another finishing source
        states = {s: _SOURCES.get(s, {}).get("status") for s in b["source_ids"]}
        if any(v not in ("completed", "failed") for v in states.values()):
            b["analysis"] = {"status": "pending", "case_id": b.get("case_id")}
            _save_batch(batch_id)
            return
        done = [s for s, v in states.items() if v == "completed"]
        failed = [s for s, v in states.items() if v == "failed"]
        case = _CASES.get(b.get("case_id") or "")
        if not done and not case:
            b["analysis"] = {"status": "skipped", "case_id": b.get("case_id"),
                             "reason": f"All {len(failed)} document(s) failed parsing; retry them to build the final parse."}
        else:
            if not case:
                cid = f"case_{uuid.uuid4().hex[:12]}"
                now = _now()
                _CASES[cid] = {"case_id": cid, "title": f"Batch {batch_id}", "status": "open", "created_at": now,
                               "updated_at": now, "source_ids": list(done), "metadata": {"batch_id": batch_id}}
                b["case_id"] = cid
                created_case = cid
            b["analysis"] = {"status": "running", "case_id": b["case_id"], "started_at": _now()}
            _ANALYSIS_POOL.submit(_run_batch_analysis, batch_id, b["case_id"])
    if created_case:
        _save_case(created_case)
        _sync_case(created_case)
    _save_batch(batch_id)


def _run_batch_analysis(batch_id: str, case_id: str) -> None:
    try:
        result = _analyze(case_id)
        final = result.get("final") or {}
        state = {"status": "failed" if final.get("verdict") == "failed" else "completed", "case_id": case_id,
                 "analyzed_at": result.get("analyzed_at"), "final": final}
        if final.get("error"):
            state["error"] = final["error"]
    except _AnalysisError as e:
        state = {"status": "failed", "case_id": case_id, "error": {"code": e.code, "message": e.message}}
    except Exception as exc:  # never leave the batch "running"
        state = {"status": "failed", "case_id": case_id, "error": _error_info(exc)}
    with _LOCK:
        b = _BATCHES.get(batch_id)
        if not b:
            return
        b["analysis"] = state
    _save_batch(batch_id)


@router.post("/batches/{batch_id}/analyze")
def analyze_batch(batch_id: str):
    """(Re)run cross-document reasoning for a finished batch."""
    with _LOCK:
        b = _BATCHES.get(batch_id)
        if not b:
            return _err(404, "NOT_FOUND", "Batch not found")
        if (b.get("analysis") or {}).get("status") == "running":
            return _err(409, "CONFLICT", "Cross-document reasoning is already running for this batch")
        b["analysis"] = {"status": "pending", "case_id": b.get("case_id")}
    _start_batch_analysis(batch_id)
    with _LOCK:
        return _ok(_batch_view(_BATCHES[batch_id]))
