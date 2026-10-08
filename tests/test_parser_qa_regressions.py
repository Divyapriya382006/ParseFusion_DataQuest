"""Regression assertions for the captured four-page parser QA sample.

Refresh the compact fixture from a newly parsed canonical source after parser fixes.
"""

from __future__ import annotations

import importlib
import json
import re
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

import pytest


FIXTURE = Path(__file__).parent / "fixtures" / "parser_qa_sample_snapshot.json"


@pytest.fixture(scope="module")
def report() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8-sig"))


def _page(report: dict, number: int) -> dict:
    return next(page for page in report["pages"] if page["page_number"] == number)


def _tables(page: dict) -> list[dict]:
    return [block for block in page["blocks"] if block["type"] == "table"]


def _debt_table(page: dict) -> dict:
    return next(table for table in _tables(page) if table["n_cols"] == 7)


def _cells_by_row(table: dict) -> dict[int, dict[int, dict]]:
    rows: dict[int, dict[int, dict]] = defaultdict(dict)
    for cell in table["cells"]:
        rows[cell["row"]][cell["col"]] = cell
    return rows


def _number(value: str) -> Decimal:
    text = value.strip()
    negative = text.startswith("(") and text.endswith(")")
    digits = re.sub(r"[$,()\s]", "", text)
    number = Decimal(digits)
    return -number if negative else number


def test_unverified_extraction_is_not_reported_as_perfect_or_complete(report: dict) -> None:
    source_warnings = {warning["code"] for warning in report["warnings"]}
    assert "OCR_FAILED" not in source_warnings
    assert report["status"] in {"needs_review", "partial_success"}
    assert report["document_confidence"] < 1.0

    for page in report["pages"]:
        assert any(w["code"] == "CONFIDENCE_NOT_CROSS_CHECKED" for w in page["warnings"])
        for block in page["blocks"]:
            if block["extraction_method"] == "native_text":
                assert block["confidence"] < 1.0
                assert block["needs_review"]
                assert any(w["code"] == "CONFIDENCE_NOT_CROSS_CHECKED" for w in block["warnings"])


def test_empty_image_regions_are_flagged_and_covered(report: dict) -> None:
    figures = [
        (page, block)
        for page in report["pages"]
        for block in page["blocks"]
        if block["type"] == "figure"
        and block["confidence_breakdown"].get("ocr_text_blocks_inside") == 0
    ]
    assert figures
    for page, figure in figures:
        assert figure["needs_review"]
        assert page["coverage_score"] is not None
        assert page["uncovered_regions"]


def test_scanned_slip_fields_are_recovered_from_its_image(report: dict) -> None:
    page = _page(report, 4)
    figure = next(block for block in page["blocks"] if block["type"] == "figure")
    x1, y1, x2, y2 = figure["location"]["bbox"]
    extracted = " ".join(
        block.get("raw_text", "")
        for block in page["blocks"]
        if block["extraction_method"] == "ocr"
        and block["location"]["bbox"]
        and x1 <= (block["location"]["bbox"][0] + block["location"]["bbox"][2]) / 2 <= x2
        and y1 <= (block["location"]["bbox"][1] + block["location"]["bbox"][3]) / 2 <= y2
    ).casefold()
    for expected in ("eastport", "14,280", "$7.50", "$107,100", "ml", "30 sep 2026"):
        assert expected in extracted


def test_debt_rows_and_totals_match_the_source_values(report: dict) -> None:
    tables = [_debt_table(_page(report, 2)), _debt_table(_page(report, 3))]
    facility_rows: list[dict[int, dict]] = []
    total_row: dict[int, dict] | None = None
    for table in tables:
        rows = _cells_by_row(table)
        facility_rows.extend(rows[row] for row in range(2, table["n_rows"] - (1 if table["n_rows"] == 7 else 0)))
        if table["n_rows"] == 7:
            total_row = rows[6]

    assert len(facility_rows) == 8
    for row in facility_rows:
        assert _number(row[2]["raw_text"]) + _number(row[3]["raw_text"]) + _number(row[4]["raw_text"]) == _number(row[5]["raw_text"])
    assert sum((_number(row[2]["raw_text"]) for row in facility_rows), Decimal(0)) == Decimal(19600)
    assert sum((_number(row[3]["raw_text"]) for row in facility_rows), Decimal(0)) == Decimal(1550)
    assert sum((_number(row[4]["raw_text"]) for row in facility_rows), Decimal(0)) == Decimal(-1400)
    assert sum((_number(row[5]["raw_text"]) for row in facility_rows), Decimal(0)) == Decimal(19750)
    assert sum((_number(row[6]["raw_text"]) for row in facility_rows), Decimal(0)) == Decimal(499)
    assert total_row is not None
    assert [_number(total_row[col]["raw_text"]) for col in range(2, 7)] == [
        Decimal(19600), Decimal(1550), Decimal(-1400), Decimal(19750), Decimal(499)
    ]


def test_monetary_values_have_explicit_units_and_normalized_values(report: dict) -> None:
    tables = [_debt_table(_page(report, 2)), _debt_table(_page(report, 3))]
    monetary_cells = [
        cell
        for table in tables
        for cell in table["cells"]
        if cell["row"] >= 2 and cell["col"] in {2, 3, 4, 5, 6}
    ]
    assert monetary_cells
    assert all(cell["normalized"] for cell in monetary_cells)
    assert all(cell["normalized"].get("unit") for cell in monetary_cells)


def test_chart_is_not_silently_exported_as_a_table(report: dict) -> None:
    page = _page(report, 3)
    charts = [block for block in page["blocks"] if block["type"] == "chart"]
    warnings = {
        warning["code"]
        for warning in [*report["warnings"], *(page["warnings"] or [])]
        if warning
    }
    assert charts or "CHART_EXTRACTION_UNAVAILABLE" in warnings
    for table in _tables(page):
        widths = [
            cell["location"]["bbox"][2] - cell["location"]["bbox"][0]
            for cell in table["cells"]
            if cell["location"]["bbox"]
        ]
        assert not widths or min(widths) >= page["width"] * 0.01


def test_cross_page_debt_tables_are_linked_or_flagged(report: dict) -> None:
    first = _debt_table(_page(report, 2))
    second = _debt_table(_page(report, 3))
    warnings = {warning["code"] for warning in report["warnings"]}
    linked = first.get("continues_to") == second["table_id"] and second.get("continues_from") == first["table_id"]
    assert linked or "POSSIBLE_TABLE_CONTINUATION" in warnings


def test_table_spans_follow_cell_geometry_and_subheaders_are_headers(report: dict) -> None:
    for page_number in (2, 3):
        table = _debt_table(_page(report, page_number))
        cells = table["cells"]
        xs = sorted({round(edge, 2) for cell in cells for edge in cell["location"]["bbox"][::2]})
        ys = sorted({round(edge, 2) for cell in cells for edge in cell["location"]["bbox"][1::2]})
        x_bands = [(left, right) for left, right in zip(xs, xs[1:]) if right - left > 1]
        y_bands = [(top, bottom) for top, bottom in zip(ys, ys[1:]) if bottom - top > 1]

        for cell in cells:
            x1, y1, x2, y2 = cell["location"]["bbox"]
            expected_cols = sum(x1 <= (left + right) / 2 <= x2 for left, right in x_bands)
            expected_rows = sum(y1 <= (top + bottom) / 2 <= y2 for top, bottom in y_bands)
            assert cell["col_span"] == expected_cols
            assert cell["row_span"] == expected_rows

        assert all(cell["is_header"] for cell in cells if cell["row"] in {0, 1})


def test_reading_order_keeps_two_columns_contiguous(report: dict) -> None:
    page = _page(report, 1)
    blocks = [block for block in page["blocks"] if block["type"] == "text" and block.get("raw_text")]
    left_heading = next(block for block in blocks if block["raw_text"].strip() == "Operating overview")
    right_heading = next(block for block in blocks if block["raw_text"].strip() == "Review notes")
    end_heading = next(block for block in blocks if block["raw_text"].strip() == "Key figures")
    top = min(left_heading["location"]["bbox"][1], right_heading["location"]["bbox"][1])
    bottom = end_heading["location"]["bbox"][1]
    left, right = [], []
    for block in blocks:
        x1, y1, x2, y2 = block["location"]["bbox"]
        if top <= (y1 + y2) / 2 < bottom and x2 - x1 < page["width"] * 0.6:
            (left if (x1 + x2) / 2 < page["width"] / 2 else right).append(block["reading_order_index"])
    assert left and right
    assert max(left) < min(right)


def test_skipped_native_text_ids_have_explicit_explanations(report: dict) -> None:
    for page in report["pages"]:
        indices = sorted(
            int(match.group(1))
            for block in page["blocks"]
            if block["extraction_method"] == "native_text"
            if (match := re.search(r"_native_text_(\d+)$", block["block_id"]))
        )
        gaps = set(range(min(indices, default=0), max(indices, default=-1) + 1)) - set(indices)
        explanations = set(page.get("block_id_gap_explanations", []))
        assert gaps <= explanations


def test_repeating_page_chrome_is_not_body_text(report: dict) -> None:
    for page in report["pages"]:
        body = [
            block for block in page["blocks"]
            if block["type"] not in {"header", "footer"}
        ]
        text = re.sub(r"\s+", " ", " ".join(block.get("raw_text") or "" for block in body)).casefold()
        assert "parsefusion | universal parser qa" not in text
        assert "synthetic test data" not in text
        assert not re.search(r"\bpage\s+\d+\s+of\s+4\b", text)


def test_equations_are_structured_or_explicitly_reported_unavailable(report: dict) -> None:
    equation_text = " ".join(
        block.get("raw_text") or ""
        for block in _page(report, 4)["blocks"]
    ).casefold()
    assert "closing debt = opening debt" in equation_text
    assert "net debt = gross debt" in equation_text
    has_equations = any(block["type"] == "equation" for block in _page(report, 4)["blocks"])
    warning_codes = {
        warning["code"]
        for warning in [*report["warnings"], *(_page(report, 4)["warnings"] or [])]
        if warning
    }
    assert has_equations or "EQUATION_EXTRACTION_UNAVAILABLE" in warning_codes


def test_canonical_source_and_page_contract_includes_image_and_review_coverage(report: dict) -> None:
    assert all(report.get(key) is not None for key in ("status", "kind", "origin", "document_confidence", "errors"))
    for page in report["pages"]:
        assert page.get("image_url")
        assert page.get("coverage_score") is not None
        assert page.get("uncovered_regions") is not None


def test_batch_export_keeps_nested_table_cells_structured(report: dict) -> None:
    exporter = importlib.import_module("backend.agents.20_export")
    document = exporter.build_document(
        "source",
        [{"id": report["source_id"], "data": {"pages": report["pages"]}}],
    )
    table_names = [table["name"].casefold() for table in document["items"][0]["tables"]]
    assert any("cells" in name for name in table_names)
