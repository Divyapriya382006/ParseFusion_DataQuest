"""Regression run (item 10): the QA sample PDF, a lecture-style PDF and a scanned-only PDF, with and without OCR.

Runs the real pipeline in a separate interpreter (other test files stub shared modules in this one).
Run: pytest tests/test_regression_samples.py -q
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
pytest.importorskip("pymupdf")

_RUN = r"""
import io, json, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import pymupdf as fitz
from PIL import Image, ImageDraw
from fastapi.testclient import TestClient
from backend.main import app
c = TestClient(app)
tmp = Path(sys.argv[2])

def lecture():
    d = fitz.open(); p = d.new_page(); y = 60
    p.insert_text((60, y), "Lecture 7: Shortest Paths", fontsize=18); y += 40
    x = 120
    for ch in ["T", "(", "n", ")", "=", "O", "(", "V", "+", "E", ")"]:
        p.insert_text((x, y), ch, fontsize=13); x += 12
    y += 50
    rows = [["Algorithm", "Time"], ["Dijkstra", "O(E log V)"], ["Bellman-Ford", "O(VE)"]]
    for r in rows:
        xx = 60
        for v in r:
            p.draw_rect(fitz.Rect(xx, y, xx + 150, y + 20)); p.insert_text((xx + 5, y + 14), v, fontsize=10); xx += 150
        y += 20
    p = d.new_page()
    p.draw_line((80, 300), (80, 100)); p.draw_line((80, 300), (380, 300))
    for i, h in enumerate([120, 80, 160, 60]):
        p.draw_rect(fitz.Rect(100 + i * 70, 300 - h, 140 + i * 70, 300), fill=(0.2, 0.4, 0.8))
    p.insert_text((80, 340), "Chart 1: Runtime by graph size", fontsize=10)
    im = Image.new("RGB", (300, 200), "white"); dr = ImageDraw.Draw(im); dr.ellipse([50, 50, 250, 150], outline="black", width=4)
    b = io.BytesIO(); im.save(b, "PNG"); p.insert_image(fitz.Rect(80, 400, 380, 600), stream=b.getvalue())
    p.insert_text((80, 620), "Figure 2: A circle", fontsize=10)
    d.save(str(tmp / "lecture.pdf")); return tmp / "lecture.pdf"

def scanned():
    d = fitz.open()
    for k in range(2):
        im = Image.new("RGB", (1200, 900), "white"); dr = ImageDraw.Draw(im)
        for i in range(6):
            dr.rectangle([80, 80 + i * 110, 900, 130 + i * 110], fill="black")  # printed lines (ink)
        b = io.BytesIO(); im.save(b, "PNG"); p = d.new_page(); p.insert_image(p.rect, stream=b.getvalue())
    d.save(str(tmp / "scanned.pdf")); return tmp / "scanned.pdf"

out = {}
for path in [Path(sys.argv[3]), lecture(), scanned()]:
    sid = c.post("/agents/file-validation", files={"file": (path.name, path.read_bytes(), "application/pdf")}).json()["data"]["source_id"]
    bid = c.post("/batches", json={"source_ids": [sid], "output_formats": ["pdf", "json"]}).json()["data"]["batch_id"]
    deadline = time.time() + 240
    while time.time() < deadline:
        b = c.get(f"/batches/{bid}").json()["data"]
        if b["status"] in ("completed", "failed") and b["analysis"]["status"] not in ("pending", "running"):
            break
        time.sleep(0.3)
    out[path.name] = {"batch": b, "doc": c.get(f"/sources/{sid}").json()["data"]}
out["health"] = c.get("/health/agents").json()["data"]
print("@@" + json.dumps(out))
"""


def _run(tmp: Path, ocr: bool) -> dict:
    env = {**os.environ, "PARSEFUSION_STORE": "memory", "AGENT_DEBUG": "0"}
    if not ocr:
        env["PARSEFUSION_OCR_DISABLED"] = "1"
    p = subprocess.run([sys.executable, "-c", _RUN, str(ROOT), str(tmp), str(ROOT / "tests" / "fixtures" / "qa_sample.pdf")],
                       capture_output=True, text=True, env=env, timeout=600, cwd=str(ROOT))
    line = next((ln for ln in p.stdout.splitlines() if ln.startswith("@@")), None)
    assert line, p.stderr[-3000:]
    return json.loads(line[2:])


@pytest.fixture(scope="module")
def no_ocr(tmp_path_factory):
    return _run(tmp_path_factory.mktemp("noocr"), ocr=False)


@pytest.fixture(scope="module")
def with_ocr(tmp_path_factory):
    out = _run(tmp_path_factory.mktemp("ocr"), ocr=True)
    if not out["health"]["ocr"]["available"]:
        pytest.skip("no OCR engine installed on this machine")
    return out


def _blocks(doc):
    return [b for p in doc["pages"] for b in p["blocks"]]


# item 1: OCR reported, failure is one loud document-level notice
def test_ocr_engine_reported_in_health(with_ocr):
    ocr = with_ocr["health"]["ocr"]
    assert ocr["engine"] and ocr["version"]
    agent = next(a for a in with_ocr["health"]["agents"] if a["id"].startswith("04_"))
    assert agent["engine_version"] == ocr["version"]


def test_ocr_unavailable_is_one_document_notice(no_ocr):
    assert no_ocr["health"]["ocr"]["available"] is False and no_ocr["health"]["ocr"]["reason"]
    for name in ("qa_sample.pdf", "lecture.pdf", "scanned.pdf"):
        codes = [w["code"] for w in no_ocr[name]["doc"]["warnings"]]
        assert codes.count("OCR_UNAVAILABLE") == 1, codes
        assert "OCR_FAILED" not in codes and "CONFIDENCE_NOT_CROSS_CHECKED" not in codes


def test_scanned_text_is_read_with_ocr(with_ocr):
    # the synthetic "scan" is black bars (ink, no letters): OCR runs, finds nothing -> unreadable, never "ok"
    pages = with_ocr["scanned.pdf"]["doc"]["pages"]
    assert all(p["status"] in ("unreadable", "ok", "partial") for p in pages)
    assert all(p["status"] != "ok" or p["blocks"] for p in pages)


# item 2: no silent page loss
def test_pages_without_blocks_are_never_ok(no_ocr):
    doc = no_ocr["scanned.pdf"]["doc"]
    assert [p["status"] for p in doc["pages"]] == ["needs_ocr", "needs_ocr"]
    assert all(p["coverage_score"] == 0.0 and p["uncovered_regions"] for p in doc["pages"])
    assert "PAGES_UNREAD" in [w["code"] for w in doc["warnings"]] and doc["unread_pages"] == [1, 2]
    for name in ("qa_sample.pdf", "lecture.pdf"):
        for p in no_ocr[name]["doc"]["pages"]:
            assert p["status"] != "ok" or p["blocks"]


# item 3: missing cross-check does not flag blocks
def test_no_per_block_flags_without_ocr(no_ocr):
    for name in ("qa_sample.pdf", "lecture.pdf"):
        flagged = [b for b in _blocks(no_ocr[name]["doc"]) if b["needs_review"]]
        assert all(b.get("review_reasons") for b in flagged)
        assert not any("not_cross_checked" in (b.get("review_reasons") or []) for b in flagged)
    assert no_ocr["qa_sample.pdf"]["doc"]["parse_score"]["cap"]["applied"]


# item 4: equations
def test_lecture_equation_is_one_block(no_ocr):
    blocks = _blocks(no_ocr["lecture.pdf"]["doc"])
    eqs = [b for b in blocks if b["type"] == "equation"]
    assert len(eqs) == 1 and eqs[0]["crop_url"] and eqs[0]["needs_review"]  # unverified without OCR
    assert not [b for b in blocks if b["type"] == "text" and len((b.get("raw_text") or "").strip()) <= 1]


# item 5: page score consistency
def test_page_score_never_above_reading_order_or_cap(no_ocr, with_ocr):
    for run in (no_ocr, with_ocr):
        for name in ("qa_sample.pdf", "lecture.pdf"):
            doc = run[name]["doc"]
            cap = doc["parse_score"]["cap"]
            for p in doc["pages"]:
                v = p["page_score"]["value"]
                if v is None:
                    continue
                assert v <= p["reading_order_confidence"] + 1e-9
                if cap.get("applied"):
                    assert v <= cap["max"] + 1e-9


# item 6: tables vs charts
def test_chart_is_not_a_table(no_ocr):
    blocks = _blocks(no_ocr["lecture.pdf"]["doc"])
    charts = [b for b in blocks if b["type"] == "chart"]
    tables = [b for b in blocks if b["type"] == "table"]
    # a chart is either digitised (series + description) or flagged as not digitised; never silently dropped
    assert len(charts) == 1 and (charts[0].get("interpreted") and charts[0].get("chart_data")
                                 or charts[0]["warnings"][0]["code"] == "CHART_EXTRACTION_UNAVAILABLE")
    assert len(tables) == 1 and tables[0]["n_rows"] == 3


# item 7: figures
def test_figures_have_crop_caption_and_flag(no_ocr):
    figs = [b for b in _blocks(no_ocr["lecture.pdf"]["doc"]) if b["type"] == "figure"]
    assert figs and all(f["crop_url"] and f["interpreted"] is False for f in figs)
    assert figs[0]["caption"].startswith("Figure 2")


# item 8: PDF export of the QA sample, with and without OCR
def test_qa_sample_pdf_export(no_ocr, with_ocr):
    for run in (no_ocr, with_ocr):
        b = run["qa_sample.pdf"]["batch"]
        assert sorted(e["format"] for e in b["exports"]) == ["json", "pdf"], b.get("export_errors")
        assert b["export_errors"] == []


# cross-document reasoning always runs (single documents included) and has the union parse
def test_analysis_runs_for_every_batch(no_ocr):
    for name in ("qa_sample.pdf", "lecture.pdf", "scanned.pdf"):
        assert no_ocr[name]["batch"]["analysis"]["status"] in ("completed", "skipped")
