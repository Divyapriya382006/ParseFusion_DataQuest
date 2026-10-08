"""Structure for scanned pages: tables and chart/diagram regions found from the page image and its OCR lines.

A page with a text layer gets its tables, images and charts from the PDF drawing commands. A scan has none of
that: OCR returns loose text lines, so every table cell and every chart label would stay a separate paragraph.
This module rebuilds the structure from pixels and geometry:

  find_graphics()  coloured (or, for black-and-white scans, non-text) areas = charts, diagrams, photos, stamps.
                   Nearby short OCR labels (axis ticks, legend, title) are pulled into the region.
  build_tables()   OCR cells -> rows -> columns, so "North | 1,245.50 | 1,389.75 | +11.6%" is one table row.
                   Works without ruling lines (borderless tables); merged header cells get a column span.
  to_upright() / from_upright()  a page scanned sideways is analysed in its upright orientation.

Everything is geometry; no values are invented. Thresholds are in platform_config.json under "scan" (all optional).
"""
from __future__ import annotations

import io
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

Box = List[float]

DEFAULTS = {
    "colour_min_saturation": 45,       # max(R,G,B) - min(R,G,B) at or above this is "coloured"
    "cell_px": 8,                      # analysis grid
    "cell_min_pixels": 6,              # coloured pixels needed for a grid cell to count
    "merge_gap_px": 56,                # coloured parts closer than this belong to one graphic
    "min_colour_pixels": 1200,         # a graphic has at least this many coloured pixels
    "min_width_fraction": 0.08,        # and is at least this wide / tall (page fraction)
    "min_height_fraction": 0.04,
    "coloured_text_fraction": 0.6,     # share of coloured pixels under OCR boxes above which it is coloured text
    "label_margin_x": 0.06,            # OCR labels this close (page fraction) to a graphic belong to it
    "label_margin_y": 0.03,
    "label_max_words": 8,
    "label_rounds": 2,
    "greyscale_graphics": True,        # also look for non-coloured graphics (black-and-white scans)
    "grey_ink_below": 200,             # grey value that counts as ink
    "grey_min_ink_pixels": 3500,       # ink left after text and ruling lines are removed
    "grey_min_density": 0.004,
    "rule_fraction": 0.5,              # a row/column that is this inked end to end is a ruling line
    "split_gap_px": 48,                # empty band between two charts side by side / stacked
    # tables
    "table_min_rows": 3,
    "table_min_cols": 2,
    "table_max_cell_chars": 42,
    "table_max_cell_words": 7,
    "table_row_gap": 1.9,              # max gap between rows, in line heights
    "table_min_aligned_rows": 0.6,     # share of rows that use at least two distinct columns
    "table_split_words_min": 3,        # a wide OCR line with this many tokens may hold several cells
    "table_max_split_calls": 40,
    "cell_gap": 1.1,                   # words closer than this many line heights are one cell
}

_CAPTION = re.compile(r"^\s*(figure|fig\.?|chart|table|source|note)\b", re.I)
_NUM = re.compile(r"^[\(\-\+−–]?[₹$€£]?\d[\d,.\s]*%?\)?$")


def settings() -> dict:
    try:
        from backend import platform_api
        user = platform_api._file_settings().get("scan") or {}
    except Exception:
        user = {}
    return {**DEFAULTS, **{k: v for k, v in user.items() if k in DEFAULTS}}


# ------------------------------------------------------------------------------------------------ geometry
def _w(b: Sequence[float]) -> float:
    return max(0.0, b[2] - b[0])


def _h(b: Sequence[float]) -> float:
    return max(0.0, b[3] - b[1])


def union(boxes: Sequence[Sequence[float]]) -> Box:
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _centre_in(b: Sequence[float], outer: Sequence[float]) -> bool:
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


def upright_size(W: float, H: float, rot: int) -> Tuple[float, float]:
    return (H, W) if rot in (90, 270) else (W, H)


def to_upright(b: Sequence[float], W: float, H: float, rot: int) -> Box:
    """Box in the stored page image -> the same box once the page is turned upright (`rot` degrees clockwise)."""
    x0, y0, x1, y1 = b
    if rot == 90:
        return [H - y1, x0, H - y0, x1]
    if rot == 180:
        return [W - x1, H - y1, W - x0, H - y0]
    if rot == 270:
        return [y0, W - x1, y1, W - x0]
    return [x0, y0, x1, y1]


def from_upright(b: Sequence[float], W: float, H: float, rot: int) -> Box:
    x0, y0, x1, y1 = b
    if rot == 90:
        return [y0, H - x1, y1, H - x0]
    if rot == 180:
        return [W - x1, H - y1, W - x0, H - y0]
    if rot == 270:
        return [W - y1, x0, W - y0, x1]
    return [x0, y0, x1, y1]


# ------------------------------------------------------------------------------------------------ graphics
def _dilate(g: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return g
    p = np.pad(g.astype(np.int32), ((r + 1, r), (r + 1, r)))
    s = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    h, w = g.shape
    win = s[k:k + h, k:k + w] - s[0:h, k:k + w] - s[k:k + h, 0:w] + s[0:h, 0:w]
    return win > 0


def _components(g: np.ndarray) -> List[List[Tuple[int, int]]]:
    h, w = g.shape
    seen = np.zeros_like(g, dtype=bool)
    out = []
    for y in range(h):
        for x in range(w):
            if not g[y, x] or seen[y, x]:
                continue
            stack, comp = [(y, x)], []
            seen[y, x] = True
            while stack:
                cy, cx = stack.pop()
                comp.append((cy, cx))
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if 0 <= ny < h and 0 <= nx < w and g[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            out.append(comp)
    return out


def _rule_free_ink(ink: np.ndarray, frac: float) -> np.ndarray:
    """Ink that is not part of a long horizontal/vertical ruling line (table borders, underlines, gridlines)."""
    if ink.size == 0:
        return ink
    rows = ink.sum(1) >= frac * ink.shape[1]
    cols = ink.sum(0) >= frac * ink.shape[0]
    r = ink.copy()
    for y in np.where(rows)[0]:
        r[max(0, y - 2):y + 3, :] = False
    for x in np.where(cols)[0]:
        r[:, max(0, x - 2):x + 3] = False
    return r


def _split_regions(box: Box, colour: np.ndarray, ink: np.ndarray, cfg: dict) -> List[Box]:
    """Charts printed side by side (or stacked) that the merge joined: cut at an empty band with graphics on both sides."""
    x0, y0, x1, y1 = [int(v) for v in box]
    sub_ink = ink[y0:y1, x0:x1]
    sub_col = colour[y0:y1, x0:x1]
    gap = int(cfg["split_gap_px"])
    need = int(cfg["min_colour_pixels"])
    for axis in (1, 0):   # 1: vertical band (charts side by side), 0: horizontal band (charts stacked)
        prof = sub_ink.sum(axis=0 if axis == 1 else 1)
        empty = prof <= 0
        n = len(empty)
        i = 0
        while i < n:
            if not empty[i]:
                i += 1
                continue
            j = i
            while j < n and empty[j]:
                j += 1
            if j - i >= gap and i > 0 and j < n:
                a, b = (sub_col[:, :i], sub_col[:, j:]) if axis == 1 else (sub_col[:i, :], sub_col[j:, :])
                if a.sum() >= need and b.sum() >= need:
                    if axis == 1:
                        parts = [[x0, y0, x0 + i, y1], [x0 + j, y0, x1, y1]]
                    else:
                        parts = [[x0, y0, x1, y0 + i], [x0, y0 + j, x1, y1]]
                    out: List[Box] = []
                    for p in parts:
                        out += _split_regions(p, colour, ink, cfg)
                    return out
            i = j
    return [[float(x0), float(y0), float(x1), float(y1)]]


def find_graphics(png: bytes, lines: List[dict], cfg: Optional[dict] = None) -> List[dict]:
    """-> [{"bbox", "seed_bbox", "colour_pixels", "colours"}] for each chart/diagram/photo on the page image.
    `lines` are OCR lines ({"text","bbox"}) in the same pixel space; text itself never makes a graphic."""
    cfg = cfg or settings()
    from PIL import Image
    img = Image.open(io.BytesIO(png)).convert("RGB")
    rgb = np.asarray(img)
    H, W = rgb.shape[:2]
    a = rgb.astype(np.int16)
    sat = a.max(2) - a.min(2)
    in_text = np.zeros((H, W), dtype=bool)
    for ln in lines:
        b = ln["bbox"]
        in_text[max(0, int(b[1]) - 2):min(H, int(b[3]) + 3), max(0, int(b[0]) - 2):min(W, int(b[2]) + 3)] = True
    colour = sat >= int(cfg["colour_min_saturation"])
    c_total = int(colour.sum())
    colour_graphic = colour & ~in_text
    cell = int(cfg["cell_px"])
    seeds: List[dict] = []

    def regions_from(mask: np.ndarray, min_px: int) -> List[dict]:
        gh, gw = H // cell, W // cell
        if gh == 0 or gw == 0:
            return []
        counts = mask[:gh * cell, :gw * cell].reshape(gh, cell, gw, cell).sum(axis=(1, 3))
        on = counts >= int(cfg["cell_min_pixels"])
        grown = _dilate(on, max(1, int(round(int(cfg["merge_gap_px"]) / cell / 2))))
        res = []
        for comp in _components(grown):
            cells = [(y, x) for y, x in comp if on[y, x]]
            if not cells:
                continue
            ys, xs = [c[0] for c in cells], [c[1] for c in cells]
            box = [float(min(xs) * cell), float(min(ys) * cell), float((max(xs) + 1) * cell), float((max(ys) + 1) * cell)]
            px = int(mask[int(box[1]):int(box[3]), int(box[0]):int(box[2])].sum())
            if px < min_px or _w(box) < float(cfg["min_width_fraction"]) * W or _h(box) < float(cfg["min_height_fraction"]) * H:
                continue
            res.append({"bbox": box, "colour_pixels": px})
        return res

    if c_total:
        # coloured text (headings, links) is not a graphic: most of its coloured pixels lie under OCR boxes
        if float((colour & in_text).sum()) / c_total < float(cfg["coloured_text_fraction"]) or colour_graphic.sum() >= int(cfg["min_colour_pixels"]):
            seeds += regions_from(colour_graphic, int(cfg["min_colour_pixels"]))
    if cfg.get("greyscale_graphics"):
        ink = (a.max(2) < int(cfg["grey_ink_below"])) & ~in_text & ~colour
        if ink.sum() >= int(cfg["grey_min_ink_pixels"]):
            for r in regions_from(ink, int(cfg["grey_min_ink_pixels"])):
                if any(_overlap(r["bbox"], s["bbox"]) for s in seeds):
                    continue
                b = [int(v) for v in r["bbox"]]
                sub = ink[b[1]:b[3], b[0]:b[2]]
                free = _rule_free_ink(sub, float(cfg["rule_fraction"]))
                n_free = int(free.sum())
                if n_free >= int(cfg["grey_min_ink_pixels"]) and n_free / max(1, sub.size) >= float(cfg["grey_min_density"]):
                    r["colour_pixels"] = n_free
                    r["grey"] = True
                    seeds.append(r)
    out: List[dict] = []
    ink_any = (a.max(2) < 235) & ~in_text
    for s in seeds:
        for part in _split_regions(s["bbox"], colour_graphic if not s.get("grey") else (ink_any), ink_any, cfg):
            px = int((colour_graphic if not s.get("grey") else ink_any)[int(part[1]):int(part[3]), int(part[0]):int(part[2])].sum())
            if px >= int(cfg["min_colour_pixels"]) or s.get("grey"):
                out.append({"bbox": part, "seed_bbox": list(part), "colour_pixels": px, "grey": bool(s.get("grey"))})
    # pull the labels (title, axis ticks, legend, data labels) into each graphic; captions stay outside
    mx, my = float(cfg["label_margin_x"]) * W, float(cfg["label_margin_y"]) * H
    for g in out:
        for _ in range(int(cfg["label_rounds"])):
            b = g["bbox"]
            near = [ln for ln in lines
                    if len(ln["text"].split()) <= int(cfg["label_max_words"]) and not _CAPTION.match(ln["text"])
                    and ln["bbox"][2] >= b[0] - mx and ln["bbox"][0] <= b[2] + mx
                    and ln["bbox"][3] >= b[1] - my and ln["bbox"][1] <= b[3] + my]
            if not near:
                break
            nb = union([b] + [ln["bbox"] for ln in near])
            if nb == b:
                break
            g["bbox"] = nb
    # graphics that grew into each other are one
    merged: List[dict] = []
    for g in sorted(out, key=lambda t: -_w(t["bbox"]) * _h(t["bbox"])):
        host = next((m for m in merged if _inside_most(g["bbox"], m["bbox"])), None)
        if host is None:
            merged.append(g)
    for g in merged:
        g["bbox"] = [max(0.0, g["bbox"][0] - 4), max(0.0, g["bbox"][1] - 4), min(float(W), g["bbox"][2] + 4), min(float(H), g["bbox"][3] + 4)]
        g["shape"] = shape_hint(colour_graphic, g["seed_bbox"]) if not g.get("grey") else None
    merged.sort(key=lambda t: (t["bbox"][1], t["bbox"][0]))
    return merged


def _overlap(a: Sequence[float], b: Sequence[float]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _inside_most(a: Sequence[float], b: Sequence[float]) -> bool:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    area = max(1.0, _w(a) * _h(a))
    return ix * iy / area > 0.5


def shape_hint(colour: np.ndarray, seed: Sequence[float]) -> Optional[str]:
    """"pie" or "donut" when the coloured area is a filled / hollow disc; otherwise None (no guess is made)."""
    x0, y0, x1, y1 = [int(v) for v in seed]
    sub = colour[y0:y1, x0:x1]
    h, w = sub.shape
    if h < 40 or w < 40:
        return None
    aspect = w / h
    if not 0.8 <= aspect <= 1.25:
        return None
    yy, xx = np.mgrid[0:h, 0:w]
    cy, cx = (h - 1) / 2, (w - 1) / 2
    r = min(h, w) / 2
    d = np.hypot(yy - cy, xx - cx)
    inner = sub[d <= 0.3 * r].mean()
    ring = sub[(d > 0.55 * r) & (d <= 0.95 * r)].mean()
    outside = sub[d > 1.12 * r].mean() if (d > 1.12 * r).any() else 0.0
    if ring > 0.8 and outside < 0.15:
        return "pie" if inner > 0.8 else ("donut" if inner < 0.25 else None)
    return None


# ------------------------------------------------------------------------------------------------ tables
def is_number(text: str) -> bool:
    t = text.strip()
    return bool(t) and bool(_NUM.match(t))


def split_cells(words: List[dict], gap_lines: float) -> List[dict]:
    """Word boxes on one text row -> cells: words closer than `gap_lines` line heights belong to one cell."""
    out: List[dict] = []
    for w in sorted(words, key=lambda d: d["bbox"][0]):
        if out:
            last = out[-1]
            hh = max(_h(last["bbox"]), _h(w["bbox"]), 1.0)
            if w["bbox"][0] - last["bbox"][2] <= gap_lines * hh * 0.55:
                last["text"] = (last["text"] + " " + w["text"]).strip()
                last["bbox"] = union([last["bbox"], w["bbox"]])
                last["confidence"] = min(last["confidence"], w["confidence"])
                continue
        out.append({"text": w["text"], "bbox": list(w["bbox"]), "confidence": float(w.get("confidence", 1.0))})
    return out


def _group_rows(cells: List[dict]) -> List[List[dict]]:
    rows: List[List[dict]] = []
    for c in sorted(cells, key=lambda d: (d["bbox"][1] + d["bbox"][3]) / 2):
        cy = (c["bbox"][1] + c["bbox"][3]) / 2
        placed = False
        for r in rows[-3:]:
            top, bottom = min(x["bbox"][1] for x in r), max(x["bbox"][3] for x in r)
            overlap = min(bottom, c["bbox"][3]) - max(top, c["bbox"][1])
            if overlap >= 0.5 * min(bottom - top, _h(c["bbox"])) and top - 0.5 * _h(c["bbox"]) <= cy <= bottom + 0.5 * _h(c["bbox"]):
                r.append(c)
                placed = True
                break
        if not placed:
            rows.append([c])
    for r in rows:
        r.sort(key=lambda d: d["bbox"][0])
    rows.sort(key=lambda r: sum((x["bbox"][1] + x["bbox"][3]) / 2 for x in r) / len(r))
    return rows


def _short(c: dict, cfg: dict) -> bool:
    t = c["text"].strip()
    return len(t) <= int(cfg["table_max_cell_chars"]) and len(t.split()) <= int(cfg["table_max_cell_words"])


def build_tables(cells: List[dict], cfg: Optional[dict] = None) -> List[dict]:
    """`cells`: OCR boxes in upright page pixels ({"text","bbox","confidence"}); each is a word group that reads as one cell.
    -> tables [{"bbox","rows":[[{"text","bbox","col","col_span","confidence"}]],"n_cols"}] (pixel coordinates)."""
    cfg = cfg or settings()
    cells = [c for c in cells if c["text"].strip()]
    if len(cells) < 6:
        return []
    heights = sorted(_h(c["bbox"]) for c in cells)
    med_h = max(8.0, heights[len(heights) // 2])
    rows = _group_rows(cells)
    tabular = [len(r) >= 2 and all(_short(c, cfg) for c in r) for r in rows]
    # single short cell between two tabular rows (a section row such as "Revenue") belongs to the table
    for i in range(1, len(rows) - 1):
        if not tabular[i] and len(rows[i]) == 1 and _short(rows[i][0], cfg) and tabular[i - 1] and tabular[i + 1]:
            tabular[i] = True
    runs: List[List[List[dict]]] = []
    cur: List[List[dict]] = []
    prev_bottom = None
    for r, ok in zip(rows, tabular):
        top = min(c["bbox"][1] for c in r)
        if ok and (not cur or prev_bottom is None or top - prev_bottom <= float(cfg["table_row_gap"]) * med_h):
            cur.append(r)
        else:
            if cur:
                runs.append(cur)
            cur = [r] if ok else []
        prev_bottom = max(c["bbox"][3] for c in r)
    if cur:
        runs.append(cur)
    tables = []
    for run in runs:
        t = _make_table(run, med_h, cfg)
        if t:
            tables.append(t)
    return tables


def _make_table(run: List[List[dict]], med_h: float, cfg: dict) -> Optional[dict]:
    while run and len(run[0]) == 1:
        run = run[1:]
    while run and len(run[-1]) == 1:
        run = run[:-1]
    if len(run) < int(cfg["table_min_rows"]):
        return None
    top_n = max(len(r) for r in run)
    if top_n < int(cfg["table_min_cols"]):
        return None
    # reference columns: x-extent union over the fullest rows
    ref = sorted([[c["bbox"][0], c["bbox"][2]] for r in run if len(r) == top_n for c in r])
    cols: List[List[float]] = []
    for lo, hi in ref:
        if cols and lo <= cols[-1][1]:
            cols[-1][1] = max(cols[-1][1], hi)
        else:
            cols.append([lo, hi])
    if len(cols) < int(cfg["table_min_cols"]):
        return None
    out_rows: List[List[dict]] = []
    used_cols_per_row = []
    for r in run:
        row_cells = []
        for c in r:
            lo, hi = c["bbox"][0], c["bbox"][2]
            hit = [i for i, (a, b) in enumerate(cols) if min(hi, b) - max(lo, a) > 0.25 * (hi - lo)]
            if not hit:
                centre = (lo + hi) / 2
                hit = [min(range(len(cols)), key=lambda i: abs(centre - (cols[i][0] + cols[i][1]) / 2))]
            row_cells.append({"text": c["text"].strip(), "bbox": list(c["bbox"]), "col": hit[0], "col_span": hit[-1] - hit[0] + 1,
                              "confidence": float(c.get("confidence", 1.0))})
        # two cells in one column (an OCR box split a cell): join them
        merged: List[dict] = []
        for rc in row_cells:
            if merged and merged[-1]["col"] == rc["col"] and merged[-1]["col_span"] == rc["col_span"]:
                m = merged[-1]
                m["text"] = (m["text"] + " " + rc["text"]).strip()
                m["bbox"] = union([m["bbox"], rc["bbox"]])
                m["confidence"] = min(m["confidence"], rc["confidence"])
            else:
                merged.append(rc)
        out_rows.append(merged)
        used_cols_per_row.append(len({m["col"] for m in merged}))
    aligned = sum(1 for n in used_cols_per_row if n >= 2) / len(out_rows)
    if aligned < float(cfg["table_min_aligned_rows"]):
        return None
    # a table has columns that repeat: at least two columns are used by most rows
    use = [sum(1 for r in out_rows if any(c["col"] == i for c in r)) for i in range(len(cols))]
    if sum(1 for u in use if u >= 0.6 * len(out_rows)) < 2:
        return None
    boxes = [c["bbox"] for r in out_rows for c in r]
    return {"bbox": union(boxes), "rows": out_rows, "n_cols": len(cols), "method": "ocr_grid"}
