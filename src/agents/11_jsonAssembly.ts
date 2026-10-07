"""
11_json_assembly.py - Agent 11: JSON Assembly  (Person C).   POST /agents/json-assembly      In {source_id}  ->  Out SourceDocument

Orchestrates what the other agents already stored; it does NOT re-run extractors.  Missing inputs -> CONFLICT {missing:[...]} (nothing partial is saved).

Inputs (store kinds, see common/util.py):  format_route (02)  native_text (03)  ocr (04)  spreadsheet (08)  layout (05)  reading_order (06)
                                           tables (07)  charts (09)  equations (10)  consensus (21)
Pipeline (debug line per step):
  1 source + route + completeness check   2 per page: regions in reading order   3 text lines -> regions (containment)   4 table / chart / figure / equation blocks
  5 orphan text   6 unique ids, reading_order_index, unicode normalisation   7 table continuation links   8 coverage (from 21)   9 Markdown
  10 validate (JSON Schema + invariants; fails loudly)   11 audit (fail closed) + SHA-256 integrity record + save

TEXT SOURCE PER PAGE   consensus blocks (21) when the page has any, else the native text layer if usable, else the OCR engine with the best mean confidence.
LINE -> REGION         a line belongs to the region containing >= assembly.region_containment_min of its area (best containment, ties: smallest region).
                       Lines inside table/figure/chart/equation regions are part of that block (not duplicated).  Lines in no region become an
                       ORPHAN text block (warning ORPHAN_TEXT, confidence capped by assembly.orphan_block_confidence), placed after the page's main flow.
BLOCK CONFIDENCE       `confidence` = engine confidence (text: character-weighted mean of the line confidences; table/chart/equation: the producing agent's value).
                       Everything agent 12 needs to combine is kept in `extra` (engine_confidence, layout_confidence, agreement, agreement_similarity, single_source, ...).
Never invents: a text region with no text keeps text=null + warning NO_TEXT_FOR_REGION; unknown fields from other agents are preserved under `extra`.
Status: "complete" when every page has >= 1 block and no error was recorded, else "partial" (pages that failed are listed in `errors`).
coverage_score (document) = mean of the page coverage scores from agent 21 (null when 21 produced none).
Markdown (stored, served by GET /sources/{id}/markdown): title -> heading, paragraphs, lists, GFM tables (no detected header -> empty header row, nothing invented),
equations $$..$$, figures/charts as image references with captions, header/footer omitted from the body.
"""
from __future__ import annotations

import re
from typing import Annotated, Any, Literal, Optional, Union

import jsonschema
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from common import audit, auth, config, crypto, jobs, store, util
from common.envelope import ApiError, Timer, WarningItem, accepted, dbg, handle, now_iso, warn

AGENT = "11_json_assembly"
router = APIRouter()
TEXTISH = ["text", "title", "header", "footer", "list", "caption", "signature", "stamp", "form_field"]
ABSORBING = {"table", "figure", "chart", "equation"}
SCHEMA_VERSION = "1"


# =========================================================================== models
class Location(BaseModel):
    bbox: Optional[list[float]] = None
    coordinate_system: str = "pixel_top_left"
    page_width: Optional[float] = None
    page_height: Optional[float] = None
    bbox_unavailable_reason: Optional[str] = None


class Badge(BaseModel):
    scope_id: str
    label: str
    status: str
    detail: Optional[str] = None


class BaseBlock(BaseModel):
    block_id: str
    source_id: str
    page_id: str
    page_number: int
    reading_order_index: int
    location: Location
    confidence: float = Field(ge=0, le=1)
    extraction_method: str
    text: Optional[str] = None
    warnings: list[WarningItem] = []
    extra: dict = {}


class TextBlock(BaseBlock):
    type: Literal["text", "title", "header", "footer", "list", "caption", "signature", "stamp", "form_field"]


class TableCell(BaseModel):
    row: int
    col: int
    row_span: int = 1
    col_span: int = 1
    is_header: bool = False
    raw_text: str
    normalized: Optional[dict] = None
    location: Location
    confidence: float = Field(ge=0, le=1)
    extraction_method: str
    alternatives: list[dict] = []
    extra: dict = {}


class TableBlock(BaseBlock):
    type: Literal["table"] = "table"
    n_rows: int
    n_cols: int
    header_rows: int = 0
    cells: list[TableCell]
    badges: list[Badge] = []
    continues_from: Optional[str] = None
    continues_to: Optional[str] = None


class ChartBlock(BaseBlock):
    type: Literal["chart"] = "chart"
    chart_type: Optional[str] = None
    title: Optional[str] = None
    caption: Optional[str] = None
    crop_url: str
    x_axis: dict = {}
    y_axis: dict = {}
    series: list[dict] = []
    insight_text: Optional[str] = None


class FigureBlock(BaseBlock):
    type: Literal["figure"] = "figure"
    caption: Optional[str] = None
    crop_url: str
    text_in_figure: list[str] = []
    description: Optional[str] = None


class EquationBlock(BaseBlock):
    type: Literal["equation"] = "equation"
    latex: Optional[str] = None
    plain_text: Optional[str] = None
    verified: bool = False
    equation_number: Optional[str] = None


Block = Annotated[Union[TextBlock, TableBlock, ChartBlock, FigureBlock, EquationBlock], Field(discriminator="type")]


class UncoveredRegion(BaseModel):
    page_number: int
    bbox: list[float]
    area_px: int


class Page(BaseModel):
    page_number: int
    page_id: str
    image_url: Optional[str] = None
    width: Optional[float] = None
    height: Optional[float] = None
    page_class: Optional[str] = None
    layout_class: Optional[str] = None
    blocks: list[Block] = []
    warnings: list[WarningItem] = []
    coverage_score: Optional[float] = None


class SourceDocument(BaseModel):
    schema_version: str = SCHEMA_VERSION
    source_id: str
    status: str                       # complete | partial
    route: Optional[str] = None
    pages: list[Page]
    warnings: list[WarningItem] = []
    errors: list[dict] = []
    coverage_score: Optional[float] = None
    uncovered_regions: list[UncoveredRegion] = []
    generated_at: str


class AssemblyInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)


# =========================================================================== 1. completeness
def missing_outputs(source_id: str, route: dict) -> list:
    miss: list = []
    if route["route"] in ("xlsx", "csv"):
        if not store.exists("spreadsheet", source_id):
            miss.append("spreadsheet")
        return miss
    if not store.exists("consensus", source_id):
        miss.append("consensus")
    for u in route["units"]:
        pid = util.make_page_id(source_id, u["page_number"])
        n = u["page_number"]
        if not store.exists("layout", pid):
            miss.append(f"layout:p{n}")
            continue
        if not store.exists("reading_order", pid):
            miss.append(f"reading_order:p{n}")
        if not (store.exists("native_text", pid) or store.exists("ocr", pid)):
            miss.append(f"text:p{n}")
        lay = store.get("layout", pid) or {}
        types = {r.get("type") for r in lay.get("regions", [])}
        if "table" in types and not store.exists("tables", pid):
            miss.append(f"tables:p{n}")
        if types & {"chart", "figure"} and not store.exists("charts", pid):
            miss.append(f"charts:p{n}")
        if "equation" in types and not store.exists("equations", pid):
            miss.append(f"equations:p{n}")
    return miss


# =========================================================================== helpers
def _loc(bbox: Optional[list], w: Optional[float], h: Optional[float], reason: Optional[str] = None) -> Location:
    if bbox is None:
        return Location(bbox=None, page_width=w, page_height=h, bbox_unavailable_reason=reason or "unknown")
    return Location(bbox=[util.r2(v) for v in bbox], page_width=w, page_height=h)


def _warns(items: Any) -> list:
    out = []
    for w in items or []:
        if isinstance(w, dict) and "code" in w:
            out.append(WarningItem(code=str(w["code"]), message=str(w.get("message", "")), details=w.get("details")))
    return out


def _unique(bid: str, used: set, warns: list) -> str:
    out, k = bid, 2
    while out in used:
        out = f"{bid}#{k}"
        k += 1
    if out != bid:
        warns.append(warn("DUPLICATE_BLOCK_ID_RESOLVED", "A duplicate block id was made unique", block_id=out))
    used.add(out)
    return out


_CELL_ID = re.compile(r":r\d+c\d+(#\d+)?$")
_AGR_RANK = {"split": 0, "majority": 1, "unanimous": 2}


def _normalized(text: str, value: Optional[float]) -> Optional[dict]:
    if value is None or not text:
        return None
    t = text.strip()
    rule = "parenthesis_negative" if t.startswith("(") else "strip_percent" if t.endswith("%") else "strip_thousands_separator" if "," in t else "plain_number"
    return {"value": value, "rule": rule}


def _text_items(source_id: str, page_id: str, cons: dict) -> tuple:
    """-> (items, source_label). item = {text,bbox,confidence,extractor,agreement,similarity,single,escalated,needs_review,block_id}"""
    items = []
    for b in cons.get(page_id, []):
        if _CELL_ID.search(b["block_id"]):
            continue
        bb = util.bbox_of(b)
        if bb:
            items.append({"text": b["winner"], "bbox": bb, "confidence": util.clamp01(b.get("confidence")), "extractor": b.get("winner_extractor"), "agreement": b.get("agreement"),
                          "similarity": b.get("similarity"), "single": b.get("single_source"), "escalated": b.get("escalated"), "needs_review": b.get("needs_review"), "block_id": b["block_id"]})
    if items:
        return items, "consensus"
    nat, usable = util.native_lines(page_id)
    if nat and usable:
        return [{"text": l["text"], "bbox": l["bbox"], "confidence": l["confidence"], "extractor": "native_text"} for l in nat], "native_text"
    engines = util.ocr_engines(page_id)
    engines = [e for e in engines if e["lines"]]
    if engines:
        best = max(engines, key=lambda e: (sum(l["confidence"] for l in e["lines"]) / len(e["lines"]), e["engine"]))
        return [{"text": l["text"], "bbox": l["bbox"], "confidence": l["confidence"], "extractor": best["engine"]} for l in best["lines"]], f"ocr:{best['engine']}"
    return [], "none"


def _ordered_regions(layout: dict, order: Optional[dict], warns: list) -> list:
    regs = {r["region_id"]: r for r in layout.get("regions", [])}
    ids: list = []
    if order:
        if order.get("ordered_ids"):
            ids = list(order["ordered_ids"])
        else:
            ids = [i["region_id"] for i in sorted(order.get("items", []), key=lambda i: i.get("order", 0))]
    seen, out = set(), []
    for i in ids:
        if i in regs and i not in seen:
            out.append(regs[i])
            seen.add(i)
    rest = sorted((r for rid, r in regs.items() if rid not in seen), key=lambda r: (util.bbox_of(r)[1] if util.bbox_of(r) else 0, util.bbox_of(r)[0] if util.bbox_of(r) else 0, r["region_id"]))
    if rest:
        warns.append(warn("REGION_NOT_IN_READING_ORDER", f"{len(rest)} region(s) were missing from the reading order and were appended top-to-bottom", count=len(rest)))
    return out + rest


def _crop_url(source_id: str, page_number: int, region_id: str) -> str:
    return f"/sources/{source_id}/pages/{page_number}/regions/{region_id}/crop"


# =========================================================================== 2-6. page assembly
def assemble_page(source_id: str, unit: dict, cons: dict, used: set) -> Page:
    pn = unit["page_number"]
    page_id = util.make_page_id(source_id, pn)
    layout = store.get("layout", page_id)
    order = store.get("reading_order", page_id)
    W, H = layout.get("page_width"), layout.get("page_height")
    pwarn: list = []
    regs = _ordered_regions(layout, order, pwarn)
    tables = {t["region_id"]: t for t in (store.get("tables", page_id) or {}).get("tables", [])}
    charts = {c["region_id"]: c for c in (store.get("charts", page_id) or {}).get("results", [])}
    eqs = {e["region_id"]: e for e in (store.get("equations", page_id) or {}).get("equations", [])}
    items, src_label = _text_items(source_id, page_id, cons)
    thr = float(config.get("assembly.region_containment_min", 0.5))
    # ---- 3. lines -> regions
    attached: dict = {r["region_id"]: [] for r in regs}
    orphans: list = []
    rboxes = [(r, util.bbox_of(r)) for r in regs if util.bbox_of(r)]
    for it in items:
        best, best_key = None, None
        for r, rb in rboxes:
            c = util.contain(it["bbox"], rb)
            if c >= thr:
                key = (-round(c, 6), util.area(rb), r["region_id"])
                if best_key is None or key < best_key:
                    best, best_key = r, key
        if best is None:
            orphans.append(it)
        elif best["type"] not in ABSORBING:
            attached[best["region_id"]].append(it)
    blocks: list = []

    def add(block):
        blocks.append(block)

    for r in regs:
        rb = util.bbox_of(r)
        rid, typ = r["region_id"], r["type"]
        loc = _loc(rb, W, H, "region_has_no_bbox")
        bwarn = _warns(r.get("warnings"))
        layout_conf = util.clamp01(r.get("confidence"), 0.5)
        if typ == "table" and rid in tables:
            t = tables[rid]
            cells = []
            for c in t.get("cells", []):
                cb = util.bbox_of(c)
                txt = util.normalize_text(c.get("raw_text", c.get("text", "")))
                cells.append(TableCell(row=int(c["row"]), col=int(c["col"]), row_span=int(c.get("row_span", c.get("rowspan", 1))), col_span=int(c.get("col_span", c.get("colspan", 1))),
                                       is_header=bool(c.get("is_header", False)), raw_text=txt, normalized=c.get("normalized") or _normalized(txt, c.get("numeric_value")),
                                       location=_loc(cb, W, H, "cell_has_no_bbox"), confidence=util.clamp01(c.get("confidence"), 0.0),
                                       extraction_method=str(c.get("extraction_method", t.get("extraction_method", "unknown"))), alternatives=c.get("alternatives") or [],
                                       extra={k: c[k] for k in ("is_empty", "inferred_empty") if k in c}))
            bid = _unique(rid, used, pwarn)
            badges = []
            checks = (t.get("signals") or {}).get("total_checks") or []
            if checks:
                bad = [k for k in checks if not k.get("ok", True)]
                badges.append(Badge(scope_id=bid, label="Totals mismatch" if bad else "Totals verified", status="mismatch" if bad else "pass",
                                    detail="; ".join(f"row {k['row']} col {k['col']}: stated {k['stated']} vs computed {k['computed']}" for k in (bad or checks))[:500]))
            if not cells:
                bwarn.append(warn("TABLE_WITHOUT_CELLS", "The table agent produced no cells for this region"))
            add(TableBlock(block_id=bid, source_id=source_id, page_id=page_id, page_number=pn, reading_order_index=0, location=loc,
                           confidence=util.clamp01(t.get("confidence"), 0.0), extraction_method=str(t.get("extraction_method", "unknown")), warnings=bwarn + _warns(t.get("warnings")),
                           extra={"layout_confidence": layout_conf, "engine_confidence": util.clamp01(t.get("confidence"), 0.0), "table_signals": t.get("signals", {})},
                           n_rows=int(t.get("n_rows", 0)), n_cols=int(t.get("n_cols", 0)), header_rows=int(t.get("header_rows", 0)), cells=cells, badges=badges))
        elif typ in ("chart", "figure") and rid in charts:
            c = charts[rid]
            bid = _unique(rid, used, pwarn)
            common_kw = dict(block_id=bid, source_id=source_id, page_id=page_id, page_number=pn, reading_order_index=0, location=loc, confidence=util.clamp01(c.get("confidence"), 0.0),
                             extraction_method=str(c.get("extraction_method", "unknown")), warnings=bwarn + _warns(c.get("warnings")),
                             extra={"layout_confidence": layout_conf, "engine_confidence": util.clamp01(c.get("confidence"), 0.0), "signals": c.get("signals", {})})
            if typ == "chart" or c.get("kind") == "chart":
                add(ChartBlock(**common_kw, chart_type=c.get("chart_type"), title=c.get("title"), caption=c.get("caption"), crop_url=c.get("crop_url") or _crop_url(source_id, pn, rid),
                               x_axis=c.get("x_axis") or {}, y_axis=c.get("y_axis") or {}, series=c.get("series") or [], insight_text=c.get("insight_text")))
            else:
                add(FigureBlock(**common_kw, caption=c.get("caption"), crop_url=c.get("crop_url") or _crop_url(source_id, pn, rid), text_in_figure=c.get("text_in_figure") or [],
                                description=c.get("description")))
        elif typ == "equation" and rid in eqs:
            e = eqs[rid]
            ver = e.get("verification") or {}
            bid = _unique(rid, used, pwarn)
            add(EquationBlock(block_id=bid, source_id=source_id, page_id=page_id, page_number=pn, reading_order_index=0, location=loc, confidence=util.clamp01(e.get("confidence"), 0.0),
                              extraction_method=str(e.get("extraction_method", "unknown")), warnings=bwarn + _warns(e.get("warnings")),
                              extra={"layout_confidence": layout_conf, "engine_confidence": util.clamp01(e.get("confidence"), 0.0), "verification": ver},
                              latex=e.get("latex"), plain_text=util.normalize_text(e.get("plain_text")) or None, verified=bool(ver.get("passed", e.get("verified", False))),
                              equation_number=e.get("equation_number")))
        elif typ in TEXTISH:
            its = sorted(attached.get(rid, []), key=lambda i: (round(i["bbox"][1] / 4), i["bbox"][0]))
            bid = _unique(rid, used, pwarn)
            if its:
                text = "\n".join(util.normalize_text(i["text"]) for i in its)
                tot = sum(max(1, len(i["text"])) for i in its)
                eng = sum(i["confidence"] * max(1, len(i["text"])) for i in its) / tot
                agr = [i["agreement"] for i in its if i.get("agreement")]
                sims = [i["similarity"] for i in its if i.get("similarity") is not None]
                extra = {"layout_confidence": layout_conf, "engine_confidence": round(eng, 4), "lines": len(its), "source": src_label, "extractors": sorted({i["extractor"] for i in its if i.get("extractor")}),
                         "agreement": min(agr, key=lambda a: _AGR_RANK.get(a, 1)) if agr else None, "agreement_similarity": round(sum(sims) / len(sims), 4) if sims else None,
                         "single_source": all(i.get("single") for i in its) if agr else None, "escalated": any(i.get("escalated") for i in its), "needs_review": any(i.get("needs_review") for i in its),
                         "consensus_block_ids": [i["block_id"] for i in its if i.get("block_id")]}
                add(TextBlock(type=typ, block_id=bid, source_id=source_id, page_id=page_id, page_number=pn, reading_order_index=0, location=loc, confidence=round(eng, 4),
                              extraction_method=src_label, text=text, warnings=bwarn, extra=extra))
            else:
                bwarn.append(warn("NO_TEXT_FOR_REGION", "No text was extracted for this region"))
                add(TextBlock(type=typ, block_id=bid, source_id=source_id, page_id=page_id, page_number=pn, reading_order_index=0, location=loc, confidence=0.0, extraction_method=src_label,
                              text=None, warnings=bwarn, extra={"layout_confidence": layout_conf, "engine_confidence": 0.0, "lines": 0, "source": src_label}))
        else:
            pwarn.append(warn("REGION_WITHOUT_AGENT_OUTPUT", "A region has no output from its agent and was not assembled", region_id=rid, type=typ))
    # ---- 5. orphan text
    cap = float(config.get("assembly.orphan_block_confidence", 0.5))
    orph_blocks = []
    for it in sorted(orphans, key=lambda i: (round(i["bbox"][1] / 4), i["bbox"][0], i["text"])):
        bid = _unique(util.stable_id(page_id, "orphan", *[round(v) for v in it["bbox"]]), used, pwarn)
        orph_blocks.append(TextBlock(type="text", block_id=bid, source_id=source_id, page_id=page_id, page_number=pn, reading_order_index=0, location=_loc(it["bbox"], W, H),
                                     confidence=min(it["confidence"], cap), extraction_method=src_label, text=util.normalize_text(it["text"]),
                                     warnings=[warn("ORPHAN_TEXT", "This text is not inside any layout region")],
                                     extra={"layout_confidence": 0.0, "engine_confidence": it["confidence"], "lines": 1, "source": src_label, "agreement": it.get("agreement"),
                                            "agreement_similarity": it.get("similarity"), "single_source": it.get("single"), "needs_review": it.get("needs_review")}))
    if orph_blocks:
        pwarn.append(warn("ORPHAN_TEXT", f"{len(orph_blocks)} line(s) of text are outside every layout region", count=len(orph_blocks)))
        idx = next((i for i, b in enumerate(blocks) if b.type == "footer"), len(blocks))
        blocks[idx:idx] = orph_blocks
    cap_n = int(config.get("assembly.max_blocks_per_page", 5000))
    if len(blocks) > cap_n:
        pwarn.append(warn("BLOCK_LIMIT_REACHED", "The page has more blocks than assembly.max_blocks_per_page; the rest were dropped", kept=cap_n, total=len(blocks)))
        blocks = blocks[:cap_n]
    for i, b in enumerate(blocks):
        b.reading_order_index = i
    if not blocks:
        pwarn.append(warn("PAGE_EMPTY", "This page has no blocks"))
    return Page(page_number=pn, page_id=page_id, image_url=f"/sources/{source_id}/pages/{pn}/image", width=W, height=H, page_class=unit.get("page_class"),
                layout_class=layout.get("layout_class"), blocks=blocks, warnings=pwarn)


def _spreadsheet_pages(source_id: str, used: set) -> list:
    data = store.get("spreadsheet", source_id) or {}
    pages = []
    for si, sh in enumerate(data.get("sheets", []), start=1):
        page_id = util.make_page_id(source_id, si)
        pw: list = []
        cells = sh.get("cells", [])
        ranges = [r for r in (sh.get("probable_tables") or []) if isinstance(r, str)] or ([sh["used_range"]] if sh.get("used_range") else [])
        if sh.get("hidden"):
            pw.append(warn("HIDDEN_SHEET", "This sheet is hidden in the workbook (it is included, never dropped)", sheet=sh.get("name")))
        blocks = []
        for ri, rng in enumerate(ranges):
            sub = _cells_in_range(cells, rng)
            if not sub:
                continue
            tcs = []
            for (r, c, cell) in sub:
                disp = cell.get("displayed_value")
                txt = util.normalize_text(str(disp if disp is not None else ("" if cell.get("raw_value") is None else cell.get("raw_value"))))
                tcs.append(TableCell(row=r, col=c, raw_text=txt, location=_loc(None, None, None, "spreadsheet_has_no_page_geometry"), confidence=1.0, extraction_method="spreadsheet",
                                     extra={k: cell[k] for k in ("ref", "formula", "number_format", "hidden") if cell.get(k) is not None}))
            rows = max(c.row for c in tcs) + 1
            cols = max(c.col for c in tcs) + 1
            bid = _unique(util.stable_id(page_id, "sheet", rng), used, pw)
            blocks.append(TableBlock(block_id=bid, source_id=source_id, page_id=page_id, page_number=si, reading_order_index=ri,
                                     location=_loc(None, None, None, "spreadsheet_has_no_page_geometry"), confidence=1.0, extraction_method="spreadsheet",
                                     extra={"sheet": sh.get("name"), "range": rng, "hidden_sheet": bool(sh.get("hidden")), "engine_confidence": 1.0, "layout_confidence": 1.0},
                                     n_rows=rows, n_cols=cols, header_rows=0, cells=sorted(tcs, key=lambda c: (c.row, c.col))))
        if not blocks:
            pw.append(warn("PAGE_EMPTY", "This sheet has no cells"))
        pages.append(Page(page_number=si, page_id=page_id, image_url=None, page_class="sheet", blocks=blocks, warnings=pw))
    return pages


def _col_idx(letters: str) -> int:
    n = 0
    for ch in letters.upper():
        n = n * 26 + (ord(ch) - 64)
    return n


_REF = re.compile(r"^\$?([A-Za-z]{1,3})\$?(\d+)$")


def _cells_in_range(cells: list, rng: str) -> list:
    m = re.match(r"^(?:.*!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$", rng or "")
    if not m:
        return []
    c1, r1 = _col_idx(m.group(1)), int(m.group(2))
    c2, r2 = (_col_idx(m.group(3)), int(m.group(4))) if m.group(3) else (c1, r1)
    out = []
    for cell in cells:
        mm = _REF.match(str(cell.get("ref", "")))
        if not mm:
            continue
        c, r = _col_idx(mm.group(1)), int(mm.group(2))
        if c1 <= c <= c2 and r1 <= r <= r2:
            out.append((r - r1, c - c1, cell))
    return out


# =========================================================================== 7. continuation
def _link_continuations(pages: list) -> None:
    """a table at the bottom of a page and a table at the top of the next with the same column count are linked (heuristic, flagged in extra)"""
    for a, b in zip(pages, pages[1:]):
        ta = [x for x in a.blocks if x.type == "table"]
        tb = [x for x in b.blocks if x.type == "table"]
        if not ta or not tb or not a.height or not b.height:
            continue
        last, first = ta[-1], tb[0]
        if last.location.bbox is None or first.location.bbox is None or last.n_cols != first.n_cols or last.n_cols == 0:
            continue
        if last.location.bbox[3] >= 0.75 * a.height and first.location.bbox[1] <= 0.25 * b.height and last.continues_to is None and first.continues_from is None:
            last.continues_to, first.continues_from = first.block_id, last.block_id
            for x in (last, first):
                x.extra["continuation_evidence"] = "same_column_count_bottom_to_top"


# =========================================================================== 9. markdown
def _esc(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ").strip()


def _md_table(b: TableBlock) -> str:
    if not b.cells or b.n_cols == 0:
        return ""
    grid = [["" for _ in range(b.n_cols)] for _ in range(b.n_rows)]
    for c in b.cells:
        if c.row < b.n_rows and c.col < b.n_cols:
            grid[c.row][c.col] = _esc(c.raw_text)
    if b.header_rows >= 1:
        head, body = grid[0], grid[1:]
    else:
        head, body = [""] * b.n_cols, grid
    lines = ["| " + " | ".join(head) + " |", "|" + "|".join(" --- " for _ in head) + "|"] + ["| " + " | ".join(r) + " |" for r in body]
    return "\n".join(lines)


def to_markdown(doc: SourceDocument) -> str:
    out: list = []
    first_title = True
    for p in doc.pages:
        out.append(f"<!-- page {p.page_number} -->")
        attached_caps = set()
        for b in p.blocks:
            if b.type == "caption":
                attached_caps.add(b.block_id)
        for b in p.blocks:
            if b.type in ("header", "footer"):
                continue
            if b.type == "title":
                out.append(("# " if first_title else "## ") + _esc(b.text or ""))
                first_title = False
            elif b.type == "list":
                for ln in (b.text or "").split("\n"):
                    ln = re.sub(r"^\s*(?:[•●○▪■◦·\-–—*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+", "", ln).strip()
                    if ln:
                        out.append(f"- {ln}")
            elif b.type == "table":
                md = _md_table(b)
                if md:
                    out.append(md)
            elif b.type == "equation":
                body = b.latex or b.plain_text
                if body:
                    out.append(f"$$\n{body}\n$$" + (f"\n\n*({b.equation_number})*" if b.equation_number else ""))
            elif b.type in ("figure", "chart"):
                cap = (b.caption or "").strip()
                out.append(f"![{_esc(cap) or b.type}]({b.crop_url})" + (f"\n\n*{_esc(cap)}*" if cap else ""))
            elif b.type == "caption":
                out.append(f"*{_esc(b.text or '')}*" if b.text else "")
            elif b.text:
                out.append(b.text.replace("\n", " ") if b.type == "text" else b.text)
        out.append("")
    md = "\n\n".join(x for x in out if x is not None)
    return re.sub(r"\n{3,}", "\n\n", md).strip() + "\n"


# =========================================================================== 10. validation
def validate_document(doc: dict) -> None:
    problems: list = []
    try:
        jsonschema.validate(doc, SourceDocument.model_json_schema())
    except jsonschema.ValidationError as e:
        problems.append(f"schema: {'/'.join(str(p) for p in e.absolute_path)}: {e.message[:120]}")
    seen: set = set()
    for p in doc["pages"]:
        for i, b in enumerate(p["blocks"]):
            if b["block_id"] in seen:
                problems.append(f"duplicate block_id {b['block_id']}")
            seen.add(b["block_id"])
            if b["reading_order_index"] != i:
                problems.append(f"reading_order_index not contiguous on page {p['page_number']}")
            bb = b["location"].get("bbox")
            if bb is not None and (not util.valid_bbox(bb) or (p.get("width") and (bb[0] < -1 or bb[2] > p["width"] + 1 or bb[1] < -1 or bb[3] > p["height"] + 1))):
                problems.append(f"bbox out of page: {b['block_id']}")
            if b["location"].get("bbox") is None and not b["location"].get("bbox_unavailable_reason"):
                problems.append(f"bbox null without reason: {b['block_id']}")
    nums = [p["page_number"] for p in doc["pages"]]
    if nums != sorted(set(nums)):
        problems.append("page numbers are not unique and ascending")
    if problems:
        raise ApiError("ENGINE_FAILED", "The assembled document failed validation and was not saved", {"problems": problems[:20]})


# =========================================================================== orchestration
def build(source_id: str) -> tuple:
    util.need_source(source_id)
    route = util.route_units(source_id)
    if not route or not route["units"] and route.get("route") not in ("xlsx", "csv"):
        raise ApiError("CONFLICT", "Required outputs are missing", {"missing": ["format_route"]})
    miss = missing_outputs(source_id, route)
    if miss:
        raise ApiError("CONFLICT", "Required outputs are missing", {"missing": miss})
    t = Timer()
    used: set = set()
    errors: list = []
    gwarn: list = []
    cons_all = store.get("consensus", source_id) or {"blocks": [], "coverage": []}
    cons: dict = {}
    for b in cons_all["blocks"]:
        cons.setdefault(b["page_id"], []).append(b)
    if route["route"] in ("xlsx", "csv"):
        pages = _spreadsheet_pages(source_id, used)
    else:
        pages = []
        for u in route["units"]:
            try:
                pages.append(assemble_page(source_id, u, cons, used))
            except ApiError:
                raise
            except Exception as e:  # one bad page must not sink the document: partial output + error record
                dbg(AGENT, "page_failed", page=u["page_number"], err=type(e).__name__)
                errors.append({"code": "ENGINE_FAILED", "message": "This page could not be assembled", "page_number": u["page_number"]})
                pages.append(Page(page_number=u["page_number"], page_id=util.make_page_id(source_id, u["page_number"]), image_url=f"/sources/{source_id}/pages/{u['page_number']}/image",
                                  blocks=[], warnings=[warn("PAGE_FAILED", "This page could not be assembled")]))
        _link_continuations(pages)
    dbg(AGENT, "pages_assembled", pages=len(pages), blocks=sum(len(p.blocks) for p in pages), ms=t.ms())
    cov = {c["page_number"]: c for c in cons_all.get("coverage", [])}
    unc: list = []
    scores: list = []
    for p in pages:
        c = cov.get(p.page_number)
        if c:
            p.coverage_score = c["coverage_score"]
            scores.append(c["coverage_score"])
            unc += [UncoveredRegion(page_number=p.page_number, bbox=r["bbox"], area_px=r["area_px"]) for r in c["uncovered_regions"]]
    status = "complete" if (pages and not errors and all(p.blocks for p in pages)) else "partial"
    doc = SourceDocument(source_id=source_id, status=status, route=route["route"], pages=pages, warnings=gwarn, errors=errors,
                         coverage_score=round(sum(scores) / len(scores), 4) if scores else None, uncovered_regions=unc, generated_at=now_iso())
    return doc, to_markdown(doc)


def document_hash(doc_dict: dict) -> str:
    body = {k: v for k, v in doc_dict.items() if k != "generated_at"}   # same inputs => same hash (timestamp excluded)
    return crypto.sha256_hex(crypto.canonical_json(body))


def load_verified_document(source_id: str) -> dict:
    """document dict, after checking its SHA-256 integrity record (used by agents 12 and 13)"""
    d = store.get("document", source_id)
    if not isinstance(d, dict):
        raise ApiError("CONFLICT", "Required outputs are missing", {"missing": ["document"]})
    rec = store.get("document_hash", source_id) or {}
    if not rec.get("sha256") or not crypto.compare(rec["sha256"], document_hash(d)):
        raise ApiError("ENGINE_FAILED", "The stored document failed its integrity check")
    return d


def run(req: AssemblyInput, user: Optional[dict] = None) -> SourceDocument:
    user = user or auth.require("run_agents")
    t = Timer()
    dbg(AGENT, "start", source_id=req.source_id, user=user["user_id"])
    doc, md = build(req.source_id)
    d = doc.model_dump(mode="json")
    validate_document(d)
    dbg(AGENT, "validated", ms=t.ms())
    sha = document_hash(d)
    audit.append({"event_type": "json_assembled", "object_type": "source", "object_id": req.source_id, "outcome": "success", "actor_id": user["user_id"], "actor_role": user["role"],
                  "tenant_id": user["tenant_id"], "details": {"pages": len(doc.pages), "blocks": sum(len(p.blocks) for p in doc.pages), "status": doc.status, "sha256": sha, "ms": t.ms()}})
    store.put("document", req.source_id, d)
    store.put("document_hash", req.source_id, {"sha256": sha, "algorithm": "sha256(canonical_json(document without generated_at))", "at": now_iso()})
    store.put("markdown", req.source_id, {"markdown": md, "sha256": crypto.sha256_hex(md)})
    dbg(AGENT, "saved", sha256=sha[:12], status=doc.status, ms=t.ms())
    return doc


@router.post("/agents/json-assembly")
def json_assembly_endpoint(body: dict, request: Request):
    box: dict = {}

    def go():
        req = AssemblyInput.model_validate(body)
        user = auth.require("run_agents")
        route = util.route_units(req.source_id)
        if route and len(route["units"]) > int(config.get("assembly.async_pages", 50)):
            util.need_source(req.source_id)
            box["job"] = jobs.submit("json_assembly", lambda: run(req, user), owner=user)
            return None
        return run(req, user)

    resp = handle(request, go)
    return accepted(request, box["job"]) if "job" in box else resp
