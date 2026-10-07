"""
09_chart_figure.py - Agent 09: Chart & Figure Understanding  (Person B).   POST /agents/chart-figure

Chart / figure regions of a page -> structured chart data (type, title, axes, series, points) or a figure record.

Engines (extraction_method on every point/result):
  "pdf_vector"     born-digital charts: the drawn bars/lines ARE the data. Axis ticks (numeric text) calibrate pixel->value by least
                   squares; bars: top edge, lines: vertices. Printed data labels, when present, are used and cross-checked.
  "derender_model" optional plug-in (DePlot / MatCha / vision LLM routed through common.llm_guard) via set_derender_engine(fn)
  "none"           raster charts with no plug-in: type + visible text only, data = null (NOT guessed) + DATA_NOT_EXTRACTED warning

Pipeline (debug line per step):
  1 load page + layout, pick chart/figure regions   2 words (PDF text layer or OCR)   3 vector primitives in the region
  4 axes + bars + lines   5 y calibration (+ R^2)   6 categories, legend, data labels   7 values + evidence   8 confidence   9 store + audit

CONFIDENCE (documented):
  calib_q       = 1.0 if R^2 >= 0.9999, else R^2 clipped to [0,1], and 0 (values withheld) if fewer than 2 numeric ticks or R^2 < 0.99
  point.conf    = calib_q * (0.9 if category label found else 0.75) + (0.1 if a printed data label agrees within 1%)  [clipped to 1]
                  value taken from a printed data label (value_source="data_label") -> 0.95 (+0.05 if it agrees with the geometry)
  chart.conf    = mean(point.conf); 0.0 when there are no points
  figure.conf   = layout region confidence (nothing is measured)
Never invents: no calibration -> value null (+ CALIBRATION_FAILED); unreadable category -> x_label null; pie slices are not measured
(UNSUPPORTED_CHART_TYPE); horizontal bars are not measured (UNSUPPORTED_ORIENTATION).
"""
from __future__ import annotations

import hashlib
import statistics
from typing import Callable, Optional

import numpy as np
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

try:
    from backend.agents import b_common as bc
except ImportError:  # pragma: no cover
    import b_common as bc  # type: ignore

fitz = bc.fitz
AGENT = "09_chart_figure"
router = APIRouter()

# --------------------------------------------------------------------------- plug-ins
_DERENDER: Optional[Callable] = None
_DESCRIBER: Optional[Callable] = None


def set_derender_engine(fn: Optional[Callable]) -> None:
    """fn(PIL RGB crop) -> {"chart_type","title","x_axis":{"title","categories"},"y_axis":{"title"},
       "series":[{"name","points":[{"x_label","value","confidence"?}]}]}   (route LLMs through common.llm_guard inside fn)"""
    global _DERENDER
    _DERENDER = fn


def set_figure_describer(fn: Optional[Callable]) -> None:
    """fn(PIL RGB crop) -> str description (grounded by the caller via common.llm_guard)"""
    global _DESCRIBER
    _DESCRIBER = fn


# --------------------------------------------------------------------------- models
class ChartFigureInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, default=1)
    region_id: Optional[str] = None


class Point(BaseModel):
    x_label: Optional[str] = None
    value: Optional[float] = None
    value_source: str = "axis_calibration"      # axis_calibration | data_label | derender_model
    verified_by_label: bool = False
    location: bc.Location
    extraction_method: str
    confidence: float = Field(ge=0, le=1)


class Series(BaseModel):
    series_id: str
    name: Optional[str] = None
    color: Optional[str] = None
    kind: str                                    # bar | line
    points: list[Point]


class Axis(BaseModel):
    title: Optional[str] = None
    categories: list[str] = []
    ticks: list[dict] = []
    scale: Optional[str] = None
    calibration: Optional[dict] = None


class ChartResult(BaseModel):
    region_id: str
    kind: str                                    # chart | figure
    chart_type: Optional[str] = None             # bar | grouped_bar | line | combo | pie | unknown
    title: Optional[str] = None
    caption: Optional[str] = None
    x_axis: Axis = Axis()
    y_axis: Axis = Axis()
    series: list[Series] = []
    text_in_figure: list[str] = []
    description: Optional[str] = None
    image_sha1: Optional[str] = None
    location: bc.Location
    extraction_method: str
    confidence: float = Field(ge=0, le=1)
    signals: dict = {}
    warnings: list[bc.WarningItem] = []


class ChartFigureOutput(BaseModel):
    source_id: str
    page_id: str
    page_number: int
    results: list[ChartResult]
    warnings: list[bc.WarningItem] = []


def T(name: str, default):
    return bc.cfg(f"chart.{name}", default)


# --------------------------------------------------------------------------- helpers
def _hex(c) -> Optional[str]:
    if c is None:
        return None
    try:
        return "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in c[:3])
    except Exception:
        return None


def _is_white(c) -> bool:
    return c is not None and all(v >= 0.97 for v in c[:3])


def _parse_num(s: str) -> Optional[float]:
    return bc.import_agent("07_table").parse_number(s)[0]


def _px_pt(ctx: bc.PageCtx, p) -> tuple:
    q = fitz.Point(p) * ctx.rot
    return q.x * ctx.sx, q.y * ctx.sx


def vector_primitives(ctx: bc.PageCtx, bbox: list) -> dict:
    """filled rects (bars/swatches), stroked straight segments, curve-filled paths inside the region (all in px)"""
    r = ctx.px_to_pt(bbox).normalize()
    with ctx.lock:
        drawings = ctx.page.get_drawings()
    rects, segs, pies = [], [], 0
    for d in drawings:
        dr = d["rect"]
        if dr.x1 < r.x0 or dr.x0 > r.x1 or dr.y1 < r.y0 or dr.y0 > r.y1 or dr.width > r.width * 1.05:   # outside the region, or spans beyond it (page rules)
            continue   # (manual overlap test: pure horizontal/vertical lines have an EMPTY rect, which Rect.intersects() rejects)
        has_c = any(it[0] == "c" for it in d["items"])
        if d.get("fill") is not None and has_c:
            pies += 1
        for it in d["items"]:
            if it[0] == "re" and d.get("fill") is not None and not _is_white(d["fill"]):
                rects.append({"bbox": ctx.pt_to_px(it[1]), "color": _hex(d["fill"])})
            elif it[0] == "re" and d.get("fill") is None and d.get("color") is not None:   # outlined rect: 4 thin edges not needed
                continue
            elif it[0] == "l":
                x1, y1 = _px_pt(ctx, it[1])
                x2, y2 = _px_pt(ctx, it[2])
                segs.append({"p1": (x1, y1), "p2": (x2, y2), "color": _hex(d.get("color")), "width": d.get("width") or 0.0})
            elif it[0] == "re" and d.get("fill") is not None:   # white fill = background panel; ignore
                continue
    return {"rects": rects, "segs": segs, "pie_paths": pies}


def fit_axis(ticks: list) -> Optional[dict]:
    """ticks [(pixel_y, value)] -> {"a","b","r2"} for value = a*pixel + b, or None"""
    if len(ticks) < 2:
        return None
    ys = np.array([t[0] for t in ticks], dtype=float)
    vs = np.array([t[1] for t in ticks], dtype=float)
    if np.ptp(ys) < 1e-6:
        return None
    a, b = np.polyfit(ys, vs, 1)
    pred = a * ys + b
    ss_res = float(((vs - pred) ** 2).sum())
    ss_tot = float(((vs - vs.mean()) ** 2).sum())
    r2 = 1.0 if ss_tot < 1e-12 else max(0.0, 1.0 - ss_res / ss_tot)
    return {"a": float(a), "b": float(b), "r2": float(r2), "n": len(ticks)}


def calib_quality(cal: Optional[dict]) -> float:
    if not cal or cal["r2"] < 0.99:
        return 0.0
    return 1.0 if cal["r2"] >= 0.9999 else float(cal["r2"])


def _lines_in_chain(segs: list) -> list:
    """connect segments sharing endpoints (tol 1.5px) -> list of vertex lists sorted by x"""
    chains: list = []
    for s in sorted(segs, key=lambda s: (min(s["p1"][0], s["p2"][0]), s["p1"][1])):
        a, b = sorted([s["p1"], s["p2"]])
        placed = False
        for ch in chains:
            if ch["color"] == s["color"] and abs(ch["pts"][-1][0] - a[0]) <= 1.5 and abs(ch["pts"][-1][1] - a[1]) <= 1.5:
                ch["pts"].append(b)
                placed = True
                break
        if not placed:
            chains.append({"color": s["color"], "pts": [a, b]})
    return chains


# --------------------------------------------------------------------------- vector derendering
def derender_vector(ctx: bc.PageCtx, region: dict, words: list, warns: list) -> Optional[dict]:
    t = bc.Timer()
    bbox = region["location"]["bbox"]
    prim = vector_primitives(ctx, bbox)
    W = bbox[2] - bbox[0]
    Hh = bbox[3] - bbox[1]
    rects = [r for r in prim["rects"] if bc.area(r["bbox"]) < 0.5 * W * Hh and (r["bbox"][2] - r["bbox"][0]) < 0.6 * W]
    segs = prim["segs"]
    hl = [s for s in segs if abs(s["p1"][1] - s["p2"][1]) < 1 and abs(s["p1"][0] - s["p2"][0]) >= 0.5 * W * 0.6]
    vl = [s for s in segs if abs(s["p1"][0] - s["p2"][0]) < 1 and abs(s["p1"][1] - s["p2"][1]) >= 0.5 * Hh * 0.6]
    bc.dbg(AGENT, "primitives", rects=len(rects), segs=len(segs), hlines=len(hl), vlines=len(vl), pie_paths=prim["pie_paths"])
    if prim["pie_paths"] >= 3 and not rects:
        warns.append(bc.warn("UNSUPPORTED_CHART_TYPE", "Pie/donut slices are not measured; only the chart type and visible text are reported"))
        return {"chart_type": "pie", "series": [], "x_axis": Axis(), "y_axis": Axis(), "title": None, "signals": {"pie_paths": prim["pie_paths"]}}
    # ---- bars (vertical): bars share a baseline; legend swatches are small and not on it
    bars: list = []
    if rects:
        bottoms = sorted(rects, key=lambda r: r["bbox"][3])
        groups: list = []
        for r in bottoms:
            if groups and abs(groups[-1][-1]["bbox"][3] - r["bbox"][3]) <= 2.0:
                groups[-1].append(r)
            else:
                groups.append([r])
        best = max(groups, key=lambda g: (len(g), -g[0]["bbox"][3]))
        if len(best) >= 2 or (len(best) == 1 and not segs):
            med_area = statistics.median(bc.area(r["bbox"]) for r in best)
            bars = [r for r in best if bc.area(r["bbox"]) >= 0.15 * med_area]
            lefts = {round(r["bbox"][0] / 2) for r in bars}
            if len(bars) >= 3 and len(lefts) == 1:   # same left edge -> horizontal bars
                warns.append(bc.warn("UNSUPPORTED_ORIENTATION", "Horizontal bar charts are not measured"))
                return {"chart_type": "bar", "series": [], "x_axis": Axis(), "y_axis": Axis(), "title": None, "signals": {"orientation": "horizontal"}}
    bar_ids = {id(b) for b in bars}
    swatches = [r for r in rects if id(r) not in bar_ids and bc.area(r["bbox"]) < 0.05 * W * Hh]
    base_px = max((b["bbox"][3] for b in bars), default=None)
    # ---- axes (lines closest to the baseline / left of the plot)
    axis_y = None
    if hl:
        cand = [s["p1"][1] for s in hl]
        axis_y = min(cand, key=lambda y: abs(y - base_px)) if base_px is not None else max(cand)
    axis_x = min((s["p1"][0] for s in vl), default=None)
    # ---- y ticks = numeric words left of the y axis, label centre ~ tick
    ticks: list = []
    ref_x = axis_x if axis_x is not None else (min(b["bbox"][0] for b in bars) if bars else bbox[0] + 0.15 * W)
    plot_top = min([b["bbox"][1] for b in bars] + [min(s["p1"][1], s["p2"][1]) for s in vl] + [axis_y or bbox[3]])
    plot_bot = axis_y if axis_y is not None else (base_px if base_px is not None else bbox[3])
    for w in words:
        cx, cy = (w["bbox"][0] + w["bbox"][2]) / 2, (w["bbox"][1] + w["bbox"][3]) / 2
        v = _parse_num(w["text"])
        if v is not None and cx < ref_x + 2 and cx > ref_x - 0.3 * W and plot_top - 12 <= cy <= plot_bot + 12:
            ticks.append((cy, v, w))
    # drop duplicate values (same label twice)
    seen, tk = set(), []
    for cy, v, w in sorted(ticks, key=lambda t: t[0]):
        if v not in seen:
            seen.add(v)
            tk.append((cy, v, w))
    # snap each label to the short tick mark next to it (exact pixel row); labels without a tick mark keep their centre
    tick_marks = [s["p1"][1] for s in segs if abs(s["p1"][1] - s["p2"][1]) < 1 and abs(s["p1"][0] - s["p2"][0]) <= 0.08 * W and abs(max(s["p1"][0], s["p2"][0]) - ref_x) <= 0.03 * W + 3]
    snapped = []
    for cy, v, w in tk:
        hh = w["bbox"][3] - w["bbox"][1]
        near = [y for y in tick_marks if abs(y - cy) <= 0.8 * hh]
        snapped.append((min(near, key=lambda y: abs(y - cy)) if near else cy, v, w))
    tk = snapped
    cal = fit_axis([(c, v) for c, v, _ in tk])
    cq = calib_quality(cal)
    bc.dbg(AGENT, "calibration", ticks=len(tk), r2=round(cal["r2"], 5) if cal else None, quality=cq)
    if cq == 0.0:
        warns.append(bc.warn("CALIBRATION_FAILED", "The value axis could not be calibrated from numeric tick labels; computed values are withheld", ticks=len(tk)))
    # ---- categories = non-numeric words below the baseline (one text row nearest to it)
    cats: list = []
    if plot_bot is not None:
        below = [w for w in words if (w["bbox"][1] + w["bbox"][3]) / 2 > plot_bot + 1
                 and (_parse_num(w["text"]) is None or (w["bbox"][1] + w["bbox"][3]) / 2 < plot_bot + 0.1 * Hh)]
        if below:
            top_row_y = min((w["bbox"][1] + w["bbox"][3]) / 2 for w in below)
            row = [w for w in below if abs((w["bbox"][1] + w["bbox"][3]) / 2 - top_row_y) <= 0.6 * (w["bbox"][3] - w["bbox"][1])]
            cats = sorted(row, key=lambda w: w["bbox"][0])
    cat_c = [((w["bbox"][0] + w["bbox"][2]) / 2, w["text"]) for w in cats]

    def cat_for(x: float, tol: float) -> Optional[str]:
        if not cat_c:
            return None
        cx, t = min(cat_c, key=lambda c: abs(c[0] - x))
        return t if abs(cx - x) <= tol else None
    # ---- legend: swatch + word to the right on the same line
    legend = {}
    for s in swatches:
        sb = s["bbox"]
        cy = (sb[1] + sb[3]) / 2
        cands = [w for w in words if w["bbox"][0] >= sb[2] - 1 and abs((w["bbox"][1] + w["bbox"][3]) / 2 - cy) <= (sb[3] - sb[1]) and w["bbox"][0] - sb[2] < 0.15 * W and _parse_num(w["text"]) is None]
        if cands:
            nxt = min(cands, key=lambda w: w["bbox"][0])
            line = sorted([w for w in cands if abs(w["bbox"][1] - nxt["bbox"][1]) < 3], key=lambda w: w["bbox"][0])
            legend[s["color"]] = " ".join(w["text"] for w in line)
    # ---- series
    series: list = []
    value_words = [(w, _parse_num(w["text"])) for w in words if _parse_num(w["text"]) is not None]
    if bars:
        by_color: dict = {}
        for b in sorted(bars, key=lambda b: b["bbox"][0]):
            by_color.setdefault(b["color"], []).append(b)
        merged_color = len(by_color) == len(bars) and len(bars) > 1 and not legend
        groups = {"__all__": sorted(bars, key=lambda b: b["bbox"][0])} if merged_color else by_color
        med_w = statistics.median(b["bbox"][2] - b["bbox"][0] for b in bars)
        for color, bl in groups.items():
            pts = []
            for b in bl:
                bb = b["bbox"]
                cx = (bb[0] + bb[2]) / 2
                label = cat_for(cx, max(1.5 * med_w, 0.08 * W))
                calc = None
                if cal and cq > 0:
                    calc = cal["a"] * bb[1] + cal["b"]
                # printed data label directly above the bar
                above = [(w, v) for w, v in value_words if bb[0] - 2 <= (w["bbox"][0] + w["bbox"][2]) / 2 <= bb[2] + 2 and bb[1] - 0.12 * Hh <= (w["bbox"][1] + w["bbox"][3]) / 2 <= bb[1] + 2]
                above = [(w, v) for w, v in above if not (w["bbox"][2] < ref_x + 2)]
                val, src, ver = calc, "axis_calibration", False
                if above:
                    w, v = min(above, key=lambda t: abs((t[0]["bbox"][1] + t[0]["bbox"][3]) / 2 - bb[1]))
                    if calc is not None and abs(v - calc) <= 0.01 * max(abs(v), abs(calc), 1e-9) + 1e-9:
                        val, src, ver = v, "data_label", True
                    elif calc is not None:
                        val, src = v, "data_label"
                        warns.append(bc.warn("DATA_LABEL_MISMATCH", "A printed data label differs from the bar height; the printed value was used", label=v, measured=round(calc, 4)))
                    else:
                        val, src = v, "data_label"
                if val is None:
                    conf = 0.0
                else:
                    if src == "data_label":
                        conf = 0.95 + (0.05 if ver else 0.0)
                    else:
                        conf = cq * (0.9 if label else 0.75)
                pts.append(Point(x_label=label, value=(round(val, 6) if val is not None else None), value_source=src, verified_by_label=ver, location=ctx.loc(bb),
                                 extraction_method="pdf_vector", confidence=round(min(1.0, conf), 3)))
            series.append(Series(series_id=bc.stable_id(ctx.page_id, region["region_id"], "bar", color), name=legend.get(color) if color != "__all__" else None,
                                 color=color if color != "__all__" else None, kind="bar", points=pts))
    # ---- lines (non-axis, non-grid segments chained by colour)
    data_segs = [s for s in segs if not (abs(s["p1"][1] - s["p2"][1]) < 1 or abs(s["p1"][0] - s["p2"][0]) < 1)]
    if len(data_segs) >= 2 and not (bars and len(data_segs) < 3):
        for ch in _lines_in_chain(data_segs):
            if len(ch["pts"]) < 3:
                continue
            pts = []
            for (x, y) in ch["pts"]:
                label = cat_for(x, 0.08 * W)
                val = (cal["a"] * y + cal["b"]) if (cal and cq > 0) else None
                conf = 0.0 if val is None else cq * (0.9 if label else 0.75)
                pts.append(Point(x_label=label, value=round(val, 6) if val is not None else None, location=ctx.loc([x - 2, y - 2, x + 2, y + 2]), extraction_method="pdf_vector",
                                 confidence=round(conf, 3)))
            series.append(Series(series_id=bc.stable_id(ctx.page_id, region["region_id"], "line", ch["color"], round(ch["pts"][0][0])), name=legend.get(ch["color"]), color=ch["color"], kind="line", points=pts))
    if not series:
        return None
    kinds = {s.kind for s in series}
    ctype = "combo" if len(kinds) > 1 else ("line" if kinds == {"line"} else ("grouped_bar" if len(series) > 1 else "bar"))
    # ---- title / axis titles from plain text outside the plot
    title = None
    text_rows = [w for w in words if _parse_num(w["text"]) is None and w not in cats]
    band = [bbox[0], bbox[1] - 0.1 * ctx.height, bbox[2], bbox[1]]
    band_words = [w for w in bc.pdf_words(ctx, band, pad_pt=0.0) if _parse_num(w["text"]) is None and w["bbox"][3] <= bbox[1] + 1]
    if band_words:  # title printed just above the drawn chart (outside the region) - take the nearest line only
        nearest = max(w["bbox"][3] for w in band_words)
        ln = sorted([w for w in band_words if nearest - w["bbox"][3] <= 4], key=lambda w: w["bbox"][0])
        txt = " ".join(w["text"] for w in ln)
        if len(txt) <= 80 and not txt.lower().startswith(("figure", "fig.", "table", "chart")):
            title = txt
    if title is None and text_rows:
        above = [w for w in text_rows if (w["bbox"][3]) <= plot_top - 2]
        if above:
            ty = min(w["bbox"][1] for w in above)
            title = " ".join(w["text"] for w in sorted([w for w in above if abs(w["bbox"][1] - ty) <= 4], key=lambda w: w["bbox"][0])) or None
    x_title = None
    if cats and plot_bot is not None:
        cat_bottom = max(w["bbox"][3] for w in cats)
        under = [w for w in text_rows if w["bbox"][1] >= cat_bottom + 1 and w not in cats]
        if under:
            uy = min(w["bbox"][1] for w in under)
            x_title = " ".join(w["text"] for w in sorted([w for w in under if abs(w["bbox"][1] - uy) <= 4], key=lambda w: w["bbox"][0])) or None
    bc.dbg(AGENT, "derendered", chart_type=ctype, series=len(series), points=sum(len(s.points) for s in series), title=title, ms=t.ms())
    y_axis = Axis(title=None, ticks=[{"value": v, "pixel_y": round(c, 2)} for c, v, _ in tk], scale="linear" if cal else None,
                  calibration=({"r2": round(cal["r2"], 6), "n_ticks": cal["n"], "value_per_px": cal["a"], "quality": round(cq, 4)} if cal else None))
    return {"chart_type": ctype, "series": series, "x_axis": Axis(title=x_title, categories=[c[1] for c in cat_c]), "y_axis": y_axis, "title": title,
            "signals": {"bars": len(bars), "legend_entries": len(legend), "baseline_value_check": None}}


# --------------------------------------------------------------------------- orchestration
def _caption_for(layout: dict, region: dict) -> Optional[str]:
    regs = {r["region_id"]: r for r in layout["regions"]}
    caps = [r["region_id"] for r in layout["regions"] if r["type"] == "caption"]
    att = bc.import_agent("06_reading_order")._attach_captions(caps, [region["region_id"]], regs, layout["page_height"], 0.12)
    for cid, pid in sorted(att.items()):
        if pid == region["region_id"]:
            return (regs[cid].get("text_preview") or None)
    return None


def _from_engine(ctx: bc.PageCtx, region: dict, crop, warns: list) -> Optional[dict]:
    try:
        raw = _DERENDER(crop)
    except Exception as e:
        bc.dbg(AGENT, "derender_engine_failed", err=type(e).__name__)
        warns.append(bc.warn("DERENDER_FAILED", "The chart derender engine failed", error=type(e).__name__))
        return None
    if not isinstance(raw, dict) or not raw.get("series"):
        warns.append(bc.warn("DERENDER_EMPTY", "The chart derender engine returned no data"))
        return None
    series = []
    for i, s in enumerate(raw["series"]):
        pts = []
        for p in s.get("points", []):
            v = p.get("value")
            v = float(v) if isinstance(v, (int, float)) else None
            conf = min(float(p.get("confidence", 0.5)), 0.8)   # model output is never trusted above 0.8
            pts.append(Point(x_label=p.get("x_label"), value=v, value_source="derender_model", location=ctx.loc(None, "model_output_has_no_geometry"),
                             extraction_method="derender_model", confidence=round(conf if v is not None else 0.0, 3)))
        series.append(Series(series_id=bc.stable_id(ctx.page_id, region["region_id"], "model", i), name=s.get("name"), color=None, kind=s.get("kind", "bar"), points=pts))
    xa, ya = raw.get("x_axis") or {}, raw.get("y_axis") or {}
    return {"chart_type": raw.get("chart_type") or "unknown", "series": series, "title": raw.get("title"),
            "x_axis": Axis(title=xa.get("title"), categories=list(xa.get("categories") or [])), "y_axis": Axis(title=ya.get("title")), "signals": {"engine": "derender_model"}}


def analyze_region(ctx: bc.PageCtx, layout: dict, region: dict) -> ChartResult:
    warns: list = []
    bbox = region["location"]["bbox"]
    caption = _caption_for(layout, region)
    b = bc.clamp_box(bbox, ctx.width, ctx.height)
    crop = ctx.img.crop(tuple(int(v) for v in b))
    sha = hashlib.sha1(crop.tobytes()).hexdigest()
    words = bc.pdf_words(ctx, bbox) if ctx.kind == "pdf" else []
    word_src = "pdf_text_layer" if words else "none"
    kind = region["type"]
    bc.dbg(AGENT, "region", region_id=region["region_id"], kind=kind, words=len(words), source=region["signals"].get("source"))
    data = None
    method = "none"
    if kind == "chart":
        if ctx.kind == "pdf" and region["signals"].get("source") == "vector":
            data = derender_vector(ctx, region, words, warns)
            method = "pdf_vector" if data and data["series"] else "none"
        if (data is None or not data["series"]) and _DERENDER is not None and (data is None or data.get("chart_type") != "pie"):
            alt = _from_engine(ctx, region, crop, warns)
            if alt:
                data, method = alt, "derender_model"
        if data is None or not data["series"]:
            if _DERENDER is None and not any(w.code in ("UNSUPPORTED_CHART_TYPE", "UNSUPPORTED_ORIENTATION") for w in warns):
                warns.append(bc.warn("DATA_NOT_EXTRACTED", "No chart derender engine is configured for this chart, so no data values were extracted"))
    if not words and (ctx.kind != "pdf" or method == "none"):
        try:
            words = bc.ocr_words(crop, psm=11)
            for w in words:
                w["bbox"] = [w["bbox"][0] + b[0], w["bbox"][1] + b[1], w["bbox"][2] + b[0], w["bbox"][3] + b[1]]
            word_src = "ocr"
        except bc.AgentError:
            warns.append(bc.warn("OCR_FAILED", "Text inside the figure could not be read"))
    lines = bc.import_agent("05_layout")._group_lines(words) if words else []
    text_in = [" ".join(w["text"] for w in ln) for ln in lines][:60]
    description = None
    if kind == "figure" and _DESCRIBER is not None:
        try:
            description = str(_DESCRIBER(crop))[:2000] or None
        except Exception as e:
            warns.append(bc.warn("DESCRIBER_FAILED", "The figure describer failed", error=type(e).__name__))
    pts = [p for s in (data["series"] if data else []) for p in s.points]
    if kind == "chart" and pts:
        conf = sum(p.confidence for p in pts) / len(pts)
    elif kind == "chart":
        conf = 0.0
    else:
        conf = region["confidence"]
    sig = dict((data or {}).get("signals", {}))
    sig.update(word_source=word_src, layout_source=region["signals"].get("source"), layout_chart_score=region["signals"].get("chart_score"))
    return ChartResult(region_id=region["region_id"], kind=kind, chart_type=(data or {}).get("chart_type") if kind == "chart" else None,
                       title=(data or {}).get("title"), caption=caption, x_axis=(data or {}).get("x_axis", Axis()), y_axis=(data or {}).get("y_axis", Axis()),
                       series=(data or {}).get("series", []), text_in_figure=text_in, description=description, image_sha1=sha, location=ctx.loc(bbox),
                       extraction_method=method if kind == "chart" else ("describer" if description else "none"), confidence=round(max(0.0, min(1.0, conf)), 3),
                       signals=sig, warnings=warns)


def run(req: ChartFigureInput, user: Optional[dict] = None) -> ChartFigureOutput:
    if user is None:
        user = bc.current_user()
    t = bc.Timer()
    bc.dbg(AGENT, "start", source_id=req.source_id, page=req.page_number, region_id=req.region_id, user=user.get("user_id"))
    ctx = bc.load_page(req.source_id, req.page_number, user)
    layout = bc.get_layout(ctx)
    if req.region_id:
        reg = bc.find_region(layout, req.region_id)
        if reg["type"] not in ("chart", "figure"):
            raise bc.AgentError("INVALID_INPUT", "region_id is not a chart or figure region", {"type": reg["type"]})
        regions = [reg]
    else:
        regions = [r for r in layout["regions"] if r["type"] in ("chart", "figure")]
    results = [analyze_region(ctx, layout, r) for r in sorted(regions, key=lambda r: (r["location"]["bbox"][1], r["location"]["bbox"][0]))]
    warns = [] if results else [bc.warn("NO_CHARTS", "No chart or figure regions on this page")]
    out = ChartFigureOutput(source_id=ctx.source_id, page_id=ctx.page_id, page_number=ctx.page_number, results=results, warnings=warns)
    try:
        bc.store().put("charts", ctx.page_id, bc.jsonable_encoder(out))
    except Exception as e:
        bc.dbg(AGENT, "store_put_failed_nonfatal", err=type(e).__name__)
    bc.audit("chart_figure.analyzed", "page", ctx.page_id, {"results": len(results), "points": sum(len(s.points) for r in results for s in r.series)}, user=user)
    bc.dbg(AGENT, "done", results=len(results), ms=t.ms())
    return out


@router.post("/agents/chart-figure")
def chart_figure_endpoint(body: dict, request: Request):
    return bc.handle(request, lambda: run(ChartFigureInput.model_validate(body)))
