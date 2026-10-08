"""Unit tests for backend/page_quality.py (items 2-7) and the PDF export layout fix (item 8)."""
import io
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import page_quality as pq  # noqa: E402

CFG = pq.DEFAULTS


def _png(draw=None, size=(400, 300)):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", size, "white")
    if draw:
        draw(ImageDraw.Draw(im))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def _tb(i, text, box, conf=1.0, agr=None):
    bd = {"native_text_quality": 1.0}
    if agr is not None:
        bd["ocr_agreement"] = agr
    return {"block_id": f"b{i}", "type": "text", "source_id": "s", "page_id": "p", "unit_id": "p", "raw_text": text,
            "location": {"bbox": list(box), "coordinate_system": "pixel_top_left", "page_width": 1000, "page_height": 1000},
            "confidence": conf, "confidence_breakdown": bd, "extraction_method": "native_text", "needs_review": False}


# item 3 ---------------------------------------------------------------------------------------------------
def test_review_reasons_only_for_genuine_uncertainty():
    assert pq.review_reasons("Net salary: 72,500", 0.98, 0.6, None, 0.8) == []          # no cross-check: no flag
    assert pq.review_reasons("Net salary", 0.4, 0.6, None, 0.8) == ["low_confidence"]
    assert pq.review_reasons("Net salary", 0.9, 0.6, 0.5, 0.8) == ["extractor_disagreement"]
    assert pq.review_reasons("x \ue001 y", 0.9, 0.6, 1.0, 0.8) == ["garbled_glyphs"]


# item 2 ---------------------------------------------------------------------------------------------------
def test_coverage_blank_page_has_no_score():
    score, regions, ink = pq.ink_coverage(_png(), [], CFG)
    assert score is None and regions == [] and ink == 0


def test_coverage_detects_unread_ink():
    png = _png(lambda d: d.rectangle([50, 50, 350, 120], fill="black"))
    score, regions, _ = pq.ink_coverage(png, [], CFG)
    assert score == 0.0 and regions
    score2, regions2, _ = pq.ink_coverage(png, [[40, 40, 360, 130]], CFG)
    assert score2 == 1.0 and regions2 == []


def test_page_status_never_ok_for_ink_without_blocks():
    assert pq.page_status(False, 0.0, True, False, CFG) == "needs_ocr"
    assert pq.page_status(False, 0.0, True, True, CFG) == "unreadable"
    assert pq.page_status(False, None, False, True, CFG) == "blank"
    assert pq.page_status(True, 0.3, False, True, CFG) == "partial"
    assert pq.page_status(True, 0.95, False, True, CFG) == "ok"


# item 4 ---------------------------------------------------------------------------------------------------
def test_equation_fragments_merge_into_one_block():
    frags = [_tb(i, t, (100 + 30 * i, 100, 120 + 30 * i, 120)) for i, t in enumerate(["T", "(", "n", ")", "=", "O", "(", "n", "²", ")"])]
    prose = _tb(99, "Dijkstra computes shortest paths in graphs", (100, 300, 700, 320))
    out = pq.merge_equations(frags + [prose], 1, lambda b: "/crop", CFG, 0.8)
    eqs = [b for b in out if b["type"] == "equation"]
    assert len(eqs) == 1 and eqs[0]["raw_text"].replace(" ", "").startswith("T(n)=O")
    assert eqs[0]["crop_url"] == "/crop" and eqs[0]["latex"] is None
    assert eqs[0]["needs_review"] and not eqs[0]["verified"]          # not confirmed by OCR
    assert not any(b["type"] == "text" and len(b["raw_text"]) <= 2 for b in out)
    assert prose in out


def test_lone_symbol_and_lists_are_not_equations():
    out = pq.merge_equations([_tb(0, "A B 4", (100, 100, 160, 120)), _tb(1, "•", (100, 400, 110, 410))], 1, lambda b: "", CFG, 0.8)
    assert all(b["type"] == "text" for b in out)


def test_verified_equation_does_not_need_review():
    frags = [_tb(i, t, (100 + 30 * i, 100, 120 + 30 * i, 120), agr=1.0) for i, t in enumerate(["x", "=", "y", "+", "1"])]
    eq = [b for b in pq.merge_equations(frags, 1, lambda b: "", CFG, 0.8) if b["type"] == "equation"][0]
    assert eq["verified"] and not eq["needs_review"]


# item 6 ---------------------------------------------------------------------------------------------------
def _table(rows, bbox=(0, 0, 100, 100)):
    return {"bbox": list(bbox), "rows": [[{"text": t, "col_span": 1} for t in r] for r in rows]}


def test_table_grid_rules():
    assert pq.validate_table(_table([["Algorithm", "Time"], ["Dijkstra", "O(E log V)"], ["BF", "O(VE)"]]), [], CFG)[0]
    assert not pq.validate_table(_table([["Lecture 7: Shortest paths"]]), [], CFG)[0]                       # title
    assert not pq.validate_table(_table([["A B 4"], ["A C 2"], ["B C 5"]]), [], CFG)[0]                     # edge list
    long = "This is a full sentence that was laid out inside a box and should never be a table cell"
    assert not pq.validate_table(_table([[long, ""], ["", long]]), [], CFG)[0]                             # sentences
    assert not pq.validate_table(_table([["a", "b"], ["c", "d"]], (10, 10, 20, 20)), [[0, 0, 100, 100]], CFG)[0]  # in chart


def test_chart_detected_from_vector_axes():
    fitz = pytest.importorskip("pymupdf")
    doc = fitz.open()
    p = doc.new_page()
    p.draw_line((80, 300), (80, 100))
    p.draw_line((80, 300), (380, 300))
    for i, h in enumerate([120, 80, 160, 60]):
        p.draw_rect(fitz.Rect(100 + i * 70, 300 - h, 140 + i * 70, 300), fill=(0.2, 0.4, 0.8))
    charts = pq.detect_charts(p, 2.0, CFG)
    assert len(charts) == 1 and charts[0][0] <= 160 and charts[0][3] >= 600
    blank = doc.new_page()
    blank.insert_text((72, 72), "no chart here")
    assert pq.detect_charts(blank, 2.0, CFG) == []


# item 7 ---------------------------------------------------------------------------------------------------
def test_caption_prefers_labelled_line_below():
    fig = [100, 100, 500, 400]
    heading = _tb(0, "Figure and chart overview", (100, 40, 400, 60))
    caption = _tb(1, "Figure 2: Example weighted graph", (100, 410, 450, 430))
    assert pq.find_caption(fig, [heading, caption], 2000, CFG)["block_id"] == "b1"


# item 8 ---------------------------------------------------------------------------------------------------
def test_pdf_export_renders_wide_tables():
    """Regression: a wide table used to raise 'flowable given negative availWidth' -> 'Processing failed'."""
    pytest.importorskip("reportlab")
    import importlib
    a20 = importlib.import_module("backend.agents.20_export")
    cols = [f"column_{i}_with_a_long_name" for i in range(14)]
    doc = {"title": "t", "items": [{"kind": "source", "id": "s1", "kv": [("k", "v")],
                                     "tables": [{"name": "wide", "columns": cols, "rows": [["value " * 8] * 14] * 3}]}]}
    data = a20.RENDERERS["pdf"]["fn"](doc, {"masked": False})
    assert data[:4] == b"%PDF"


def test_word_formulas_are_equations_but_sentences_are_not():
    f = _tb(0, "Net debt = Gross debt - Cash and equivalents", (100, 100, 600, 120))
    s = _tb(1, "Relaxation: if d(v) > d(u) + w then update d(v)", (100, 300, 700, 320))
    out = pq.merge_equations([f, s], 1, lambda b: "/c", CFG, 0.8)
    assert [b["type"] for b in out].count("equation") == 1
    assert any(b["type"] == "text" and b["raw_text"].startswith("Relaxation") for b in out)
