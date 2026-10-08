"""Page quality checks used by the pipeline (pipeline_api._process_unit).

coverage      How much of the printed page (ink) is covered by extracted blocks. A page with ink and no blocks is never
              reported as read: status needs_ocr (no OCR engine) or unreadable (OCR found nothing). Uncovered ink is
              returned as regions in page-image pixels.
equations     Math fragments (private-use glyphs, 1-3 character pieces, operator-heavy lines, stacked fraction parts)
              are merged into ONE equation block instead of one block per symbol.
tables        A table must have a real grid: enough rows and columns, filled cells, consistent rows, short cells.
              Edge lists, single-cell titles and sentences are rejected; anything inside a chart is rejected.
charts        Vector axes (a long vertical and a long horizontal line meeting at a corner) plus marks between them.
              Emitted as a chart block flagged CHART_EXTRACTION_UNAVAILABLE (series are not digitised).
captions      The nearest text line just below/above a figure or chart, preferring "Figure/Chart/..." lines.
review        needs_review only for genuine uncertainty: low confidence, extractor disagreement, garbled glyphs,
              unverified equations.

Every threshold comes from the "page_quality" section of backend/platform_config.json (defaults below).
"""
from __future__ import annotations

import io
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

DEFAULTS: Dict[str, Any] = {
    "ink_grid_columns": 48,             # coverage grid resolution (rows follow the page aspect ratio)
    "ink_gray_threshold": 160,          # a pixel darker than this is ink
    "ink_min_cell_fraction": 0.004,     # a grid cell is ink when this share of its pixels is dark
    "coverage_partial_below": 0.6,      # coverage below this -> page status "partial"
    "uncovered_min_cells": 4,           # smaller uncovered ink regions are ignored (specks, rules)
    "equation_math_chars": "=+−-×÷*/^<>≤≥≠≈∑∏∫√∞∂∇αβγδεθλμπσφωΔΣΠΩ()[]{},",
    "equation_operator_chars": "=+−×÷^<>≤≥≠≈∑∏∫√∂∇",
    "equation_fragment_max_chars": 3,
    "equation_min_math_ratio": 0.4,
    "equation_prose_min_words": 3,      # lines with this many real words are prose, not math
    "equation_formula_max_words": 14,   # "Net debt = Gross debt - Cash" style formulas up to this many words
    "equation_line_gap_factor": 0.8,    # max vertical gap between fragments, in line heights
    "equation_x_gap_factor": 6.0,       # max horizontal gap between fragments, in line heights
    "table_min_rows": 2,
    "table_min_cols": 2,
    "table_min_fill": 0.5,              # share of non-empty cells
    "table_min_row_consistency": 0.6,   # share of rows with >= 2 non-empty cells
    "table_max_words_per_cell": 12,     # longer cells in a 1-2 column "table" are sentences
    "chart_min_axis_fraction": 0.15,    # axis length relative to page width/height
    "chart_corner_tolerance_pt": 6.0,
    "chart_min_marks": 3,               # bars / line segments between the axes
    "chart_label_margin_fraction": 0.12,
    "caption_max_gap_fraction": 0.06,   # of page height
    "caption_require_label": True,      # an unlabelled neighbour (a heading, a paragraph) is never taken as a caption
    "caption_pattern": r"^\s*(fig(ure)?|chart|graph|diagram|image|plate|plot)\.?\s*\d+",
}

_PUA = re.compile("[-�]|\\(cid:\\d+\\)")


def settings() -> dict:
    try:
        from backend import platform_api
        user = platform_api._file_settings().get("page_quality") or {}
    except Exception:
        user = {}
    return {**DEFAULTS, **{k: v for k, v in user.items() if k in DEFAULTS}}


# ----------------------------------------------------------------------------------------------- geometry helpers
def _overlap(a: Sequence[float], b: Sequence[float]) -> bool:
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def _inside(b: Sequence[float], outer: Sequence[float]) -> bool:
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


def union(boxes: List[Sequence[float]]) -> List[float]:
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


# ----------------------------------------------------------------------------------------------- review reasons
def review_reasons(text: str, conf: float, threshold: float, agreement: Optional[float], review_below: float) -> List[str]:
    reasons = []
    if conf < threshold:
        reasons.append("low_confidence")
    if agreement is not None and agreement < review_below:
        reasons.append("extractor_disagreement")
    if _PUA.search(text or ""):
        reasons.append("garbled_glyphs")
    return reasons


# ----------------------------------------------------------------------------------------------- coverage
def ink_coverage(png: bytes, boxes: List[Sequence[float]], cfg: dict) -> Tuple[Optional[float], List[List[float]], int]:
    """-> (coverage 0..1 or None when the page has no ink, uncovered ink regions [px boxes], ink cell count)."""
    import numpy as np
    from PIL import Image
    im = Image.open(io.BytesIO(png)).convert("L")
    W, H = im.size
    gx = int(cfg["ink_grid_columns"])
    gy = max(1, round(gx * H / max(1, W)))
    dark = np.asarray(im) < int(cfg["ink_gray_threshold"])
    ys = np.linspace(0, H, gy + 1).astype(int)
    xs = np.linspace(0, W, gx + 1).astype(int)
    ink = np.zeros((gy, gx), dtype=bool)
    for r in range(gy):
        band = dark[ys[r]:ys[r + 1]]
        for c in range(gx):
            cell = band[:, xs[c]:xs[c + 1]]
            if cell.size and cell.mean() >= float(cfg["ink_min_cell_fraction"]):
                ink[r, c] = True
    n_ink = int(ink.sum())
    if n_ink == 0:
        return None, [], 0
    covered = np.zeros_like(ink)
    for b in boxes:
        c0 = max(0, int(np.searchsorted(xs, b[0], "right")) - 1)
        c1 = min(gx - 1, int(np.searchsorted(xs, b[2], "left")))
        r0 = max(0, int(np.searchsorted(ys, b[1], "right")) - 1)
        r1 = min(gy - 1, int(np.searchsorted(ys, b[3], "left")))
        covered[r0:r1 + 1, c0:c1 + 1] = True
    unc = ink & ~covered
    score = round(float((ink & covered).sum()) / n_ink, 4)
    # connected uncovered ink -> regions
    seen = np.zeros_like(unc)
    regions: List[List[float]] = []
    for r in range(gy):
        for c in range(gx):
            if unc[r, c] and not seen[r, c]:
                stack, cells = [(r, c)], []
                seen[r, c] = True
                while stack:
                    y, x = stack.pop()
                    cells.append((y, x))
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
                        yy, xx = y + dy, x + dx
                        if 0 <= yy < gy and 0 <= xx < gx and unc[yy, xx] and not seen[yy, xx]:
                            seen[yy, xx] = True
                            stack.append((yy, xx))
                if len(cells) >= int(cfg["uncovered_min_cells"]):
                    rr = [y for y, _ in cells]
                    cc = [x for _, x in cells]
                    regions.append([float(xs[min(cc)]), float(ys[min(rr)]), float(xs[max(cc) + 1]), float(ys[max(rr) + 1])])
    return score, regions, n_ink


def page_status(has_blocks: bool, coverage: Optional[float], needed_ocr: bool, ocr_available: bool, cfg: dict) -> str:
    if coverage is None:
        return "ok" if has_blocks else "blank"
    if not has_blocks:
        return "needs_ocr" if (needed_ocr and not ocr_available) else "unreadable"
    if coverage < float(cfg["coverage_partial_below"]):
        return "partial"
    return "ok"


# ----------------------------------------------------------------------------------------------- equations
def _is_math(text: str, cfg: dict) -> Tuple[bool, bool]:
    """-> (is a math fragment, contains an operator/private-use glyph)."""
    t = (text or "").strip()
    if not t:
        return False, False
    pua = bool(_PUA.search(t))
    ops = set(cfg["equation_operator_chars"])
    has_op = pua or any(ch in ops for ch in t)
    # word formula: "<name> = <terms joined by operators>", short, not a sentence
    if "=" in t and re.search(r"=.*[+\-−×÷/*]", t) and len(t.split()) <= int(cfg["equation_formula_max_words"]) \
            and not t.rstrip().endswith((".", "?", "!")):
        return True, True
    words = [w for w in re.findall(r"[A-Za-z]{3,}", t)]
    if len(words) >= int(cfg["equation_prose_min_words"]):
        return False, False
    toks = t.split()
    math_chars = set(cfg["equation_math_chars"])
    m = sum(1 for ch in t if ch in math_chars) + sum(1 for tok in toks if len(tok) == 1 and tok.isalpha())
    ratio = m / max(1, len(toks))
    frag = len(t) <= int(cfg["equation_fragment_max_chars"])
    return (pua or frag or (has_op and ratio >= float(cfg["equation_min_math_ratio"]))), has_op


def merge_equations(blocks: List[dict], page_number: int, crop_url, cfg: dict, review_below: float) -> List[dict]:
    """Cluster math fragments and replace each cluster that contains an operator (or a private-use glyph) with
    one equation block. Plain short fragments without any operator (list items, labels) are left alone."""
    cands = []
    for i, b in enumerate(blocks):
        if b.get("type") != "text" or not (b.get("location") or {}).get("bbox"):
            continue
        is_m, op = _is_math(b.get("raw_text", ""), cfg)
        if is_m:
            cands.append((i, b, op))
    if not cands:
        return blocks
    parent = list(range(len(cands)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a in range(len(cands)):
        ba = cands[a][1]["location"]["bbox"]
        for b in range(a + 1, len(cands)):
            bb = cands[b][1]["location"]["bbox"]
            lh = max(1.0, min(ba[3] - ba[1], bb[3] - bb[1]))
            vgap = max(0.0, max(ba[1], bb[1]) - min(ba[3], bb[3]))
            hgap = max(0.0, max(ba[0], bb[0]) - min(ba[2], bb[2]))
            if vgap <= float(cfg["equation_line_gap_factor"]) * lh and hgap <= float(cfg["equation_x_gap_factor"]) * lh:
                parent[find(a)] = find(b)
    groups: Dict[int, List[int]] = {}
    for k in range(len(cands)):
        groups.setdefault(find(k), []).append(k)
    drop: set = set()
    new_blocks: List[dict] = []
    for g in groups.values():
        members = [cands[k] for k in g]
        if not any(op for _, _, op in members):
            continue
        if len(members) == 1 and len((members[0][1].get("raw_text") or "").strip()) <= int(cfg["equation_fragment_max_chars"]):
            continue  # a lone symbol is not an equation
        mb = [m[1] for m in members]
        box = union([b["location"]["bbox"] for b in mb])
        lines: Dict[int, List[dict]] = {}
        for b in sorted(mb, key=lambda b: (b["location"]["bbox"][1], b["location"]["bbox"][0])):
            key = next((k for k in lines if abs(k - b["location"]["bbox"][1]) <= 0.5 * (b["location"]["bbox"][3] - b["location"]["bbox"][1])), None)
            lines.setdefault(key if key is not None else int(b["location"]["bbox"][1]), []).append(b)
        text = "\n".join(" ".join(x.get("raw_text", "").strip() for x in sorted(ls, key=lambda x: x["location"]["bbox"][0]))
                         for _, ls in sorted(lines.items()))
        agreements = [b.get("confidence_breakdown", {}).get("ocr_agreement") for b in mb]
        verified = all(a is not None and a >= review_below for a in agreements)
        first = mb[0]
        eid = f"{first['page_id']}_equation_{len(new_blocks)}"
        new_blocks.append({
            "block_id": eid, "type": "equation", "equation_id": eid, "source_id": first["source_id"],
            "page_id": first["page_id"], "unit_id": first.get("unit_id"), "reading_order_index": 0,
            "location": {**first["location"], "bbox": box},
            "confidence": round(min(b["confidence"] for b in mb), 4),
            "confidence_breakdown": {"fragments_merged": len(mb), "verified_against_ocr": 1.0 if verified else 0.0},
            "extraction_method": f"equation_merge({first.get('extraction_method', 'text')})",
            "raw_text": text, "plain_text": text, "latex": None, "latex_unavailable_reason": "no LaTeX recogniser installed",
            "verified": verified, "needs_review": not verified,
            "review_reasons": [] if verified else ["equation_unverified"],
            "warnings": [] if verified else [{"code": "EQUATION_UNVERIFIED", "message": "Equation text was not confirmed by a second extractor"}],
            "crop_url": crop_url(box), "fragments": [b["block_id"] for b in mb],
        })
        drop.update(i for i, _, _ in members)  # block indices
    if not new_blocks:
        return blocks
    return [b for i, b in enumerate(blocks) if i not in drop] + new_blocks


# ----------------------------------------------------------------------------------------------- tables
def validate_table(t: dict, charts: List[List[float]], cfg: dict) -> Tuple[bool, str]:
    rows = t.get("rows") or []
    n_rows = len(rows)
    n_cols = max((sum(c.get("col_span", 1) for c in r) for r in rows), default=0)
    if any(_inside(t["bbox"], ch) for ch in charts):
        return False, "inside a chart"
    if n_rows < int(cfg["table_min_rows"]) or n_cols < int(cfg["table_min_cols"]):
        return False, f"only {n_rows} row(s) x {n_cols} column(s)"
    cells = [c for r in rows for c in r]
    filled = [c for c in cells if (c.get("text") or "").strip()]
    if len(filled) <= 1:
        return False, "single-cell title"
    if len(filled) / max(1, len(cells)) < float(cfg["table_min_fill"]):
        return False, f"only {len(filled)}/{len(cells)} cells filled"
    full_rows = sum(1 for r in rows if sum(1 for c in r if (c.get("text") or "").strip()) >= 2)
    if full_rows / n_rows < float(cfg["table_min_row_consistency"]):
        return False, "rows do not form consistent columns"
    long_cells = [c for c in filled if len(c["text"].split()) > int(cfg["table_max_words_per_cell"])]
    if long_cells and n_cols <= 2:
        return False, "cells are sentences"
    return True, "grid"


# ----------------------------------------------------------------------------------------------- charts
def detect_charts(page: Any, scale: float, cfg: dict) -> List[List[float]]:
    """Charts from vector drawings: a vertical and a horizontal axis meeting at a corner, with marks between them."""
    try:
        drawings = page.get_drawings()
    except Exception:
        return []
    W, H = float(page.rect.width), float(page.rect.height)
    tol = float(cfg["chart_corner_tolerance_pt"])
    hs, vs, marks = [], [], []
    for d in drawings:
        for it in d.get("items", []):
            if it[0] == "l":
                p1, p2 = it[1], it[2]
                if abs(p1.y - p2.y) <= 1 and abs(p1.x - p2.x) >= float(cfg["chart_min_axis_fraction"]) * W:
                    hs.append((min(p1.x, p2.x), p1.y, max(p1.x, p2.x)))
                elif abs(p1.x - p2.x) <= 1 and abs(p1.y - p2.y) >= float(cfg["chart_min_axis_fraction"]) * H:
                    vs.append((p1.x, min(p1.y, p2.y), max(p1.y, p2.y)))
                else:
                    marks.append(((p1.x + p2.x) / 2, (p1.y + p2.y) / 2))
            elif it[0] in ("re", "qu"):
                r = it[1].rect if it[0] == "qu" else it[1]
                marks.append(((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
    charts: List[List[float]] = []
    for hx0, hy, hx1 in hs:
        for vx, vy0, vy1 in vs:
            if abs(vx - hx0) <= tol and abs(vy1 - hy) <= tol:  # bottom-left corner
                inside = [m for m in marks if hx0 < m[0] < hx1 and vy0 < m[1] < hy]
                if len(inside) >= int(cfg["chart_min_marks"]):
                    mx = float(cfg["chart_label_margin_fraction"])
                    box = [hx0 - mx * (hx1 - hx0), vy0 - mx * (hy - vy0) / 2, hx1 + mx * (hx1 - hx0) / 2, hy + mx * (hy - vy0)]
                    box = [max(0.0, box[0]), max(0.0, box[1]), min(W, box[2]), min(H, box[3])]
                    px = [round(v * scale, 2) for v in box]
                    if not any(_overlap(px, c) for c in charts):
                        charts.append(px)
    return charts


# ----------------------------------------------------------------------------------------------- captions
def find_caption(box: Sequence[float], text_blocks: List[dict], page_height: float, cfg: dict) -> Optional[dict]:
    gap = float(cfg["caption_max_gap_fraction"]) * max(1.0, page_height)
    pat = re.compile(cfg["caption_pattern"], re.I)
    best = None
    for b in text_blocks:
        bb = (b.get("location") or {}).get("bbox")
        if not bb:
            continue
        if _inside(bb, box):
            # text inside the region is only a caption when it is labelled like one (e.g. "Chart 1: ...")
            if pat.search(b.get("raw_text", "")):
                key = (0, 0, 0.0)
                if best is None or key < best[0]:
                    best = (key, b)
            continue
        if min(bb[2], box[2]) <= max(bb[0], box[0]):
            continue  # no horizontal overlap
        lh = max(1.0, bb[3] - bb[1])  # a caption may touch the region's edge by up to one line height
        below = bb[1] - box[3]
        above = box[1] - bb[3]
        dist = max(0.0, below) if below >= -lh else (max(0.0, above) if above >= -lh else None)
        if dist is None or dist > gap:
            continue
        labelled = bool(pat.search(b.get("raw_text", "")))
        if not labelled and cfg.get("caption_require_label", True):
            continue
        key = (0 if labelled else 1, 0 if below >= -lh else 1, abs(dist))
        if best is None or key < best[0]:
            best = (key, b)
    return best[1] if best else None
