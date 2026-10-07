import importlib
import sys
import types
from dataclasses import dataclass

import pytest


@pytest.fixture
def validators(monkeypatch):
    models = types.ModuleType("backend.common.models")

    @dataclass
    class CheckResult:
        name: str
        status: str
        detail: str

    class TableBlock:
        pass

    models.CheckResult = CheckResult
    models.TableBlock = TableBlock
    monkeypatch.setitem(sys.modules, "backend.common.models", models)
    sys.modules.pop("backend.agents._validators", None)
    return importlib.import_module("backend.agents._validators")


def test_parse_number_accepts_accounting_and_indian_grouping(validators):
    assert validators.parse_number("(1,234.50)") == -1234.50
    assert validators.parse_number("1,00,000") == 100000
    assert validators.parse_number("12.5-") == -12.5
    assert validators.parse_number("12,34,56") is None


def test_dates_check_validity_and_order(validators):
    results = validators.check_dates("Period: 31/01/2025 to 01/02/2025", day_first=True)
    assert [(result.name, result.status) for result in results] == [
        ("date_validity", "pass"),
        ("date_ordering", "pass"),
    ]
    assert validators.check_dates("Due: 31/02/2025", day_first=True)[0].status == "fail"


def test_identifier_checksums_and_label_values(validators):
    assert validators.iban_valid("GB82 WEST 1234 5698 7654 32")
    assert validators.luhn_valid("4111 1111 1111 1111")
    assert not validators.luhn_valid("4111 1111 1111 1112")
    assert validators.label_values("Invoice total: 1,234.50") == [("invoice total", "1,234.50")]


def test_table_total_is_checked_only_when_computable(validators):
    class Cell:
        def __init__(self, row, col, raw_text, is_header=False):
            self.row = row
            self.col = col
            self.raw_text = raw_text
            self.is_header = is_header

    table = validators.TableBlock()
    table.cells = [
        Cell(1, 1, "Description", True),
        Cell(1, 2, "Amount", True),
        Cell(2, 1, "Item A"),
        Cell(2, 2, "10"),
        Cell(3, 1, "Item B"),
        Cell(3, 2, "20"),
        Cell(4, 1, "Total"),
        Cell(4, 2, "30"),
    ]
    checks = validators.check_table_arithmetic(table, tol=0)
    assert len(checks) == 1
    assert checks[0].name == "arithmetic.column_total"
    assert checks[0].status == "pass"
