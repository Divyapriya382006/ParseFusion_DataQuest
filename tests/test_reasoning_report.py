"""Acceptance tests for the explained cross-document reasoning (sections 2-4 of the pipeline page).

T1 zero facts -> zero_fact_reason          T2 skipped candidates are all listed
T3 cell facts carry row/column headers     T4 matrix cells / pseudocode are not facts
T5 comparable + not comparable = considered T6 nothing comparable -> not_scored, value None (never 0)
T7 parse score capped on OCR_FAILED         T8 case score reproduces from its components
Run: pytest tests/test_reasoning_report.py -q
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
pytest.importorskip("pymupdf")

# The pipeline runs in a fresh interpreter: other test files replace shared modules (store, auth) in this one.
_SCENARIO = r"""
import json, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import pymupdf as fitz
from fastapi.testclient import TestClient
from backend.main import app
client = TestClient(app)
tmp = Path(sys.argv[2]); spec = json.loads(sys.argv[3])

def pdf(name, lines):
    doc = fitz.open(); page = doc.new_page(); y = 72
    for line in lines:
        page.insert_text((72, y), line, fontsize=12); y += 22
    doc.save(str(tmp / name)); return tmp / name

ids = []
for item in spec:
    path = pdf(item["name"], item["lines"]) if "lines" in item else tmp / item["name"]
    if "csv" in item:
        path.write_text(item["csv"])
    data = client.post("/agents/file-validation", files={"file": (path.name, path.read_bytes(), item["mime"])}).json()["data"]
    assert data["status"] == "accepted", data
    ids.append(data["source_id"])
case_id = client.post("/cases", json={"title": "report test"}).json()["data"]["case_id"]
batch_id = client.post("/batches", json={"source_ids": ids, "case_id": case_id}).json()["data"]["batch_id"]
deadline = time.time() + 180
while time.time() < deadline:
    b = client.get(f"/batches/{batch_id}").json()["data"]
    if b["status"] in ("completed", "failed") and b["analysis"]["status"] not in ("pending", "running"):
        break
    time.sleep(0.3)
print("@@" + json.dumps(client.get(f"/cases/{case_id}/analysis").json()))
"""


def _analyze(tmp: Path, spec: list) -> dict:
    env = {**os.environ, "PARSEFUSION_STORE": "memory", "AGENT_DEBUG": "0"}
    out = subprocess.run([sys.executable, "-c", _SCENARIO, str(ROOT), str(tmp), json.dumps(spec)],
                         capture_output=True, text=True, env=env, timeout=300, cwd=str(ROOT))
    line = next((ln for ln in out.stdout.splitlines() if ln.startswith("@@")), None)
    assert line, out.stderr[-2000:]
    res = json.loads(line[2:])
    assert res["ok"], res
    assert "report" in res["data"], res["data"].get("final")
    return res["data"]


def _facts(analysis: dict) -> list:
    return next(s for s in analysis["stages"] if s["stage"] == "fact_normalization")["output"]["facts"]


@pytest.fixture(scope="module")
def algo(tmp_path_factory):
    return _analyze(tmp_path_factory.mktemp("algo"), [
        {"name": "fw.pdf", "mime": "application/pdf", "lines": ["Floyd-Warshall", "for k = 1 to n", "dist i i = 0", "a = 3", "b = 7"]},
        {"name": "bf.pdf", "mime": "application/pdf", "lines": ["Bellman-Ford", "for i = 1 to V-1", "d v = d u + w"]}])


@pytest.fixture(scope="module")
def salary(tmp_path_factory):
    return _analyze(tmp_path_factory.mktemp("sal"), [
        {"name": "cert.pdf", "mime": "application/pdf", "lines": ["SALARY CERTIFICATE", "Employee name: Ravi Kumar",
                                                                    "Pay period: September 2026", "Net salary: INR 72,500",
                                                                    "Professional tax: INR 200"]},
        {"name": "stmt.pdf", "mime": "application/pdf", "lines": ["BANK STATEMENT", "Account holder: Ravi Kumar",
                                                                    "Statement period: September 2026", "Net salary: INR 65,000",
                                                                    "Professional tax: INR 200"]},
        {"name": "pay.csv", "mime": "text/csv", "csv": "Item,Amount INR\nNet salary,72500\nBonus,5000\n"}])


def test_t1_zero_facts_have_a_reason(algo):
    docs = algo["report"]["documents"]
    assert docs and all(d["facts"]["accepted"] == 0 for d in docs)
    assert all(d["facts"]["zero_fact_reason"] for d in docs)


def test_t2_every_skipped_candidate_is_listed(salary, algo):
    for a in (salary, algo):
        rep = a["report"]
        assert len(rep["skipped_candidates"]) == sum(d["facts"]["skipped_total"] or 0 for d in rep["documents"])
        assert all(c["ok"] for c in rep["reconciliation"]), rep["reconciliation"]


def test_t3_cell_facts_carry_headers(salary):
    cells = [f for f in _facts(salary) if (f.get("origin") or {}).get("type") == "table_cell"]
    assert cells, "expected facts from the CSV table"
    for f in cells:
        assert f["origin"]["row_label"] and f["origin"]["column_headers"]


def test_t4_matrix_cells_and_pseudocode_are_not_facts(algo):
    assert _facts(algo) == []
    assert sum(d["facts"]["unclassified_numbers"] for d in algo["report"]["documents"]) >= 3


def test_t5_counts_reconcile(salary):
    c = salary["report"]["counts"]
    assert c["comparable"] + c["not_comparable"] == c["pairs_considered"]
    assert c["pairs_considered"] > 0


def test_t6_not_scored_is_null_not_zero(algo):
    cs = algo["report"]["case_score"]
    assert cs["status"] == "not_scored" and cs["value"] is None and cs["reason"]
    assert algo["final"]["confidence"] is None and algo["final"]["verdict"] == "not_scored"


def test_t7_parse_score_capped_when_ocr_failed():
    sys.path.insert(0, str(ROOT))
    from backend import pipeline_api
    blocks = [{"confidence": 1.0, "extraction_method": "native_text", "confidence_breakdown": {}}] * 3
    ps = pipeline_api._parse_score(blocks, [{"reading_order_confidence": 1.0}], [], [{"code": "OCR_FAILED"}])
    assert ps["cap"]["applied"] and ps["cap"]["reason"] and ps["value"] <= ps["cap"]["max"] < 1.0


def test_t8_case_score_reproduces_from_components(salary):
    cs = salary["report"]["case_score"]
    assert cs["status"] == "scored" and cs["reason_code"]
    total = sum(c["value"] * c["weight"] for c in cs["components"])
    assert abs(total - cs["value"]) < 1e-3


def _monotonic(funnel):
    for unit in ("facts", "groups", "pairs"):
        main = [st for st in funnel if st["unit"] == unit and not st["stage"].startswith("unnamed")]
        counts = [st["count"] for st in main]
        assert counts == sorted(counts, reverse=True), (unit, counts)
        for st in main:
            if st.get("dropped"):
                assert st.get("reason_code"), st


def test_t9_funnel_is_monotonic_and_drops_have_reasons(salary, algo):
    for a in (salary, algo):
        _monotonic(a["report"]["funnel"])
    stages = {st["stage"]: st for st in salary["report"]["funnel"]}
    assert stages["candidate pairs"]["count"] == salary["report"]["counts"]["pairs_considered"]


def test_t10_attribute_overlap_lists_every_fact_attribute(salary):
    rep = salary["report"]
    listed = {fid for a in rep["attribute_overlap"] for d in a["documents"] for fid in d["fact_ids"]}
    assert {f["fact_id"] for f in _facts(salary)} == listed
    assert any(a["shared_across_documents"] for a in rep["attribute_overlap"])


def test_t11_relation_summary_built_from_returned_fields(salary):
    for rel in salary["report"]["relatedness"]:
        if rel["score"] is None:
            continue
        assert str(rel["shared_attributes_count"]) in rel["relation_summary"]
        for e in rel["shared_entities"]:
            assert e in rel["relation_summary"]
        assert rel["topic_similarity"]["method"]


def test_t12_not_scored_has_reason_code(algo):
    cs = algo["report"]["case_score"]
    assert cs["reason_code"] and cs["reason_text"] and cs["value"] is None
    assert algo["report"]["unlock_hints"] and all(h["reason_code"] for h in algo["report"]["unlock_hints"])


@pytest.fixture(scope="module")
def single(tmp_path_factory):
    return _analyze(tmp_path_factory.mktemp("one"), [
        {"name": "one.pdf", "mime": "application/pdf", "lines": ["Lecture 1", "Vertices: 4", "Edges: 5"]}])


def test_t13_single_document_gets_final_union_parse(single):
    stages = {s["stage"]: s for s in single["stages"]}
    assert {"parsing", "union_parse", "fact_normalization", "cross_document_reasoning"} <= set(stages)
    u = stages["union_parse"]["output"]
    assert u["pages"] == 1 and u["blocks"] >= 1 and len(u["documents"]) == 1
    assert single["final"]["verdict"] == "not_scored" and single["final"]["confidence"] is None


def test_t14_union_parse_adds_up(salary):
    u = next(s for s in salary["stages"] if s["stage"] == "union_parse")["output"]
    parsing = next(s for s in salary["stages"] if s["stage"] == "parsing")["output"]
    assert u["blocks"] == sum(p["blocks"] for p in parsing) and u["pages"] == sum(p["pages"] for p in parsing)
