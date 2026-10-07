"""Agent 01 - File Validation  (POST /agents/file-validation, multipart).  Owner: Person A.

README
  Inputs : multipart {file, options?:{password?}}  (or form field `password`). run() takes a binary stream.
  Outputs: {source_id, sanitized_filename, sha256, detected_mime, size_bytes, page_count?, status, error?,
            duplicate_of?, warnings[]}.  Rejected files still get a source_id (metadata only, no bytes stored).
  Algorithm (sequential, one debug line per step):
    1 stream-read in chunks while hashing (SHA-256) and enforcing /config.limits size -> TOO_LARGE
    2 sanitize filename (NFKC, basename, no control/bidi chars, length cap, reserved names, double-ext guard)
    3 detect MIME from magic bytes (never from extension); extension/content mismatch -> UNSUPPORTED_FORMAT
    4 safety: executables, OOXML macros/ActiveX, zip bombs (ratio/entries/depth/size), zip path traversal,
      image decompression bombs, PDF /Launch (reject) and /JavaScript (accepted, flagged in audit/meta only)
    5 encrypted PDF / OOXML: password -> PASSWORD_REQUIRED unless correct; decrypted copy is stored
    6 page count (pikepdf / zip metadata / 1 for images); limit /config.limits.max_pages -> TOO_LARGE
    7 duplicate detection by (tenant, sha256) -> duplicate_of (still accepted)
    8 encrypt original (AES-256-GCM via common/crypto), persist, audit file_uploaded (fail closed);
      rejections -> audit file_rejected + ntfy for malware/macro/bomb categories
  Libraries: pikepdf, PyMuPDF (fallback), Pillow, zipfile, charset-normalizer (optional), msoffcrypto-tool (optional).
  Limits : declared zip sizes are trusted for bomb checks (actual parsing later is bounded by the same limits);
           legacy OLE Office (.doc/.xls/.ppt) is rejected as UNSUPPORTED_FORMAT; passwords are memory-only.
"""
from __future__ import annotations

import csv
import email
import hashlib
import io
import re
import time
import unicodedata
import uuid
import zipfile
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, ConfigDict, SecretStr

from backend.agents._support import (AgentError, Code, MIME_DOCX, MIME_PDF, MIME_PPTX, MIME_XLSX, IMAGE_MIMES, S,
                                     Timer, WarningItem, audit_event, commit, current_user, dbg, endpoint, limit,
                                     put_blob, store_get)

AGENT = "01-file-validation"

# ---------------------------------------------------------------------------- models
class FileValidationOptions(BaseModel):
    password: Optional[SecretStr] = None


class FileValidationInput(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    filename: str
    stream: Any  # binary file-like object
    options: Optional[FileValidationOptions] = None
    origin: Optional[Dict[str, Any]] = None  # internal only (agent 02 registers e-mail attachments); not on the HTTP API


class ErrorInfo(BaseModel):
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None


class FileValidationOutput(BaseModel):
    source_id: str
    sanitized_filename: str
    sha256: str
    detected_mime: str
    size_bytes: int
    page_count: Optional[int] = None
    status: Literal["accepted", "rejected"]
    error: Optional[ErrorInfo] = None
    duplicate_of: Optional[str] = None
    warnings: List[WarningItem] = []


class _Reject(Exception):
    def __init__(self, code: str, message: str, category: Optional[str] = None, notify: bool = False,
                 details: Optional[dict] = None):
        super().__init__(message)
        self.code, self.message, self.category, self.notify, self.details = code, message, category, notify, details


# ---------------------------------------------------------------------------- constants
DANGEROUS_EXT = {"exe", "dll", "bat", "cmd", "com", "scr", "pif", "msi", "msp", "js", "jse", "vbs", "vbe", "wsf",
                 "wsh", "ps1", "psm1", "sh", "bash", "jar", "apk", "app", "lnk", "reg", "hta", "cpl", "docm",
                 "xlsm", "pptm", "dotm", "xlam", "ppam", "sldm"}
RESERVED_WIN = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
EXT_TO_MIMES = {
    "pdf": {MIME_PDF}, "png": {"image/png"}, "jpg": {"image/jpeg"}, "jpeg": {"image/jpeg"},
    "tif": {"image/tiff"}, "tiff": {"image/tiff"}, "bmp": {"image/bmp"}, "webp": {"image/webp"}, "gif": {"image/gif"},
    "docx": {MIME_DOCX}, "xlsx": {MIME_XLSX}, "pptx": {MIME_PPTX}, "csv": {"text/csv"},
    "tsv": {"text/tab-separated-values"}, "eml": {"message/rfc822"}, "html": {"text/html"}, "htm": {"text/html"},
}
CANON_EXT = {MIME_PDF: "pdf", "image/png": "png", "image/jpeg": "jpg", "image/tiff": "tiff", "image/bmp": "bmp",
             "image/webp": "webp", "image/gif": "gif", MIME_DOCX: "docx", MIME_XLSX: "xlsx", MIME_PPTX: "pptx",
             "text/csv": "csv", "text/tab-separated-values": "tsv", "message/rfc822": "eml", "text/html": "html"}
ALLOWED_MIMES = set(CANON_EXT)
NESTED_ARCHIVE_EXT = (".zip", ".docx", ".xlsx", ".pptx", ".jar", ".odt", ".ods", ".odp")
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
ENC_MARKER = "EncryptedPackage".encode("utf-16le")


# ---------------------------------------------------------------------------- filename
def sanitize_filename(name: Optional[str]) -> str:
    max_len = int(S("validation.max_filename_len"))
    n = unicodedata.normalize("NFKC", name or "")
    n = n.replace("\\", "/").split("/")[-1]
    n = "".join(ch for ch in n if unicodedata.category(ch)[0] != "C")  # control + bidi/format chars
    n = re.sub(r'[<>:"|?*]', "_", n)
    n = re.sub(r"\s+", " ", n).strip(" .")
    n = n.lstrip(".")
    if not n:
        n = "file"
    stem, dot, ext = n.rpartition(".")
    if not dot:
        stem, ext = n, ""
    if stem.lower() in RESERVED_WIN:
        stem = "_" + stem
    if ext and len(ext) > 12:
        stem, ext = n[: max_len], ""
    keep = max_len - (len(ext) + 1 if ext else 0)
    stem = stem[: max(1, keep)] or "file"
    return f"{stem}.{ext}" if ext else stem


def _ext_of(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


# ---------------------------------------------------------------------------- MIME sniffing
def _is_html(head: bytes) -> bool:
    h = head[:2048].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return h.startswith((b"<!doctype html", b"<html", b"<head", b"<body")) or b"<html" in h


_EML_HDR = re.compile(rb"^(from|to|subject|date|message-id|mime-version|received|return-path|content-type):", re.I | re.M)


def _is_eml(head: bytes) -> bool:
    h = head[:4096]
    names = {m.group(1).lower() for m in _EML_HDR.finditer(h)}
    first = h.lstrip(b"\xef\xbb\xbf\r\n")[:200]
    starts_ok = bool(re.match(rb"^(From |[A-Za-z][A-Za-z0-9\-]{1,40}:)", first))
    return starts_ok and len(names) >= 2 and bool(names & {b"from", b"to", b"subject", b"date", b"received", b"return-path"})


def _decode_sample(sample: bytes) -> Optional[str]:
    if sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return sample.decode("utf-16", errors="strict")
        except UnicodeDecodeError:
            return sample[:-1].decode("utf-16", errors="replace")
    if b"\x00" in sample:
        return None
    try:
        import charset_normalizer
        best = charset_normalizer.from_bytes(sample).best()
        if best is not None:
            return str(best)
    except Exception:
        pass
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return sample.decode(enc)
        except UnicodeDecodeError:
            continue
    return None


def _looks_like_text(data: bytes) -> bool:
    txt = _decode_sample(data[:65536])
    if not txt:
        return False
    printable = sum(1 for c in txt if c.isprintable() or c in "\r\n\t")
    return printable / max(1, len(txt)) >= float(S("validation.min_printable_ratio"))


def detect_mime(data: bytes, ext: str) -> str:
    """Magic-byte detection. Returns a MIME string; unknown binary -> application/octet-stream."""
    head = data[:16]
    if b"%PDF-" in data[:1024]:
        return MIME_PDF
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "image/tiff"
    if head[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if head[:2] == b"BM" and len(data) > 18 and int.from_bytes(data[14:18], "little") in (12, 40, 52, 56, 108, 124):
        return "image/bmp"
    if head[:2] == b"MZ":
        return "application/x-msdownload"
    if head[:4] == b"\x7fELF":
        return "application/x-elf"
    if head[:4] in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
        return "application/x-executable"
    if head[:2] == b"#!":
        return "text/x-script"
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        return "application/zip"  # refined by _inspect_zip
    if head[:8] == OLE_MAGIC:
        return "application/x-ole-storage"
    if head[:2] in (b"\x1f\x8b",) or head[:4] == b"Rar!" or head[:6] == b"7z\xbc\xaf\x27\x1c":
        return "application/x-archive"
    # E-mail first: an HTML e-mail has an <html> body within the first few KB, but it starts with RFC 822 headers,
    # which an HTML file never does.
    if _is_eml(data):
        return "message/rfc822"
    if _is_html(data):
        return "text/html"
    if ext in ("csv", "tsv") and _looks_like_text(data):
        return "text/csv" if ext == "csv" else "text/tab-separated-values"
    return "application/octet-stream"


# ---------------------------------------------------------------------------- ZIP / OOXML inspection
def _inspect_zip(data: bytes, depth: int = 0) -> Tuple[str, Optional[int]]:
    """Safety checks for zip containers. Returns (mime, page_count) for depth 0."""
    max_ratio = float(S("validation.max_compression_ratio"))
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        infos = zf.infolist()
    except zipfile.BadZipFile as exc:
        raise _Reject(Code.CORRUPT_FILE, "Archive is corrupt") from exc
    if len(infos) > int(S("validation.max_zip_entries")):
        raise _Reject(Code.TOO_LARGE, "Archive has too many entries", "zip_bomb", True)
    total = 0
    names = set()
    for i in infos:
        n = i.filename
        names.add(n)
        parts = n.replace("\\", "/").split("/")
        if n.startswith(("/", "\\")) or ".." in parts or (len(n) > 1 and n[1] == ":"):
            raise _Reject(Code.UNSUPPORTED_FORMAT, "Archive contains unsafe paths", "path_traversal", True)
        if i.flag_bits & 0x1:
            raise _Reject(Code.UNSUPPORTED_FORMAT, "Archive contains encrypted entries", "encrypted_zip", False)
        total += i.file_size
        if i.file_size > 5 * 1024 * 1024 and i.compress_size > 0 and i.file_size / i.compress_size > max_ratio:
            raise _Reject(Code.TOO_LARGE, "Archive entry has a suspicious compression ratio", "zip_bomb", True)
    if total > int(S("validation.max_uncompressed_bytes")) or \
            (total > 50 * 1024 * 1024 and total / max(1, len(data)) > max_ratio):
        raise _Reject(Code.TOO_LARGE, "Archive expands beyond allowed size", "zip_bomb", True)
    low = {n.lower() for n in names}
    if any(n.endswith("vbaproject.bin") or "/activex/" in n or n.startswith("activex/") or n.startswith("xl/macrosheets/")
           for n in low):
        raise _Reject(Code.UNSUPPORTED_FORMAT, "Macro or ActiveX content is not allowed", "macro", True)
    if "[Content_Types].xml" in names:
        try:
            ct = zf.read("[Content_Types].xml")[:2_000_000].lower()
        except Exception as exc:
            raise _Reject(Code.CORRUPT_FILE, "Archive is corrupt") from exc
        if b"macroenabled" in ct or b"vbaproject" in ct:
            raise _Reject(Code.UNSUPPORTED_FORMAT, "Macro-enabled Office files are not allowed", "macro", True)
    if "META-INF/MANIFEST.MF" in names and any(n.endswith(".class") for n in low):
        raise _Reject(Code.UNSUPPORTED_FORMAT, "Executable archives are not allowed", "executable", True)
    for i in infos:  # nested archives (bounded depth and size)
        if i.filename.lower().endswith(NESTED_ARCHIVE_EXT):
            if depth + 1 > int(S("validation.max_zip_depth")):
                raise _Reject(Code.TOO_LARGE, "Archive nesting too deep", "zip_bomb", True)
            if i.file_size > int(S("validation.max_nested_read_bytes")):
                raise _Reject(Code.TOO_LARGE, "Nested archive too large", "zip_bomb", True)
            try:
                inner = zf.read(i)
            except Exception as exc:
                raise _Reject(Code.CORRUPT_FILE, "Archive is corrupt") from exc
            if inner[:2] == b"PK":
                _inspect_zip(inner, depth + 1)
    if depth > 0:
        return "application/zip", None
    if "word/document.xml" in names:
        pages = None
        if "docProps/app.xml" in names:
            m = re.search(rb"<Pages>(\d+)</Pages>", zf.read("docProps/app.xml")[:200_000])
            pages = int(m.group(1)) if m else None
        return MIME_DOCX, pages
    if "xl/workbook.xml" in names:
        wb = zf.read("xl/workbook.xml")[:5_000_000]
        return MIME_XLSX, len(re.findall(rb"<sheet\s", wb)) or None
    if "ppt/presentation.xml" in names:
        return MIME_PPTX, sum(1 for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n))
    return "application/zip", None


# ---------------------------------------------------------------------------- per-type validation
def _pw(options: Optional[FileValidationOptions]) -> str:
    if options is None or options.password is None:
        return ""
    return options.password.get_secret_value()


def _validate_pdf(data: bytes, password: str) -> Tuple[bytes, int, Dict[str, Any]]:
    import pikepdf
    flags: Dict[str, Any] = {}
    try:
        pdf = pikepdf.open(io.BytesIO(data), password=password)
    except pikepdf.PasswordError as exc:
        raise _Reject(Code.PASSWORD_REQUIRED, "Password incorrect" if password else "Password required") from exc
    except Exception:
        return _validate_pdf_fallback(data)
    try:
        pages = len(pdf.pages)
        js = launch = False
        cap = int(S("validation.pdf_scan_max_objects"))
        for idx, obj in enumerate(pdf.objects):
            if idx > cap:
                flags["scan_truncated"] = True
                break
            try:
                if obj._type_code not in (pikepdf.ObjectType.dictionary, pikepdf.ObjectType.stream):
                    continue
                s = obj.get("/S")
                if "/Launch" in obj or (s is not None and str(s) == "/Launch"):
                    launch = True
                if "/JS" in obj or (s is not None and str(s) == "/JavaScript"):
                    js = True
            except Exception:
                continue
        if launch:
            raise _Reject(Code.UNSUPPORTED_FORMAT, "PDF contains launch actions", "pdf_launch", True)
        if js:
            flags["pdf_javascript"] = True  # flagged, never executed
        out = data
        if pdf.is_encrypted:
            buf = io.BytesIO()
            pdf.save(buf, encryption=False)
            out = buf.getvalue()
            flags["decrypted"] = True
        return out, pages, flags
    finally:
        pdf.close()


def _validate_pdf_fallback(data: bytes) -> Tuple[bytes, int, Dict[str, Any]]:
    import fitz
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise _Reject(Code.CORRUPT_FILE, "PDF is corrupt or truncated") from exc
    try:
        if doc.needs_pass:
            raise _Reject(Code.PASSWORD_REQUIRED, "Password required")
        if doc.page_count <= 0:
            raise _Reject(Code.CORRUPT_FILE, "PDF has no readable pages")
        return data, doc.page_count, {"repaired_by_fallback": True}
    finally:
        doc.close()


def _validate_image(data: bytes) -> int:
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
            if w * h > int(S("validation.max_image_pixels")):
                raise _Reject(Code.TOO_LARGE, "Image dimensions are too large", "image_bomb", True)
            if w * h <= int(S("validation.image_load_check_max_pixels")):
                im.load()  # catches truncated files
            else:
                im.verify()
    except _Reject:
        raise
    except Image.DecompressionBombError as exc:
        raise _Reject(Code.TOO_LARGE, "Image dimensions are too large", "image_bomb", True) from exc
    except Exception as exc:
        raise _Reject(Code.CORRUPT_FILE, "Image is corrupt or truncated") from exc
    return 1


def _validate_text_kind(mime: str, data: bytes) -> None:
    if not _looks_like_text(data):
        raise _Reject(Code.UNSUPPORTED_FORMAT, "Content is not valid text for this format")
    if mime in ("text/csv", "text/tab-separated-values"):
        sample = (_decode_sample(data[:65536]) or "")
        try:
            csv.Sniffer().sniff(sample[:8192], delimiters=",;\t|")
        except csv.Error:
            if not sample.strip():
                raise _Reject(Code.CORRUPT_FILE, "Delimited file is empty")
    if mime == "message/rfc822":
        try:
            email.message_from_bytes(data[:2_000_000])
        except Exception as exc:
            raise _Reject(Code.CORRUPT_FILE, "E-mail could not be parsed") from exc


# ---------------------------------------------------------------------------- evaluation pipeline
def _evaluate(data: bytes, name: str, sanitized: str, password: str, max_pages: int, flags: Dict[str, Any]
              ) -> Tuple[str, Optional[int], bytes]:
    """-> (mime, page_count, bytes_to_store). Raises _Reject."""
    ext = _ext_of(sanitized)
    parts = sanitized.lower().split(".")
    if len(parts) > 2 and any(p in DANGEROUS_EXT for p in parts[1:]):
        raise _Reject(Code.UNSUPPORTED_FORMAT, "Double or executable extension is not allowed", "double_extension", True)
    if ext in DANGEROUS_EXT:
        raise _Reject(Code.UNSUPPORTED_FORMAT, "This file type is not allowed", "executable"
                      if ext not in ("docm", "xlsm", "pptm", "dotm", "xlam", "ppam", "sldm") else "macro", True)
    if len(data) == 0:
        raise _Reject(Code.CORRUPT_FILE, "File is empty")
    mime = detect_mime(data, ext)
    dbg(AGENT, "step3-detect", f"mime={mime} ext={ext or '-'}")
    store_data = data
    if mime == "application/x-ole-storage":
        if ENC_MARKER in data:
            if not password:
                raise _Reject(Code.PASSWORD_REQUIRED, "Password required", details={"detected_mime": mime})
            try:
                import msoffcrypto
            except ImportError as exc:
                raise _Reject(Code.UNSUPPORTED_FORMAT, "Encrypted Office files are not supported on this server") from exc
            try:
                f = msoffcrypto.OfficeFile(io.BytesIO(data))
                f.load_key(password=password)
                out = io.BytesIO()
                f.decrypt(out)
            except Exception as exc:
                raise _Reject(Code.PASSWORD_REQUIRED, "Password incorrect") from exc
            store_data = out.getvalue()
            flags["decrypted"] = True
            mime = detect_mime(store_data, ext)
            if mime != "application/zip":
                raise _Reject(Code.UNSUPPORTED_FORMAT, "Decrypted content is not a supported Office file")
        else:
            raise _Reject(Code.UNSUPPORTED_FORMAT, "Legacy Office/OLE files are not supported; save as .docx/.xlsx/.pptx")
    if mime in ("application/x-msdownload", "application/x-elf", "application/x-executable", "text/x-script"):
        raise _Reject(Code.UNSUPPORTED_FORMAT, "Executable content is not allowed", "executable", True)
    pages: Optional[int] = None
    if mime == "application/zip":
        mime, pages = _inspect_zip(store_data)
        dbg(AGENT, "step4-zip", f"container={mime}")
        if mime == "application/zip":
            raise _Reject(Code.UNSUPPORTED_FORMAT, "Generic archives are not supported")
    if mime not in ALLOWED_MIMES:
        raise _Reject(Code.UNSUPPORTED_FORMAT, "Unsupported or unrecognised file format")
    if ext and mime not in EXT_TO_MIMES.get(ext, set()):
        raise _Reject(Code.UNSUPPORTED_FORMAT, "File extension does not match file content",
                      details={"detected_mime": mime})
    if mime == MIME_PDF:
        store_data, pages, f2 = _validate_pdf(store_data, password)
        flags.update(f2)
    elif mime in IMAGE_MIMES:
        pages = _validate_image(store_data)
    elif mime in ("text/csv", "text/tab-separated-values", "message/rfc822", "text/html"):
        _validate_text_kind(mime, store_data)
    dbg(AGENT, "step6-pages", f"page_count={pages}")
    if pages is not None and pages > max_pages:
        raise _Reject(Code.TOO_LARGE, "Document has too many pages", details={"page_count": pages, "max_pages": max_pages})
    return mime, pages, store_data


def _read_stream(stream: Any, max_bytes: int) -> Tuple[bytes, str, bool]:
    h = hashlib.sha256()
    buf = bytearray()
    chunk = int(S("validation.read_chunk_bytes"))
    too_large = False
    while True:
        c = stream.read(chunk)
        if not c:
            break
        h.update(c)
        buf += c
        if len(buf) > max_bytes:
            too_large = True
            break
    return bytes(buf), h.hexdigest(), too_large


def _notify_rejected(user: dict, category: str, sha: str, source_id: str) -> None:
    try:
        from backend.common import notify
        notify.file_rejected(str(user.get("user_id")), str(user.get("role")), category, sha[:12], source_id)
    except Exception as exc:
        dbg(AGENT, "notify", f"failed to queue ({type(exc).__name__})")


# ---------------------------------------------------------------------------- main
def run(inp: FileValidationInput) -> FileValidationOutput:
    timer = Timer()
    user = current_user()
    tenant = user["tenant_id"]
    source_id = str(uuid.uuid4())
    if inp.stream is None or not hasattr(inp.stream, "read"):
        raise AgentError(Code.INVALID_INPUT, "A file is required")
    dbg(AGENT, "step1-start", f"source_id={source_id[:8]} user_role={user.get('role')}")
    max_bytes = limit(("max_file_size_bytes", "max_file_size_mb", "maxFileSizeBytes"), "max_file_size_bytes")
    max_pages = limit(("max_pages", "maxPages"), "max_pages")
    data, sha, too_large = _read_stream(inp.stream, max_bytes)
    size = len(data)
    sanitized = sanitize_filename(inp.filename)
    dbg(AGENT, "step1-read", f"bytes={size} sha256={sha[:12]} too_large={too_large}")
    flags: Dict[str, Any] = {}
    mime = "application/octet-stream"
    pages: Optional[int] = None
    store_data = data
    error: Optional[ErrorInfo] = None
    category: Optional[str] = None
    notify_flag = False
    try:
        if too_large:
            raise _Reject(Code.TOO_LARGE, "File exceeds the maximum allowed size",
                          details={"max_bytes": max_bytes, "size_is_lower_bound": True})
        dbg(AGENT, "step2-filename", f"sanitized_len={len(sanitized)}")
        mime_guess = detect_mime(data, _ext_of(sanitized)) if data else mime
        mime = mime_guess
        mime, pages, store_data = _evaluate(data, inp.filename, sanitized, _pw(inp.options), max_pages, flags)
    except _Reject as r:
        error = ErrorInfo(code=r.code, message=r.message, details=r.details)
        category, notify_flag = r.category, r.notify
        if r.details and r.details.get("detected_mime"):
            mime = r.details["detected_mime"]
        dbg(AGENT, "REJECTED", f"{r.code} category={category}")
    except AgentError:
        raise
    except Exception as exc:  # engine failure must not look like a bad file
        dbg(AGENT, "ENGINE_ERROR", f"{type(exc).__name__}")
        raise AgentError(Code.ENGINE_FAILED, "File validation failed") from exc

    origin = inp.origin or {"type": "upload"}
    base_meta = {"source_id": source_id, "tenant_id": tenant, "owner_id": user.get("user_id"), "sanitized_filename": sanitized,
                 "sha256": sha, "detected_mime": mime, "size_bytes": size, "page_count": pages, "origin": origin,
                 "created_at": time.time(), "flags": flags}

    if error is not None:
        meta = {**base_meta, "status": "rejected", "error": error.model_dump()}
        commit_ok = True
        try:
            commit([("source_meta", source_id, meta)],
                   dict(event_type="file_rejected", object_type="source", object_id=source_id, outcome="denied",
                        details={"code": error.code, "category": category, "sha256": sha, "size_bytes": size,
                                 "detected_mime": mime, "duration_ms": timer.ms()}), user)
        except AgentError:
            commit_ok = False
            dbg(AGENT, "audit", "rejection could not be recorded (non-fatal)")
        if notify_flag and category:
            _notify_rejected(user, category, sha, source_id)
        dbg(AGENT, "done", f"status=rejected code={error.code} ms={timer.ms()} recorded={commit_ok}")
        return FileValidationOutput(source_id=source_id, sanitized_filename=sanitized, sha256=sha, detected_mime=mime,
                                    size_bytes=size, page_count=None, status="rejected", error=error)

    dup = store_get("sha256_index", f"{tenant}:{sha}")
    duplicate_of = dup.get("source_id") if isinstance(dup, dict) else None
    dbg(AGENT, "step7-duplicate", f"duplicate={'yes' if duplicate_of else 'no'}")
    if "." not in sanitized:
        sanitized = f"{sanitized}.{CANON_EXT[mime]}"
    base_meta["sanitized_filename"] = sanitized
    base_meta["decrypted"] = bool(flags.get("decrypted"))
    meta = {**base_meta, "status": "accepted", "duplicate_of": duplicate_of}
    try:
        put_blob("original", source_id, store_data, tenant)  # AES-256-GCM, aad = tenant:source_id
    except AgentError:
        raise
    except Exception as exc:
        raise AgentError(Code.ENGINE_FAILED, "Could not store the file securely") from exc
    puts: List[Tuple[str, str, Any]] = [("source_meta", source_id, meta)]
    if not duplicate_of:
        puts.append(("sha256_index", f"{tenant}:{sha}", {"source_id": source_id}))
    from backend.agents._support import store_delete
    try:
        commit(puts, dict(event_type="file_uploaded", object_type="source", object_id=source_id,
                          details={"sha256": sha, "size_bytes": size, "detected_mime": mime, "page_count": pages,
                                   "duplicate_of": duplicate_of, "origin": origin.get("type"),
                                   "pdf_javascript": bool(flags.get("pdf_javascript")), "decrypted": bool(flags.get("decrypted")),
                                   "duration_ms": timer.ms()}), user)
    except AgentError:
        store_delete("original", source_id)  # fail closed: no audit -> no stored file
        raise
    dbg(AGENT, "done", f"status=accepted mime={mime} pages={pages} ms={timer.ms()}")
    warns: List[WarningItem] = []
    if duplicate_of:
        warns.append(WarningItem(code="DUPLICATE_FILE", message="An identical file was already uploaded", details={"duplicate_of": duplicate_of}))
    if flags.get("pdf_javascript"):
        warns.append(WarningItem(code="PDF_JAVASCRIPT", message="PDF contains JavaScript; it was not executed"))
    return FileValidationOutput(source_id=source_id, sanitized_filename=sanitized, sha256=sha, detected_mime=mime,
                                size_bytes=size, page_count=pages, status="accepted", duplicate_of=duplicate_of, warnings=warns)


# ---------------------------------------------------------------------------- router
try:
    from fastapi import APIRouter, File, Form, Request, UploadFile
except ImportError:  # fastapi not installed
    APIRouter = None


def build_router():
    import json as _json
    r = APIRouter()

    @r.post("/agents/file-validation")
    def file_validation(request: Request, file: UploadFile = File(...), options: Optional[str] = Form(None),
                        password: Optional[str] = Form(None)):
        def _go():
            opts: Dict[str, Any] = {}
            if options:
                try:
                    opts = _json.loads(options)
                    if not isinstance(opts, dict):
                        raise ValueError
                except ValueError:
                    raise AgentError(Code.INVALID_INPUT, "options must be a JSON object")
            if password:
                opts["password"] = password
            cl = request.headers.get("content-length")
            if cl and cl.isdigit() and int(cl) > limit(("max_file_size_bytes", "max_file_size_mb"), "max_file_size_bytes") * 1.02 + 65536:
                raise AgentError(Code.TOO_LARGE, "File exceeds the maximum allowed size")
            return run(FileValidationInput(filename=file.filename or "", stream=file.file,
                                           options=FileValidationOptions(password=opts.get("password"))))
        return endpoint(request, _go)

    return r


router = build_router() if APIRouter is not None else None