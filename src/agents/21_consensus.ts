"""Agent 21 -- Consensus / Parser Jury (+ coverage audit).   Owner: Person C

POST /agents/consensus   In: {source_id, page_number?, block_id?}
                         Out: {blocks:[{block_id, winner, agreement, candidates, escalated, needs_review}],
                               coverage:[{page_number, coverage_score, uncovered_regions}]}

Consumes (via common/upstream, never A/B internals):
    A: format_router (units), native_text (03), ocr (04, one record per engine)
    B: layout (05) regions, table blocks (07)
    platform: page image (for the coverage audit)

block_id == layout region_id (a "block" in agent 11 is one layout region).

Candidates
    For every text-like / table region, each extractor that produced text inside the region is a
    candidate: `native_text`, `ocr:<engine>`, `table` (cells joined row-major).
    Lines are assigned to a region by CONTAINMENT (fraction of the line box inside the region;
    IoU is meaningless for a line vs. a whole region). Table-extractor candidates are aligned by
    bbox IoU against the region (config consensus.table_iou_threshold).
    Text is normalised (NFC, whitespace collapsed) before comparison.

Voting
    weight(c)   = reliability(extractor) * confidence(c)          reliability: config consensus.engine_reliability
    clustering  : greedy; a candidate joins the first cluster whose representative has
                  rapidfuzz ratio/100 >= consensus.cluster_similarity
    winner      : heaviest cluster (tie -> more members, then extractor name); its heaviest candidate
    similarity  : mean pairwise rapidfuzz ratio/100 over ALL candidates
    agreement   : "unanimous" all normalised values identical | "majority" winning cluster (near-matches
                  >= cluster_similarity count together) holds > half the candidates | "split" otherwise. `n_candidates` is reported so a single-extractor "unanimous"
                  is distinguishable from a real jury.
    escalated   : split AND similarity < consensus.escalation_similarity -> needs_review
    No candidate for a text region -> winner null, needs_review true (nothing was extracted).
    The optional vision-LLM tiebreak is NOT implemented (would go through llm_guard, Person D).

Coverage audit (per page)
    page image -> grayscale; background = most frequent gray level; ink = |gray - bg| > ink_delta.
    covered = union of layout-region boxes (+ coverage_margin_px).  Uncovered ink is dilated by
    merge_dilation_px so glyphs merge into words/lines, labelled (8-connectivity), and each component
    with >= min_component_ink_px ink pixels becomes an `uncovered_region`.  Repetition filter: small
    components whose size is shared by >= repetition_min_count others are noise (halftone/watermark
    dots) and ignored.    coverage_score = covered_ink / (covered_ink + kept_uncovered_ink); a page
    with no ink scores 1.0 (nothing to cover).

Persistence: full-page runs store `consensus/<source_id>:<page>` (read by agents 11/12); runs limited
to one block_id are returned but not persisted. Audit event: consensus_run (fail-closed).
"""
from __future__ import annotations

import io
import math
from typing import Any, Optional

import numpy as np
from PIL import Image, UnidentifiedImageError
from rapidfuzz import fuzz
from scipy import ndimage

from ..common import audit, auth, config
from ..common.agent_runtime import agent
from ..common.debug import dprint
from ..common.errors import AgentError, ErrorCode
from ..common.models import (
    Agreement,
    Candidate,
    ConsensusBlock,
    ConsensusOutput,
    ConsensusRequest,
    CoveragePage,
    LayoutOutput,
    UncoveredRegion,
    Unit,
)
from ..common.textutil import TextItem, assign_items, collapse_ws, iou, join_lines, mean_confidence
from ..common.upstream import UpstreamReader, default_reader

SKIP_TYPES = {"figure", "chart", "equation"}
OPTIONAL_TEXT_TYPES = {"signature", "stamp", "form_field"}


# --------------------------------------------------------------------------- #
# voting
# --------------------------------------------------------------------------- #


def _reliability(extractor: str, table: dict[str, float]) -> float:
    if extractor in table:
        return float(table[extractor])
    base = extractor.split(":")[0]
    if base in table:
        return float(table[base])
    return float(table.get("default", 0.5))


def _sim(a: str, b: str) -> float:
    return fuzz.ratio(a, b) / 100.0


def vote(block_id: str, cands: list[Candidate], cfg: dict[str, Any]) -> ConsensusBlock:
    """Pure function: candidates -> ConsensusBlock (deterministic)."""
    rel = cfg["engine_reliability"]
    cands = sorted(cands, key=lambda c: c.extractor)  # stable order regardless of arrival order
    if not cands:
        return ConsensusBlock(block_id=block_id, winner=None, agreement=None, candidates=[], escalated=False, needs_review=True)
    if len(cands) == 1:
        return ConsensusBlock(
            block_id=block_id,
            winner=cands[0],
            agreement=Agreement(level="unanimous", similarity=1.0, n_candidates=1),
            candidates=cands,
            escalated=False,
            needs_review=False,
        )

    norm = {c.extractor: collapse_ws(c.value) for c in cands}
    weight = {c.extractor: _reliability(c.extractor, rel) * c.confidence for c in cands}
    order = sorted(cands, key=lambda c: (-weight[c.extractor], c.extractor))

    clusters: list[list[Candidate]] = []
    for c in order:
        for cl in clusters:
            if _sim(norm[c.extractor], norm[cl[0].extractor]) >= cfg["cluster_similarity"]:
                cl.append(c)
                break
        else:
            clusters.append([c])

    def cl_key(cl: list[Candidate]) -> tuple:
        return (-sum(weight[c.extractor] for c in cl), -len(cl), cl[0].extractor)

    best = sorted(clusters, key=cl_key)[0]
    winner = sorted(best, key=lambda c: (-weight[c.extractor], c.extractor))[0]

    pair_sims = [_sim(norm[a.extractor], norm[b.extractor]) for i, a in enumerate(cands) for b in cands[i + 1 :]]
    similarity = round(sum(pair_sims) / len(pair_sims), 4)

    n = len(cands)
    if len({norm[c.extractor] for c in cands}) == 1:
        level = "unanimous"  # identical after normalisation (near-matches are "majority")
    elif len(best) * 2 > n:
        level = "majority"
    else:
        level = "split"
    escalated = level == "split" and similarity < cfg["escalation_similarity"]
    return ConsensusBlock(
        block_id=block_id,
        winner=winner,
        agreement=Agreement(level=level, similarity=similarity, n_candidates=n),
        candidates=cands,
        escalated=escalated,
        needs_review=escalated,
    )


# --------------------------------------------------------------------------- #
# coverage audit
# --------------------------------------------------------------------------- #


def coverage_audit(
    image_bytes: bytes,
    boxes: list[list[float]],
    page_w: Optional[float],
    page_h: Optional[float],
    page_number: int,
    cfg: dict[str, Any],
) -> CoveragePage:
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise AgentError(ErrorCode.CORRUPT_FILE, "page image could not be decoded", {"page_number": page_number}) from exc

    gray = np.asarray(img.convert("L"), dtype=np.int16)
    h_px, w_px = gray.shape
    pw = float(page_w) if page_w else float(w_px)
    ph = float(page_h) if page_h else float(h_px)
    sx, sy = w_px / pw, h_px / ph

    bg = int(np.bincount(gray.ravel(), minlength=256).argmax())
    ink = np.abs(gray - bg) > int(cfg["ink_delta"])

    covered = np.zeros(ink.shape, dtype=bool)
    m = int(cfg["coverage_margin_px"])
    for x1, y1, x2, y2 in boxes:
        a, b = max(0, math.floor(x1 * sx) - m), max(0, math.floor(y1 * sy) - m)
        c, d = min(w_px, math.ceil(x2 * sx) + m), min(h_px, math.ceil(y2 * sy) + m)
        if c > a and d > b:
            covered[b:d, a:c] = True

    covered_ink = int((ink & covered).sum())
    uncovered = ink & ~covered

    regions: list[tuple[list[float], int]] = []
    if uncovered.any():
        merged = ndimage.binary_dilation(uncovered, iterations=int(cfg["merge_dilation_px"]))
        labels, n = ndimage.label(merged, structure=np.ones((3, 3), dtype=int))
        if n:
            counts = ndimage.sum(uncovered, labels, index=np.arange(1, n + 1))
            slices = ndimage.find_objects(labels)
            comps = []
            for i, sl in enumerate(slices):
                ink_px = int(counts[i])
                if sl is None or ink_px < int(cfg["min_component_ink_px"]):
                    continue
                y1, y2, x1, x2 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
                comps.append((ink_px, x1, y1, x2, y2))
            # repetition filter: many small components of identical size = noise, not content
            bin_px = max(1, int(cfg["repetition_size_bin_px"]))
            groups: dict[tuple[int, int], int] = {}
            for ink_px, x1, y1, x2, y2 in comps:
                groups[((x2 - x1) // bin_px, (y2 - y1) // bin_px)] = groups.get(((x2 - x1) // bin_px, (y2 - y1) // bin_px), 0) + 1
            for ink_px, x1, y1, x2, y2 in comps:
                k = ((x2 - x1) // bin_px, (y2 - y1) // bin_px)
                if ink_px <= int(cfg["repetition_max_ink_px"]) and groups[k] >= int(cfg["repetition_min_count"]):
                    continue
                regions.append(([round(x1 / sx, 2), round(y1 / sy, 2), round(x2 / sx, 2), round(y2 / sy, 2)], ink_px))

    regions.sort(key=lambda r: (r[0][1], r[0][0]))
    kept_uncovered = sum(r[1] for r in regions)
    denom = covered_ink + kept_uncovered
    score = 1.0 if denom == 0 else covered_ink / denom
    return CoveragePage(
        page_number=page_number,
        coverage_score=round(score, 6),
        uncovered_regions=[
            UncoveredRegion(page_number=page_number, bbox=bb, page_width=pw, page_height=ph, ink_pixels=ink_px)
            for bb, ink_px in regions
        ],
    )


# --------------------------------------------------------------------------- #
# per-page work
# --------------------------------------------------------------------------- #


def _items_from_native(native: Any) -> list[TextItem]:
    if native is None or not native.has_usable_text:
        return []
    return [
        TextItem(s.text, tuple(s.location.bbox), s.confidence)  # type: ignore[arg-type]
        for s in native.spans
        if s.location.bbox is not None and s.text.strip()
    ]


def _items_from_ocr(ocr: Any) -> list[TextItem]:
    return [
        TextItem(l.text, tuple(l.location.bbox), l.confidence)  # type: ignore[arg-type]
        for l in ocr.lines
        if l.location.bbox is not None and l.text.strip()
    ]


def _vote_page(
    reader: UpstreamReader,
    source_id: str,
    unit: Unit,
    layout: Optional[LayoutOutput],
    only_block: Optional[str],
    cfg: dict[str, Any],
    assembly_cfg: dict[str, Any],
) -> list[ConsensusBlock]:
    if layout is None:
        return []
    page = unit.page_number
    thr = float(assembly_cfg["containment_threshold"])
    regions = [r for r in layout.regions]
    reg_boxes = [(r.region_id, r.location.bbox) for r in regions]

    sources: dict[str, dict[str, list[TextItem]]] = {}
    native = reader.native_text(source_id, page)
    n_items = _items_from_native(native)
    if n_items:
        sources["native_text"] = assign_items(n_items, reg_boxes, thr)[0]
    for o in reader.ocr(source_id, page):
        items = _items_from_ocr(o)
        if items:
            sources[f"ocr:{o.engine}"] = assign_items(items, reg_boxes, thr)[0]

    tables = reader.tables(source_id, page)
    blocks: list[ConsensusBlock] = []
    for r in sorted(regions, key=lambda r: (r.location.bbox or [0, 0, 0, 0])[1::-1] + [r.region_id]):  # type: ignore[operator]
        if only_block and r.region_id != only_block:
            continue
        if r.type in SKIP_TYPES:
            continue
        cands: list[Candidate] = []
        for name, assigned in sources.items():
            items = assigned.get(r.region_id)
            if items:
                text = join_lines(items)
                if text:
                    cands.append(Candidate(extractor=name, value=text, confidence=round(mean_confidence(items), 6)))
        tb = tables.get(r.region_id) if r.type == "table" else None
        if tb is not None and r.location.bbox and tb.location.bbox:
            if iou(r.location.bbox, tb.location.bbox) >= float(cfg["table_iou_threshold"]):
                cells = sorted(tb.cells, key=lambda c: (c.row, c.col))
                text = " ".join(collapse_ws(c.raw_text) for c in cells if c.raw_text.strip())
                if text:
                    conf = sum(c.confidence for c in cells) / len(cells)
                    cands.append(Candidate(extractor="table", value=text, confidence=round(conf, 6)))
        if not cands and r.type in OPTIONAL_TEXT_TYPES:
            continue  # a signature/stamp with no text is normal, not a failure
        blocks.append(vote(r.region_id, cands, cfg))
    return blocks


@agent("21", "consensus_run", lambda r: ("source", r.source_id))
def run(inp: ConsensusRequest, *, reader: Optional[UpstreamReader] = None) -> ConsensusOutput:
    auth.current_user()
    reader = reader or default_reader()
    cfg = config.get("consensus")
    acfg = config.get("assembly")

    if not reader.source_exists(inp.source_id):
        raise AgentError(ErrorCode.NOT_FOUND, "source not found")
    router = reader.router(inp.source_id)
    if router is None:
        raise AgentError(ErrorCode.CONFLICT, "source has not been routed (agent 02)", {"missing": [{"kind": "format_router"}]})
    if router.route in acfg["spreadsheet_routes"]:
        raise AgentError(ErrorCode.UNSUPPORTED_FORMAT, "consensus applies to page-based sources, not spreadsheets", {"route": router.route})

    units = sorted(router.units, key=lambda u: u.page_number)
    if inp.page_number is not None:
        units = [u for u in units if u.page_number == inp.page_number]
        if not units:
            raise AgentError(ErrorCode.NOT_FOUND, "page not found in source", {"page_number": inp.page_number})

    blocks: list[ConsensusBlock] = []
    coverage: list[CoveragePage] = []
    missing: list[dict[str, Any]] = []
    writes: list[tuple[str, str, Any]] = []
    found_block = inp.block_id is None

    for unit in units:
        layout = reader.layout(inp.source_id, unit.page_number)
        if layout is None and unit.page_class != "blank":
            missing.append({"page_number": unit.page_number, "kind": "layout"})
            continue
        image: Optional[bytes] = None
        if inp.block_id is None:
            image = reader.page_image(inp.source_id, unit.page_number)
            if image is None:
                missing.append({"page_number": unit.page_number, "kind": "page_image"})
                continue
        page_blocks = _vote_page(reader, inp.source_id, unit, layout, inp.block_id, cfg, acfg)
        if inp.block_id and page_blocks:
            found_block = True
        page_cov = None
        if image is not None:
            boxes, pw, ph = [], None, None
            for r in (layout.regions if layout else []):
                if r.location.bbox:
                    boxes.append(r.location.bbox)
                    pw, ph = pw or r.location.page_width, ph or r.location.page_height
            page_cov = coverage_audit(image, boxes, pw, ph, unit.page_number, cfg)
            coverage.append(page_cov)
        blocks.extend(page_blocks)
        dprint(
            "agent21",
            "page voted",
            page=unit.page_number,
            blocks=len(page_blocks),
            escalated=sum(b.escalated for b in page_blocks),
            coverage=None if page_cov is None else page_cov.coverage_score,
            uncovered=0 if page_cov is None else len(page_cov.uncovered_regions),
        )
        if inp.block_id is None:
            out_page = ConsensusOutput(blocks=page_blocks, coverage=[page_cov] if page_cov else [])
            writes.append(("consensus", f"{inp.source_id}:{unit.page_number}", out_page))

    if missing:
        raise AgentError(ErrorCode.CONFLICT, "upstream outputs required for consensus are missing", {"missing": missing})
    if not found_block:
        raise AgentError(ErrorCode.NOT_FOUND, "block not found", {"block_id": inp.block_id})

    out = ConsensusOutput(blocks=blocks, coverage=coverage)
    event = audit.build_event(
        "consensus_run",
        "source",
        inp.source_id,
        "success",
        {
            "pages": len(units),
            "blocks": len(blocks),
            "escalated": sum(b.escalated for b in blocks),
            "needs_review": sum(b.needs_review for b in blocks),
            "block_filter": bool(inp.block_id),
        },
    )
    audit.commit_with_audit(event, writes)
    return out
