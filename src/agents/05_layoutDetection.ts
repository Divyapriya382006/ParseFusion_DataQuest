"""
05_layout.py - Agent 05: Layout Analysis  (Person B).   POST /agents/layout

Page -> typed regions (text,title,table,figure,chart,equation,header,footer,list,caption,signature,stamp,form_field)
+ a page-level layout_class (single_column,multi_column,form,invoice_like,slide,spreadsheet_like,other).

Engines (extraction_method on every region):
  "pdf_native"      born-digital PDF: PyMuPDF text blocks/fonts, find_tables(), image info, vector drawings   (no model, deterministic)
  "cv_ocr"          scanned PDF / image: OpenCV (Otsu, morphology, line masks) + ONE full-page OCR pass
  "layout_model:*"  optional plug-in (LayoutParser / PP-Structure / DocLayout-YOLO) via set_layout_model(fn)

Pipeline (each step prints a debug line):
  1 load page   2 choose engine   3 detect tables   4 detect figures/charts   5 build + classify text blocks
  6 resolve overlaps (priority table>chart=figure>equation>rest)   7 page class   8 confidence   9 store + audit

CONFIDENCE (documented, per region):   conf = clamp(0.5*type_score + 0.3*geom_score + 0.2*text_quality)
  type_score    rule strength in [0,1] (see _ts_* below).  geom_score = 1.0 if bbox inside page and area >= 0.0005*page else 0.5.
  text_quality  = share of non-garbled chars (PDF) or mean OCR word confidence (images); 1.0 for table/figure/chart.
layout_class_confidence = mean(region conf) * 0.5 + rule_strength * 0.5.

Never invents values: when a class cannot be decided the answer is "other" with a warning, never a guess.
Thresholds come from /config (layout.*) with the defaults below.
"""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass
from typing import Any, Callable, Optional

import numpy as np
from fastapi import APIRouter, Request
from PIL import Image
from pydantic import BaseModel, Field

try:
    from backend.agents import b_common as bc
except ImportError:  # pragma: no cover
    import b_common as bc  # type: ignore

fitz = bc.fitz
AGENT = "05_layout"
router = APIRouter()

REGION_TYPES = ["text", "title", "table", "figure", "chart", "equation", "header", "footer", "list", "caption", "signature", "stamp", "form_field"]
LAYOUT_CLASSES = ["single_column", "multi_column", "form", "invoice_like", "slide", "spreadsheet_like", "other"]
PRIORITY = {"table": 5, "chart": 4, "figure": 4, "equation": 3}


# --------------------------------------------------------------------------- models
class LayoutInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, default=1)
    refresh: bool = False  # recompute even if a stored layout exists


class Region(BaseModel):
    region_id: str
    type: str
    location: bc.Location
    extraction_method: str
    confidence: float = Field(ge=0, le=1)
    text_preview: Optional[str] = None
    font_size: Optional[float] = None
    signals: dict = {}


class LayoutOutput(BaseModel):
    source_id: str
    page_id: str
    page_number: int
    page_width: int
    page_height: int
    layout_class: str
    layout_class_confidence: float
    layout_class_signals: dict = {}
    regions: list[Region]
    warnings: list[bc.WarningItem] = []
    stats: dict = {}


# --------------------------------------------------------------------------- thresholds
def T(name: str, default: Any) -> Any:
    return bc.cfg(f"layout.{name}", default)


# --------------------------------------------------------------------------- optional model plug-in
_MODEL: Optional[Callable] = None
_MODEL_NAME = "model"


def set_layout_model(fn: Optional[Callable], name: str = "model") -> None:
    """fn(PIL RGB image) -> [{"type": <REGION_TYPES>, "bbox": [x1,y1,x2,y2] (image px), "score": 0..1}]"""
    global _MODEL, _MODEL_NAME
    _MODEL, _MODEL_NAME = fn, name


# --------------------------------------------------------------------------- text-block abstraction (shared by both engines)
@dataclass
class TB:
    bbox: list
    text: str
    line_texts: list
    size: float                      # font size (pt) or word height (px) - only compared within the page
    bold: bool = False
    mathfont: float = 0.0            # share of chars in math fonts
    q: float = 1.0                   # text quality
    src: str = "pdf_native"
    mean_size_ratio: float = 1.0


MATH_CH = set("∑∫∏√≤≥≠≈±∞∂∇×÷∈∉⊂⊃⊆⊇∪∩→←⇒⇔∀∃αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ")
SEMI_MATH = set("=+−-/^<>")
BULLET = re.compile(r"^\s*(?:[•●○▪■◦·\-–—*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivxIVX]{1,4}[.)])\s+\S")
CAPTION = re.compile(r"^\s*(figure|fig\.|table|chart|graph|diagram|exhibit)\s*[0-9IVXivx]+[.:)\-\s]", re.I)
PAGE_NUM = re.compile(r"^\s*(page\s*)?\d{1,4}(\s*(of|/)\s*\d{1,4})?\s*$", re.I)
FORM_LINE = re.compile(r"(_{3,}|\.{5,})|^[\w .#/()'-]{2,40}:\s*$")
SIGN = re.compile(r"\b(signature|signed|authori[sz]ed signatory|sign here)\b", re.I)
MATHFONT = re.compile(r"math|cmmi|cmsy|cmex|cmr|symbol|stix|cambria math|euclid", re.I)


def math_ratio(s: str) -> float:
    ns = [c for c in s if not c.isspace()]
    if not ns:
        return 0.0
    m = sum(1.0 if c in MATH_CH else 0.5 if c in SEMI_MATH else 0.0 for c in ns)
    return m / len(ns)


def prose_words(s: str) -> int:
    return len(re.findall(r"[A-Za-z]{4,}", s))


def classify_text(tb: TB, W: int, H: int, body: float, min_math: float) -> tuple:
    """-> (type, type_score, signals). Order matters: header/footer, caption, equation, signature/form, list, title, text."""
    x1, y1, x2, y2 = tb.bbox
    chars = len(tb.text.replace("\n", ""))
    nl = len(tb.line_texts)
    sig: dict = {"chars": chars, "lines": nl, "size_ratio": round(tb.size / body, 2) if body else 1.0}
    first = tb.line_texts[0] if tb.line_texts else tb.text
    if (y2 <= H * T("header_band", 0.06) or y1 >= H * (1 - T("footer_band", 0.06))) and chars <= 120 and nl <= 2 and tb.size <= body * 1.15:
        kind = "header" if y2 <= H * 0.5 else "footer"
        return kind, (0.9 if PAGE_NUM.match(tb.text) else 0.8), sig
    if CAPTION.match(first):
        return "caption", 0.9, sig
    mr = math_ratio(tb.text)
    sig["math_ratio"] = round(mr, 2)
    has_math = any(c in MATH_CH for c in tb.text) or "=" in tb.text
    if nl <= 3 and chars <= 200 and has_math and prose_words(tb.text) <= 2 and (mr >= min_math or tb.mathfont >= 0.5):
        cx = (x1 + x2) / 2 / W
        sig["centered"] = 0.35 <= cx <= 0.65
        return "equation", min(1.0, 0.5 + mr + (0.1 if sig["centered"] else 0.0)), sig
    if SIGN.search(tb.text) and chars <= 80:
        return "signature", 0.6, sig
    form_lines = sum(1 for l in tb.line_texts if FORM_LINE.search(l))
    if form_lines and form_lines >= max(1, nl // 2) and chars <= 160:
        return "form_field", 0.7, sig
    bl = sum(1 for l in tb.line_texts if BULLET.match(l))
    if bl and bl >= max(1, (nl + 1) // 2) and (nl > 1 or bl == nl):
        return "list", 0.85, sig
    ratio = tb.size / body if body else 1.0
    if chars <= 160 and nl <= 3 and (ratio >= T("title_size_ratio", 1.25) or (tb.bold and nl == 1 and chars <= 100 and ratio >= 1.0 and tb.src == "pdf_native")):
        return "title", min(1.0, 0.55 + 0.45 * min(1.0, max(0.0, ratio - 1.0) / 0.5)), sig
    return "text", (0.8 if tb.src == "pdf_native" else 0.7), sig


def geom_score(b: list, W: int, H: int) -> float:
    inside = b[0] >= -1 and b[1] >= -1 and b[2] <= W + 1 and b[3] <= H + 1
    return 1.0 if inside and bc.area(b) >= T("min_area_frac", 0.0005) * W * H else 0.5


def mk_region(ctx: bc.PageCtx, typ: str, bbox: list, method: str, type_score: float, text_q: float = 1.0, text: Optional[str] = None,
              size: Optional[float] = None, signals: Optional[dict] = None) -> Region:
    b = bc.clamp_box(bbox, ctx.width, ctx.height)
    conf = max(0.0, min(1.0, 0.5 * type_score + 0.3 * geom_score(bbox, ctx.width, ctx.height) + 0.2 * text_q))
    return Region(region_id=bc.stable_id(ctx.page_id, typ, *[round(v) for v in b]), type=typ, location=ctx.loc(b), extraction_method=method,
                  confidence=round(conf, 3), text_preview=(text[:120] if text else None), font_size=(round(size, 2) if size else None), signals=signals or {})


# --------------------------------------------------------------------------- raster chart score (shared)
def raster_chart_score(img: Image.Image) -> float:
    """REQUIRES axes (long H line low + long V line left) = 0.5; then few colours +0.2, mostly white 0.1, many short bars/ticks 0.2. -> [0,1]"""
    import cv2
    im = img.convert("RGB")
    s = 600.0 / max(im.size)
    if s < 1:
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))))
    arr = np.asarray(im)
    g = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    h, w = g.shape
    if h < 20 or w < 20:
        return 0.0
    edges = cv2.Canny(g, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=40, minLineLength=int(0.4 * min(h, w)), maxLineGap=3)
    horiz = vert = False
    if lines is not None:
        for l in np.asarray(lines).reshape(-1, 4):
            x1, y1, x2, y2 = [int(v) for v in l]
            if abs(y1 - y2) <= 2 and y1 > h * 0.4:
                horiz = True
            if abs(x1 - x2) <= 2 and x1 < w * 0.6:
                vert = True
    if not (horiz and vert):
        return 0.2 if (horiz or vert) else 0.0  # no axes -> never a chart (photos/noise can have few colours)
    score = 0.5
    q = (arr >> 4).reshape(-1, 3)
    ncol = len(np.unique(q[:, 0].astype(np.int32) * 256 + q[:, 1].astype(np.int32) * 16 + q[:, 2]))
    if ncol < 64:
        score += 0.2
    if (g > 235).mean() >= 0.5:
        score += 0.1
    cnts, _ = cv2.findContours(cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rects = [cv2.boundingRect(c) for c in cnts]
    bars = [r for r in rects if r[2] * r[3] > 0.002 * w * h and r[3] > r[2] * 0.5]
    if len(bars) >= 3:
        score += 0.2
    return round(min(1.0, score), 3)


# --------------------------------------------------------------------------- PDF native engine
def _numeric_like(s: str) -> bool:
    s = s.strip()
    return bool(s) and bool(re.fullmatch(r"[\(\-−]?[$€£]?\d[\d,.\s]*%?[\)]?[kKmMbB]?", s))


def _pdf_text_blocks(ctx: bc.PageCtx) -> tuple:
    """-> (list[TB], body_size, total_chars). Span-weighted body size; tiny/empty blocks dropped (pre-processing)."""
    with ctx.lock:
        d = ctx.page.get_text("dict", flags=fitz.TEXT_MEDIABOX_CLIP)
    tbs: list = []
    sizes: list = []
    for b in d.get("blocks", []):
        if b.get("type") != 0:
            continue
        lines, bold_chars, math_chars, tot, szs = [], 0, 0, 0, []
        for ln in b.get("lines", []):
            txt = "".join(sp["text"] for sp in ln.get("spans", []))
            if not txt.strip():
                continue
            lines.append(re.sub(r"\s+", " ", txt).strip())
            for sp in ln["spans"]:
                n = len(sp["text"].strip())
                if n == 0:
                    continue
                tot += n
                szs.append((sp["size"], n))
                if sp["flags"] & 16 or "bold" in sp["font"].lower():
                    bold_chars += n
                if MATHFONT.search(sp["font"]):
                    math_chars += n
        if not lines or tot == 0:
            continue
        text = "\n".join(lines)
        sizes += szs
        size = max(szs, key=lambda t: t[1])[0] if szs else 10.0
        tbs.append(TB(ctx.pt_to_px(b["bbox"]), text, lines, float(size), bold_chars >= 0.8 * tot, math_chars / tot, bc.text_confidence(text)))
    if sizes:
        flat = [s for s, n in sizes for _ in range(min(n, 400))]
        body = float(statistics.median(flat))
    else:
        body = 10.0
    return tbs, body, sum(len(t.text) for t in tbs)


def _pdf_tables(ctx: bc.PageCtx, warns: list) -> list:
    out = []
    try:
        with ctx.lock:
            tf = ctx.page.find_tables()
            for t in tf.tables:
                if t.row_count >= 2 and t.col_count >= 2:
                    out.append((ctx.vis_to_px(t.bbox), t.row_count, t.col_count))
        # second pass: BORDERLESS tables (text-alignment strategy). Strict, to avoid calling prose a table:
        # >= 3 rows, >= 3 columns, >= 70% of cells filled, >= 20% of filled cells numeric.
        with ctx.lock:
            tf = ctx.page.find_tables(strategy="text")
            for t in tf.tables:
                if t.row_count < 3 or t.col_count < 3:
                    continue
                rows = t.extract()
                cells = [c for r in rows for c in r]
                rows = [r for r in rows if any(c and str(c).strip() for c in r)]   # text strategy yields blank spacer rows
                cells = [c for r in rows for c in r]
                filled = [c for c in cells if c and str(c).strip()]
                if len(rows) < 3 or not cells or len(filled) / len(cells) < 0.7 or sum(1 for c in filled if _numeric_like(str(c))) / len(filled) < 0.2:
                    continue
                b = ctx.vis_to_px(t.bbox)
                if any(bc.iou(b, o[0]) > 0.3 for o in out):
                    continue
                out.append((b, t.row_count, t.col_count))
    except Exception as e:
        bc.dbg(AGENT, "find_tables_failed", err=type(e).__name__)
        warns.append(bc.warn("TABLE_FINDER_FAILED", "Table finder failed on this page; tables may be missing", error=type(e).__name__))
    return out


def _pdf_figures(ctx: bc.PageCtx, tables: list, tbs: list, warns: list) -> list:
    """-> list of (bbox_px, kind 'figure'|'chart', type_score, signals). Raster images + vector-drawing clusters."""
    W, H = ctx.width, ctx.height
    out = []
    with ctx.lock:
        infos = ctx.page.get_image_info()
        drawings = ctx.page.get_drawings()
        pw, ph = ctx.page.rect.width, ctx.page.rect.height
    tab_boxes = [t[0] for t in tables]
    for im in infos:
        b = ctx.pt_to_px(im["bbox"])
        if bc.area(b) < T("min_figure_frac", 0.005) * W * H or any(bc.contain(b, tb) > 0.6 for tb in tab_boxes):
            continue
        crop = ctx.img.crop(tuple(int(v) for v in bc.clamp_box(b, W, H)))
        cs = raster_chart_score(crop) if min(crop.size) >= 20 else 0.0
        if cs >= T("chart_min_score", 0.6):
            out.append((b, "chart", 0.5 + 0.5 * cs, {"chart_score": cs, "source": "raster"}))
        else:
            out.append((b, "figure", 0.9, {"source": "raster", "chart_score": cs}))
    if len(drawings) > int(T("max_drawings", 6000)):
        warns.append(bc.warn("TOO_MANY_DRAWINGS", "Vector drawing count is very high; vector figures were skipped", count=len(drawings)))
        return out
    items = []
    for d in drawings:
        r = d["rect"]
        if r.width > 0.95 * pw and r.height > 0.95 * ph:
            continue  # page background
        if r.is_empty and r.width == 0 and r.height == 0:
            continue
        items.append(d)
    items.sort(key=lambda d: d["rect"].x0)
    gap = 4.0
    uf = bc.UnionFind(len(items))
    for i in range(len(items)):
        ri = items[i]["rect"]
        for j in range(i + 1, len(items)):
            rj = items[j]["rect"]
            if rj.x0 > ri.x1 + gap:
                break
            if rj.y0 <= ri.y1 + gap and rj.y1 >= ri.y0 - gap:
                uf.union(i, j)
    def _union(ds):  # manual union: empty (line) rects are ignored by Rect.__or__
        return fitz.Rect(min(d["rect"].x0 for d in ds), min(d["rect"].y0 for d in ds), max(d["rect"].x1 for d in ds), max(d["rect"].y1 for d in ds))

    def _has_axes(ds, rect):
        ls = [it for d in ds for it in d["items"] if it[0] == "l"]
        return (any(abs(it[1].y - it[2].y) < 1 and abs(it[1].x - it[2].x) > 0.4 * rect.width for it in ls)
                and any(abs(it[1].x - it[2].x) < 1 and abs(it[1].y - it[2].y) > 0.4 * rect.height for it in ls))
    clusters = [[items[k] for k in grp] for grp in uf.groups()]
    # a plot area (drawn inside a pair of axes) is one figure: merge clusters that lie inside an axes cluster
    clusters.sort(key=lambda ds: -_union(ds).get_area())
    merged: list = []
    for ds in clusters:
        r_ = _union(ds)
        host = next((m for m in merged if _has_axes(m, _union(m)) and (_union(m) + (-4, -4, 4, 4)).contains(r_)), None)
        if host is not None:
            host.extend(ds)
        else:
            merged.append(list(ds))
    for ds in merged:
        n_items = sum(len(d["items"]) for d in ds)
        rect = _union(ds)
        if n_items < 4 or rect.width < 24 or rect.height < 24 or rect.width * rect.height < T("min_figure_frac", 0.005) * pw * ph:
            continue
        b = ctx.pt_to_px(rect)
        if any(bc.contain(b, tb) > 0.6 for tb in tab_boxes) or any(bc.contain(tb, b) > 0.9 for tb in tab_boxes):
            continue
        if any(bc.contain(b, o[0]) > 0.8 for o in out):
            continue
        bars = [d for d in ds if d.get("fill") is not None and d["items"] and d["items"][0][0] == "re"]
        widths = sorted(round(d["rect"].width) for d in bars)
        similar = bool(widths) and sum(1 for w in widths if abs(w - widths[len(widths) // 2]) <= 2) >= 3
        segs = sum(1 for d in ds for it in d["items"] if it[0] == "l")
        curves = sum(1 for d in ds if d.get("fill") is not None and any(it[0] == "c" for it in d["items"]))
        long_h = any(it[0] == "l" and abs(it[1].y - it[2].y) < 1 and abs(it[1].x - it[2].x) > 0.4 * rect.width for d in ds for it in d["items"])
        long_v = any(it[0] == "l" and abs(it[1].x - it[2].x) < 1 and abs(it[1].y - it[2].y) > 0.4 * rect.height for d in ds for it in d["items"])
        score = 0.0
        score += 0.6 if similar else 0.0
        score += 0.4 if (segs >= 6 and not similar) else 0.0
        score += 0.4 if curves >= 3 else 0.0
        score += 0.1 if (long_h and long_v) else 0.0
        near = sum(1 for tb in tbs if bc.contain(tb.bbox, bc.union_box([b, [b[0] - 40, b[1] - 20, b[2] + 20, b[3] + 40]])) > 0.8 and _numeric_like(tb.text))
        score += 0.2 if near >= 3 else 0.0
        score = round(min(1.0, score), 3)
        # absorb tick / axis labels that sit just outside the drawn cluster (short, single-line, not captions)
        mx, my = 0.07 * W, 0.025 * H
        ring = [b[0] - mx, b[1] - my, b[2] + mx, b[3] + my]
        grown = [b]
        for tb in tbs:
            if (len(tb.text.replace("\n", " ")) <= 48 and all(len(l) <= 14 for l in tb.line_texts) and not CAPTION.match(tb.text)
                    and ring[0] <= (tb.bbox[0] + tb.bbox[2]) / 2 <= ring[2] and ring[1] <= (tb.bbox[1] + tb.bbox[3]) / 2 <= ring[3]):
                grown.append(tb.bbox)
        b = bc.union_box(grown)
        sg = {"source": "vector", "items": n_items, "bars": len(bars) if similar else 0, "segments": segs, "curves": curves, "chart_score": score}
        if score >= T("chart_min_score", 0.6):
            out.append((b, "chart", 0.5 + 0.5 * score, sg))
        else:
            out.append((b, "figure", 0.5 + 0.5 * min(1.0, n_items / 40), sg))
    return out


def _merge_lists(regs: list, ctx: bc.PageCtx) -> list:
    """vertically adjacent list items (gap < 1.5 line) -> one list region"""
    lists = sorted([r for r in regs if r.type == "list"], key=lambda r: r.location.bbox[1])
    others = [r for r in regs if r.type != "list"]
    merged: list = []
    for r in lists:
        b = r.location.bbox
        if merged:
            pb = merged[-1].location.bbox
            lh = max(1.0, (pb[3] - pb[1]) / max(1, merged[-1].signals.get("lines", 1)))
            if b[1] - pb[3] <= 1.5 * lh and abs(b[0] - pb[0]) <= 0.06 * ctx.width:
                u = bc.union_box([pb, b])
                prev = merged[-1]
                lines = prev.signals.get("lines", 1) + r.signals.get("lines", 1)
                merged[-1] = mk_region(ctx, "list", u, prev.extraction_method, min(prev.signals.get("ts", 0.85), 0.85), 1.0,
                                       (prev.text_preview or "") + "\n" + (r.text_preview or ""), prev.font_size, {"lines": lines, "ts": 0.85, "merged": True})
                continue
        merged.append(r)
    return others + merged


def _build_regions_pdf(ctx: bc.PageCtx, warns: list) -> list:
    t = bc.Timer()
    tbs, body, nchars = _pdf_text_blocks(ctx)
    bc.dbg(AGENT, "pdf_text_blocks", blocks=len(tbs), body_size=round(body, 2), chars=nchars, ms=t.ms())
    tables = _pdf_tables(ctx, warns)
    bc.dbg(AGENT, "pdf_tables", count=len(tables))
    figs = _pdf_figures(ctx, tables, tbs, warns)
    bc.dbg(AGENT, "pdf_figures", count=len(figs), charts=sum(1 for f in figs if f[1] == "chart"))
    regs: list = []
    for b, rows, cols in tables:
        regs.append(mk_region(ctx, "table", b, "pdf_native", 0.6 + 0.4 * min(1.0, rows * cols / 12), 1.0, signals={"rows": rows, "cols": cols}))
    for b, kind, ts, sg in figs:
        regs.append(mk_region(ctx, kind, b, "pdf_native", ts, 1.0, signals=sg))
    big = [r.location.bbox for r in regs]
    for tb in tbs:
        if any(bc.contain(tb.bbox, bb) >= 0.7 for bb in big):  # text inside table/figure belongs to it
            continue
        typ, ts, sg = classify_text(tb, ctx.width, ctx.height, body, T("equation_min_math_ratio", 0.2))
        sg["ts"] = ts
        sg["lines"] = len(tb.line_texts)
        regs.append(mk_region(ctx, typ, tb.bbox, "pdf_native", ts, tb.q, tb.text, tb.size, sg))
    return regs


# --------------------------------------------------------------------------- image / scanned engine
def _group_lines(words: list) -> list:
    """words -> list of lines (list of words), by y-centre proximity"""
    ws = sorted(words, key=lambda w: ((w["bbox"][1] + w["bbox"][3]) / 2, w["bbox"][0]))
    lines: list = []
    for w in ws:
        cy = (w["bbox"][1] + w["bbox"][3]) / 2
        h = w["bbox"][3] - w["bbox"][1]
        if lines and abs(cy - lines[-1]["cy"]) <= 0.6 * max(h, lines[-1]["h"]):
            ln = lines[-1]
            ln["w"].append(w)
            ln["cy"] = (ln["cy"] * (len(ln["w"]) - 1) + cy) / len(ln["w"])
            ln["h"] = max(ln["h"], h)
        else:
            lines.append({"w": [w], "cy": cy, "h": h})
    for ln in lines:
        ln["w"].sort(key=lambda w: w["bbox"][0])
    return [ln["w"] for ln in lines]


def _build_regions_image(ctx: bc.PageCtx, warns: list, method: str) -> list:
    import cv2
    t = bc.Timer()
    W, H = ctx.width, ctx.height
    f = min(1.0, 1600.0 / max(W, H))
    gray = ctx.gray()
    if f < 1.0:
        gray = cv2.resize(gray, (int(W * f), int(H * f)), interpolation=cv2.INTER_AREA)
    gh, gw = gray.shape
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, binv = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    bc.dbg(AGENT, "cv_binarised", work=f"{gw}x{gh}", scale=round(f, 3), ink=round(float((binv > 0).mean()), 4), ms=t.ms())
    # --- table detection via line masks
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, gw // 25), 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(15, gh // 25)))
    hmask = cv2.morphologyEx(binv, cv2.MORPH_OPEN, hk)
    vmask = cv2.morphologyEx(binv, cv2.MORPH_OPEN, vk)
    grid = cv2.dilate(cv2.bitwise_or(hmask, vmask), cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7)))
    cnts, _ = cv2.findContours(grid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    tables: list = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if w * h < 0.01 * gw * gh or w < 0.15 * gw or h < 0.03 * gh:
            continue
        nh = cv2.connectedComponents(hmask[y:y + h, x:x + w])[0] - 1
        nv = cv2.connectedComponents(vmask[y:y + h, x:x + w])[0] - 1
        if nh >= 2 and nv >= 2:
            tables.append(([x / f, y / f, (x + w) / f, (y + h) / f], max(1, nh - 1), max(1, nv - 1)))
    bc.dbg(AGENT, "cv_tables", count=len(tables))
    # --- one OCR pass for the whole page
    words = bc.ocr_words(ctx.img, psm=3)
    mean_conf = sum(w["conf"] for w in words) / len(words) if words else 0.0
    bc.dbg(AGENT, "cv_ocr", words=len(words), mean_conf=round(mean_conf, 3), ms=t.ms())
    regs: list = []
    for b, rows, cols in tables:
        regs.append(mk_region(ctx, "table", b, method, 0.55 + 0.35 * min(1.0, rows * cols / 12), 1.0, signals={"rows": rows, "cols": cols}))
    tab_boxes = [r.location.bbox for r in regs]
    words = [w for w in words if not any(bc.contain(w["bbox"], tb) > 0.5 for tb in tab_boxes)]
    # --- remove table lines and text from the ink mask; what is left and big = figures
    ink = binv.copy()
    for w in words:
        x1, y1, x2, y2 = [int(v * f) for v in w["bbox"]]
        ink[max(0, y1 - 2):y2 + 2, max(0, x1 - 2):x2 + 2] = 0
    for tb in tab_boxes:
        x1, y1, x2, y2 = [int(v * f) for v in tb]
        ink[y1:y2, x1:x2] = 0
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    fig_mask = cv2.dilate(ink, cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, gw // 60), max(9, gw // 60))))
    cnts, _ = cv2.findContours(fig_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    figs: list = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if w * h < T("min_figure_frac", 0.005) * 4 * gw * gh or w < 0.1 * gw or h < 0.05 * gh:
            continue
        if float((ink[y:y + h, x:x + w] > 0).mean()) < 0.01:
            continue
        figs.append([x / f, y / f, (x + w) / f, (y + h) / f])
    for b in figs:
        crop = ctx.img.crop(tuple(int(v) for v in bc.clamp_box(b, W, H)))
        cs = raster_chart_score(crop)
        if cs >= T("chart_min_score", 0.6):
            regs.append(mk_region(ctx, "chart", b, method, 0.5 + 0.5 * cs, 1.0, signals={"chart_score": cs, "source": "raster"}))
        else:
            regs.append(mk_region(ctx, "figure", b, method, 0.8, 1.0, signals={"chart_score": cs, "source": "raster"}))
    bc.dbg(AGENT, "cv_figures", count=len(figs))
    words = [w for w in words if not any(bc.contain(w["bbox"], fb) > 0.6 for fb in figs)]
    # --- text blocks: group words into lines, lines into blocks by vertical gap + column overlap
    lines = _group_lines(words)
    heights = [w["bbox"][3] - w["bbox"][1] for ln in lines for w in ln]
    body = float(statistics.median(heights)) if heights else 10.0
    blocks: list = []
    for ln in lines:
        lb = bc.union_box([w["bbox"] for w in ln])
        placed = False
        for blk in blocks:
            bb = blk["bbox"]
            gap = lb[1] - bb[3]
            ov = min(bb[2], lb[2]) - max(bb[0], lb[0])
            lh = max(1.0, blk["lh"])
            if -0.3 * lh <= gap <= 0.9 * lh and ov > 0.3 * min(bb[2] - bb[0], lb[2] - lb[0]) and abs((lb[3] - lb[1]) - lh) <= 0.5 * lh:
                blk["lines"].append(ln)
                blk["bbox"] = bc.union_box([bb, lb])
                placed = True
                break
        if not placed:
            blocks.append({"bbox": lb, "lines": [ln], "lh": lb[3] - lb[1]})
    for blk in blocks:
        ln_txt = [" ".join(w["text"] for w in ln) for ln in blk["lines"]]
        sz = float(statistics.median([w["bbox"][3] - w["bbox"][1] for ln in blk["lines"] for w in ln]))
        q = sum(w["conf"] for ln in blk["lines"] for w in ln) / sum(len(ln) for ln in blk["lines"])
        tb = TB(blk["bbox"], "\n".join(ln_txt), ln_txt, sz, False, 0.0, q, "ocr")
        typ, ts, sg = classify_text(tb, W, H, body, T("equation_min_math_ratio", 0.2))
        sg["ts"], sg["lines"] = ts, len(ln_txt)
        regs.append(mk_region(ctx, typ, tb.bbox, method, ts, q, tb.text, sz, sg))
    bc.dbg(AGENT, "cv_blocks", count=len(blocks), body_px=round(body, 1), ms=t.ms())
    return regs


# --------------------------------------------------------------------------- overlap resolution + page class
def resolve_overlaps(regs: list) -> list:
    keep = []
    for r in sorted(regs, key=lambda r: (-PRIORITY.get(r.type, 1), -r.confidence)):
        b = r.location.bbox
        drop = False
        for k in keep:
            kb = k.location.bbox
            if PRIORITY.get(k.type, 1) > PRIORITY.get(r.type, 1) and bc.contain(b, kb) >= 0.8:
                drop = True
            elif PRIORITY.get(k.type, 1) == PRIORITY.get(r.type, 1) and bc.iou(b, kb) >= 0.9:
                drop = True
            if drop:
                break
        if not drop:
            keep.append(r)
    keep.sort(key=lambda r: (r.location.bbox[1], r.location.bbox[0], r.type))
    return keep


def page_class(regs: list, W: int, H: int) -> tuple:
    """-> (class, strength 0..1, signals). Deterministic rules; 'other' when nothing fits."""
    if not regs:
        return "other", 0.0, {"reason": "no_regions"}
    texts = [r for r in regs if r.type in ("text", "list", "title")]
    full = " ".join((r.text_preview or "") for r in regs).lower()
    tabs = [r for r in regs if r.type == "table"]
    tab_frac = sum(bc.area(r.location.bbox) for r in tabs) / (W * H)
    ff = sum(1 for r in regs if r.type in ("form_field", "signature"))
    sig = {"regions": len(regs), "tables": len(tabs), "table_area_frac": round(tab_frac, 3), "form_fields": ff}
    if tabs and tab_frac >= 0.6:
        return "spreadsheet_like", 0.9, sig
    if ff >= 3:
        return "form", min(1.0, 0.5 + 0.1 * ff), sig
    if tabs and re.search(r"\b(invoice|bill to|amount due|subtotal|total due|invoice no|tax invoice)\b", full):
        return "invoice_like", 0.85, sig
    n_title = sum(1 for r in regs if r.type == "title")
    if W > H * 1.3 and len(texts) <= 12 and n_title >= 1 and sum(len(r.text_preview or "") for r in texts) < 900:
        return "slide", 0.7, sig
    narrow = [r for r in texts if (r.location.bbox[2] - r.location.bbox[0]) < 0.6 * W and len(r.text_preview or "") > 40]
    if len(narrow) >= 4:
        mid = W / 2
        left = [r for r in narrow if r.location.bbox[2] <= mid + 0.05 * W]
        right = [r for r in narrow if r.location.bbox[0] >= mid - 0.05 * W]
        sig.update(left=len(left), right=len(right))
        if len(left) >= 2 and len(right) >= 2:
            return "multi_column", 0.8, sig
    if texts:
        return "single_column", 0.75, sig
    return "other", 0.3, sig


# --------------------------------------------------------------------------- orchestration
def analyze_page(ctx: bc.PageCtx) -> LayoutOutput:
    t = bc.Timer()
    warns: list = []
    W, H = ctx.width, ctx.height
    regs: list = []
    method = "pdf_native"
    if _MODEL is not None:
        try:
            dets = _MODEL(ctx.img)
            for d in dets:
                if d.get("type") in REGION_TYPES and len(d.get("bbox", [])) == 4:
                    regs.append(mk_region(ctx, d["type"], d["bbox"], f"layout_model:{_MODEL_NAME}", float(d.get("score", 0.5)), 1.0, signals={"model": _MODEL_NAME}))
            method = f"layout_model:{_MODEL_NAME}"
            bc.dbg(AGENT, "model_regions", count=len(regs))
        except Exception as e:
            bc.dbg(AGENT, "model_failed_fallback", err=type(e).__name__)
            warns.append(bc.warn("MODEL_FAILED", "Layout model failed; heuristic engine used", error=type(e).__name__))
            regs = []
    if not regs:
        scanned = False
        if ctx.kind == "pdf":
            tbs, _, nchars = _pdf_text_blocks(ctx)
            with ctx.lock:
                infos = ctx.page.get_image_info()
            cover = max((bc.area(ctx.pt_to_px(i["bbox"])) / (W * H) for i in infos), default=0.0)
            scanned = nchars < 20 and cover >= 0.8
            bc.dbg(AGENT, "engine_probe", chars=nchars, image_cover=round(cover, 2), scanned=scanned)
        if ctx.kind == "pdf" and not scanned:
            method = "pdf_native"
            regs = _build_regions_pdf(ctx, warns)
        else:
            method = "cv_ocr"
            if ctx.kind == "pdf":
                warns.append(bc.warn("SCANNED_PAGE_OCR", "Page has no text layer; layout was derived from the image and OCR"))
            regs = _build_regions_image(ctx, warns, method)
        regs = _merge_lists(regs, ctx)
    regs = resolve_overlaps(regs)
    bc.dbg(AGENT, "regions_final", count=len(regs), by_type={ty: sum(1 for r in regs if r.type == ty) for ty in REGION_TYPES if any(r.type == ty for r in regs)})
    cls, strength, csig = page_class(regs, W, H)
    mean_conf = sum(r.confidence for r in regs) / len(regs) if regs else 0.0
    ccf = round(0.5 * mean_conf + 0.5 * strength, 3)
    low = [r.region_id for r in regs if r.confidence < T("low_conf", 0.5)]
    if low:
        warns.append(bc.warn("LOW_CONFIDENCE_REGION", f"{len(low)} region(s) have confidence below {T('low_conf', 0.5)}", region_ids=low))
    if not regs:
        warns.append(bc.warn("NO_REGIONS", "No regions were detected on this page"))
    if cls == "other" and regs:
        warns.append(bc.warn("LAYOUT_CLASS_UNDECIDED", "Page class could not be decided; reported as 'other'"))
    return LayoutOutput(source_id=ctx.source_id, page_id=ctx.page_id, page_number=ctx.page_number, page_width=W, page_height=H, layout_class=cls,
                        layout_class_confidence=ccf, layout_class_signals=csig, regions=regs, warnings=warns,
                        stats={"engine": method, "ms": t.ms(), "regions": len(regs)})


def run(req: LayoutInput, user: Optional[dict] = None) -> LayoutOutput:
    if user is None:
        user = bc.current_user()
    bc.dbg(AGENT, "start", source_id=req.source_id, page=req.page_number, user=user.get("user_id"))
    ctx = bc.load_page(req.source_id, req.page_number, user)
    out = analyze_page(ctx)
    d = bc.jsonable_encoder(out)
    try:
        bc.store().put("layout", ctx.page_id, d)
    except Exception as e:
        bc.dbg(AGENT, "store_put_failed_nonfatal", err=type(e).__name__)
    bc.audit("layout.analyzed", "page", ctx.page_id, {"regions": len(out.regions), "layout_class": out.layout_class, "engine": out.stats["engine"]}, user=user)
    bc.dbg(AGENT, "done", regions=len(out.regions), layout_class=out.layout_class, ms=out.stats["ms"])
    return out


@router.post("/agents/layout")
def layout_endpoint(body: dict, request: Request):
    return bc.handle(request, lambda: run(LayoutInput.model_validate(body)))
