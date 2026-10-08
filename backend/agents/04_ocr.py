"""Agent 04 - OCR  (POST /agents/ocr).  Owner: Person A.

README
  Inputs : {source_id, page_number, region?, engine?}   region = [x1,y1,x2,y2] or {"bbox":[...]} in page-image pixels
  Outputs: {engine, lines:[{text, location, confidence}], handwriting_detected?, warnings[]}
  Engines: "tesseract" (pytesseract), "rapidocr" (pip-only, ONNX, no system install) and "paddleocr" behind one
           interface; default = first configured+available
           (settings ocr.engines).  An explicitly requested engine that is missing -> ENGINE_FAILED.
  Algorithm:
    1 authorise, load cached page image (agent 02 pre-rendered it) and page_meta (rotation, script)
    2 optional region crop (+padding); small crops are upscaled (<= 3x)
    3 pre-processing, only as far as it helps: upright by OSD rotation -> deskew (projection-profile search,
      only if |angle| > 0.3 deg) -> pass 1 on grayscale+autocontrast; if mean confidence < 0.80 run pass 2
      (median denoise + Bradley adaptive binarisation) and keep it only when it scores better
    4 languages come from detection (OSD/native script -> settings ocr.script_langs), filtered to installed packs
    5 bboxes are mapped back through every transform to FULL-PAGE coordinates of the cached page image
    6 lines sorted top-to-bottom / left-to-right; confidence = engine confidence normalised to [0,1]
      (tesseract word conf/100 length-weighted per line; paddle score as-is)
    7 handwriting_detected = (>=40% low-confidence lines) AND (high stroke-width variation); only a flag
  Results cached under store kind "ocr" id "<source_id>:<page>:<engine>[:r<hash>]" (agent 11/21 read these).
  Timeout per page -> TIMEOUT.  Limits: PaddleOCR cannot be killed on timeout (thread finishes in background).
"""
from __future__ import annotations

import hashlib
import io
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
from pydantic import BaseModel, Field, field_validator

from backend.agents._support import (AgentError, Code, Location, S, Timer, WarningItem, audit_event, clamp_bbox, commit,
                                     current_user, dbg, endpoint, get_page_image, load_meta, page_id_for, store_get)

AGENT = "04-ocr"

# Several pages are OCR'd in parallel; one thread per Tesseract process avoids oversubscribing the CPU.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")


class RegionIn(BaseModel):
    bbox: List[float]


class OcrInput(BaseModel):
    source_id: str
    page_number: int = Field(ge=1)
    region: Optional[Union[List[float], RegionIn]] = None
    engine: Optional[str] = None
    mode: Optional[str] = None   # "sparse" = scattered labels (charts, diagrams): word-level boxes instead of paragraph lines

    @field_validator("region", mode="before")
    @classmethod
    def _region(cls, v: Any) -> Any:
        if v is None or isinstance(v, (list, RegionIn)):
            return v
        if isinstance(v, dict):
            b = v.get("bbox") or (v.get("location") or {}).get("bbox")
            if b is not None:
                return list(b)
        raise ValueError("region must be [x1,y1,x2,y2] or {bbox:[...]}")


class OcrLine(BaseModel):
    text: str
    location: Location
    confidence: float


class OcrOutput(BaseModel):
    engine: str
    lines: List[OcrLine]
    handwriting_detected: Optional[bool] = None
    warnings: List[WarningItem] = []


class RawLine:
    __slots__ = ("text", "bbox", "conf")

    def __init__(self, text: str, bbox: Tuple[float, float, float, float], conf: float):
        self.text, self.bbox, self.conf = text, bbox, max(0.0, min(1.0, conf))


# ---------------------------------------------------------------------------- engines
_TESS_LANGS: Optional[set] = None
_PADDLE: Dict[str, Any] = {}
_PADDLE_LOCK = threading.Lock()
_RAPID: Dict[str, Any] = {}
_RAPID_LOCK = threading.Lock()


def _locate_tesseract() -> None:
    """Point pytesseract at the binary: TESSERACT_CMD, else PATH, else the usual Windows install folders."""
    import shutil
    import pytesseract
    candidates = [os.getenv("TESSERACT_CMD", ""), shutil.which("tesseract") or "",
                  r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
                  os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe")]
    for c in candidates:
        if c and os.path.isfile(c):
            pytesseract.pytesseract.tesseract_cmd = c
            return


def _tess_available() -> bool:
    try:
        import pytesseract
        _locate_tesseract()
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def _paddle_available() -> bool:
    try:
        import paddleocr  # noqa: F401
        return True
    except Exception:
        return False


def _rapid_available() -> bool:
    try:
        import rapidocr_onnxruntime  # noqa: F401
        return True
    except Exception:
        return False


def available_engines() -> Dict[str, bool]:
    if os.getenv("PARSEFUSION_OCR_DISABLED", "").strip().lower() in ("1", "true", "yes"):
        return {"tesseract": False, "paddleocr": False, "rapidocr": False}  # explicit switch (tests, or text-layer-only runs)
    return {"tesseract": _tess_available(), "paddleocr": _paddle_available(), "rapidocr": _rapid_available()}


def engine_info() -> Dict[str, Any]:
    """The engine run() would use by default, its version and languages, or why no engine is available."""
    avail = available_engines()
    configured = [e for e in (S("ocr.engines") or []) if e in avail]
    chosen = next((e for e in configured if avail.get(e)), None)
    info: Dict[str, Any] = {"available": bool(chosen), "engine": chosen, "version": None, "cmd": None,
                            "languages": None, "configured_order": configured, "installed": avail, "reason": None}
    if chosen == "tesseract":
        import pytesseract
        _locate_tesseract()
        info["version"] = str(pytesseract.get_tesseract_version())
        info["cmd"] = pytesseract.pytesseract.tesseract_cmd
        try:
            info["languages"] = sorted(pytesseract.get_languages(config=""))
        except Exception:
            pass
    elif chosen == "paddleocr":
        try:
            import paddleocr
            info["version"] = getattr(paddleocr, "__version__", None)
        except Exception:
            pass
    elif chosen == "rapidocr":
        try:
            from importlib.metadata import version
            info["version"] = version("rapidocr-onnxruntime")
        except Exception:
            pass
        info["languages"] = ["en", "ch"]
    if not chosen:
        info["reason"] = ("OCR is switched off (PARSEFUSION_OCR_DISABLED)" if os.getenv("PARSEFUSION_OCR_DISABLED") else None) or ("No OCR engine found. Easiest fix: pip install rapidocr-onnxruntime (no system install needed). "
                          "Or install Tesseract (e.g. C:\\Program Files\\Tesseract-OCR) or set TESSERACT_CMD")
    return info


def _tess_langs(requested: str, warnings: List[WarningItem]) -> str:
    global _TESS_LANGS
    import pytesseract
    if _TESS_LANGS is None:
        _TESS_LANGS = set(pytesseract.get_languages(config=""))
    want = [l for l in requested.split("+") if l]
    have = [l for l in want if l in _TESS_LANGS]
    if len(have) != len(want):
        warnings.append(WarningItem(code="LANGUAGE_PACK_MISSING", message="Some OCR language packs are not installed",
                                    details={"requested": want, "used": have}))
    if not have:
        if "eng" in _TESS_LANGS:
            return "eng"
        raise AgentError(Code.ENGINE_FAILED, "No Tesseract language data is installed")
    return "+".join(have)


def _run_tesseract(img: Any, langs: str, psm: int, timeout: float) -> List[RawLine]:
    import pytesseract
    try:
        d = pytesseract.image_to_data(img, lang=langs, config=f"--oem 1 --psm {psm}",
                                      output_type=pytesseract.Output.DICT, timeout=timeout)
    except RuntimeError as exc:
        if "timeout" in str(exc).lower():
            raise AgentError(Code.TIMEOUT, "OCR timed out") from exc
        raise AgentError(Code.ENGINE_FAILED, "OCR engine failed") from exc
    groups: Dict[Tuple[int, int, int], List[int]] = {}
    for i, t in enumerate(d["text"]):
        try:
            conf = float(d["conf"][i])
        except (TypeError, ValueError):
            continue
        if conf < 0 or not str(t).strip():
            continue
        groups.setdefault((d["block_num"][i], d["par_num"][i], d["line_num"][i]), []).append(i)
    out: List[RawLine] = []
    for idxs in groups.values():
        idxs.sort(key=lambda i: d["left"][i])
        text = " ".join(str(d["text"][i]).strip() for i in idxs)
        wsum = sum(max(1, len(str(d["text"][i]).strip())) for i in idxs)
        conf = sum(float(d["conf"][i]) * max(1, len(str(d["text"][i]).strip())) for i in idxs) / wsum / 100.0
        x1 = min(d["left"][i] for i in idxs)
        y1 = min(d["top"][i] for i in idxs)
        x2 = max(d["left"][i] + d["width"][i] for i in idxs)
        y2 = max(d["top"][i] + d["height"][i] for i in idxs)
        out.append(RawLine(text, (x1, y1, x2, y2), conf))
    return out


def _rapid_instance() -> Any:
    with _RAPID_LOCK:
        if "ocr" not in _RAPID:
            from rapidocr_onnxruntime import RapidOCR
            _RAPID["ocr"] = RapidOCR()
        return _RAPID["ocr"]


def _run_rapid(img: Any) -> List[RawLine]:
    """RapidOCR (PP-OCR models on onnxruntime). Detects every text box separately, so axis ticks, legend entries and
    labels in a chart come back as separate items rather than merged lines."""
    arr = np.asarray(img.convert("RGB"))
    try:
        res, _ = _rapid_instance()(arr)
    except Exception as exc:
        raise AgentError(Code.ENGINE_FAILED, "OCR engine failed") from exc
    out: List[RawLine] = []
    for item in res or []:
        poly, text, score = item[0], str(item[1]).strip(), item[2]
        if not text:
            continue
        p = np.asarray(poly, dtype=float)
        out.append(RawLine(text, (float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())), float(score)))
    return out


def _paddle_instance(lang: str) -> Any:
    with _PADDLE_LOCK:
        if lang not in _PADDLE:
            from paddleocr import PaddleOCR
            try:
                _PADDLE[lang] = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
            except (TypeError, ValueError):
                _PADDLE[lang] = PaddleOCR(use_textline_orientation=True, lang=lang)
        return _PADDLE[lang]


def _run_paddle(img: Any, lang: str) -> List[RawLine]:
    ocr = _paddle_instance(lang)
    arr = np.asarray(img.convert("RGB"))
    try:
        res = ocr.ocr(arr, cls=True)
    except TypeError:
        res = ocr.ocr(arr)
    out: List[RawLine] = []
    if not res:
        return out
    first = res[0]
    if isinstance(first, dict) or hasattr(first, "get") and not isinstance(first, list):  # paddleocr 3.x
        texts, scores, polys = first.get("rec_texts", []), first.get("rec_scores", []), first.get("rec_polys", first.get("dt_polys", []))
        for t, s, p in zip(texts, scores, polys):
            p = np.asarray(p)
            if str(t).strip():
                out.append(RawLine(str(t).strip(), (float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())), float(s)))
        return out
    for item in first or []:
        poly, (t, s) = item[0], item[1]
        p = np.asarray(poly)
        if str(t).strip():
            out.append(RawLine(str(t).strip(), (float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())), float(s)))
    return out


# ---------------------------------------------------------------------------- image pre-processing
def otsu_threshold(arr: np.ndarray) -> int:
    hist = np.bincount(arr.ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    if total == 0:
        return 128
    sum_all = float((np.arange(256) * hist).sum())
    w_b = sum_b = 0.0
    best, thr = -1.0, 128
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b, m_f = sum_b / w_b, (sum_all - sum_b) / w_f
        var = w_b * w_f * (m_b - m_f) ** 2
        if var > best:
            best, thr = var, t
    return thr


def estimate_skew(gray: Any) -> float:
    """Degrees to rotate (PIL counter-clockwise convention) so text lines become horizontal; 0 when unsure."""
    from PIL import Image
    im = gray.copy()
    im.thumbnail((800, 800))
    arr = np.asarray(im, dtype=np.uint8)
    ink = arr <= otsu_threshold(arr)
    frac = float(ink.mean())
    if frac < 0.002 or frac > 0.5:
        return 0.0
    binimg = Image.fromarray((ink * 255).astype(np.uint8))
    cache: Dict[float, float] = {}

    def score(a: float) -> float:
        a = round(a, 3)
        if a not in cache:
            r = binimg.rotate(a, resample=Image.NEAREST, expand=False, fillcolor=0)
            cache[a] = float(np.var(np.asarray(r).sum(axis=1) / 255.0))
        return cache[a]

    mx = float(S("ocr.deskew_max_deg"))
    best = max(np.arange(-mx, mx + 0.01, 1.0), key=score)
    best = max(np.arange(best - 1.0, best + 1.01, 0.25), key=score)
    if score(best) <= score(0.0) * 1.05:
        return 0.0
    return float(best)


def adaptive_binarize(gray: Any, t: float = 0.15) -> Any:
    """Bradley-Roth adaptive threshold via an integral image (numpy only)."""
    from PIL import Image
    a = np.asarray(gray, dtype=np.float64)
    h, w = a.shape
    win = max(15, (min(h, w) // 16) | 1)
    r = win // 2
    ii = np.pad(a.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    ys, xs = np.arange(h), np.arange(w)
    y0, y1 = np.clip(ys - r, 0, h), np.clip(ys + r + 1, 0, h)
    x0, x1 = np.clip(xs - r, 0, w), np.clip(xs + r + 1, 0, w)
    sums = ii[y1][:, x1] - ii[y0][:, x1] - ii[y1][:, x0] + ii[y0][:, x0]
    cnt = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    out = np.where(a * cnt <= sums * (1.0 - t), 0, 255).astype(np.uint8)
    return Image.fromarray(out, mode="L")


class Transform:
    """crop offset -> rot90(cw) -> upscale -> deskew; maps boxes back to full-page coordinates."""

    def __init__(self, ox: float, oy: float, cw: int, ch: int, rot: int, up: float, skew: float, rw: float, rh: float):
        self.ox, self.oy, self.cw, self.ch, self.rot, self.up, self.skew, self.rw, self.rh = ox, oy, cw, ch, rot, up, skew, rw, rh

    def point_back(self, x: float, y: float) -> Tuple[float, float]:
        if self.skew:
            th = math.radians(self.skew)
            c, s = math.cos(th), math.sin(th)
            cx, cy = self.rw * self.up / 2.0, self.rh * self.up / 2.0
            dx, dy = x - cx, y - cy
            x, y = cx + c * dx - s * dy, cy + s * dx + c * dy
        x, y = x / self.up, y / self.up
        if self.rot == 90:
            x, y = y, self.ch - x
        elif self.rot == 180:
            x, y = self.cw - x, self.ch - y
        elif self.rot == 270:
            x, y = self.cw - y, x
        return x + self.ox, y + self.oy

    def box_back(self, b: Tuple[float, float, float, float]) -> List[float]:
        pts = [self.point_back(b[0], b[1]), self.point_back(b[2], b[1]), self.point_back(b[2], b[3]), self.point_back(b[0], b[3])]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return [min(xs), min(ys), max(xs), max(ys)]


def _mean_conf(lines: List[RawLine]) -> Tuple[float, int]:
    n = sum(len(l.text) for l in lines)
    return (sum(l.conf * len(l.text) for l in lines) / n if n else 0.0), n


def _pipeline(page_img: Any, region: Optional[List[float]], rot: int, engine: str, tess_langs: str, paddle_lang: str,
              psm: int, timeout: float, sparse: bool = False) -> Tuple[List[Tuple[RawLine, List[float]]], str]:
    """CPU-heavy part (runs in a worker thread). -> [(raw line, bbox in full-page px)], note."""
    from PIL import Image, ImageFilter, ImageOps
    W, H = page_img.size
    ox = oy = 0
    img = page_img
    if region:
        pad = int(S("ocr.region_pad_px"))
        x1, y1, x2, y2 = region
        ox, oy = max(0, int(math.floor(x1)) - pad), max(0, int(math.floor(y1)) - pad)
        ex, ey = min(W, int(math.ceil(x2)) + pad), min(H, int(math.ceil(y2)) + pad)
        img = page_img.crop((ox, oy, ex, ey))
    cw, ch = img.size
    gray = ImageOps.autocontrast(img.convert("L"))
    if rot:
        gray = gray.rotate(-rot, expand=True)  # PIL rotates counter-clockwise; OSD gives clockwise degrees
    rw, rh = gray.size
    up = 1.0
    if region and gray.height < int(S("ocr.region_min_height_px")):
        up = min(float(S("ocr.region_max_upscale")), int(S("ocr.region_min_height_px")) / max(1, gray.height))
    skew = 0.0
    if (not region or gray.width > 200) and not sparse:   # charts and diagrams are axis-aligned: never "deskew" them
        s = estimate_skew(gray)
        if abs(s) >= float(S("ocr.deskew_min_deg")):
            skew = s
    if up != 1.0:
        gray = gray.resize((int(gray.width * up), int(gray.height * up)), Image.LANCZOS)
    if skew:
        gray = gray.rotate(skew, resample=Image.BICUBIC, expand=False, fillcolor=255)
    tf = Transform(ox, oy, cw, ch, rot, up, skew, rw, rh)

    def recognize(im: Any) -> List[RawLine]:
        if engine == "tesseract":
            return _run_tesseract(im, tess_langs, psm, timeout)
        if engine == "rapidocr":
            return _run_rapid(im)
        return _run_paddle(im, paddle_lang)

    if sparse and engine == "rapidocr":
        # RapidOCR's detector works best on the original colour crop, upscaled when small (tick labels are tiny)
        colour = img.convert("RGB")
        if rot:
            colour = colour.rotate(-rot, expand=True)
        if up != 1.0:
            colour = colour.resize((int(colour.width * up), int(colour.height * up)), Image.LANCZOS)
        gray = colour
    lines1 = recognize(gray)
    c1, n1 = _mean_conf(lines1)
    chosen, note = lines1, "pass1"
    if c1 < float(S("ocr.retry_conf_threshold")) and not (sparse and engine == "rapidocr"):
        enh = adaptive_binarize(gray.filter(ImageFilter.MedianFilter(3)))
        lines2 = recognize(enh)
        c2, n2 = _mean_conf(lines2)
        if c2 > c1 + 0.02 and n2 >= 0.8 * n1:
            chosen, note = lines2, "pass2_enhanced"
    out = [(l, tf.box_back(l.bbox)) for l in chosen if l.text.strip()]
    return out, f"{note} rot={rot} skew={skew:.2f} up={up:.2f}"


def _handwriting(page_gray: Any, items: List[Tuple[RawLine, List[float]]]) -> Optional[bool]:
    if not items:
        return None
    low = sum(1 for l, _ in items if l.conf < 0.6) / len(items)
    if low < float(S("ocr.handwriting_low_conf_fraction")):
        return False
    cands = sorted(items, key=lambda it: len(it[0].text), reverse=True)[: int(S("ocr.handwriting_max_lines"))]
    cvs: List[float] = []
    for _, b in cands:
        crop = np.asarray(page_gray.crop((int(b[0]), int(b[1]), int(math.ceil(b[2])), int(math.ceil(b[3])))), dtype=np.uint8)
        if crop.size < 100:
            continue
        ink = crop <= otsu_threshold(crop)
        runs: List[int] = []
        for row in ink[:: max(1, ink.shape[0] // 12)]:
            d = np.diff(np.concatenate(([0], row.astype(np.int8), [0])))
            st, en = np.where(d == 1)[0], np.where(d == -1)[0]
            runs.extend((en - st).tolist())
        if len(runs) >= 8 and np.mean(runs) > 0:
            cvs.append(float(np.std(runs) / np.mean(runs)))
    if not cvs:
        return False
    return float(np.median(cvs)) >= float(S("ocr.handwriting_cv_threshold"))


# ---------------------------------------------------------------------------- main
_POOL: Optional[ThreadPoolExecutor] = None


def _pool() -> ThreadPoolExecutor:
    global _POOL
    if _POOL is None:
        _POOL = ThreadPoolExecutor(max_workers=int(S("ocr.workers")), thread_name_prefix="ocr")
    return _POOL


def _pick_engine(requested: Optional[str], warnings: List[WarningItem]) -> str:
    avail = available_engines()
    configured = [e for e in S("ocr.engines") if e in avail]
    if requested:
        r = requested.lower()
        if r not in avail:
            raise AgentError(Code.INVALID_INPUT, "Unknown OCR engine", {"available": list(avail)})
        if not avail[r]:
            raise AgentError(Code.ENGINE_FAILED, "Requested OCR engine is not installed on the server")
        return r
    for e in configured:
        if avail[e]:
            if e != configured[0]:
                warnings.append(WarningItem(code="ENGINE_FALLBACK", message="Default OCR engine unavailable; used fallback",
                                            details={"used": e}))
            return e
    raise AgentError(Code.ENGINE_FAILED, "No OCR engine is installed on the server")


def _parse_region(region: Any, W: int, H: int) -> Optional[List[float]]:
    if region is None:
        return None
    b = region.bbox if isinstance(region, RegionIn) else region
    if len(b) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in b):
        raise AgentError(Code.INVALID_INPUT, "region must be four finite numbers [x1,y1,x2,y2]")
    x1, y1, x2, y2 = clamp_bbox([b[0], b[1], b[2], b[3]], W, H)
    if (x2 - x1) < 4 or (y2 - y1) < 4:
        raise AgentError(Code.INVALID_INPUT, "region is empty or outside the page", {"page_width": W, "page_height": H})
    return [x1, y1, x2, y2]


def run(inp: OcrInput) -> OcrOutput:
    from PIL import Image
    timer = Timer()
    user = current_user()
    sid, pno = inp.source_id, inp.page_number
    meta = load_meta(sid, user)
    warnings: List[WarningItem] = []
    png, W, H = get_page_image(sid, pno, meta)
    dbg(AGENT, "step1-image", f"page={pno} {W}x{H}")
    region = _parse_region(inp.region, W, H)
    engine = _pick_engine(inp.engine, warnings)
    rkey = "" if region is None else ":r" + hashlib.sha256(
        ",".join(f"{v:.2f}" for v in region).encode("ascii")
    ).hexdigest()[:16]
    mkey = ":sparse" if (inp.mode or "").lower() == "sparse" else ""
    cache_id = f"{sid}:{pno}:{engine}{rkey}{mkey}"
    cached = store_get("ocr", cache_id)
    if isinstance(cached, dict) and "lines" in cached:
        audit_event("ocr_run", "source", sid, details={"page": pno, "engine": engine, "cached": True}, user=user, fail_closed=True)
        dbg(AGENT, "done", "served from cache")
        return OcrOutput(**cached)
    pm = ((store_get("page_meta", sid) or {}).get("pages") or {}).get(str(pno)) or {}
    if pm.get("page_class") == "blank" and region is None:
        warnings.append(WarningItem(code="PAGE_BLANK", message="Page classified blank; OCR skipped", page_number=pno))
        out = OcrOutput(engine=engine, lines=[], handwriting_detected=None, warnings=warnings)
        commit([("ocr", cache_id, out.model_dump(mode="json"))], dict(event_type="ocr_run", object_type="source", object_id=sid,
               details={"page": pno, "engine": engine, "lines": 0, "blank": True, "duration_ms": timer.ms()}), user)
        return out
    rot = int(pm.get("rotation_correction_cw") or 0)
    rot = rot if rot in (0, 90, 180, 270) else 0
    script = pm.get("script")
    sl = (S("ocr.script_langs") or {}).get(script or "", None)
    tess_req = sl["tesseract"] if sl else S("ocr.default_langs")
    paddle_lang = sl["paddle"] if sl else "en"
    tess_langs = _tess_langs(tess_req, warnings) if engine == "tesseract" else tess_req
    dbg(AGENT, "step2-config", f"engine={engine} script={script} langs={tess_langs if engine == 'tesseract' else paddle_lang} rot={rot} region={'yes' if region else 'no'}")
    psm = int(S("ocr.psm_region") if region else S("ocr.psm_page"))
    if mkey:
        psm = int(S("ocr.psm_sparse"))
    timeout = float(S("ocr.timeout_s"))
    page_img = Image.open(io.BytesIO(png))
    page_img.load()
    extra = (True,) if mkey else ()   # the sparse flag is only passed when set, so the common call keeps its signature
    fut = _pool().submit(_pipeline, page_img, region, rot, engine, tess_langs, paddle_lang, psm, timeout, *extra)
    try:
        items, note = fut.result(timeout=timeout + 5)
    except FutTimeout as exc:
        fut.cancel()
        raise AgentError(Code.TIMEOUT, "OCR timed out") from exc
    dbg(AGENT, "step3-ocr", f"{note} raw_lines={len(items)}")
    pid = page_id_for(sid, pno)
    lines: List[OcrLine] = []
    band = max(5.0, 0.5 * float(np.median([b[3] - b[1] for _, b in items])) if items else 5.0)
    items.sort(key=lambda it: (round(it[1][1] / band), it[1][0]))
    for raw, box in items:
        bb = clamp_bbox(box, W, H)
        lines.append(OcrLine(text=raw.text, confidence=round(raw.conf, 4),
                             location=Location(source_id=sid, page_id=pid, bbox=bb, page_width=W, page_height=H,
                                               extraction_method=f"ocr:{engine}")))
    hw = _handwriting(page_img.convert("L"), items)
    if hw:
        warnings.append(WarningItem(code="HANDWRITING_POSSIBLE", message="Handwriting may be present; verify manually", page_number=pno))
    if not lines:
        warnings.append(WarningItem(code="NO_TEXT_FOUND", message="OCR found no text", page_number=pno))
    dbg(AGENT, "step6-result", f"lines={len(lines)} handwriting={hw}")
    out = OcrOutput(engine=engine, lines=lines, handwriting_detected=hw, warnings=warnings)
    commit([("ocr", cache_id, out.model_dump(mode="json"))],
           dict(event_type="ocr_run", object_type="source", object_id=sid,
                details={"page": pno, "engine": engine, "lines": len(lines), "region": region is not None,
                         "cached": False, "duration_ms": timer.ms()}), user)
    dbg(AGENT, "done", f"ms={timer.ms()}")
    return out


try:
    from fastapi import APIRouter, Body, Request
except ImportError:  # fastapi not installed
    APIRouter = None


def build_router():
    r = APIRouter()

    @r.post("/agents/ocr")
    def ocr(request: Request, payload: dict = Body(...)):
        return endpoint(request, lambda: run(OcrInput.model_validate(payload)))

    return r


router = build_router() if APIRouter is not None else None
