"""Agent 03 - Native Text Extraction  (POST /agents/native-text).  Owner: Person A.

README
  Inputs : {source_id, page_number}
  Outputs: {page_id, spans:[{text, location, font?, confidence}], has_usable_text, warnings[]}
  Algorithm:
    1 authorise + load meta/page_meta (page geometry from agent 02 so bboxes match the page image exactly)
    2 PDF/DOCX/PPTX: PyMuPDF get_text("dict") on the cached document; one span per LINE (visible spans only)
    3 hidden text (alpha 0, tiny font, white text on a non-filled background) is EXCLUDED and reported as
      HIDDEN_TEXT (prompt-injection safe); text fully outside the page is dropped + TEXT_OUTSIDE_PAGE
    4 ligatures expanded, NUL/zero-width/soft-hyphen removed; bboxes scaled to page-image pixels
      (scale = dpi/72, origin top-left, page_width/page_height = rendered image size), rotation already applied
    5 confidence = clamp(1 - garbage_penalty*garbage_ratio(line) - tounicode_penalty*missing_ToUnicode_fraction)
      garbage = private-use / U+FFFD / unassigned / control chars / "(cid:N)" tokens
    6 has_usable_text = non-space chars >= min_chars AND page garbage ratio <= max_garbage_ratio
    7 EML body / HTML: text lines with bbox=null (reason non_paginated_source); images: empty + NO_TEXT_LAYER
  Never runs OCR.  Result cached under store kind "native_text", id "<source_id>:<page>".
  Libraries: PyMuPDF, stdlib html.parser/email.   Limits: white-on-dark detection uses filled vector rectangles only.
"""
from __future__ import annotations

import email
import email.policy
import re
import unicodedata
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

from backend.agents._support import (AgentError, Code, Location, S, Timer, WarningItem, audit_event, clamp_bbox, commit,
                                     current_user, dbg, endpoint, get_original_bytes, kind_of, load_meta, open_pdf,
                                     page_geometry, page_id_for, pdf_loader, store_get)

AGENT = "03-native-text"
METHOD = "native_text"


class NativeTextInput(BaseModel):
    source_id: str
    page_number: int = Field(ge=1)


class Span(BaseModel):
    text: str
    location: Location
    font: Optional[str] = None
    confidence: float


class NativeTextOutput(BaseModel):
    page_id: str
    spans: List[Span]
    has_usable_text: bool
    warnings: List[WarningItem] = []


_LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"}
_STRIP = dict.fromkeys(map(ord, "\x00﻿​­"), None)
_CID = re.compile(r"\(cid:\d+\)")


def clean_text(s: str) -> str:
    for k, v in _LIGATURES.items():
        s = s.replace(k, v)
    return unicodedata.normalize("NFC", s.translate(_STRIP))


def garbage_stats(s: str) -> Tuple[int, int]:
    """-> (bad_chars, non_space_chars)."""
    cid_chars = sum(len(m) for m in _CID.findall(s))
    rest = _CID.sub("", s)
    bad = cid_chars
    total = cid_chars
    for ch in rest:
        if ch.isspace():
            continue
        total += 1
        cat = unicodedata.category(ch)
        if ch == "�" or cat in ("Co", "Cn", "Cs") or (cat == "Cc" and ch not in "\t\n\r"):
            bad += 1
    return bad, total


def _rtl_ratio(s: str) -> float:
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if unicodedata.bidirectional(c) in ("R", "AL")) / len(letters)


def _missing_tounicode_fraction(doc: Any, page: Any) -> float:
    try:
        fonts = page.get_fonts(full=False)
    except Exception:
        return 0.0
    if not fonts:
        return 0.0
    missing = 0
    for f in fonts:
        xref, ftype = f[0], str(f[2])
        if ftype in ("Type0", "CIDFontType0", "CIDFontType2"):
            try:
                if doc.xref_get_key(xref, "ToUnicode")[0] == "null":
                    missing += 1
            except Exception:
                pass
    return missing / len(fonts)


def _is_light(color: int) -> bool:
    r, g, b = (color >> 16) & 255, (color >> 8) & 255, color & 255
    return r > 240 and g > 240 and b > 240


def _covered_by_fill(bbox: Tuple[float, float, float, float], fills: List[Tuple[float, float, float, float]]) -> bool:
    area = max(1e-6, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
    for f in fills:
        w = min(bbox[2], f[2]) - max(bbox[0], f[0])
        h = min(bbox[3], f[3]) - max(bbox[1], f[1])
        if w > 0 and h > 0 and (w * h) / area >= 0.5:
            return True
    return False


def _extract_pdf_page(doc: Any, page_number: int, source_id: str, pm: Optional[dict], warnings: List[WarningItem]
                      ) -> Tuple[List[Span], int, int]:
    import fitz
    page = doc.load_page(page_number - 1)
    rect = page.rect
    if pm and pm.get("scale") and pm.get("width_px"):
        scale, wpx, hpx = float(pm["scale"]), int(pm["width_px"]), int(pm["height_px"])
    else:
        scale, wpx, hpx = page_geometry(rect.width, rect.height)
    pid = page_id_for(source_id, page_number)
    dbg(AGENT, "step2-extract", f"page={page_number} scale={scale:.3f} image={wpx}x{hpx}")
    d = page.get_text("dict", flags=fitz.TEXT_PRESERVE_LIGATURES | fitz.TEXT_PRESERVE_WHITESPACE)
    tiny = float(S("native_text.tiny_font_pt"))
    fills: Optional[List[Tuple[float, float, float, float]]] = None
    hidden_spans = outside = 0
    lines: List[Tuple[str, Tuple[float, float, float, float], Optional[str]]] = []
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            vis_text: List[str] = []
            boxes: List[Tuple[float, float, float, float]] = []
            fonts: Dict[str, int] = {}
            for sp in line.get("spans", []):
                txt = sp.get("text", "")
                if not txt.strip():
                    if vis_text:  # keep inter-word spaces inside a line
                        vis_text.append(txt)
                    continue
                hidden = sp.get("alpha", 255) == 0 or float(sp.get("size", 10)) < tiny
                if not hidden and _is_light(int(sp.get("color", 0))):
                    if fills is None:
                        fills = []
                        try:
                            for dr in page.get_cdrawings():
                                f = dr.get("fill")
                                if f is not None and not all(c > 0.94 for c in f):
                                    fills.append(tuple(dr["rect"]))
                            for info in page.get_image_info():
                                fills.append(tuple(info["bbox"]))
                        except Exception:
                            pass
                    hidden = not _covered_by_fill(tuple(sp["bbox"]), fills)
                if hidden:
                    hidden_spans += 1
                    continue
                vis_text.append(txt)
                boxes.append(tuple(sp["bbox"]))
                fonts[sp.get("font", "")] = fonts.get(sp.get("font", ""), 0) + len(txt)
            text = clean_text("".join(vis_text)).strip()
            if not text or not boxes:
                continue
            bb = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
            if bb[2] <= rect.x0 or bb[0] >= rect.x1 or bb[3] <= rect.y0 or bb[1] >= rect.y1:
                outside += 1
                continue
            lines.append((text, bb, max(fonts, key=fonts.get) if fonts else None))
    if hidden_spans:
        warnings.append(WarningItem(code="HIDDEN_TEXT", message="Hidden or invisible text was excluded", page_number=page_number,
                                    details={"hidden_spans": hidden_spans}))
    if outside:
        warnings.append(WarningItem(code="TEXT_OUTSIDE_PAGE", message="Text outside the page box was dropped",
                                    page_number=page_number, details={"lines": outside}))
    tu_frac = _missing_tounicode_fraction(doc, page)
    gp, tp = float(S("native_text.garbage_penalty")), float(S("native_text.tounicode_penalty"))
    spans: List[Span] = []
    for text, bb, font in lines:
        bad, tot = garbage_stats(text)
        ratio = bad / tot if tot else 0.0
        conf = max(0.0, min(1.0, 1.0 - gp * ratio - tp * tu_frac))
        # PyMuPDF bboxes are relative to page.rect (rotation applied): shift by rect origin, then scale to pixels
        box = clamp_bbox([(bb[0] - rect.x0) * scale, (bb[1] - rect.y0) * scale, (bb[2] - rect.x0) * scale, (bb[3] - rect.y0) * scale],
                         wpx, hpx)
        spans.append(Span(text=text, font=font or None, confidence=round(conf, 4),
                          location=Location(source_id=source_id, page_id=pid, bbox=box, page_width=wpx, page_height=hpx,
                                            extraction_method=METHOD)))
    spans.sort(key=lambda s: (round(s.location.bbox[1], 1), s.location.bbox[0], s.text))
    return spans, wpx, hpx


class _HtmlText(HTMLParser):
    SKIP = {"script", "style", "head", "title", "noscript", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: List[str] = []
        self._skip = 0
        self._stack: List[bool] = []

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        style = a.get("style", "").replace(" ", "").lower()
        hidden = tag in self.SKIP or "hidden" in a or "display:none" in style or "visibility:hidden" in style
        if tag not in ("br", "img", "hr", "meta", "link", "input"):
            self._stack.append(hidden)
            self._skip += 1 if hidden else 0
        if tag in ("br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("br", "img", "hr", "meta", "link", "input"):
            return
        if self._stack:
            if self._stack.pop():
                self._skip -= 1
        if tag in ("p", "div", "tr", "li", "table"):
            self.out.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.out.append(data)


def _decode(data: bytes) -> str:
    try:
        import charset_normalizer
        best = charset_normalizer.from_bytes(data[:2_000_000]).best()
        if best is not None:
            return str(best)
    except Exception:
        pass
    return data.decode("utf-8", errors="replace")


def _non_paginated_spans(text: str, source_id: str, page_number: int) -> List[Span]:
    pid = page_id_for(source_id, page_number)
    spans = []
    for ln in text.splitlines():
        t = clean_text(re.sub(r"[ \t ]+", " ", ln)).strip()
        if not t:
            continue
        bad, tot = garbage_stats(t)
        conf = max(0.0, 1.0 - float(S("native_text.garbage_penalty")) * (bad / tot if tot else 0.0))
        spans.append(Span(text=t, confidence=round(conf, 4),
                          location=Location(source_id=source_id, page_id=pid, bbox=None,
                                            bbox_unavailable_reason="non_paginated_source", extraction_method=METHOD)))
    return spans


def _eml_text(source_id: str) -> str:
    msg = email.message_from_bytes(get_original_bytes(source_id), policy=email.policy.default)
    head = "\n".join(f"{k}: {msg[k]}" for k in ("From", "To", "Cc", "Date", "Subject") if msg[k])
    body = msg.get_body(preferencelist=("plain", "html"))
    text = ""
    if body is not None:
        raw = body.get_content()
        if body.get_content_type() == "text/html":
            p = _HtmlText()
            p.feed(raw)
            text = "".join(p.out)
        else:
            text = raw
    return head + "\n\n" + text


def run(inp: NativeTextInput) -> NativeTextOutput:
    timer = Timer()
    user = current_user()
    sid, pno = inp.source_id, inp.page_number
    meta = load_meta(sid, user)
    kind = kind_of(meta["detected_mime"])
    dbg(AGENT, "step1-load", f"source={sid[:8]} kind={kind} page={pno}")
    cached = store_get("native_text", f"{sid}:{pno}")
    if isinstance(cached, dict) and "page_id" in cached:
        audit_event("native_text_run", "source", sid, details={"page": pno, "cached": True}, user=user, fail_closed=True)
        dbg(AGENT, "done", "served from cache")
        return NativeTextOutput(**cached)
    warnings: List[WarningItem] = []
    pid = page_id_for(sid, pno)
    if kind in ("pdf", "docx", "pptx"):
        pm_all = store_get("page_meta", sid) or {}
        pm = (pm_all.get("pages") or {}).get(str(pno))
        key, loader = pdf_loader(sid, meta)
        with open_pdf(key, loader) as doc:
            if pno > doc.page_count:
                raise AgentError(Code.INVALID_INPUT, "page_number out of range", {"page_count": doc.page_count})
            spans, _, _ = _extract_pdf_page(doc, pno, sid, pm, warnings)
    elif kind == "eml":
        if pno != 1:
            raise AgentError(Code.INVALID_INPUT, "Attachment units are separate sources; use the child source_id")
        spans = _non_paginated_spans(_eml_text(sid), sid, 1)
    elif kind == "html":
        if pno != 1:
            raise AgentError(Code.INVALID_INPUT, "HTML sources have a single page")
        p = _HtmlText()
        p.feed(_decode(get_original_bytes(sid)))
        spans = _non_paginated_spans("".join(p.out), sid, 1)
    elif kind == "image":
        if pno != 1:
            raise AgentError(Code.INVALID_INPUT, "Image sources have a single page")
        spans = []
        warnings.append(WarningItem(code="NO_TEXT_LAYER", message="Image sources have no native text; use OCR", page_number=1))
    else:
        raise AgentError(Code.UNSUPPORTED_FORMAT, "Use /agents/spreadsheet for spreadsheet and CSV sources")
    full = " ".join(s.text for s in spans)
    bad, tot = garbage_stats(full)
    ratio = bad / tot if tot else 0.0
    usable = tot >= int(S("native_text.min_chars")) and ratio <= float(S("native_text.max_garbage_ratio"))
    if spans and _rtl_ratio(full) > 0.3:
        warnings.append(WarningItem(code="RTL_TEXT", message="Right-to-left text present; logical order kept", page_number=pno))
    if spans and not usable:
        warnings.append(WarningItem(code="UNUSABLE_TEXT_LAYER", message="Text layer looks garbled; OCR recommended",
                                    page_number=pno, details={"garbage_ratio": round(ratio, 4)}))
    dbg(AGENT, "step5-quality", f"spans={len(spans)} chars={tot} garbage={ratio:.3f} usable={usable}")
    out = NativeTextOutput(page_id=pid, spans=spans, has_usable_text=usable, warnings=warnings)
    commit([("native_text", f"{sid}:{pno}", out.model_dump(mode="json"))],
           dict(event_type="native_text_run", object_type="source", object_id=sid,
                details={"page": pno, "spans": len(spans), "usable": usable, "cached": False, "duration_ms": timer.ms()}), user)
    dbg(AGENT, "done", f"ms={timer.ms()}")
    return out


try:
    from fastapi import APIRouter, Body, Request
except ImportError:  # fastapi not installed
    APIRouter = None


def build_router():
    r = APIRouter()

    @r.post("/agents/native-text")
    def native_text(request: Request, payload: dict = Body(...)):
        return endpoint(request, lambda: run(NativeTextInput.model_validate(payload)))

    return r


router = build_router() if APIRouter is not None else None
