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
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

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
        "location": dict(loc), "confidence": 1.0, "extraction_method": "spreadsheet", "needs_review": False,
        "warnings": [], "n_rows": max(r for r, _, _ in parsed) - r0 + 1, "n_cols": max(c for _, c, _ in parsed) - c0 + 1,
        "cells": cells,
    }


def _process_unit(source_id: str, kind: str, unit: dict, page_meta: dict, threshold: float) -> dict:
    """Runs the extractors one unit needs and returns a PageUnit (without image_url, added when served)."""
    n = int(unit["page_number"])
    page_id = unit["unit_id"]
    pclass = unit.get("page_class", "native_text")
    pm = (page_meta.get("pages") or {}).get(str(n), {}) or {}
    warnings: List[dict] = []
    blocks: List[dict] = []
    methods: List[str] = []

    if kind not in ("xlsx", "csv") and pclass != "blank":
        if pclass in NATIVE_CLASSES or kind not in PAGINATED_KINDS:
            try:
                a03 = _agent("03_native_text")
                out = a03.run(a03.NativeTextInput(source_id=source_id, page_number=n)).model_dump(mode="json")
                blocks += _text_blocks(out.get("spans") or [], source_id, page_id, "native_text", len(blocks), threshold)
                warnings += [_warn(w, source_id) for w in out.get("warnings") or []]
                methods.append("native_text")
            except Exception as exc:
                warnings.append({"code": "NATIVE_TEXT_FAILED", "message": _error_info(exc)["message"], "source_id": source_id})
        if kind in PAGINATED_KINDS and pclass in OCR_CLASSES:
            try:
                a04 = _agent("04_ocr")
                out = a04.run(a04.OcrInput(source_id=source_id, page_number=n)).model_dump(mode="json")
                blocks += _text_blocks(out.get("lines") or [], source_id, page_id, "ocr", len(blocks), threshold)
                warnings += [_warn(w, source_id) for w in out.get("warnings") or []]
                methods.append(f"ocr:{out.get('engine')}")
            except Exception as exc:
                warnings.append({"code": "OCR_FAILED", "message": _error_info(exc)["message"], "source_id": source_id})

    width = int(pm.get("width_px") or 0)
    height = int(pm.get("height_px") or 0)
    if not width and blocks:
        width = max((b["location"]["page_width"] for b in blocks), default=0)
        height = max((b["location"]["page_height"] for b in blocks), default=0)
    rotation = int(pm.get("rotation_correction_cw") or pm.get("declared_rotation") or 0)
    blocks = _sort_reading(blocks)
    return {
        "page_id": page_id, "source_id": source_id, "unit_id": page_id, "page_number": n,
        "width": width, "height": height, "rotation": rotation, "layout_class": pclass,
        # Reading order here is geometric (top-to-bottom, left-to-right); agent 06 is not running.
        "reading_order_confidence": 1.0 if blocks else 0.0,
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


# ----------------------------------------------------------------------------------------------- execution
def _set_source(source_id: str, **kw: Any) -> None:
    with _LOCK:
        _SOURCES.setdefault(source_id, {}).update(kw)


def _run_source(batch_id: str, source_id: str) -> None:
    support = _support()
    started = time.time()
    _set_source(source_id, status="running", stage="format_router", error=None, units_total=0, units_done=0,
                pages={}, warnings=[], started_at=started, finished_at=None, batch_id=batch_id)
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
        _set_source(source_id, status="completed", stage="completed", pages=page_map, warnings=warnings,
                    finished_at=time.time())
    except Exception as exc:
        _set_source(source_id, status="failed", stage="failed", error=_error_info(exc), finished_at=time.time())
    finally:
        _refresh_batch(batch_id)


def _refresh_batch(batch_id: str) -> None:
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


def _batch_view(b: dict) -> dict:
    out = {k: b[k] for k in ("batch_id", "created_at", "status", "source_ids", "progress_percent", "stage",
                             "sources_summary") if k in b}
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
            "case_id": body.case_id, "mode": body.mode, "output_formats": body.output_formats,
            "sources_summary": {"total": len(source_ids), "completed": 0, "failed": 0},
        }
        _JOBS[job_id] = batch_id
        for s in source_ids:
            _SOURCES[s] = {"status": "queued", "stage": "queued", "batch_id": batch_id}
        if body.case_id:
            case = _CASES[body.case_id]
            case["source_ids"] = list(dict.fromkeys(case["source_ids"] + source_ids))
            case["updated_at"] = _now()
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
        if body.source_id not in b["source_ids"]:
            return _err(400, "INVALID_INPUT", "Source is not part of this batch")
        if _SOURCES.get(body.source_id, {}).get("status") == "running":
            return _err(409, "CONFLICT", "Source is already running")
        _SOURCES[body.source_id] = {"status": "queued", "stage": "queued", "batch_id": batch_id}
        b.pop("finished_at", None)
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