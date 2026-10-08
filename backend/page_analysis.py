"""Page analysis used by the pipeline: measured confidence, tables, figures and reading order.

Confidence (per text block and table cell)
    Native text from a PDF is checked against an independent OCR pass of the rendered page (agent 04):
        agreement  = fuzzy similarity (0..1) between the native text and the OCR text found at the same place
        confidence = native_quality * (native_weight + agreement_weight * agreement)
    native_quality is agent 03's own score (garbage characters, missing ToUnicode maps, ...). So a line only scores
    high when the text layer is clean AND what is printed on the page says the same thing. Every block carries
    confidence_breakdown with the inputs, and the OCR reading as an alternative when it differs.
    OCR-only blocks (scanned pages, text inside images) keep the OCR engine's own confidence.

Tables      PyMuPDF table finder on the PDF page (ruling lines + text alignment), cells mapped to page-image pixels.
Figures     Image objects placed on the page (from the PDF object model), as crops of the rendered page.
Reading order
    Recursive XY-cut over block boxes (columns before rows), so two-column text is read column by column.
    reading_order_confidence = share of blocks whose position was decided by a clean cut rather than a fallback.

Weights and thresholds come from the "consensus" section of backend/platform_config.json.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, List, Optional, Sequence, Tuple

from rapidfuzz import fuzz

Box = Sequence[float]

DEFAULTS = {
    "ocr_cross_check": True,       # run OCR on native pages to measure agreement
    "native_weight": 0.6,
    "agreement_weight": 0.4,
    "agreement_review_below": 0.8,  # blocks whose agreement is below this need review
    "ocr_only_min_confidence": 0.4,  # OCR text with no native counterpart is kept above this confidence
    "min_figure_area": 0.01,        # share of the page an image must cover to count as a figure
    "max_cross_check_pages": 200,
    "max_region_rechecks_per_page": 60,  # focused OCR re-reads of regions the full-page OCR did not cover
}


def settings() -> dict:
    try:
        from backend import platform_api
        user = platform_api._file_settings().get("consensus") or {}
    except Exception:
        user = {}
    return {**DEFAULTS, **{k: v for k, v in user.items() if k in DEFAULTS}}


# ----------------------------------------------------------------------------------------------- geometry
def area(b: Box) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def inter(a: Box, b: Box) -> float:
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def same_place(box: Box, line: Box) -> bool:
    """True when an OCR line sits at the box: overlapping by half the smaller height, and by 30% of the smaller
    width (a table cell is usually taller than its text, and an OCR line may run across several cells)."""
    oy = min(box[3], line[3]) - max(box[1], line[1])
    ox = min(box[2], line[2]) - max(box[0], line[0])
    if oy <= 0 or ox <= 0:
        return False
    return (oy / max(1.0, min(box[3] - box[1], line[3] - line[1])) >= 0.5
            and ox / max(1.0, min(box[2] - box[0], line[2] - line[0])) >= 0.3)


def center_inside(b: Box, outer: Box) -> bool:
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


# ----------------------------------------------------------------------------------------------- text agreement
_WS = re.compile(r"\s+")


def norm(text: str) -> str:
    t = unicodedata.normalize("NFKC", text or "").casefold()
    t = t.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    t = t.replace("–", "-").replace("—", "-")
    return _WS.sub(" ", t).strip()


def agreement(native: str, ocr: str) -> float:
    """Similarity in [0, 1] between the native text of a region and the OCR text read at the same place."""
    a, b = norm(native), norm(ocr)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    if len(a) <= 3:  # very short tokens ("0", "96"): exact token presence, a fuzzy ratio is meaningless here
        return 1.0 if a in b.split() or a == b else fuzz.ratio(a, b) / 100.0
    if len(b) > len(a) * 1.3:  # OCR line spans more than this block (e.g. several table cells on one line)
        return fuzz.partial_ratio(a, b) / 100.0
    return fuzz.ratio(a, b) / 100.0


def ocr_text_for(box: Box, ocr_lines: List[dict], used: Optional[set] = None) -> Tuple[str, List[float]]:
    """OCR lines at the box (see same_place), joined in reading order; duplicates from re-reads are dropped."""
    hits = []
    for i, line in enumerate(ocr_lines):
        lb = line["bbox"]
        if same_place(box, lb):
            hits.append((lb[1], lb[0], i))
    hits.sort()
    seen, uniq = set(), []
    for h in hits:
        key = norm(ocr_lines[h[2]]["text"])
        if key not in seen:
            seen.add(key)
            uniq.append(h)
    hits = uniq
    if used is not None:
        used.update(i for _, _, i in hits)
    return " ".join(ocr_lines[i]["text"] for _, _, i in hits), [ocr_lines[i]["confidence"] for _, _, i in hits]


def covered(box: Box, ocr_lines: List[dict]) -> bool:
    return any(same_place(box, ln["bbox"]) for ln in ocr_lines)


def union(boxes: List[Box]) -> List[float]:
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def score(native_text: str, native_quality: float, box: Optional[Box], ocr_lines: Optional[List[dict]],
          cfg: dict, used: Optional[set] = None) -> Tuple[float, dict, Optional[dict]]:
    """-> (confidence, confidence_breakdown, alternative-or-None)."""
    breakdown: Dict[str, float] = {"native_text_quality": round(native_quality, 4)}
    if ocr_lines is None or box is None:
        return round(native_quality, 4), breakdown, None
    ocr_text, ocr_confs = ocr_text_for(box, ocr_lines, used)
    agr = agreement(native_text, ocr_text)
    breakdown["ocr_agreement"] = round(agr, 4)
    if ocr_confs:
        breakdown["ocr_engine_confidence"] = round(sum(ocr_confs) / len(ocr_confs), 4)
    conf = native_quality * (float(cfg["native_weight"]) + float(cfg["agreement_weight"]) * agr)
    alt = None
    if ocr_text and norm(ocr_text) != norm(native_text):
        alt = {"extractor": "ocr", "value": ocr_text,
               "confidence": breakdown.get("ocr_engine_confidence", 0.0)}
    return round(max(0.0, min(1.0, conf)), 4), breakdown, alt


# ----------------------------------------------------------------------------------------------- tables & figures
def _to_px(rect: Any, page: Any, scale: float) -> List[float]:
    import pymupdf as fitz
    r = fitz.Rect(rect) * page.rotation_matrix
    return [round(r.x0 * scale, 2), round(r.y0 * scale, 2), round(r.x1 * scale, 2), round(r.y1 * scale, 2)]


def find_tables(page: Any, scale: float) -> List[dict]:
    """Tables on a PDF page -> [{bbox, rows:[[{text, bbox, col_span}]]}] in page-image pixels."""
    out = []
    try:
        found = page.find_tables()
    except Exception:
        return out
    for t in getattr(found, "tables", []) or []:
        try:
            texts = t.extract()
        except Exception:
            continue
        rows = []
        for r_i, row in enumerate(t.rows):
            cells: List[dict] = []
            for c_i, cb in enumerate(row.cells):
                if cb is None:  # merged into the cell on its left
                    if cells:
                        cells[-1]["col_span"] += 1
                    continue
                text = (texts[r_i][c_i] if r_i < len(texts) and c_i < len(texts[r_i]) else None) or ""
                cells.append({"col": c_i, "text": _WS.sub(" ", text).strip(), "bbox": _to_px(cb, page, scale),
                              "col_span": 1})
            rows.append(cells)
        if len(rows) >= 2 and max((len(r) for r in rows), default=0) >= 2:
            out.append({"bbox": _to_px(t.bbox, page, scale), "rows": rows, "n_cols": int(t.col_count)})
    return out


def find_figures(page: Any, scale: float, min_area: float) -> List[List[float]]:
    boxes = []
    page_area = page.rect.width * page.rect.height or 1.0
    try:
        infos = page.get_image_info()
    except Exception:
        return boxes
    for info in infos:
        bb = info.get("bbox")
        if not bb:
            continue
        import pymupdf as fitz
        r = fitz.Rect(bb) & page.rect
        if r.is_empty or (r.width * r.height) / page_area < min_area:
            continue
        box = _to_px(r, page, scale)
        if box not in boxes:
            boxes.append(box)
    return boxes


# ----------------------------------------------------------------------------------------------- reading order
def _gaps(intervals: List[Tuple[float, float]], min_gap: float) -> List[float]:
    """Cut positions between merged intervals whose gap is at least min_gap."""
    ivs = sorted(intervals)
    cuts, end = [], ivs[0][1]
    for s, e in ivs[1:]:
        if s - end >= min_gap:
            cuts.append((end + s) / 2)
        end = max(end, e)
    return cuts


def xy_cut(items: List[Tuple[Box, Any]], page_w: float, page_h: float) -> Tuple[List[Any], int]:
    """Recursive XY-cut. Columns are split before rows. -> (ordered payloads, number of items ordered by fallback)."""
    min_vgap = max(8.0, page_w * 0.015)
    min_hgap = 0.5

    def rec(group: List[Tuple[Box, Any]]) -> Tuple[List[Any], int]:
        if len(group) <= 1:
            return [p for _, p in group], 0
        vcuts = _gaps([(b[0], b[2]) for b, _ in group], min_vgap)
        if vcuts:
            return _split(group, vcuts, 0)
        hcuts = _gaps([(b[1], b[3]) for b, _ in group], min_hgap)
        if hcuts:
            return _split(group, hcuts, 1)
        # No clean cut: order top-to-bottom, left-to-right. Only boxes that genuinely overlap another box are
        # counted as uncertain (touching lines of one paragraph are not).
        ordered = sorted(group, key=lambda it: (it[0][1], it[0][0]))
        uncertain = sum(1 for i, (b, _) in enumerate(group)
                        if any(j != i and inter(b, o) > 0.2 * max(1.0, min(area(b), area(o)))
                               for j, (o, _) in enumerate(group)))
        return [p for _, p in ordered], uncertain

    def _split(group, cuts, axis):
        parts: List[List[Tuple[Box, Any]]] = [[] for _ in range(len(cuts) + 1)]
        for b, p in group:
            mid = (b[axis] + b[axis + 2]) / 2
            parts[sum(1 for c in cuts if mid > c)].append((b, p))
        out, amb = [], 0
        for part in parts:
            o, a = rec(part)
            out += o
            amb += a
        return out, amb

    return rec(items)