"""Shared helpers for Person A's agents (01, 02, 03, 04, 08).  Owner: Person A.

Everything that touches the platform (store / auth / config / audit / crypto / notify) goes through the
small adapter functions in this file, so if Person C's real interfaces differ in naming, ONLY this file
needs a one-line fix.  Nothing here changes any contract shape.

Integration assumptions (also listed in the final hand-over notes):
  * store.get_file(source_id) -> plaintext original bytes (platform decrypts what agent 01 stored)
  * store.put(kind, id, obj) / store.get(kind, id) -> obj | None ; optional store.delete(kind, id)
  * binary artifacts written by Person A (originals, page images, rendered PDFs) are AES-GCM blobs made by
    common/crypto.encrypt(plaintext, aad) with aad = f"{tenant_id}:{object_id}".encode()
      kinds: "original"(id=source_id) "page_image"(id=f"{source_id}:{n}") "rendered_pdf"(id=source_id)
  * JSON artifacts (route, page_meta, native_text, ocr, spreadsheet, source_meta) go through store.put as
    plain objects (platform field-encryption applies).
"""
from __future__ import annotations

import contextvars
import hashlib
import importlib
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field


# ------------------------------------------------------------------------------ debug
def dbg(agent: str, step: str, msg: str = "") -> None:
    """Debug print for every step. Disable with AGENT_DEBUG=0. Never pass secrets/paths here."""
    if os.getenv("AGENT_DEBUG", "1") != "0":
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        print(f"{ts} [DEBUG][{agent}] {step} | {msg}", flush=True)


# ------------------------------------------------------------------------------ errors / warnings
class Code:
    INVALID_INPUT = "INVALID_INPUT"
    NOT_FOUND = "NOT_FOUND"
    UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"
    PASSWORD_REQUIRED = "PASSWORD_REQUIRED"
    CORRUPT_FILE = "CORRUPT_FILE"
    TOO_LARGE = "TOO_LARGE"
    FORBIDDEN = "FORBIDDEN"
    ENGINE_FAILED = "ENGINE_FAILED"
    TIMEOUT = "TIMEOUT"
    CONFLICT = "CONFLICT"


HTTP_STATUS = {Code.INVALID_INPUT: 400, Code.NOT_FOUND: 404, Code.UNSUPPORTED_FORMAT: 415,
               Code.PASSWORD_REQUIRED: 422, Code.CORRUPT_FILE: 422, Code.TOO_LARGE: 413, Code.FORBIDDEN: 403,
               Code.ENGINE_FAILED: 500, Code.TIMEOUT: 504, Code.CONFLICT: 409}


class AgentError(Exception):
    def __init__(self, code: str, message: str, details: Optional[dict] = None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


class WarningItem(BaseModel):
    code: str
    message: str
    page_number: Optional[int] = None
    details: Optional[Dict[str, Any]] = None


class Location(BaseModel):
    """bbox = [x1,y1,x2,y2] in page-image pixels, origin top-left (pixel_top_left)."""
    source_id: str
    page_id: str
    bbox: Optional[List[float]] = None
    coord_system: str = "pixel_top_left"
    page_width: Optional[int] = None
    page_height: Optional[int] = None
    bbox_unavailable_reason: Optional[str] = None
    extraction_method: str


# ------------------------------------------------------------------------------ settings (config file)
_DEFAULTS: Dict[str, Any] = {
    "security": {"encrypt_artifacts": True},
    "limits_fallback": {"max_file_size_bytes": 100 * 1024 * 1024, "max_pages": 2000, "max_cells_per_sheet": 200000},
    "validation": {"max_compression_ratio": 100, "max_zip_entries": 20000, "max_zip_depth": 3,
                   "max_uncompressed_bytes": 1_000_000_000, "max_nested_read_bytes": 50_000_000,
                   "max_filename_len": 120, "pdf_scan_max_objects": 300000, "min_printable_ratio": 0.85,
                   "image_load_check_max_pixels": 40_000_000, "max_image_pixels": 120_000_000,
                   "read_chunk_bytes": 1_048_576},
    "render": {"dpi": 200, "max_render_pixels": 30_000_000, "prewarm_max_pages": 60, "lo_timeout_s": 120,
               "lo_max_concurrency": 2, "doc_cache_size": 4, "doc_cache_ttl_s": 600},
    "router": {"min_text_chars": 20, "scanned_image_ratio": 0.80, "mixed_image_ratio": 0.25,
               "blank_image_ratio": 0.01, "blank_stddev": 4.0, "osd_enabled": True, "osd_max_pages": 24,
               "osd_workers": 4, "osd_min_confidence": 2.0, "osd_dpi": 150, "max_eml_attachments": 50,
               "min_inline_attachment_bytes": 4096, "timeout_s": 300},
    "native_text": {"min_chars": 5, "max_garbage_ratio": 0.15, "garbage_penalty": 0.6, "tounicode_penalty": 0.15,
                    "tiny_font_pt": 1.5},
    "ocr": {"engines": ["paddleocr", "tesseract", "rapidocr"], "timeout_s": 90, "psm_page": 3, "psm_region": 6, "psm_sparse": 11,
            "default_langs": "eng", "retry_conf_threshold": 0.80, "deskew_min_deg": 0.3, "deskew_max_deg": 5.0,
            "region_pad_px": 8, "region_min_height_px": 96, "region_max_upscale": 3.0, "handwriting_max_lines": 40,
            "handwriting_cv_threshold": 0.85, "handwriting_low_conf_fraction": 0.4,
            "workers": max(2, (os.cpu_count() or 2) - 1),  # OCR runs in parallel across pages
            "script_langs": {
                "Latin": {"tesseract": "eng", "paddle": "en"}, "Devanagari": {"tesseract": "hin+eng", "paddle": "devanagari"},
                "Bengali": {"tesseract": "ben+eng", "paddle": "bn"}, "Gujarati": {"tesseract": "guj+eng", "paddle": "gu"},
                "Odia": {"tesseract": "ori+eng", "paddle": "en"}, "Tamil": {"tesseract": "tam+eng", "paddle": "ta"},
                "Telugu": {"tesseract": "tel+eng", "paddle": "te"}, "Kannada": {"tesseract": "kan+eng", "paddle": "ka"},
                "Malayalam": {"tesseract": "mal+eng", "paddle": "en"}, "Arabic": {"tesseract": "ara+eng", "paddle": "ar"},
                "Cyrillic": {"tesseract": "rus+eng", "paddle": "cyrillic"}, "Greek": {"tesseract": "ell+eng", "paddle": "el"},
                "Hebrew": {"tesseract": "heb+eng", "paddle": "he"}, "Thai": {"tesseract": "tha+eng", "paddle": "th"},
                "Han": {"tesseract": "chi_sim+eng", "paddle": "ch"}, "Japanese": {"tesseract": "jpn+eng", "paddle": "japan"},
                "Hangul": {"tesseract": "kor+eng", "paddle": "korean"}}},
    "spreadsheet": {"full_mode_max_xml_bytes": 60_000_000, "timeout_s": 120, "table_min_rows": 2, "table_min_cols": 2},
}
_SETTINGS: Optional[Dict[str, Any]] = None
_SETTINGS_LOCK = threading.Lock()


def _deep_merge(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        out[k] = _deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def S(path: str, default: Any = None) -> Any:
    """Threshold lookup: S('router.min_text_chars'). Override with a JSON file via AGENT_A_SETTINGS_FILE."""
    global _SETTINGS
    with _SETTINGS_LOCK:
        if _SETTINGS is None:
            cfg = _DEFAULTS
            fp = os.getenv("AGENT_A_SETTINGS_FILE")
            if fp and os.path.exists(fp):
                try:
                    with open(fp, "r", encoding="utf-8") as fh:
                        cfg = _deep_merge(_DEFAULTS, json.load(fh))
                except Exception as exc:
                    dbg("support", "settings", f"override file ignored ({type(exc).__name__})")
            _SETTINGS = cfg
    cur: Any = _SETTINGS
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def reload_settings() -> None:
    global _SETTINGS
    with _SETTINGS_LOCK:
        _SETTINGS = None


# ------------------------------------------------------------------------------ platform adapters
def _common(name: str):
    return importlib.import_module(f"backend.common.{name}")


_PCFG_CACHE: Tuple[float, dict] = (0.0, {})


def platform_config() -> dict:
    """Read /config via common.config (cached 15 s). Tries the usual accessor names."""
    global _PCFG_CACHE
    ts, val = _PCFG_CACHE
    if time.time() - ts < 15 and val:
        return val
    cfg: Any = None
    try:
        m = _common("config")
        for name in ("get_config", "load", "get_all", "current"):
            fn = getattr(m, name, None)
            if callable(fn):
                cfg = fn()
                break
        if cfg is None:
            cfg = getattr(m, "CONFIG", None) or getattr(m, "config", None)
        if hasattr(cfg, "model_dump"):
            cfg = cfg.model_dump()
    except Exception as exc:
        dbg("support", "config", f"platform config unavailable ({type(exc).__name__}); using fallbacks")
    cfg = cfg if isinstance(cfg, dict) else {}
    _PCFG_CACHE = (time.time(), cfg)
    return cfg


def limit(names: Tuple[str, ...], fallback_key: str) -> int:
    """Limit from /config.limits (any alias in `names`, *_mb aliases are converted) else fallback settings."""
    lim = platform_config().get("limits", {}) or {}
    for n in names:
        if n in lim and lim[n] is not None:
            v = float(lim[n])
            return int(v * 1024 * 1024) if n.endswith("_mb") else int(v)
    return int(S(f"limits_fallback.{fallback_key}"))


def current_user() -> dict:
    try:
        u = _common("auth").current_user()
    except AgentError:
        raise
    except Exception as exc:
        raise AgentError(Code.FORBIDDEN, "Not authenticated") from exc
    if u is None:
        raise AgentError(Code.FORBIDDEN, "Not authenticated")
    if not isinstance(u, dict):
        u = {k: getattr(u, k) for k in ("user_id", "role", "capabilities", "tenant_id") if hasattr(u, k)}
    u = dict(u)
    u["tenant_id"] = u.get("tenant_id") or "default"
    u.setdefault("role", "user")
    u.setdefault("capabilities", [])
    return u


REQUEST_ID: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("request_id", default=None)
CLIENT_INFO: contextvars.ContextVar[dict] = contextvars.ContextVar("client_info", default={})


def request_id() -> str:
    rid = REQUEST_ID.get()
    if not rid:
        rid = uuid.uuid4().hex
        REQUEST_ID.set(rid)
    return rid


_SECRET_KEYS = ("password", "passwd", "secret", "token", "authorization", "cookie")


def _redact(obj: Any, depth: int = 0) -> Any:
    if isinstance(obj, dict):
        return {k: ("[redacted]" if any(s in str(k).lower() for s in _SECRET_KEYS) else _redact(v, depth + 1))
                for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_redact(v, depth + 1) for v in list(obj)[:50]]
    if isinstance(obj, str) and len(obj) > 300:
        return obj[:300] + "…"
    return obj


def audit_event(event_type: str, object_type: str, object_id: str, outcome: str = "success",
                details: Optional[dict] = None, *, user: Optional[dict] = None, fail_closed: bool = False) -> bool:
    """audit.append wrapper. fail_closed=True -> AgentError(ENGINE_FAILED) when the audit write fails."""
    try:
        u = user or current_user()
        ci = CLIENT_INFO.get() or {}
        ev = {"event_id": str(uuid.uuid4()), "actor_id": u.get("user_id"), "actor_role": u.get("role"),
              "tenant_id": u.get("tenant_id"), "request_id": request_id(), "event_type": event_type,
              "object_type": object_type, "object_id": object_id, "outcome": outcome,
              "details": _redact(details or {}), "ip_masked": ci.get("ip_masked"),
              "user_agent_family": ci.get("ua_family")}
        _common("audit").append(ev)
        dbg("audit", event_type, f"{outcome} object={object_id[:24]}")
        return True
    except Exception as exc:
        dbg("audit", event_type, f"WRITE FAILED ({type(exc).__name__})")
        if fail_closed:
            raise AgentError(Code.ENGINE_FAILED, "Audit write failed; action rolled back") from exc
        return False


def store_put(kind: str, oid: str, obj: Any) -> None:
    _common("store").put(kind, oid, obj)


def store_get(kind: str, oid: str) -> Any:
    try:
        return _common("store").get(kind, oid)
    except KeyError:
        return None


def store_delete(kind: str, oid: str) -> None:
    fn = getattr(_common("store"), "delete", None)
    if callable(fn):
        try:
            fn(kind, oid)
        except Exception:
            pass


def commit(puts: List[Tuple[str, str, Any]], audit_kwargs: dict, user: dict) -> None:
    """Persist artifacts then audit (fail closed). If the audit write fails everything is rolled back."""
    done: List[Tuple[str, str]] = []
    try:
        for kind, oid, obj in puts:
            store_put(kind, oid, obj)
            done.append((kind, oid))
    except Exception as exc:
        for k, i in done:
            store_delete(k, i)
        raise AgentError(Code.ENGINE_FAILED, "Could not persist results") from exc
    try:
        audit_event(user=user, fail_closed=True, **audit_kwargs)
    except AgentError:
        for k, i in done:
            store_delete(k, i)
        raise


def _aad(tenant: str, oid: str) -> bytes:
    return f"{tenant}:{oid}".encode("utf-8")


def put_blob(kind: str, oid: str, data: bytes, tenant: str) -> None:
    if S("security.encrypt_artifacts", True):
        data = _common("crypto").encrypt(data, _aad(tenant, oid))
    store_put(kind, oid, data)


def get_blob(kind: str, oid: str, tenant: str) -> Optional[bytes]:
    blob = store_get(kind, oid)
    if blob is None:
        return None
    if S("security.encrypt_artifacts", True):
        return _common("crypto").decrypt(blob, _aad(tenant, oid))
    return blob


def get_original_bytes(source_id: str) -> bytes:
    try:
        data = _common("store").get_file(source_id)
    except KeyError:
        data = None
    if data is None:
        raise AgentError(Code.NOT_FOUND, "Source not found")
    return bytes(data)


# ------------------------------------------------------------------------------ ids / geometry
def unit_id(source_id: str, page_number: int) -> str:
    return "u_" + hashlib.sha256(f"{source_id}:{page_number}".encode()).hexdigest()[:16]


def page_id_for(source_id: str, page_number: int) -> str:
    """page_id == unit_id (documented in README / hand-over)."""
    return unit_id(source_id, page_number)


def page_geometry(width_pt: float, height_pt: float) -> Tuple[float, int, int]:
    """-> (scale, width_px, height_px). scale = dpi/72, reduced when the page would exceed max_render_pixels."""
    scale = float(S("render.dpi")) / 72.0
    px = (width_pt * scale) * (height_pt * scale)
    cap = float(S("render.max_render_pixels"))
    if px > cap:
        scale *= math.sqrt(cap / px)
    return scale, max(1, math.ceil(width_pt * scale - 1e-3)), max(1, math.ceil(height_pt * scale - 1e-3))


def clamp_bbox(b: List[float], w: float, h: float) -> List[float]:
    x1, y1, x2, y2 = b
    x1, x2 = sorted((min(max(x1, 0.0), w), min(max(x2, 0.0), w)))
    y1, y2 = sorted((min(max(y1, 0.0), h), min(max(y2, 0.0), h)))
    return [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)]


_SCRIPT_RANGES = [
    ("Latin", 0x0041, 0x024F), ("Latin", 0x1E00, 0x1EFF), ("Greek", 0x0370, 0x03FF), ("Cyrillic", 0x0400, 0x04FF),
    ("Hebrew", 0x0590, 0x05FF), ("Arabic", 0x0600, 0x06FF), ("Arabic", 0x0750, 0x077F), ("Devanagari", 0x0900, 0x097F),
    ("Bengali", 0x0980, 0x09FF), ("Gujarati", 0x0A80, 0x0AFF), ("Odia", 0x0B00, 0x0B7F), ("Tamil", 0x0B80, 0x0BFF),
    ("Telugu", 0x0C00, 0x0C7F), ("Kannada", 0x0C80, 0x0CFF), ("Malayalam", 0x0D00, 0x0D7F), ("Thai", 0x0E00, 0x0E7F),
    ("Han", 0x4E00, 0x9FFF), ("Japanese", 0x3040, 0x30FF), ("Hangul", 0xAC00, 0xD7AF),
]


def dominant_script(text: str) -> Optional[str]:
    counts: Dict[str, int] = {}
    for ch in text[:4000]:
        o = ord(ch)
        if o < 0x41:
            continue
        for name, lo, hi in _SCRIPT_RANGES:
            if lo <= o <= hi:
                counts[name] = counts.get(name, 0) + 1
                break
    return max(counts, key=counts.get) if counts else None


OSD_SCRIPT_ALIASES = {"Korean": "Hangul", "Hangul": "Hangul", "Latin": "Latin", "Cyrillic": "Cyrillic", "Arabic": "Arabic",
                      "Han": "Han", "HanS": "Han", "HanT": "Han", "Japanese": "Japanese", "Greek": "Greek",
                      "Hebrew": "Hebrew", "Devanagari": "Devanagari", "Bengali": "Bengali", "Tamil": "Tamil",
                      "Telugu": "Telugu", "Kannada": "Kannada", "Malayalam": "Malayalam", "Thai": "Thai",
                      "Gujarati": "Gujarati", "Oriya": "Odia"}


# ------------------------------------------------------------------------------ source meta / kinds
MIME_PDF = "application/pdf"
MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MIME_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
IMAGE_MIMES = {"image/png", "image/jpeg", "image/tiff", "image/bmp", "image/webp", "image/gif"}


def kind_of(mime: str) -> str:
    if mime == MIME_PDF:
        return "pdf"
    if mime in IMAGE_MIMES:
        return "image"
    return {MIME_DOCX: "docx", MIME_PPTX: "pptx", MIME_XLSX: "xlsx", "text/csv": "csv",
            "text/tab-separated-values": "csv", "message/rfc822": "eml", "text/html": "html"}.get(mime, "unknown")


def load_meta(source_id: str, user: dict, require_accepted: bool = True) -> dict:
    if not source_id or not isinstance(source_id, str):
        raise AgentError(Code.INVALID_INPUT, "source_id is required")
    meta = store_get("source_meta", source_id)
    if not meta or meta.get("tenant_id") != user["tenant_id"]:
        raise AgentError(Code.NOT_FOUND, "Source not found")
    if require_accepted and meta.get("status") != "accepted":
        raise AgentError(Code.CONFLICT, "Source was rejected by file validation", {"status": meta.get("status")})
    return meta


def load_agent(module_name: str):
    """Import a numbered agent module (e.g. '01_file_validation') - digits prevent a plain import statement."""
    return importlib.import_module(f"backend.agents.{module_name}")


# ------------------------------------------------------------------------------ PDF doc cache (huge win: 03 is called per page)
class _DocEntry:
    def __init__(self, doc: Any):
        self.doc, self.lock, self.expires = doc, threading.RLock(), time.time() + float(S("render.doc_cache_ttl_s"))


_DOCS: "OrderedDict[str, _DocEntry]" = OrderedDict()
_DOCS_LOCK = threading.Lock()


@contextmanager
def open_pdf(cache_key: str, loader: Callable[[], bytes]):
    """Yield a locked fitz.Document, cached (LRU) so repeated per-page calls do not re-read/re-parse the file."""
    import fitz  # PyMuPDF
    entry: Optional[_DocEntry] = None
    with _DOCS_LOCK:
        e = _DOCS.get(cache_key)
        if e is not None and e.expires > time.time():
            _DOCS.move_to_end(cache_key)
            entry = e
    if entry is None:
        data = loader()
        try:
            doc = fitz.open(stream=data, filetype="pdf")
        except Exception as exc:
            raise AgentError(Code.CORRUPT_FILE, "PDF could not be opened") from exc
        if doc.needs_pass:
            doc.close()
            raise AgentError(Code.PASSWORD_REQUIRED, "PDF is password protected")
        new = _DocEntry(doc)
        evicted: List[_DocEntry] = []
        with _DOCS_LOCK:
            cur = _DOCS.get(cache_key)
            if cur is not None and cur.expires > time.time():
                evicted.append(new)  # lost the race -> use the existing one
                entry = cur
            else:
                if cur is not None:
                    evicted.append(cur)
                _DOCS[cache_key] = new
                entry = new
            while len(_DOCS) > int(S("render.doc_cache_size")):
                _, old = _DOCS.popitem(last=False)
                evicted.append(old)
        for old in evicted:
            if old is not entry:
                with old.lock:
                    try:
                        old.doc.close()
                    except Exception:
                        pass
        dbg("support", "pdf_cache", f"opened document pages={entry.doc.page_count}")
    with entry.lock:
        yield entry.doc


def clear_doc_cache() -> None:
    with _DOCS_LOCK:
        items = list(_DOCS.values())
        _DOCS.clear()
    for e in items:
        with e.lock:
            try:
                e.doc.close()
            except Exception:
                pass


# ------------------------------------------------------------------------------ LibreOffice rendering (docx/pptx -> pdf)
_LO_SEM: Optional[threading.Semaphore] = None
_CONV_LOCKS: Dict[str, threading.Lock] = {}
_CONV_LOCKS_GUARD = threading.Lock()


def _convert_with_libreoffice(data: bytes, ext: str) -> bytes:
    global _LO_SEM
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise AgentError(Code.ENGINE_FAILED, "LibreOffice is not installed on the server")
    if _LO_SEM is None:
        _LO_SEM = threading.Semaphore(int(S("render.lo_max_concurrency")))
    with _LO_SEM, tempfile.TemporaryDirectory(prefix="pf_lo_") as tmp:
        src = os.path.join(tmp, f"input.{ext}")
        with open(src, "wb") as fh:
            fh.write(data)
        profile = os.path.join(tmp, "profile")
        cmd = [exe, "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
               f"-env:UserInstallation=file://{profile}", "--convert-to", "pdf", "--outdir", tmp, src]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=float(S("render.lo_timeout_s")),
                           env={**os.environ, "HOME": tmp})
        except subprocess.TimeoutExpired as exc:
            raise AgentError(Code.TIMEOUT, "Document rendering timed out") from exc
        except Exception as exc:
            raise AgentError(Code.ENGINE_FAILED, "Document rendering failed") from exc
        out = os.path.join(tmp, "input.pdf")
        if not os.path.exists(out):
            raise AgentError(Code.ENGINE_FAILED, "Document rendering produced no output")
        with open(out, "rb") as fh:
            return fh.read()


def rendered_pdf_bytes(source_id: str, meta: dict) -> bytes:
    """Cached PDF rendition of a docx/pptx source (page images + native text positions come from it)."""
    tenant = meta["tenant_id"]
    cached = get_blob("rendered_pdf", source_id, tenant)
    if cached:
        return cached
    with _CONV_LOCKS_GUARD:
        lock = _CONV_LOCKS.setdefault(source_id, threading.Lock())
    with lock:
        cached = get_blob("rendered_pdf", source_id, tenant)
        if cached:
            return cached
        ext = "docx" if kind_of(meta["detected_mime"]) == "docx" else "pptx"
        dbg("support", "render", f"LibreOffice convert {ext}")
        pdf = _convert_with_libreoffice(get_original_bytes(source_id), ext)
        put_blob("rendered_pdf", source_id, pdf, tenant)
        return pdf


def pdf_loader(source_id: str, meta: dict) -> Tuple[str, Callable[[], bytes]]:
    k = kind_of(meta["detected_mime"])
    if k == "pdf":
        return f"{meta['tenant_id']}:{source_id}:orig", lambda: get_original_bytes(source_id)
    if k in ("docx", "pptx"):
        return f"{meta['tenant_id']}:{source_id}:rendered", lambda: rendered_pdf_bytes(source_id, meta)
    raise AgentError(Code.UNSUPPORTED_FORMAT, "Source has no page rendition")


def render_pdf_page_png(page: Any, scale: float) -> Tuple[bytes, int, int]:
    import fitz
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    return pix.tobytes("png"), pix.width, pix.height


def normalized_image_png(data: bytes) -> Tuple[bytes, int, int, float]:
    """Image source -> upright RGB PNG (EXIF applied, pixel-capped). -> (png, w, h, scale_applied)."""
    from PIL import Image, ImageOps
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    scale = 1.0
    cap = float(S("render.max_render_pixels"))
    if im.width * im.height > cap:
        scale = math.sqrt(cap / (im.width * im.height))
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG", compress_level=3)
    return buf.getvalue(), im.width, im.height, scale


def get_page_image(source_id: str, page_number: int, meta: dict) -> Tuple[bytes, int, int]:
    """Cached page image (PNG) + pixel size. Renders on a miss and caches it for every other agent."""
    from PIL import Image
    tenant = meta["tenant_id"]
    oid = f"{source_id}:{page_number}"
    png = get_blob("page_image", oid, tenant)
    if png:
        with Image.open(io.BytesIO(png)) as im:
            return png, im.width, im.height
    k = kind_of(meta["detected_mime"])
    if k == "image":
        if page_number != 1:
            raise AgentError(Code.INVALID_INPUT, "Image sources have a single page")
        png, w, h, _ = normalized_image_png(get_original_bytes(source_id))
    elif k in ("pdf", "docx", "pptx"):
        key, loader = pdf_loader(source_id, meta)
        with open_pdf(key, loader) as doc:
            if not 1 <= page_number <= doc.page_count:
                raise AgentError(Code.INVALID_INPUT, "page_number out of range", {"page_count": doc.page_count})
            page = doc.load_page(page_number - 1)
            scale, _, _ = page_geometry(page.rect.width, page.rect.height)
            png, w, h = render_pdf_page_png(page, scale)
    else:
        raise AgentError(Code.UNSUPPORTED_FORMAT, "Source has no page images")
    put_blob("page_image", oid, png, tenant)
    dbg("support", "page_image", f"rendered+cached page={page_number} {w}x{h}")
    return png, w, h


# ------------------------------------------------------------------------------ API envelope
def ok_envelope(data: Any, rid: str) -> dict:
    if hasattr(data, "model_dump"):
        data = data.model_dump(mode="json")
    return {"ok": True, "data": data, "request_id": rid}


def err_envelope(code: str, message: str, rid: str, details: Optional[dict] = None) -> dict:
    e: Dict[str, Any] = {"code": code, "message": message}
    if details:
        e["details"] = details
    return {"ok": False, "error": e, "request_id": rid}


def endpoint(request: Any, fn: Callable[[], Any]):
    """Run `fn` and wrap its result/exception in the standard envelope (sync, executed in the threadpool)."""
    from fastapi.responses import JSONResponse
    from pydantic import ValidationError
    rid = (request.headers.get("x-request-id") if request is not None else None) or uuid.uuid4().hex
    REQUEST_ID.set(rid)
    try:
        host = request.client.host if request is not None and request.client else None
        ua = request.headers.get("user-agent") if request is not None else None
        from backend.common import notify
        CLIENT_INFO.set({"ip_masked": notify.mask_ip(host), "ua_family": notify.ua_family(ua)})
    except Exception:
        CLIENT_INFO.set({})
    try:
        return JSONResponse(ok_envelope(fn(), rid), status_code=200)
    except AgentError as e:
        dbg("endpoint", "error", f"{e.code}: {e.message}")
        return JSONResponse(err_envelope(e.code, e.message, rid, e.details), status_code=HTTP_STATUS.get(e.code, 500))
    except ValidationError as e:
        try:
            det = {"errors": e.errors(include_input=False, include_url=False)}
        except TypeError:
            det = {"errors": [{"loc": x.get("loc"), "msg": x.get("msg")} for x in e.errors()]}
        return JSONResponse(err_envelope(Code.INVALID_INPUT, "Invalid request", rid, json.loads(json.dumps(det, default=str))), status_code=400)
    except Exception as e:  # never leak internals / paths
        dbg("endpoint", "UNEXPECTED", f"{type(e).__name__}\n{traceback.format_exc()}")
        return JSONResponse(err_envelope(Code.ENGINE_FAILED, "Internal processing error", rid), status_code=500)


class Timer:
    def __init__(self) -> None:
        self.t0 = time.perf_counter()

    def ms(self) -> int:
        return int((time.perf_counter() - self.t0) * 1000)