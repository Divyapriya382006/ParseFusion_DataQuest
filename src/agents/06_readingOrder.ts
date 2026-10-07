"""
06_reading_order.py - Agent 06: Reading Order  (Person B).   POST /agents/reading-order

Layout regions of one page -> the order a human reads them.   Deterministic recursive XY-cut, no model, no randomness.

Pipeline (debug line per step):
  1 load page + layout (from store, else agent 05)   2 split flow: header / main / footer
  3 detach captions from the main flow (attached to their figure/table/chart)
  4 XY-cut on main regions (cut with the larger NORMALISED gap wins: gap/H for horizontal, gap/W for vertical; tie -> horizontal)
  5 re-attach captions (before the parent if the caption is above it, else after)   6 confidence   7 store + audit

CONFIDENCE (documented):
  cut_conf     1.0  clean cut   (gap >= 2 * minimum gap)
               0.8  marginal cut (gap >= minimum gap)
               0.6  fallback    (no cut possible: rows by y, then x)
  item.confidence = round(region.confidence * cut_conf_of_the_last_cut_that_isolated_it, 3)
  order_confidence = mean(item.confidence over items)  (0.0 if there are no items)
  signals.agreement_with_row_major = Kendall tau (-1..1) between the XY-cut order and plain top-to-bottom/left-to-right order,
  reported for transparency (multi-column pages are EXPECTED to differ).
Thresholds (config reading_order.*): xy_min_gap_y_frac=0.008 (of page height), xy_min_gap_x_frac=0.02 (of page width), caption_max_dist_frac=0.12.
"""
from __future__ import annotations

import statistics
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

try:
    from backend.agents import b_common as bc
except ImportError:  # pragma: no cover
    import b_common as bc  # type: ignore

AGENT = "06_reading_order"
router = APIRouter()
METHOD = "xy_cut"


class ReadingOrderInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, default=1)
    refresh_layout: bool = False


class OrderItem(BaseModel):
    order: int
    region_id: str
    type: str
    flow: str                       # header | main | footer
    group: int                      # reading group (column / block index inside the flow)
    parent_region_id: Optional[str] = None   # for captions
    location: bc.Location
    extraction_method: str = METHOD
    confidence: float = Field(ge=0, le=1)
    text_preview: Optional[str] = None


class ReadingOrderOutput(BaseModel):
    source_id: str
    page_id: str
    page_number: int
    page_width: int
    page_height: int
    items: list[OrderItem]
    order_confidence: float
    columns_detected: int
    signals: dict = {}
    warnings: list[bc.WarningItem] = []


def T(name: str, default):
    return bc.cfg(f"reading_order.{name}", default)


# --------------------------------------------------------------------------- XY-cut
def _best_gap(idx: list, boxes: list, axis: int) -> tuple:
    """Largest empty gap in the projection of boxes on `axis` (0 = x, 1 = y). -> (gap, cut_position) or (0, None)"""
    iv = sorted((boxes[i][axis], boxes[i][axis + 2]) for i in idx)
    best, pos, end = 0.0, None, iv[0][1]
    for a, b in iv[1:]:
        if a - end > best:
            best, pos = a - end, (a + end) / 2.0
        end = max(end, b)
    return best, pos


def xy_cut(idx: list, boxes: list, W: int, H: int, min_y: float, min_x: float, state: dict) -> list:
    """-> list of (index, cut_conf, group_id). `state` carries the running group counter and cut statistics."""
    if len(idx) == 1:
        g = state["g"]
        state["g"] += 1
        return [(idx[0], 1.0, g)]
    gy, py = _best_gap(idx, boxes, 1)
    gx, px = _best_gap(idx, boxes, 0)
    ok_y, ok_x = gy >= min_y, gx >= min_x
    if ok_y or ok_x:
        use_y = ok_y and (not ok_x or gy / H >= gx / W)
        gap, pos, axis, mn = (gy, py, 1, min_y) if use_y else (gx, px, 0, min_x)
        a = [i for i in idx if (boxes[i][axis] + boxes[i][axis + 2]) / 2.0 < pos]
        b = [i for i in idx if (boxes[i][axis] + boxes[i][axis + 2]) / 2.0 >= pos]
        if a and b:
            conf = 1.0 if gap >= 2 * mn else 0.8
            state["cuts"].append(("h" if use_y else "v", round(gap, 1), conf))
            if not use_y:
                state["vcuts"] += 1
            out = []
            for part in (a, b):
                sub = xy_cut(part, boxes, W, H, min_y, min_x, state)
                out += [(i, min(c, conf), g) for i, c, g in sub]
            return out
    # fallback: group into rows by y-centre, rows top-to-bottom, left-to-right inside a row
    hs = [boxes[i][3] - boxes[i][1] for i in idx]
    row_h = max(1.0, 0.5 * statistics.median(hs))
    order = sorted(idx, key=lambda i: (round(((boxes[i][1] + boxes[i][3]) / 2) / row_h), boxes[i][0], boxes[i][1], i))
    state["cuts"].append(("fallback", 0.0, 0.6))
    g = state["g"]
    state["g"] += 1
    return [(i, 0.6, g) for i in order]


def _attach_captions(captions: list, parents: list, regs: dict, H: int, max_dist: float) -> dict:
    """caption region_id -> parent region_id (nearest figure/table/chart with >=30% horizontal overlap within max_dist)"""
    res = {}
    for c in captions:
        cb = regs[c]["location"]["bbox"]
        best = None
        for p in parents:
            pb = regs[p]["location"]["bbox"]
            ov = min(cb[2], pb[2]) - max(cb[0], pb[0])
            if ov < 0.3 * min(cb[2] - cb[0], pb[2] - pb[0]):
                continue
            dist = max(pb[1] - cb[3], cb[1] - pb[3], 0.0)
            if dist <= max_dist * H and (best is None or (dist, p) < best):
                best = (dist, p)
        if best:
            res[c] = best[1]
    return res


def order_regions(layout: dict) -> tuple:
    """Pure function. layout dict (agent 05 output) -> (items_data list, columns, signals, warnings)"""
    W, H = layout["page_width"], layout["page_height"]
    regs = {r["region_id"]: r for r in layout["regions"]}
    warns: list = []
    headers = sorted([r for r in regs.values() if r["type"] == "header"], key=lambda r: (r["location"]["bbox"][1], r["location"]["bbox"][0], r["region_id"]))
    footers = sorted([r for r in regs.values() if r["type"] == "footer"], key=lambda r: (r["location"]["bbox"][1], r["location"]["bbox"][0], r["region_id"]))
    rest = [r for r in regs.values() if r["type"] not in ("header", "footer")]
    parents = [r["region_id"] for r in rest if r["type"] in ("figure", "chart", "table")]
    caps = [r["region_id"] for r in rest if r["type"] == "caption"]
    attach = _attach_captions(caps, parents, regs, H, T("caption_max_dist_frac", 0.12))
    bc.dbg(AGENT, "split", headers=len(headers), footers=len(footers), main=len(rest), captions_attached=len(attach))
    main = sorted([r for r in rest if r["region_id"] not in attach], key=lambda r: r["region_id"])  # deterministic input order
    boxes = [r["location"]["bbox"] for r in main]
    state = {"g": 0, "cuts": [], "vcuts": 0}
    seq = xy_cut(list(range(len(main))), boxes, W, H, T("xy_min_gap_y_frac", 0.008) * H, T("xy_min_gap_x_frac", 0.02) * W, state) if main else []
    bc.dbg(AGENT, "xy_cut", cuts=len(state["cuts"]), vcuts=state["vcuts"], fallbacks=sum(1 for c in state["cuts"] if c[0] == "fallback"))
    rows: list = []   # (region, flow, group, parent, cut_conf)
    for r in headers:
        rows.append((r, "header", 0, None, 1.0))
    for i, c, g in seq:
        r = main[i]
        rows.append((r, "main", g, None, c))
        kids = sorted([cid for cid, pid in attach.items() if pid == r["region_id"]], key=lambda cid: regs[cid]["location"]["bbox"][1])
        for cid in kids:
            cr = regs[cid]
            above = cr["location"]["bbox"][1] < r["location"]["bbox"][1]
            tup = (cr, "main", g, r["region_id"], c)
            if above:
                rows.insert(len(rows) - 1, tup)   # caption above the table/figure is read first
            else:
                rows.append(tup)
    for r in footers:
        rows.append((r, "footer", 0, None, 1.0))
    columns = max(1, state["vcuts"] + 1) if state["vcuts"] else 1
    # compare with plain row-major order
    ids = [r["region_id"] for r, *_ in rows]
    rm = sorted(ids, key=lambda i: (round(regs[i]["location"]["bbox"][1] / max(1.0, 0.01 * H)), regs[i]["location"]["bbox"][0], i))
    tau = round(bc.kendall_tau(ids, rm), 3)
    sig = {"cuts": len(state["cuts"]), "vertical_cuts": state["vcuts"], "fallback_groups": sum(1 for c in state["cuts"] if c[0] == "fallback"),
           "agreement_with_row_major": tau}
    if sig["fallback_groups"]:
        warns.append(bc.warn("AMBIGUOUS_ORDER", "Some regions could not be separated by a clean cut; row-major order was used for them", groups=sig["fallback_groups"]))
    return rows, columns, sig, warns


def analyze(ctx: bc.PageCtx, layout: dict) -> ReadingOrderOutput:
    t = bc.Timer()
    rows, columns, sig, warns = order_regions(layout)
    items = []
    for n, (r, flow, g, parent, cc) in enumerate(rows):
        items.append(OrderItem(order=n, region_id=r["region_id"], type=r["type"], flow=flow, group=g, parent_region_id=parent,
                               location=bc.Location(**r["location"]), confidence=round(max(0.0, min(1.0, r["confidence"] * cc)), 3),
                               text_preview=r.get("text_preview")))
    oc = round(sum(i.confidence for i in items) / len(items), 3) if items else 0.0
    if not items:
        warns.append(bc.warn("NO_REGIONS", "The page has no regions, so there is no reading order"))
    sig["ms"] = t.ms()
    return ReadingOrderOutput(source_id=ctx.source_id, page_id=ctx.page_id, page_number=ctx.page_number, page_width=ctx.width, page_height=ctx.height,
                              items=items, order_confidence=oc, columns_detected=columns, signals=sig, warnings=warns)


def run(req: ReadingOrderInput, user: Optional[dict] = None) -> ReadingOrderOutput:
    if user is None:
        user = bc.current_user()
    bc.dbg(AGENT, "start", source_id=req.source_id, page=req.page_number, user=user.get("user_id"))
    ctx = bc.load_page(req.source_id, req.page_number, user)
    layout = bc.get_layout(ctx, refresh=req.refresh_layout)
    bc.dbg(AGENT, "layout_loaded", regions=len(layout.get("regions", [])))
    out = analyze(ctx, layout)
    try:
        bc.store().put("reading_order", ctx.page_id, bc.jsonable_encoder(out))
    except Exception as e:
        bc.dbg(AGENT, "store_put_failed_nonfatal", err=type(e).__name__)
    bc.audit("reading_order.computed", "page", ctx.page_id, {"items": len(out.items), "columns": out.columns_detected, "confidence": out.order_confidence}, user=user)
    bc.dbg(AGENT, "done", items=len(out.items), columns=out.columns_detected, order_confidence=out.order_confidence, ms=out.signals["ms"])
    return out


@router.post("/agents/reading-order")
def reading_order_endpoint(body: dict, request: Request):
    return bc.handle(request, lambda: run(ReadingOrderInput.model_validate(body)))
"""
06_reading_order.py - Agent 06: Reading Order  (Person B).   POST /agents/reading-order

Layout regions of one page -> the order a human reads them.   Deterministic recursive XY-cut, no model, no randomness.

Pipeline (debug line per step):
  1 load page + layout (from store, else agent 05)   2 split flow: header / main / footer
  3 detach captions from the main flow (attached to their figure/table/chart)
  4 XY-cut on main regions (cut with the larger NORMALISED gap wins: gap/H for horizontal, gap/W for vertical; tie -> horizontal)
  5 re-attach captions (before the parent if the caption is above it, else after)   6 confidence   7 store + audit

CONFIDENCE (documented):
  cut_conf     1.0  clean cut   (gap >= 2 * minimum gap)
               0.8  marginal cut (gap >= minimum gap)
               0.6  fallback    (no cut possible: rows by y, then x)
  item.confidence = round(region.confidence * cut_conf_of_the_last_cut_that_isolated_it, 3)
  order_confidence = mean(item.confidence over items)  (0.0 if there are no items)
  signals.agreement_with_row_major = Kendall tau (-1..1) between the XY-cut order and plain top-to-bottom/left-to-right order,
  reported for transparency (multi-column pages are EXPECTED to differ).
Thresholds (config reading_order.*): xy_min_gap_y_frac=0.008 (of page height), xy_min_gap_x_frac=0.02 (of page width), caption_max_dist_frac=0.12.
"""
from __future__ import annotations

import statistics
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

try:
    from backend.agents import b_common as bc
except ImportError:  # pragma: no cover
    import b_common as bc  # type: ignore

AGENT = "06_reading_order"
router = APIRouter()
METHOD = "xy_cut"


class ReadingOrderInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, default=1)
    refresh_layout: bool = False


class OrderItem(BaseModel):
    order: int
    region_id: str
    type: str
    flow: str                       # header | main | footer
    group: int                      # reading group (column / block index inside the flow)
    parent_region_id: Optional[str] = None   # for captions
    location: bc.Location
    extraction_method: str = METHOD
    confidence: float = Field(ge=0, le=1)
    text_preview: Optional[str] = None


class ReadingOrderOutput(BaseModel):
    source_id: str
    page_id: str
    page_number: int
    page_width: int
    page_height: int
    items: list[OrderItem]
    order_confidence: float
    columns_detected: int
    signals: dict = {}
    warnings: list[bc.WarningItem] = []


def T(name: str, default):
    return bc.cfg(f"reading_order.{name}", default)


# --------------------------------------------------------------------------- XY-cut
def _best_gap(idx: list, boxes: list, axis: int) -> tuple:
    """Largest empty gap in the projection of boxes on `axis` (0 = x, 1 = y). -> (gap, cut_position) or (0, None)"""
    iv = sorted((boxes[i][axis], boxes[i][axis + 2]) for i in idx)
    best, pos, end = 0.0, None, iv[0][1]
    for a, b in iv[1:]:
        if a - end > best:
            best, pos = a - end, (a + end) / 2.0
        end = max(end, b)
    return best, pos


def xy_cut(idx: list, boxes: list, W: int, H: int, min_y: float, min_x: float, state: dict) -> list:
    """-> list of (index, cut_conf, group_id). `state` carries the running group counter and cut statistics."""
    if len(idx) == 1:
        g = state["g"]
        state["g"] += 1
        return [(idx[0], 1.0, g)]
    gy, py = _best_gap(idx, boxes, 1)
    gx, px = _best_gap(idx, boxes, 0)
    ok_y, ok_x = gy >= min_y, gx >= min_x
    if ok_y or ok_x:
        use_y = ok_y and (not ok_x or gy / H >= gx / W)
        gap, pos, axis, mn = (gy, py, 1, min_y) if use_y else (gx, px, 0, min_x)
        a = [i for i in idx if (boxes[i][axis] + boxes[i][axis + 2]) / 2.0 < pos]
        b = [i for i in idx if (boxes[i][axis] + boxes[i][axis + 2]) / 2.0 >= pos]
        if a and b:
            conf = 1.0 if gap >= 2 * mn else 0.8
            state["cuts"].append(("h" if use_y else "v", round(gap, 1), conf))
            if not use_y:
                state["vcuts"] += 1
            out = []
            for part in (a, b):
                sub = xy_cut(part, boxes, W, H, min_y, min_x, state)
                out += [(i, min(c, conf), g) for i, c, g in sub]
            return out
    # fallback: group into rows by y-centre, rows top-to-bottom, left-to-right inside a row
    hs = [boxes[i][3] - boxes[i][1] for i in idx]
    row_h = max(1.0, 0.5 * statistics.median(hs))
    order = sorted(idx, key=lambda i: (round(((boxes[i][1] + boxes[i][3]) / 2) / row_h), boxes[i][0], boxes[i][1], i))
    state["cuts"].append(("fallback", 0.0, 0.6))
    g = state["g"]
    state["g"] += 1
    return [(i, 0.6, g) for i in order]


def _attach_captions(captions: list, parents: list, regs: dict, H: int, max_dist: float) -> dict:
    """caption region_id -> parent region_id (nearest figure/table/chart with >=30% horizontal overlap within max_dist)"""
    res = {}
    for c in captions:
        cb = regs[c]["location"]["bbox"]
        best = None
        for p in parents:
            pb = regs[p]["location"]["bbox"]
            ov = min(cb[2], pb[2]) - max(cb[0], pb[0])
            if ov < 0.3 * min(cb[2] - cb[0], pb[2] - pb[0]):
                continue
            dist = max(pb[1] - cb[3], cb[1] - pb[3], 0.0)
            if dist <= max_dist * H and (best is None or (dist, p) < best):
                best = (dist, p)
        if best:
            res[c] = best[1]
    return res


def order_regions(layout: dict) -> tuple:
    """Pure function. layout dict (agent 05 output) -> (items_data list, columns, signals, warnings)"""
    W, H = layout["page_width"], layout["page_height"]
    regs = {r["region_id"]: r for r in layout["regions"]}
    warns: list = []
    headers = sorted([r for r in regs.values() if r["type"] == "header"], key=lambda r: (r["location"]["bbox"][1], r["location"]["bbox"][0], r["region_id"]))
    footers = sorted([r for r in regs.values() if r["type"] == "footer"], key=lambda r: (r["location"]["bbox"][1], r["location"]["bbox"][0], r["region_id"]))
    rest = [r for r in regs.values() if r["type"] not in ("header", "footer")]
    parents = [r["region_id"] for r in rest if r["type"] in ("figure", "chart", "table")]
    caps = [r["region_id"] for r in rest if r["type"] == "caption"]
    attach = _attach_captions(caps, parents, regs, H, T("caption_max_dist_frac", 0.12))
    bc.dbg(AGENT, "split", headers=len(headers), footers=len(footers), main=len(rest), captions_attached=len(attach))
    main = sorted([r for r in rest if r["region_id"] not in attach], key=lambda r: r["region_id"])  # deterministic input order
    boxes = [r["location"]["bbox"] for r in main]
    state = {"g": 0, "cuts": [], "vcuts": 0}
    seq = xy_cut(list(range(len(main))), boxes, W, H, T("xy_min_gap_y_frac", 0.008) * H, T("xy_min_gap_x_frac", 0.02) * W, state) if main else []
    bc.dbg(AGENT, "xy_cut", cuts=len(state["cuts"]), vcuts=state["vcuts"], fallbacks=sum(1 for c in state["cuts"] if c[0] == "fallback"))
    rows: list = []   # (region, flow, group, parent, cut_conf)
    for r in headers:
        rows.append((r, "header", 0, None, 1.0))
    for i, c, g in seq:
        r = main[i]
        rows.append((r, "main", g, None, c))
        kids = sorted([cid for cid, pid in attach.items() if pid == r["region_id"]], key=lambda cid: regs[cid]["location"]["bbox"][1])
        for cid in kids:
            cr = regs[cid]
            above = cr["location"]["bbox"][1] < r["location"]["bbox"][1]
            tup = (cr, "main", g, r["region_id"], c)
            if above:
                rows.insert(len(rows) - 1, tup)   # caption above the table/figure is read first
            else:
                rows.append(tup)
    for r in footers:
        rows.append((r, "footer", 0, None, 1.0))
    columns = max(1, state["vcuts"] + 1) if state["vcuts"] else 1
    # compare with plain row-major order
    ids = [r["region_id"] for r, *_ in rows]
    rm = sorted(ids, key=lambda i: (round(regs[i]["location"]["bbox"][1] / max(1.0, 0.01 * H)), regs[i]["location"]["bbox"][0], i))
    tau = round(bc.kendall_tau(ids, rm), 3)
    sig = {"cuts": len(state["cuts"]), "vertical_cuts": state["vcuts"], "fallback_groups": sum(1 for c in state["cuts"] if c[0] == "fallback"),
           "agreement_with_row_major": tau}
    if sig["fallback_groups"]:
        warns.append(bc.warn("AMBIGUOUS_ORDER", "Some regions could not be separated by a clean cut; row-major order was used for them", groups=sig["fallback_groups"]))
    return rows, columns, sig, warns


def analyze(ctx: bc.PageCtx, layout: dict) -> ReadingOrderOutput:
    t = bc.Timer()
    rows, columns, sig, warns = order_regions(layout)
    items = []
    for n, (r, flow, g, parent, cc) in enumerate(rows):
        items.append(OrderItem(order=n, region_id=r["region_id"], type=r["type"], flow=flow, group=g, parent_region_id=parent,
                               location=bc.Location(**r["location"]), confidence=round(max(0.0, min(1.0, r["confidence"] * cc)), 3),
                               text_preview=r.get("text_preview")))
    oc = round(sum(i.confidence for i in items) / len(items), 3) if items else 0.0
    if not items:
        warns.append(bc.warn("NO_REGIONS", "The page has no regions, so there is no reading order"))
    sig["ms"] = t.ms()
    return ReadingOrderOutput(source_id=ctx.source_id, page_id=ctx.page_id, page_number=ctx.page_number, page_width=ctx.width, page_height=ctx.height,
                              items=items, order_confidence=oc, columns_detected=columns, signals=sig, warnings=warns)


def run(req: ReadingOrderInput, user: Optional[dict] = None) -> ReadingOrderOutput:
    if user is None:
        user = bc.current_user()
    bc.dbg(AGENT, "start", source_id=req.source_id, page=req.page_number, user=user.get("user_id"))
    ctx = bc.load_page(req.source_id, req.page_number, user)
    layout = bc.get_layout(ctx, refresh=req.refresh_layout)
    bc.dbg(AGENT, "layout_loaded", regions=len(layout.get("regions", [])))
    out = analyze(ctx, layout)
    try:
        bc.store().put("reading_order", ctx.page_id, bc.jsonable_encoder(out))
    except Exception as e:
        bc.dbg(AGENT, "store_put_failed_nonfatal", err=type(e).__name__)
    bc.audit("reading_order.computed", "page", ctx.page_id, {"items": len(out.items), "columns": out.columns_detected, "confidence": out.order_confidence}, user=user)
    bc.dbg(AGENT, "done", items=len(out.items), columns=out.columns_detected, order_confidence=out.order_confidence, ms=out.signals["ms"])
    return out


@router.post("/agents/reading-order")
def reading_order_endpoint(body: dict, request: Request):
    return bc.handle(request, lambda: run(ReadingOrderInput.model_validate(body)))
