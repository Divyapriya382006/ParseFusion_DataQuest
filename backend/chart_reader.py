"""Bar-chart interpretation: turns the bars and axis labels of a chart into data series.

Input is geometry plus text, whichever way the chart was drawn:
  * vector charts  -> filled rectangles from the PDF drawing commands (exact)
  * raster charts  -> bars found by colour segmentation of the image crop (pixel-accurate)
  * labels         -> text boxes inside the chart (PDF text layer or OCR), in the same pixel space

Values are never guessed. The value axis is calibrated by a least-squares fit through the numeric tick labels
(pixel position -> value); the fit quality (R^2) and the number of ticks decide the confidence. If a chart prints
its values on the bars, those printed numbers are used and cross-checked against the geometry. If neither is
available the chart is reported with relative bar sizes only and `calibrated: false` (never invented numbers).

Everything is computed in page pixels. Thresholds are in platform_config.json -> "chart_reader".
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

Box = List[float]

DEFAULTS = {
    "min_bars": 2,                    # fewer rectangles than this is not a bar chart
    "min_bar_px": 3.0,                # a bar is at least this wide and tall (page pixels)
    "min_fill_ratio": 0.9,            # raster: a coloured blob must fill its bounding box this much to be a bar
    "edge_tolerance_px": 3.0,         # bars on one baseline / ticks on one axis line up within this
    "background_area_fraction": 0.4,  # a rectangle covering this much of the chart is the plot area, not a bar
    "near_white": 235,                # fills lighter than this (all channels) are background
    "colour_quantum": 24,             # raster: colours closer than this belong to one series
    "min_ticks": 2,                   # numeric tick labels needed to calibrate the value axis
    "min_r2": 0.995,                  # calibration quality needed to trust the axis
    "data_label_gap_fraction": 0.6,   # printed value sits within this many bar-widths of the bar end
    "legend_max_swatch_fraction": 0.25,  # swatch side relative to the median bar width
    "max_series": 12,
    "region_margin": {"left": 0.22, "right": 0.06, "top": 0.6, "bottom": 0.3},   # search zone around a bar group
    "label_max_words": 8,             # text lines longer than this are paragraphs, not chart labels
    "raster_min_confidence": 0.8,     # a picture is only called a chart when its axis or printed values were read
}


def settings() -> dict:
    try:
        from backend import platform_api
        user = platform_api._file_settings().get("chart_reader") or {}
    except Exception:
        user = {}
    return {**DEFAULTS, **{k: v for k, v in user.items() if k in DEFAULTS}}


# ----------------------------------------------------------------------------------------------- numbers
_NUM = re.compile(r"^[\(\-−+]?\s*[$₹€£]?\s*\d[\d,]*(?:\.\d+)?\s*(?:%|[kKmMbB])?\)?$")


def parse_number(text: str) -> Optional[float]:
    t = (text or "").strip().replace(" ", "")
    if not t or not _NUM.match(t):
        return None
    neg = t.startswith(("-", "−", "("))
    suffix = 1.0
    if t[-1] in "kK":
        suffix = 1e3
    elif t[-1] in "mM":
        suffix = 1e6
    elif t[-1] in "bB":
        suffix = 1e9
    core = re.sub(r"[^\d.]", "", t)
    try:
        v = float(core) * suffix
    except ValueError:
        return None
    return -v if neg else v


def _decimals(text: str) -> int:
    m = re.search(r"\.(\d+)", text or "")
    return len(m.group(1)) if m else 0


# ----------------------------------------------------------------------------------------------- geometry
def _w(b: Sequence[float]) -> float:
    return b[2] - b[0]


def _h(b: Sequence[float]) -> float:
    return b[3] - b[1]


def _cx(b: Sequence[float]) -> float:
    return (b[0] + b[2]) / 2


def _cy(b: Sequence[float]) -> float:
    return (b[1] + b[3]) / 2


def _hex(rgb: Sequence[float]) -> str:
    return "#%02x%02x%02x" % tuple(int(round(max(0, min(255, c)))) for c in rgb[:3])


def _same_colour(a: Sequence[float], b: Sequence[float], quantum: float) -> bool:
    return max(abs(a[i] - b[i]) for i in range(3)) <= quantum


# ----------------------------------------------------------------------------------------------- raster bars
def _runs(mask_row: np.ndarray) -> List[Tuple[int, int]]:
    d = np.diff(np.concatenate(([0], mask_row.astype(np.int8), [0])))
    starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
    return list(zip(starts.tolist(), ends.tolist()))


def components(mask: np.ndarray) -> List[Dict[str, Any]]:
    """Connected components of a boolean mask (4-connectivity) via run-length union-find. -> bbox + pixel count."""
    parent: List[int] = []

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    runs: List[Tuple[int, int, int]] = []     # (row, x0, x1)
    prev: List[int] = []
    for y in range(mask.shape[0]):
        cur = []
        for x0, x1 in _runs(mask[y]):
            idx = len(parent)
            parent.append(idx)
            runs.append((y, x0, x1))
            cur.append(idx)
            for j in prev:
                _, p0, p1 = runs[j]
                if p0 < x1 and x0 < p1:
                    a, b = find(idx), find(j)
                    if a != b:
                        parent[a] = b
        prev = cur
    groups: Dict[int, List[int]] = {}
    for i in range(len(runs)):
        groups.setdefault(find(i), []).append(i)
    out = []
    for idxs in groups.values():
        rs = [runs[i] for i in idxs]
        out.append({"bbox": [min(r[1] for r in rs), min(r[0] for r in rs), max(r[2] for r in rs), max(r[0] for r in rs) + 1],
                    "pixels": sum(r[2] - r[1] for r in rs)})
    return out


def _smooth(rgb: np.ndarray) -> np.ndarray:
    """3x3 mean: scanner noise and JPEG speckle would otherwise split one bar colour into many."""
    f = rgb.astype(np.float32)
    p = np.pad(f, ((1, 1), (1, 1), (0, 0)), mode="edge")
    h, w = rgb.shape[:2]
    acc = sum(p[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)) / 9.0
    return acc


def raster_rects(rgb: np.ndarray, cfg: dict) -> List[Dict[str, Any]]:
    """Solid rectangles in an image: [{bbox (crop px), colour (r,g,b), pixels}]."""
    h, w, _ = rgb.shape
    q = max(1, int(cfg["colour_quantum"]))
    sm = _smooth(rgb)
    key = (sm[:, :, 0].astype(np.int32) // q) * 1000000 + (sm[:, :, 1].astype(np.int32) // q) * 1000 + (sm[:, :, 2].astype(np.int32) // q)
    remaining = np.ones((h, w), dtype=bool)
    out: List[Dict[str, Any]] = []
    min_px = float(cfg["min_bar_px"])
    tol = q * 0.75
    for _ in range(40):
        vals, counts = np.unique(key[remaining], return_counts=True)
        if len(vals) == 0:
            break
        k = int(np.argmax(counts))
        if counts[k] < min_px * min_px:
            break
        seed = np.median(sm[remaining & (key == vals[k])], axis=0)
        mask = remaining & (np.abs(sm - seed).max(axis=2) <= tol)
        remaining &= ~mask
        if seed.min() >= float(cfg["near_white"]):
            continue
        colour = rgb[mask].mean(axis=0)
        for c in components(mask):
            bb = c["bbox"]
            bw, bh = bb[2] - bb[0], bb[3] - bb[1]
            if bw < min_px or bh < min_px:
                continue
            if c["pixels"] / float(bw * bh) < float(cfg["min_fill_ratio"]):
                continue
            out.append({"bbox": [float(v) for v in bb], "colour": tuple(float(v) for v in colour), "pixels": c["pixels"]})
    return out


def raster_tick_snap(rgb: np.ndarray, cfg: dict):
    """-> snap(vertical, label_bbox): exact position of the tick mark beside a value-axis label, from the pixels."""
    dark = rgb.astype(np.int32).sum(axis=2) < 3 * 110

    def snap(vertical: bool, bb: Sequence[float]) -> Optional[float]:
        H, W = dark.shape
        size = max(2, int(round((_h(bb) if vertical else _w(bb)) * 0.9)))
        if vertical:
            x0, x1 = int(bb[2]) + 2, min(W, int(bb[2]) + 2 + size)
            y0, y1 = max(0, int(bb[1] - _h(bb) * 0.6)), min(H, int(bb[3] + _h(bb) * 0.6))
            if x1 - x0 < 2 or y1 <= y0:
                return None
            counts = dark[y0:y1, x0:x1].sum(axis=1)
        else:
            y0, y1 = int(bb[3]) - int(_h(bb) * 0.2) - size, max(0, int(bb[1]) - 2)
            y0, y1 = max(0, min(y0, y1)), max(y0, y1)
            x0, x1 = max(0, int(bb[0] - _w(bb) * 0.6)), min(W, int(bb[2] + _w(bb) * 0.6))
            if y1 - y0 < 2 or x1 <= x0:
                return None
            counts = dark[y0:y1, x0:x1].sum(axis=0)
        if counts.max() < 4:
            return None
        hit = np.where(counts >= max(3.0, 0.5 * counts.max()))[0]
        if not len(hit):
            return None
        centre = (_cy(bb) - y0) if vertical else (_cx(bb) - x0)
        groups = np.split(hit, np.where(np.diff(hit) > 1)[0] + 1)
        g = min(groups, key=lambda g: abs(float(g.mean()) - centre))
        pos = float(g.mean()) + 0.5 + (y0 if vertical else x0)
        return pos if abs(pos - (_cy(bb) if vertical else _cx(bb))) <= 0.8 * (_h(bb) if vertical else _w(bb)) else None
    return snap


# ----------------------------------------------------------------------------------------------- vector bars
def vector_rects(page: Any, box_px: Box, scale: float, cfg: dict) -> Tuple[List[Dict[str, Any]], Any]:
    """Filled rectangles from the PDF drawing commands inside box_px, plus a tick snapper built from the short line
    segments (axis tick marks). Coordinates are page pixels (PDF points * scale)."""
    x0, y0, x1, y1 = [v / scale for v in box_px]
    rects: List[Dict[str, Any]] = []
    segs: List[Tuple[float, float, float, float]] = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return [], None
    tol = 0.6
    for d in drawings:
        r = d.get("rect")
        if r is None or r.x1 < x0 or r.x0 > x1 or r.y1 < y0 or r.y0 > y1:
            continue
        items = d.get("items", [])
        fill = d.get("fill")
        kinds = [it[0] for it in items]
        if fill is not None:
            boxes = []
            if kinds and all(k in ("re", "qu") for k in kinds):
                for it in items:
                    rr = it[1].rect if it[0] == "qu" else it[1]
                    boxes.append((rr.x0, rr.y0, rr.x1, rr.y1))
            elif kinds and set(kinds) <= {"l"} and 3 <= len(kinds) <= 5:
                xs = {round(p.x, 1) for it in items for p in (it[1], it[2])}
                ys = {round(p.y, 1) for it in items for p in (it[1], it[2])}
                if len(xs) <= 2 and len(ys) <= 2:
                    boxes.append((r.x0, r.y0, r.x1, r.y1))
            for b in boxes:
                if b[2] - b[0] > 0 and b[3] - b[1] > 0:
                    colour = tuple(float(c) * 255 for c in (fill if len(fill) == 3 else (fill[0],) * 3))
                    rects.append({"bbox": [b[0] * scale, b[1] * scale, b[2] * scale, b[3] * scale], "colour": colour, "pixels": 0})
        else:
            for it in items:
                if it[0] == "l":
                    a, b = it[1], it[2]
                    segs.append((a.x, a.y, b.x, b.y))
    # strokes that are drawn as thin filled rectangles are tick marks too
    for rc in list(rects):
        bb = rc["bbox"]
        if min(_w(bb), _h(bb)) < 1.6 * scale:
            segs.append((bb[0] / scale, bb[1] / scale, bb[2] / scale, bb[3] / scale))
    rects = [rc for rc in rects if min(_w(rc["bbox"]), _h(rc["bbox"])) >= 1.6 * scale or True]

    def snap(vertical: bool, bb: Sequence[float]) -> Optional[float]:
        want = _cy(bb) if vertical else _cx(bb)
        best = None
        for ax, ay, bx, by in segs:
            if vertical and abs(ay - by) <= tol and abs(bx - ax) < 12:                      # short horizontal tick
                pos = (ay + by) / 2 * scale
                near = abs(pos - want) <= 0.8 * _h(bb) and abs(max(ax, bx) * scale - bb[2]) <= 3 * _h(bb)
            elif not vertical and abs(ax - bx) <= tol and abs(by - ay) < 12:                 # short vertical tick
                pos = (ax + bx) / 2 * scale
                near = abs(pos - want) <= 0.8 * _w(bb) and abs(min(ay, by) * scale - bb[3]) <= 3 * _h(bb)
            else:
                continue
            if near and (best is None or abs(pos - want) < abs(best - want)):
                best = pos
        return best
    return rects, snap


# ----------------------------------------------------------------------------------------------- the reader
def _cluster_1d(values: List[float], tol: float) -> List[List[int]]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    groups: List[List[int]] = []
    for i in order:
        if groups and abs(values[i] - values[groups[-1][-1]]) <= tol:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


def _fit(pairs: List[Tuple[float, float]]) -> Optional[Tuple[float, float, float]]:
    """Least squares value = a * pixel + b. -> (a, b, r2)."""
    if len(pairs) < 2:
        return None
    px = np.array([p for p, _ in pairs], dtype=float)
    vals = np.array([v for _, v in pairs], dtype=float)
    if np.ptp(px) == 0 or np.ptp(vals) == 0:
        return None
    a, b = np.polyfit(px, vals, 1)
    pred = a * px + b
    ss_res = float(((vals - pred) ** 2).sum())
    ss_tot = float(((vals - vals.mean()) ** 2).sum())
    return float(a), float(b), 1.0 - ss_res / ss_tot if ss_tot else 0.0


def _axis_ticks(labels: List[dict], vertical: bool, bars_box: Box, tol: float, cfg: dict) -> List[dict]:
    """Numeric labels that sit in a line along the value axis: right edges aligned for a vertical-bar chart (labels
    to the left of the bars), centres aligned for horizontal bars (labels below). The largest such set wins."""
    cands = []
    for lb in labels:
        v = parse_number(lb["text"])
        if v is None:
            continue
        bb = lb["bbox"]
        if vertical and bb[2] <= bars_box[0] + tol and bars_box[1] - 2 * _h(bb) <= _cy(bb) <= bars_box[3] + 2 * _h(bb):
            cands.append({**lb, "value": v, "pos": _cy(bb), "align": bb[2], "_src": lb})
        elif not vertical and bb[1] >= bars_box[3] - tol and bars_box[0] - 2 * _w(bb) <= _cx(bb) <= bars_box[2] + 2 * _w(bb):
            cands.append({**lb, "value": v, "pos": _cx(bb), "align": _cy(bb), "_src": lb})
    best: List[dict] = []
    for grp in _cluster_1d([c["align"] for c in cands], max(tol, 0.8 * float(np.median([_h(c["bbox"]) for c in cands]) if cands else tol))):
        g = [cands[i] for i in grp]
        # one tick per position
        g = list({round(c["pos"]): c for c in g}.values())
        if len(g) > len(best):
            best = g
    return sorted(best, key=lambda c: c["pos"])


def read_bars(rects: List[Dict[str, Any]], labels: List[dict], chart_box: Box, cfg: Optional[dict] = None,
              title: Optional[str] = None, snap: Optional[Any] = None, exact: bool = False) -> Optional[Dict[str, Any]]:
    """rects: [{bbox, colour}] in page px (any order, may include plot background / legend swatches).
    labels: [{text, bbox, confidence}] in page px. -> chart dict or None when this is not a bar chart."""
    cfg = cfg or settings()
    tol = float(cfg["edge_tolerance_px"])
    area_box = max(1.0, _w(chart_box) * _h(chart_box))
    cands = [r for r in rects
             if _w(r["bbox"]) * _h(r["bbox"]) < float(cfg["background_area_fraction"]) * area_box
             and min(_w(r["bbox"]), _h(r["bbox"])) >= float(cfg["min_bar_px"])
             and min(r["colour"]) < float(cfg["near_white"])]
    if len(cands) < int(cfg["min_bars"]):
        return None

    # --- orientation and baseline: bars share an edge (bottom for vertical bars, left for horizontal)
    def aligned(idx_lo: int, idx_hi: int) -> Tuple[int, float]:
        edges = [r["bbox"][idx_lo] for r in cands] + [r["bbox"][idx_hi] for r in cands]
        groups = _cluster_1d(edges, tol)
        g = max(groups, key=len)
        return len(g), float(np.mean([edges[i] for i in g]))

    v_n, v_base = aligned(1, 3)
    h_n, h_base = aligned(0, 2)
    vertical = v_n >= h_n
    base_n, base = (v_n, v_base) if vertical else (h_n, h_base)
    if base_n < int(cfg["min_bars"]):
        return None
    lo, hi = (1, 3) if vertical else (0, 2)

    bars, swatches = [], []
    for r in cands:
        bb = r["bbox"]
        touches = abs(bb[lo] - base) <= tol or abs(bb[hi] - base) <= tol
        if touches:
            bars.append(r)
        else:
            swatches.append(r)
    # stacked bars do not all touch the baseline: a rectangle sitting on top of a bar of the same extent is a segment
    changed = True
    while changed:
        changed = False
        for r in list(swatches):
            bb = r["bbox"]
            for b in bars:
                bbb = b["bbox"]
                same_span = (abs(bb[0] - bbb[0]) <= tol and abs(bb[2] - bbb[2]) <= tol) if vertical else (abs(bb[1] - bbb[1]) <= tol and abs(bb[3] - bbb[3]) <= tol)
                adjacent = (abs(bb[3] - bbb[1]) <= tol or abs(bb[1] - bbb[3]) <= tol) if vertical else (abs(bb[2] - bbb[0]) <= tol or abs(bb[0] - bbb[2]) <= tol)
                if same_span and adjacent and _w(bb) * _h(bb) > 4 * tol * tol:
                    bars.append(r); swatches.remove(r); changed = True
                    break
    if len(bars) < int(cfg["min_bars"]):
        return None
    med_w = float(np.median([(_w(b["bbox"]) if vertical else _h(b["bbox"])) for b in bars]))
    # legend swatches: small squares with a text label right next to them
    legend: List[Dict[str, Any]] = []
    for sw in swatches:
        bb = sw["bbox"]
        if max(_w(bb), _h(bb)) > med_w * 3 or max(_w(bb), _h(bb)) < 2:
            continue
        near = [lb for lb in labels if lb["bbox"][0] >= bb[2] - tol and lb["bbox"][0] - bb[2] <= 4 * max(_w(bb), 6.0)
                and abs(_cy(lb["bbox"]) - _cy(bb)) <= max(_h(bb), _h(lb["bbox"]))]
        if near:
            legend.append({"colour": sw["colour"], "name": min(near, key=lambda lb: lb["bbox"][0] - bb[2])["text"].strip(), "bbox": bb})
    bars_box = [min(b["bbox"][0] for b in bars), min(b["bbox"][1] for b in bars), max(b["bbox"][2] for b in bars), max(b["bbox"][3] for b in bars)]

    # --- series by colour
    series_cols: List[Tuple[float, float, float]] = []
    for b in sorted(bars, key=lambda r: (r["bbox"][0], r["bbox"][1])):
        if not any(_same_colour(b["colour"], c, float(cfg["colour_quantum"])) for c in series_cols):
            series_cols.append(b["colour"])
    if len(series_cols) > int(cfg["max_series"]):
        return None
    for b in bars:
        b["series"] = next(i for i, c in enumerate(series_cols) if _same_colour(b["colour"], c, float(cfg["colour_quantum"])))

    # --- value axis calibration
    ticks = _axis_ticks(labels, vertical, bars_box, tol, cfg)
    if snap:   # move each label's position onto its tick mark (the label centre is a pixel or two off the mark)
        for t in ticks:
            tick_pos = snap(vertical, t["bbox"])
            if tick_pos is not None:
                t["pos"] = tick_pos
    fit = _fit([(t["pos"], t["value"]) for t in ticks]) if len(ticks) >= int(cfg["min_ticks"]) else None
    tick_ok = bool(fit and fit[2] >= float(cfg["min_r2"]))
    tick_srcs = {id(t["_src"]) for t in ticks}

    # category labels: non-numeric (or any not used as ticks) text on the category side of the plot
    cats: List[dict] = []
    for lb in labels:
        bb = lb["bbox"]
        if id(lb) in tick_srcs:
            continue
        if vertical and bb[1] >= base - tol and bars_box[0] - med_w <= _cx(bb) <= bars_box[2] + med_w:
            cats.append(lb)
        elif not vertical and bb[2] <= bars_box[0] + tol and bars_box[1] - med_w <= _cy(bb) <= bars_box[3] + med_w:
            cats.append(lb)
    # category labels sit on the bar side nearest to the baseline; drop the axis title (the farthest line)
    if cats:
        rows = _cluster_1d([c["bbox"][1] if vertical else c["bbox"][2] for c in cats], max(tol, 0.8 * float(np.median([_h(c["bbox"]) for c in cats]))))
        first = min(rows, key=lambda g: min(cats[i]["bbox"][1] if vertical else -cats[i]["bbox"][2] for i in g))
        axis_title = None
        rest = [cats[i] for g in rows if g is not first for i in g]
        if rest:
            axis_title = " ".join(c["text"].strip() for c in sorted(rest, key=lambda c: c["bbox"][0]))
        cats = [cats[i] for i in first]
    else:
        axis_title = None

    # printed values on the bars (data labels), used when the axis cannot be calibrated and to cross-check when it can
    def data_label(b: Dict[str, Any]) -> Optional[dict]:
        bb = b["bbox"]
        best = None
        for lb in labels:
            if id(lb) in tick_srcs or lb in cats or parse_number(lb["text"]) is None:
                continue
            lbb = lb["bbox"]
            gap = float(cfg["data_label_gap_fraction"]) * max(med_w, 1.0)
            if vertical:
                inside_x = bb[0] - tol <= _cx(lbb) <= bb[2] + tol
                near = (bb[1] - gap - _h(lbb) <= lbb[3] <= bb[1] + gap) or (bb[1] <= _cy(lbb) <= bb[3])
                dist = abs(lbb[3] - bb[1])
                if inside_x and near and (best is None or dist < best[0]):
                    best = (dist, lb)
            else:
                inside_y = bb[1] - tol <= _cy(lbb) <= bb[3] + tol
                near = (bb[2] - gap <= lbb[0] <= bb[2] + gap) or (bb[0] <= _cx(lbb) <= bb[2])
                dist = abs(lbb[0] - bb[2])
                if inside_y and near and (best is None or dist < best[0]):
                    best = (dist, lb)
        return best[1] if best else None

    labelled = {id(b): data_label(b) for b in bars}
    have_labels = sum(1 for v in labelled.values() if v) >= max(2, int(0.6 * len(bars)))

    # --- bar -> value
    stacked = False
    spans = [(b["bbox"][0], b["bbox"][2]) if vertical else (b["bbox"][1], b["bbox"][3]) for b in bars]
    for i, a in enumerate(spans):
        for j in range(i + 1, len(spans)):
            ov = min(a[1], spans[j][1]) - max(a[0], spans[j][0])
            if ov > 0.6 * min(a[1] - a[0], spans[j][1] - spans[j][0]):
                other = bars[j]["bbox"]; me = bars[i]["bbox"]
                if (vertical and (abs(me[3] - other[1]) <= tol or abs(me[1] - other[3]) <= tol)) or \
                        (not vertical and (abs(me[2] - other[0]) <= tol or abs(me[0] - other[2]) <= tol)):
                    stacked = True

    def px_value(pos: float) -> Optional[float]:
        return fit[0] * pos + fit[1] if fit else None

    points: List[Dict[str, Any]] = []
    dec = max([_decimals(t["text"]) for t in ticks] or [0])
    if fit and fit[0]:
        # no more digits than the picture can resolve: one pixel is |slope| value units (vector bars are exact: 2 more digits)
        dec = max(dec, int(math.floor(-math.log10(abs(fit[0])))) + (2 if exact else 0), 0)
    for b in bars:
        bb = b["bbox"]
        if vertical:
            up = base >= (bb[1] + bb[3]) / 2        # the baseline lies below the bar: it grows upwards
            end, seg_start = (bb[1], bb[3]) if up else (bb[3], bb[1])
        else:
            right = base <= (bb[0] + bb[2]) / 2     # the baseline lies left of the bar: it grows to the right
            end, seg_start = (bb[2], bb[0]) if right else (bb[0], bb[2])
        if not stacked:
            seg_start = base
        v_end, v_start = px_value(end), px_value(seg_start)
        value: Optional[float] = None
        source = None
        lb = labelled.get(id(b))
        if tick_ok and v_end is not None and v_start is not None:
            # a bar's value is the axis reading at its far end (the baseline may be drawn a pixel off the zero tick);
            # only stacked segments need the difference between their two ends
            value, source = round(v_end - v_start if stacked else v_end, dec), "axis_calibration"
            if lb is not None:
                printed = parse_number(lb["text"])
                if printed is not None and abs(printed - value) > max(abs(value) * 0.03, 10 ** -dec):
                    source = "axis_calibration_label_mismatch"
        elif have_labels and lb is not None:
            value, source = parse_number(lb["text"]), "printed_label"
        b["value"], b["source"] = value, source
        b["extent_px"] = abs(end - seg_start)
        # category by nearest label centre along the category axis
        centre = _cx(bb) if vertical else _cy(bb)
        if cats:
            c = min(cats, key=lambda lb2: abs((_cx(lb2["bbox"]) if vertical else _cy(lb2["bbox"])) - centre))
            b["category"] = c["text"].strip()
        else:
            b["category"] = None
        b["centre"] = centre

    # unlabeled categories fall back to the order of the bar groups
    if not cats:
        groups = _cluster_1d([b["centre"] for b in bars], max(med_w * 1.2, tol))
        for gi, g in enumerate(groups):
            for i in g:
                bars[i]["category"] = str(gi + 1)

    # series names: legend by colour, else "Series n"
    names: List[str] = []
    for i, col in enumerate(series_cols):
        lg = next((l for l in legend if _same_colour(l["colour"], col, float(cfg["colour_quantum"]))), None)
        names.append(lg["name"] if lg else (f"Series {i + 1}" if len(series_cols) > 1 else (title or "Values")))
    if len(series_cols) == 1 and not legend:
        names = [title or "Values"]

    cat_order: List[str] = []
    for b in sorted(bars, key=lambda x: x["centre"]):
        if b["category"] not in cat_order:
            cat_order.append(b["category"])
    series_out = []
    for i, col in enumerate(series_cols):
        pts = [b for b in sorted(bars, key=lambda x: x["centre"]) if b["series"] == i]
        series_out.append({"name": names[i], "color": _hex(col), "points": [
            {"category": b["category"], "value": b["value"], "value_source": b["source"],
             "relative_size": None, "bbox": [round(v, 1) for v in b["bbox"]]} for b in pts]})
    maxext = max([b["extent_px"] for b in bars] or [1.0]) or 1.0
    for s_i, s in enumerate(series_out):
        for p, b in zip(s["points"], [b for b in sorted(bars, key=lambda x: x["centre"]) if b["series"] == s_i]):
            p["relative_size"] = round(b["extent_px"] / maxext, 4)

    calibrated = any(b["value"] is not None for b in bars)
    n_values = sum(1 for b in bars if b["value"] is not None)
    mismatch = any(b["source"] == "axis_calibration_label_mismatch" for b in bars)
    if tick_ok:
        conf = 0.97 if len(ticks) >= 3 else 0.85
        if not cats:
            conf -= 0.15
        if mismatch:
            conf -= 0.25
    elif have_labels and n_values:
        conf = 0.85 if not cats else 0.9
    else:
        conf = 0.4
    unit = None
    if ticks:   # an axis title is a non-numeric label beyond the tick labels
        side = [lb for lb in labels if parse_number(lb["text"]) is None and id(lb) not in {id(c) for c in cats}
                and ((vertical and lb["bbox"][2] <= min(t["bbox"][0] for t in ticks) + tol) or (not vertical and lb["bbox"][1] >= max(t["bbox"][3] for t in ticks) - tol))]
        if side:
            unit = " ".join(l["text"].strip() for l in sorted(side, key=lambda l: l["bbox"][1]))
    title_guess = None
    skip = {id(c) for c in cats} | tick_srcs | {id(l) for l in labels if any(l["bbox"] == g["bbox"] for g in legend)}
    head = [lb for lb in labels if id(lb) not in skip and parse_number(lb["text"]) is None and lb["bbox"][3] <= bars_box[1] + tol
            and not any(abs(_cy(lb["bbox"]) - _cy(g["bbox"])) <= _h(lb["bbox"]) and lb["bbox"][0] >= g["bbox"][2] - tol for g in legend)]
    if head:
        top = min(head, key=lambda lb: lb["bbox"][1])
        title_guess = top["text"].strip()
    return {
        "title": title_guess, "chart_type": "bar", "orientation": "vertical" if vertical else "horizontal", "stacked": stacked,
        "series": series_out, "categories": cat_order,
        "value_axis": {"label": unit, "calibrated": tick_ok, "ticks_used": len(ticks) if tick_ok else 0,
                       "fit_r2": round(fit[2], 5) if fit else None,
                       "min": min([t["value"] for t in ticks], default=None), "max": max([t["value"] for t in ticks], default=None)},
        "category_axis": {"label": axis_title},
        "values_available": calibrated, "confidence": round(max(0.0, min(1.0, conf)), 3),
        "legend_found": bool(legend),
    }


def describe(chart: Dict[str, Any], title: Optional[str] = None) -> str:
    """One readable paragraph with every number (this text is what search, facts and chat read)."""
    unit = (chart.get("value_axis") or {}).get("label")
    head = f"{'Stacked ' if chart.get('stacked') else ''}{chart.get('orientation', 'vertical')} bar chart"
    if title:
        head += f" \"{title}\""
    bits = [head + (f" (values in {unit})" if unit else "") + "."]
    series = chart.get("series") or []
    for s in series:
        pts = s.get("points") or []
        if all(p.get("value") is None for p in pts):
            body = ", ".join(f"{p['category']}: relative size {p['relative_size']}" for p in pts)
        else:
            body = ", ".join(f"{p['category']} = {p['value']:g}" for p in pts if p.get("value") is not None)
        bits.append(f"{s['name']}: {body}.")
    vals = [(s["name"], p["category"], p["value"]) for s in series for p in s.get("points", []) if p.get("value") is not None]
    if vals:
        hi, lo = max(vals, key=lambda t: t[2]), min(vals, key=lambda t: t[2])
        multi = len(series) > 1
        fmt = lambda t: f"{t[1]}{' (' + t[0] + ')' if multi else ''} at {t[2]:g}"
        bits.append(f"Highest: {fmt(hi)}; lowest: {fmt(lo)}.")
        if len(series) == 1 and len(series[0]["points"]) >= 2:
            first, last = series[0]["points"][0], series[0]["points"][-1]
            if first.get("value") not in (None, 0) and last.get("value") is not None:
                change = (last["value"] - first["value"]) / abs(first["value"]) * 100
                bits.append(f"From {first['category']} to {last['category']} the value changes by {change:+.1f}%.")
    if not chart.get("values_available"):
        bits.append("The value axis could not be calibrated, so only relative bar sizes are known.")
    return " ".join(bits)


# ----------------------------------------------------------------------------------------------- orchestration
def interpret_region(box: Box, scale: float, *, page: Any = None, image_png: Optional[bytes] = None,
                     labels: Optional[List[dict]] = None, ocr_labels: Optional[Any] = None, title: Optional[str] = None,
                     cfg: Optional[dict] = None) -> Optional[Dict[str, Any]]:
    """Reads the bar chart inside `box` (page px). `page` (a PyMuPDF page) gives exact vector bars; `image_png` (the
    rendered page) is used when there are no vector bars. `labels` are text boxes already known (PDF text layer);
    `ocr_labels()` is called, only when needed, for word-level OCR boxes of the region. -> chart dict or None."""
    cfg = cfg or settings()
    labels = split_numeric_runs(list(labels or []))
    rects: List[Dict[str, Any]] = []
    snap = None
    method = None
    if page is not None:
        rects, snap = vector_rects(page, box, scale, cfg)
        method = "vector"
    rgb = None
    if len(rects) < int(cfg["min_bars"]) and image_png:
        try:
            import io
            from PIL import Image
            img = Image.open(io.BytesIO(image_png)).convert("RGB")
            x0, y0 = max(0, int(box[0])), max(0, int(box[1]))
            x1, y1 = min(img.width, int(math.ceil(box[2]))), min(img.height, int(math.ceil(box[3])))
            if x1 - x0 < 20 or y1 - y0 < 20:
                return None
            rgb = np.asarray(img.crop((x0, y0, x1, y1)))
        except Exception:
            return None
        found = raster_rects(rgb, cfg)
        rects = [{**r, "bbox": [r["bbox"][0] + x0, r["bbox"][1] + y0, r["bbox"][2] + x0, r["bbox"][3] + y0]} for r in found]
        base_snap = raster_tick_snap(rgb, cfg)
        snap = (lambda v, bb, _s=base_snap, _x=x0, _y=y0: (lambda r: None if r is None else r + (_y if v else _x))(
            _s(v, [bb[0] - _x, bb[1] - _y, bb[2] - _x, bb[3] - _y])))
        method = "raster"
    if len(rects) < int(cfg["min_bars"]):
        return None
    probe = read_bars(rects, labels, list(box), cfg, title, snap)       # geometry only: is this a bar chart at all?
    if probe is None:
        return None
    need_ocr = method == "raster" or sum(1 for lb in labels if parse_number(lb["text"]) is not None) < 2
    if need_ocr and ocr_labels is not None:
        try:
            more = ocr_labels() or []
        except Exception:
            more = []
        if more:
            labels = more if method == "raster" else labels + [m for m in more if not any(_overlap_boxes(m["bbox"], lb["bbox"]) for lb in labels)]
    labels = split_numeric_runs(labels)
    chart = read_bars(rects, labels, list(box), cfg, title, snap, exact=(method == "vector"))
    if chart is None:
        return None
    if method == "raster" and chart["confidence"] < float(cfg["raster_min_confidence"]):
        return None     # coloured boxes in a diagram or photo, not a chart with a readable scale
    chart["method"] = method
    return chart


def _overlap_boxes(a: Sequence[float], b: Sequence[float]) -> bool:
    ix = min(a[2], b[2]) - max(a[0], b[0])
    iy = min(a[3], b[3]) - max(a[1], b[1])
    return ix > 0 and iy > 0 and ix * iy > 0.5 * min(_w(a) * _h(a), _w(b) * _h(b))


_TRAIL = re.compile(r"^(.*?\S)\s*[-\u2013\u2014_|~=\u2212.:;,]+$")


def split_numeric_runs(labels: List[dict]) -> List[dict]:
    labels = _strip_tick_marks(labels)
    return _split_runs(labels)


def _strip_tick_marks(labels: List[dict]) -> List[dict]:
    """OCR reads the tick mark next to an axis number as a trailing dash ("20 -"); drop it and its share of the box."""
    out = []
    for lb in labels:
        m = _TRAIL.match(lb["text"].strip())
        if m and parse_number(m.group(1)) is not None:
            core = m.group(1)
            frac = len(core) / max(1, len(lb["text"].strip()))
            bb = lb["bbox"]
            out.append({**lb, "text": core, "bbox": [bb[0], bb[1], bb[0] + (bb[2] - bb[0]) * frac, bb[3]]})
        else:
            out.append(lb)
    return out


def _split_runs(labels: List[dict]) -> List[dict]:
    """OCR often returns "2021 2022 2023 2024" as one line; each number is its own axis label, so split such lines
    into one box per number (widths proportional to the characters)."""
    out: List[dict] = []
    for lb in labels:
        toks = lb["text"].split()
        if len(toks) >= 2 and all(parse_number(t) is not None for t in toks):
            total = sum(len(t) for t in toks) + (len(toks) - 1)
            x, width = lb["bbox"][0], _w(lb["bbox"])
            for t in toks:
                x1 = x + width * len(t) / total
                out.append({**lb, "text": t, "bbox": [x, lb["bbox"][1], x1, lb["bbox"][3]]})
                x = x1 + width / total
        else:
            out.append(lb)
    return out


def detect_bar_charts(page: Any, scale: float, cfg: Optional[dict] = None) -> List[List[float]]:
    """Bar charts drawn with vector rectangles, found from the bars themselves (works for column-wide charts whose
    axes are too short for the axis-based detector). A group is >= min_bars filled rectangles on one baseline that
    are close together; the region is the group plus the short text lines (ticks, categories, legend, title) around it.
    -> boxes in page px."""
    cfg = cfg or settings()
    W, H = float(page.rect.width) * scale, float(page.rect.height) * scale
    rects, _ = vector_rects(page, [0, 0, W, H], scale, cfg)
    min_px = float(cfg["min_bar_px"])
    tol = float(cfg["edge_tolerance_px"])
    cand = [r for r in rects if min(_w(r["bbox"]), _h(r["bbox"])) >= min_px and min(r["colour"]) < float(cfg["near_white"])
            and _w(r["bbox"]) * _h(r["bbox"]) < 0.2 * W * H]
    if len(cand) < int(cfg["min_bars"]):
        return []
    lines: List[Tuple[List[float], int]] = []
    try:
        groups: Dict[Tuple[int, int], List[Any]] = {}
        for w in page.get_text("words"):
            groups.setdefault((w[5], w[6]), []).append(w)
        for ws in groups.values():
            lines.append(([min(w[0] for w in ws) * scale, min(w[1] for w in ws) * scale, max(w[2] for w in ws) * scale, max(w[3] for w in ws) * scale], len(ws)))
    except Exception:
        pass
    boxes: List[List[float]] = []
    used: set = set()
    for vertical in (True, False):
        lo, hi = (1, 3) if vertical else (0, 2)
        edge_groups = _cluster_1d([r["bbox"][hi] for r in cand], tol)     # the baseline edge (bottom or left... hi side)
        for g in edge_groups:
            members = [cand[i] for i in g if i not in used]
            if len(members) < int(cfg["min_bars"]):
                continue
            along = 0 if vertical else 1
            members.sort(key=lambda r: r["bbox"][along])
            med = float(np.median([_w(r["bbox"]) if vertical else _h(r["bbox"]) for r in members]))
            run = [members[0]]
            for r in members[1:]:
                if r["bbox"][along] - run[-1]["bbox"][along + 2] <= 3 * med:
                    run.append(r)
                else:
                    if len(run) >= int(cfg["min_bars"]):
                        boxes.append(_region(run, lines, W, H, cfg))
                    run = [r]
            if len(run) >= int(cfg["min_bars"]):
                boxes.append(_region(run, lines, W, H, cfg))
            used.update(g)
    out: List[List[float]] = []
    for b in boxes:
        if not any(_overlap_boxes(b, o) for o in out):
            out.append([round(v, 2) for v in b])
    return out


def _region(run: List[Dict[str, Any]], lines: List[Tuple[List[float], int]], W: float, H: float, cfg: dict) -> List[float]:
    gb = [min(r["bbox"][0] for r in run), min(r["bbox"][1] for r in run), max(r["bbox"][2] for r in run), max(r["bbox"][3] for r in run)]
    m = cfg["region_margin"]
    zone = [max(0.0, gb[0] - m["left"] * _w(gb)), max(0.0, gb[1] - m["top"] * _h(gb)),
            min(W, gb[2] + m["right"] * _w(gb)), min(H, gb[3] + m["bottom"] * _h(gb))]
    box = list(gb)
    for lb, n_words in lines:
        if n_words <= int(cfg["label_max_words"]) and lb[0] >= zone[0] and lb[2] <= zone[2] and lb[1] >= zone[1] and lb[3] <= zone[3]:
            box = [min(box[0], lb[0]), min(box[1], lb[1]), max(box[2], lb[2]), max(box[3], lb[3])]
    return box
