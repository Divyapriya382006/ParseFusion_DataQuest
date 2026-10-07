/**
 * Agent 07: Table Extraction
 *
 * Purpose: Reconstructs complex grid tabular structures, cell row/column spans, headers, and numeric values.
 * Endpoint: POST /agents/table
 * Input Format: { source_id: ID; page_number: number; region_id: ID }
 * Output Format: TableBlock
 */

import { apiClient } from "../api/client";
import type { ID, TableBlock } from "../types/canonical";

export const ENDPOINT = "/agents/table";

export interface TableExtractionInput {
  source_id: ID;
  page_number: number;
  region_id: ID;
}

export type TableExtractionOutput = TableBlock;

export async function extractTable(
  input: TableExtractionInput,
  signal?: AbortSignal
): Promise<TableExtractionOutput> {
  return apiClient<TableExtractionOutput>("""
07_table.py - Agent 07: Table Extraction  (Person B).   POST /agents/table

Table region(s) of a page -> cell grid with row/col index, spans, header flags, per-cell evidence + confidence, optional numeric value.

Pipeline (debug line per step):
  1 load page + layout, pick table regions (all, or one region_id)
  2 words: PDF text layer (PyMuPDF words, exact) or ONE OCR pass over the padded crop
  3 structure, first engine that yields >= 2x2 cells wins:
        pdf_ruled        PyMuPDF find_tables(strategy="lines")           ruled tables with a text layer      base 1.00
        pdf_text         PyMuPDF find_tables(strategy="text")            borderless tables, text layer       base 0.85
        cv_grid          OpenCV line masks (+ border test for merged cells) scanned / image tables            base 0.90
        word_clusters    rows by y, columns by empty vertical channels   last resort (PDF or OCR words)      base 0.65
  4 grid: cluster cell edges -> (row, col, rowspan, colspan); holes become empty cells (flagged inferred_empty)
  5 assign words to cells by word centre; join in reading order
  6 header detection   7 numeric parsing   8 total checks   9 confidence   10 store + audit

CONFIDENCE (documented):
  cell.confidence  = base(engine) * mean(word confidence) * text_confidence(cell text)       (empty cell: base(engine))
  table.confidence = mean(confidence of NON-empty cells) * (0.5 + 0.5 * row_consistency)
                     row_consistency = share of rows whose count of non-empty cells equals the most common count.
Never invents: unreadable/empty cells stay "" (text null-like), numeric_value is null unless the string is unambiguous
("1.234" could be 1234 in some locales -> null + signal), totals are CHECKED (TOTAL_MISMATCH warning), never corrected.
Thresholds (config table.*): edge_tol_frac=0.003, min_cell_conf warn=0.5, ocr_pad_px=4.
"""
from __future__ import annotations

import re
import statistics
from typing import Optional

import numpy as np
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

try:
    from backend.agents import b_common as bc
except ImportError:  # pragma: no cover
    import b_common as bc  # type: ignore

fitz = bc.fitz
AGENT = "07_table"
router = APIRouter()
BASE = {"pdf_ruled": 1.0, "pdf_text": 0.85, "cv_grid": 0.9, "word_clusters": 0.65}


class TableInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, default=1)
    region_id: Optional[str] = None        # None = every table region on the page


class Cell(BaseModel):
    row: int
    col: int
    rowspan: int = 1
    colspan: int = 1
    text: str
    is_header: bool = False
    is_empty: bool = False
    inferred_empty: bool = False
    numeric_value: Optional[float] = None
    location: bc.Location
    extraction_method: str
    confidence: float = Field(ge=0, le=1)


class TableResult(BaseModel):
    region_id: str
    table_id: str
    n_rows: int
    n_cols: int
    header_rows: int
    cells: list[Cell]
    grid: list[list[Optional[str]]]        # n_rows x n_cols; covered (merged-away) positions are None
    location: bc.Location
    extraction_method: str
    confidence: float = Field(ge=0, le=1)
    signals: dict = {}
    warnings: list[bc.WarningItem] = []


class TableOutput(BaseModel):
    source_id: str
    page_id: str
    page_number: int
    tables: list[TableResult]
    warnings: list[bc.WarningItem] = []


def T(name: str, default):
    return bc.cfg(f"table.{name}", default)


# --------------------------------------------------------------------------- numbers
_NUM = re.compile(r"^\(?[-−+]?[$€£¥]?\s?\d{1,3}(,\d{3})*(\.\d+)?%?\)?$|^\(?[-−+]?[$€£¥]?\s?\d+(\.\d+)?%?\)?$")


def parse_number(s: str) -> tuple:
    """-> (value|None, ambiguous: bool). Only unambiguous en-US style numbers; (12) = -12; % kept as the plain number."""
    t = s.strip()
    if not t or not _NUM.match(t):
        return None, False
    if re.fullmatch(r"\(?[-−+]?[$€£¥]?\s?\d{1,3}\.\d{3}\)?", t):  # 1.234 -> 1.234 or 1234 (EU)?
        return None, True
    neg = t.startswith("(") and t.endswith(")") or t.lstrip("(").startswith(("-", "−"))
    core = re.sub(r"[()$€£¥%\s,+\-−]", "", t)
    try:
        v = float(core)
    except ValueError:
        return None, False
    return (-v if neg else v), False


# --------------------------------------------------------------------------- words
def _pdf_words(ctx: bc.PageCtx, bbox_px: list) -> list:
    r = ctx.px_to_pt(bbox_px).normalize()
    r = fitz.Rect(r.x0 - 3, r.y0 - 3, r.x1 + 3, r.y1 + 3)
    with ctx.lock:
        ws = ctx.page.get_text("words", clip=r)
    out = []
    for w in ws:
        if w[4].strip():
            out.append({"text": w[4], "bbox": ctx.pt_to_px((w[0], w[1], w[2], w[3])), "conf": 1.0})
    return out


def _ocr_words(ctx: bc.PageCtx, bbox_px: list) -> list:
    pad = int(T("ocr_pad_px", 4))
    b = bc.clamp_box([bbox_px[0] - pad, bbox_px[1] - pad, bbox_px[2] + pad, bbox_px[3] + pad], ctx.width, ctx.height)
    ox, oy = int(b[0]), int(b[1])
    crop = _remove_rulings(ctx.img.crop((ox, oy, int(b[2]), int(b[3]))))
    ws = bc.ocr_words(crop, psm=6) or bc.ocr_words(crop, psm=11)
    return [{"text": w["text"], "bbox": [w["bbox"][0] + ox, w["bbox"][1] + oy, w["bbox"][2] + ox, w["bbox"][3] + oy], "conf": w["conf"]} for w in ws]


def _remove_rulings(img):
    """white-out long horizontal/vertical ruling lines (OCR engines choke on grids); text strokes are far shorter than the kernels"""
    import cv2
    from PIL import Image
    g = np.asarray(img.convert("L"))
    h, w = g.shape
    if h < 30 or w < 30:
        return img
    _, binv = cv2.threshold(cv2.GaussianBlur(g, (3, 3), 0), 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    hm = cv2.morphologyEx(binv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(25, w // 12), 1)))
    vm = cv2.morphologyEx(binv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(25, h // 12))))
    lines = cv2.dilate(cv2.bitwise_or(hm, vm), np.ones((3, 3), np.uint8))
    out = np.asarray(img.convert("RGB")).copy()
    out[lines > 0] = 255
    return Image.fromarray(out)


# --------------------------------------------------------------------------- grid building
def _cluster(vals: list, tol: float) -> list:
    vals = sorted(vals)
    out: list = []
    for v in vals:
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [sum(g) / len(g) for g in out]


def _nearest(edges: list, v: float) -> int:
    return min(range(len(edges)), key=lambda i: (abs(edges[i] - v), i))


def build_grid(boxes: list, tol: float) -> tuple:
    """cell boxes (px) -> (cells [(r0,r1,c0,c1,bbox)], n_rows, n_cols, dropped_overlaps)"""
    xs = _cluster([b[0] for b in boxes] + [b[2] for b in boxes], tol)
    ys = _cluster([b[1] for b in boxes] + [b[3] for b in boxes], tol)
    cells, occ, dropped = [], {}, 0
    for b in sorted(boxes, key=lambda b: (b[1], b[0], -(b[2] - b[0]))):
        c0, c1, r0, r1 = _nearest(xs, b[0]), _nearest(xs, b[2]), _nearest(ys, b[1]), _nearest(ys, b[3])
        if c1 <= c0 or r1 <= r0:
            continue
        pos = [(r, c) for r in range(r0, r1) for c in range(c0, c1)]
        if any(p in occ for p in pos):
            dropped += 1
            continue
        for p in pos:
            occ[p] = True
        cells.append((r0, r1, c0, c1, [xs[c0], ys[r0], xs[c1], ys[r1]]))
    nr, nc = len(ys) - 1, len(xs) - 1
    for r in range(nr):
        for c in range(nc):
            if (r, c) not in occ:
                cells.append((r, r + 1, c, c + 1, [xs[c], ys[r], xs[c + 1], ys[r + 1]], True))
    return cells, nr, nc, dropped


def _cv_cells(img_crop: "np.ndarray") -> Optional[list]:
    """gray crop -> list of cell boxes (crop px) from line masks, merged cells detected by missing borders; None if no grid."""
    import cv2
    h, w = img_crop.shape
    if h < 30 or w < 30:
        return None
    _, binv = cv2.threshold(cv2.GaussianBlur(img_crop, (3, 3), 0), 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    hm = cv2.morphologyEx(binv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(12, w // 20), 1)))
    vm = cv2.morphologyEx(binv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(12, h // 20))))

    def centres(mask, axis):
        n, lab, st, _ = cv2.connectedComponentsWithStats(mask)
        vals = []
        for i in range(1, n):
            x, y, ww, hh, _a = st[i]
            if axis == 0 and ww >= 0.3 * w:
                vals.append(y + hh / 2.0)
            if axis == 1 and hh >= 0.3 * h:
                vals.append(x + ww / 2.0)
        return _cluster(vals, max(3.0, 0.01 * (h if axis == 0 else w)))
    ys, xs = centres(hm, 0), centres(vm, 1)
    if len(ys) < 3 or len(xs) < 3:
        return None
    nr, nc = len(ys) - 1, len(xs) - 1
    uf = bc.UnionFind(nr * nc)

    def present(mask, x1, y1, x2, y2):
        x1, y1, x2, y2 = int(max(0, x1)), int(max(0, y1)), int(min(w, x2 + 1)), int(min(h, y2 + 1))
        if x2 <= x1 or y2 <= y1:
            return True
        band = mask[y1:y2, x1:x2]
        return band.size > 0 and (band > 0).any(axis=0 if band.shape[1] > band.shape[0] else 1).mean() >= 0.5
    for r in range(nr):
        for c in range(nc):
            if c + 1 < nc and not present(vm, xs[c + 1] - 3, ys[r] + 4, xs[c + 1] + 3, ys[r + 1] - 4):
                uf.union(r * nc + c, r * nc + c + 1)
            if r + 1 < nr and not present(hm, xs[c] + 4, ys[r + 1] - 3, xs[c + 1] - 4, ys[r + 1] + 3):
                uf.union(r * nc + c, (r + 1) * nc + c)
    boxes = []
    for g in uf.groups():
        rs = [i // nc for i in g]
        cs = [i % nc for i in g]
        r0, r1, c0, c1 = min(rs), max(rs) + 1, min(cs), max(cs) + 1
        if (r1 - r0) * (c1 - c0) == len(g):
            boxes.append([xs[c0], ys[r0], xs[c1], ys[r1]])
        else:  # non-rectangular union -> keep single cells (never invent a span)
            for i in g:
                boxes.append([xs[i % nc], ys[i // nc], xs[i % nc + 1], ys[i // nc + 1]])
    return boxes


def _word_cluster_cells(words: list, bbox: list) -> Optional[list]:
    """borderless fallback: rows by y-centre, columns by empty vertical channels shared by >= 90% of rows"""
    if len(words) < 4:
        return None
    lines = bc.import_agent("05_layout")._group_lines(words)
    if len(lines) < 2:
        return None
    hs = [w["bbox"][3] - w["bbox"][1] for w in words]
    mh = statistics.median(hs)
    iv = sorted((w["bbox"][0], w["bbox"][2]) for w in words)
    chans, end = [], iv[0][1]
    for a, b in iv[1:]:
        if a - end >= 1.2 * mh:
            chans.append((end + a) / 2.0)
        end = max(end, b)
    edges = [bbox[0]] + chans + [bbox[2]]
    if len(edges) < 3:
        return None
    ry = []
    for ln in lines:
        lb = bc.union_box([w["bbox"] for w in ln])
        ry.append((lb[1], lb[3]))
    boxes = []
    for i, (y1, y2) in enumerate(ry):
        top = bbox[1] if i == 0 else (ry[i - 1][1] + y1) / 2
        bot = bbox[3] if i == len(ry) - 1 else (y2 + ry[i + 1][0]) / 2
        for c in range(len(edges) - 1):
            boxes.append([edges[c], top, edges[c + 1], bot])
    return boxes


# --------------------------------------------------------------------------- engines
def _find_tables_cells(ctx: bc.PageCtx, bbox_px: list, strategy: str) -> Optional[list]:
    r = ctx.px_to_vis(bbox_px).normalize()   # find_tables works in VISUAL page space (see PageCtx.vis_to_px)
    r = fitz.Rect(r.x0 - 3, r.y0 - 3, r.x1 + 3, r.y1 + 3)
    try:
        with ctx.lock:
            tf = ctx.page.find_tables(clip=r, strategy=strategy)
            best = None
            for t in tf.tables:
                tb = ctx.vis_to_px(t.bbox)
                ov = bc.iou(tb, bbox_px)
                if t.row_count >= 2 and t.col_count >= 2 and ov >= 0.4 and (best is None or ov > best[0]):
                    best = (ov, [ctx.vis_to_px(c) for c in t.cells if c])
    except Exception as e:
        bc.dbg(AGENT, "find_tables_error", strategy=strategy, err=type(e).__name__)
        return None
    return best[1] if best and len(best[1]) >= 4 else None


def extract_structure(ctx: bc.PageCtx, bbox: list, warns: list) -> tuple:
    """-> (engine, cell_boxes, words, word_source)"""
    t = bc.Timer()
    has_text = False
    words: list = []
    if ctx.kind == "pdf":
        words = _pdf_words(ctx, bbox)
        has_text = len(words) >= 4
    bc.dbg(AGENT, "words", source="pdf" if has_text else "ocr_pending", n=len(words))
    if has_text:
        for eng, strat in (("pdf_ruled", "lines"), ("pdf_text", "text")):
            cb = _find_tables_cells(ctx, bbox, strat)
            if cb:
                bc.dbg(AGENT, "engine", used=eng, cells=len(cb), ms=t.ms())
                return eng, cb, words, "pdf_text_layer"
        cb = _word_cluster_cells(words, bbox)
        if cb:
            bc.dbg(AGENT, "engine", used="word_clusters", cells=len(cb), ms=t.ms())
            return "word_clusters", cb, words, "pdf_text_layer"
        return "none", [], words, "pdf_text_layer"
    # scanned / image
    b = bc.clamp_box(bbox, ctx.width, ctx.height)
    ox, oy = int(b[0]), int(b[1])
    gray = ctx.gray()[oy:int(b[3]), ox:int(b[2])]
    cv = _cv_cells(gray)
    words = _ocr_words(ctx, bbox)
    if cv:
        cb = [[c[0] + ox, c[1] + oy, c[2] + ox, c[3] + oy] for c in cv]
        bc.dbg(AGENT, "engine", used="cv_grid", cells=len(cb), ocr_words=len(words), ms=t.ms())
        return "cv_grid", cb, words, "ocr"
    cb = _word_cluster_cells(words, bbox)
    if cb:
        warns.append(bc.warn("NO_GRID_LINES", "No ruling lines were found; the structure was inferred from word positions"))
        bc.dbg(AGENT, "engine", used="word_clusters", cells=len(cb), ocr_words=len(words), ms=t.ms())
        return "word_clusters", cb, words, "ocr"
    return "none", [], words, "ocr"


# --------------------------------------------------------------------------- assembling
def _cell_text(words: list) -> str:
    if not words:
        return ""
    lines = bc.import_agent("05_layout")._group_lines(words)
    return " ".join(" ".join(w["text"] for w in ln) for ln in lines).strip()


def _detect_header(rows_text: list) -> int:
    """1 if the first row is all non-numeric text and a later row has numbers in >= 50% of the columns where row 0 has text, else 0"""
    if len(rows_text) < 2:
        return 0
    first = rows_text[0]
    filled = [c for c, t in enumerate(first) if t]
    if not filled or any(parse_number(first[c])[0] is not None for c in filled):
        return 0
    for row in rows_text[1:]:
        nums = sum(1 for c in filled if c < len(row) and row[c] and parse_number(row[c])[0] is not None)
        if nums >= max(1, len(filled) // 2):
            return 1
    return 0


def _total_checks(grid_num: list, labels: list) -> list:
    """rows whose first cell contains 'total' -> compare with the sum of numeric cells above in the same column"""
    out = []
    for r, lab in enumerate(labels):
        if r > 0 and lab and re.search(r"\btotal\b", lab, re.I):
            for c in range(1, len(grid_num[r])):
                v = grid_num[r][c]
                above = [grid_num[k][c] for k in range(r) if grid_num[k][c] is not None]
                if v is not None and len(above) >= 2:
                    s = round(sum(above), 6)
                    out.append({"row": r, "col": c, "stated": v, "computed": s, "ok": abs(s - v) <= max(0.01, 1e-6 * abs(v))})
    return out


def assemble(ctx: bc.PageCtx, region: dict, warns_out: list) -> TableResult:
    bbox = region["location"]["bbox"]
    warns: list = []
    engine, cboxes, words, wsrc = extract_structure(ctx, bbox, warns)
    if engine == "none" or not cboxes:
        warns.append(bc.warn("STRUCTURE_NOT_FOUND", "The table structure could not be recovered; no cells were produced"))
        return TableResult(region_id=region["region_id"], table_id=bc.stable_id(ctx.page_id, "table", region["region_id"]), n_rows=0, n_cols=0, header_rows=0, cells=[], grid=[],
                           location=ctx.loc(bbox), extraction_method="none", confidence=0.0, signals={"word_source": wsrc, "words": len(words)}, warnings=warns)
    tol = max(2.0, T("edge_tol_frac", 0.003) * ctx.width)
    gcells, nr, nc, dropped = build_grid(cboxes, tol)
    if dropped:
        warns.append(bc.warn("OVERLAPPING_CELLS_DROPPED", f"{dropped} overlapping cell box(es) were ignored", count=dropped))
    base = BASE[engine]
    assigned = set()
    cells: list = []
    for g in sorted(gcells, key=lambda g: (g[0], g[2])):
        r0, r1, c0, c1, bb = g[:5]
        inferred = len(g) > 5
        mine = []
        for i, w in enumerate(words):
            cx, cy = (w["bbox"][0] + w["bbox"][2]) / 2, (w["bbox"][1] + w["bbox"][3]) / 2
            if bb[0] <= cx < bb[2] and bb[1] <= cy < bb[3] and i not in assigned:
                mine.append(w)
                assigned.add(i)
        text = _cell_text(mine)
        wc = sum(w["conf"] for w in mine) / len(mine) if mine else 1.0
        conf = base * wc * (bc.text_confidence(text) if text else 1.0)
        val, amb = parse_number(text) if text else (None, False)
        cells.append(Cell(row=r0, col=c0, rowspan=r1 - r0, colspan=c1 - c0, text=text, is_empty=not text, inferred_empty=inferred, numeric_value=val,
                          location=ctx.loc(bb), extraction_method=engine, confidence=round(max(0.0, min(1.0, conf)), 3)))
    if engine in ("pdf_text", "word_clusters"):   # text-alignment engines produce blank spacer rows; ruled/cv tables keep theirs
        covered = {r: [c for c in cells if c.row <= r < c.row + c.rowspan] for r in range(nr)}
        empty_rows = [r for r in range(nr) if all(c.is_empty and c.rowspan == 1 for c in covered[r])]
        if empty_rows and len(empty_rows) < nr:
            newidx, k = {}, 0
            for r in range(nr):
                if r not in empty_rows:
                    newidx[r] = k
                    k += 1
            cells = [c for c in cells if c.row in newidx]
            for c in cells:
                c.row = newidx[c.row]
            nr = k
    outside = len(words) - len(assigned)
    if outside:
        warns.append(bc.warn("WORDS_OUTSIDE_CELLS", f"{outside} word(s) inside the table region were not inside any cell", count=outside))
    bc.dbg(AGENT, "grid", rows=nr, cols=nc, cells=len(cells), merged=sum(1 for c in cells if c.rowspan > 1 or c.colspan > 1), outside_words=outside)
    # grid + header + numbers
    grid: list = [[None] * nc for _ in range(nr)]
    rows_text: list = [[""] * nc for _ in range(nr)]
    grid_num: list = [[None] * nc for _ in range(nr)]
    for c in cells:
        for r in range(c.row, c.row + c.rowspan):
            for k in range(c.col, c.col + c.colspan):
                grid[r][k] = None
        grid[c.row][c.col] = c.text
        rows_text[c.row][c.col] = c.text
        grid_num[c.row][c.col] = c.numeric_value
    hdr = _detect_header(rows_text)
    for c in cells:
        if c.row < hdr:
            c.is_header = True
            c.numeric_value = None
    checks = _total_checks(grid_num, [rows_text[r][0] for r in range(nr)])
    bad = [k for k in checks if not k["ok"]]
    if bad:
        warns.append(bc.warn("TOTAL_MISMATCH", "A stated total differs from the sum of the cells above it (values were NOT changed)", checks=bad))
    ambiguous = sum(1 for c in cells if c.text and parse_number(c.text)[1])
    # confidence
    filled = [c for c in cells if not c.is_empty]
    cell_mean = sum(c.confidence for c in filled) / len(filled) if filled else 0.0
    counts = [sum(1 for c in cells if c.row == r and not c.is_empty) for r in range(nr)]
    modal = statistics.mode(counts) if counts else 0
    consistency = sum(1 for n in counts if n == modal) / len(counts) if counts else 0.0
    tconf = round(max(0.0, min(1.0, cell_mean * (0.5 + 0.5 * consistency))), 3)
    low = [(c.row, c.col) for c in filled if c.confidence < T("min_cell_conf", 0.5)]
    if low:
        warns.append(bc.warn("LOW_CONFIDENCE_CELLS", f"{len(low)} cell(s) have low confidence", cells=low[:50]))
    if not filled:
        warns.append(bc.warn("EMPTY_TABLE", "The table contains no readable text"))
    sig = {"engine": engine, "word_source": wsrc, "words": len(words), "row_consistency": round(consistency, 3), "ambiguous_numbers": ambiguous,
           "total_checks": checks, "header_rule": "first_row_text_then_numbers" if hdr else "none"}
    return TableResult(region_id=region["region_id"], table_id=bc.stable_id(ctx.page_id, "table", region["region_id"]), n_rows=nr, n_cols=nc, header_rows=hdr, cells=cells,
                       grid=grid, location=ctx.loc(bbox), extraction_method=engine, confidence=tconf, signals=sig, warnings=warns)


def run(req: TableInput, user: Optional[dict] = None) -> TableOutput:
    if user is None:
        user = bc.current_user()
    t = bc.Timer()
    bc.dbg(AGENT, "start", source_id=req.source_id, page=req.page_number, region_id=req.region_id, user=user.get("user_id"))
    ctx = bc.load_page(req.source_id, req.page_number, user)
    layout = bc.get_layout(ctx)
    if req.region_id:
        reg = bc.find_region(layout, req.region_id)
        if reg["type"] != "table":
            raise bc.AgentError("INVALID_INPUT", "region_id is not a table region", {"type": reg["type"]})
        regions = [reg]
    else:
        regions = [r for r in layout["regions"] if r["type"] == "table"]
    bc.dbg(AGENT, "regions", count=len(regions))
    warns: list = []
    tables = [assemble(ctx, r, warns) for r in sorted(regions, key=lambda r: (r["location"]["bbox"][1], r["location"]["bbox"][0]))]
    if not tables:
        warns.append(bc.warn("NO_TABLES", "No table regions on this page"))
    out = TableOutput(source_id=ctx.source_id, page_id=ctx.page_id, page_number=ctx.page_number, tables=tables, warnings=warns)
    try:
        bc.store().put("tables", ctx.page_id, bc.jsonable_encoder(out))
    except Exception as e:
        bc.dbg(AGENT, "store_put_failed_nonfatal", err=type(e).__name__)
    bc.audit("table.extracted", "page", ctx.page_id, {"tables": len(tables), "cells": sum(len(x.cells) for x in tables)}, user=user)
    bc.dbg(AGENT, "done", tables=len(tables), ms=t.ms())
    return out


@router.post("/agents/table")
def table_endpoint(body: dict, request: Request):
    return bc.handle(request, lambda: run(TableInput.model_validate(body)))
ENDPOINT, {
    method: "POST",
    body: input,
    signal,
  });
}
