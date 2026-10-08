"""Column-aware reading order.

Plain XY-cut orders by rows whenever whitespace lines up across two columns (end of a paragraph, a figure), so a
two-column page comes out as "top of left, top of right, bottom of left, bottom of right". This module finds the
column gutters first and then reads column by column, with full-width blocks (title, wide figure, caption) acting
as separators between bands:

    title                      -> spanning block
    left column, right column  -> band 1: all of the left column, then all of the right
    wide table                 -> spanning block
    left column, right column  -> band 2

A page with no usable gutter returns None and the caller keeps the XY-cut order, so single-column pages are
unchanged. Every threshold lives in platform_config.json under "layout"; none are hard-coded.
"""
from __future__ import annotations

from typing import Any, Callable, List, Optional, Sequence, Tuple

Box = Sequence[float]
Item = Tuple[Box, Any]

DEFAULTS = {
    "min_gutter_fraction": 0.012,     # gutter width as a fraction of the text width
    "max_cross_fraction": 0.12,       # share of text height allowed to cross a gutter (page numbers, stray lines)
    "min_side_fraction": 0.15,        # each side of a gutter needs at least this share of the text height
    "min_lines_per_side": 4,          # and at least this many blocks
    "search_from": 0.2,               # gutters are searched between these fractions of the text width
    "search_to": 0.8,
    "min_side_width_fraction": 0.12,  # median block width per side, fraction of text width (rules out forms)
    "max_depth": 2,                   # up to 2^depth columns
}


def settings() -> dict:
    try:
        from backend import platform_api
        user = platform_api._file_settings().get("layout") or {}
    except Exception:
        user = {}
    return {**DEFAULTS, **{k: v for k, v in user.items() if k in DEFAULTS}}


def _h(b: Box) -> float:
    return max(0.0, b[3] - b[1])


def find_gutter(items: List[Item], cfg: dict) -> Optional[Tuple[float, float]]:
    """-> (x_start, x_end) of the widest vertical band that (almost) no text crosses, or None."""
    need = int(cfg["min_lines_per_side"])
    if len(items) < 2 * need:
        return None
    x0, x1 = min(b[0] for b, _ in items), max(b[2] for b, _ in items)
    width = x1 - x0
    if width <= 0:
        return None
    total_h = sum(_h(b) for b, _ in items) or 1.0
    lo, hi = x0 + width * float(cfg["search_from"]), x0 + width * float(cfg["search_to"])
    xs = sorted({round(v, 1) for b, _ in items for v in (b[0], b[2])})
    runs: List[Tuple[float, float]] = []
    start: Optional[float] = None
    end = 0.0
    for a, b in zip(xs, xs[1:]):
        mid = (a + b) / 2
        good = False
        if lo <= mid <= hi:
            cross = sum(_h(bx) for bx, _ in items if bx[0] < mid < bx[2])
            left = [bx for bx, _ in items if bx[2] <= mid]
            right = [bx for bx, _ in items if bx[0] >= mid]
            good = (cross / total_h <= float(cfg["max_cross_fraction"]) and len(left) >= need and len(right) >= need
                    and sum(_h(bx) for bx in left) / total_h >= float(cfg["min_side_fraction"])
                    and sum(_h(bx) for bx in right) / total_h >= float(cfg["min_side_fraction"]))
        if good:
            start = a if start is None else start
            end = b
        elif start is not None:
            runs.append((start, end))
            start = None
    if start is not None:
        runs.append((start, end))
    min_w = float(cfg["min_gutter_fraction"]) * width
    runs = [r for r in runs if r[1] - r[0] >= min_w]
    if not runs:
        return None
    best = max(runs, key=lambda r: r[1] - r[0])
    mid = (best[0] + best[1]) / 2
    for side in ([bx for bx, _ in items if bx[2] <= mid], [bx for bx, _ in items if bx[0] >= mid]):
        widths = sorted(bx[2] - bx[0] for bx in side)
        if widths[len(widths) // 2] < float(cfg["min_side_width_fraction"]) * width:
            return None   # two narrow stacks of short lines are a form or a table, not running text
    return best


def order(items: List[Item], fallback: Callable[[List[Item]], Tuple[List[Any], int]], cfg: Optional[dict] = None,
          _depth: int = 0) -> Optional[Tuple[List[Any], int, int]]:
    """-> (ordered payloads, uncertain count, number of columns) or None when the page has no columns."""
    cfg = cfg or settings()
    if _depth >= int(cfg["max_depth"]):
        return None
    g = find_gutter(items, cfg)
    if not g:
        return None
    mid = (g[0] + g[1]) / 2
    # a block is full-width when it reaches across the gutter
    spanning = sorted((it for it in items if it[0][0] < mid < it[0][2]), key=lambda it: it[0][1])
    span_ids = {id(it) for it in spanning}
    narrow = [it for it in items if id(it) not in span_ids]
    bottoms = [s[0][3] for s in spanning]
    bands: List[List[Item]] = [[] for _ in range(len(spanning) + 1)]
    for it in narrow:
        centre_y = (it[0][1] + it[0][3]) / 2
        bands[sum(1 for bottom in bottoms if centre_y > bottom)].append(it)
    out: List[Any] = []
    uncertain, cols = 0, 2
    for k, band in enumerate(bands):
        for side in ([it for it in band if (it[0][0] + it[0][2]) / 2 < mid], [it for it in band if (it[0][0] + it[0][2]) / 2 >= mid]):
            if not side:
                continue
            sub = order(side, fallback, cfg, _depth + 1)
            if sub:
                out.extend(sub[0]); uncertain += sub[1]; cols = max(cols, sub[2] * 2)
            else:
                ordered, unc = fallback(side)
                out.extend(ordered); uncertain += unc
        if k < len(spanning):
            out.append(spanning[k][1])
    return out, uncertain, cols
