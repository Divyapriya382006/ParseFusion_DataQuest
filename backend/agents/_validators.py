"""Deterministic validators used by agent 12."""
from __future__ import annotations

import re
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from ..common.models import CheckResult, TableBlock


_CURRENCY_PREFIX = re.compile(r"^(?:₹|Rs\.?|INR|USD|EUR|GBP|\$|€|£)\s*", re.I)
_NUM_WESTERN = re.compile(r"^\d{1,3}(?:,\d{3})+(?:\.\d+)?$")
_NUM_INDIAN = re.compile(r"^\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?$")
_NUM_PLAIN = re.compile(r"^(?:\d+(?:\.\d+)?|\.\d+)$")


def parse_number(text: str) -> Optional[Decimal]:
    """Parse clearly numeric text, including common accounting and Indian formats."""
    s = (text or "").strip()
    if not s:
        return None
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg, s = True, s[1:-1].strip()
    s = _CURRENCY_PREFIX.sub("", s)
    if s.endswith("-"):
        neg, s = True, s[:-1].strip()
    if s[:1] in ("-", "−"):
        neg, s = True, s[1:].strip()
    if not (_NUM_WESTERN.match(s) or _NUM_INDIAN.match(s) or _NUM_PLAIN.match(s)):
        return None
    try:
        value = Decimal(s.replace(",", ""))
    except InvalidOperation:
        return None
    return -value if neg else value


def _fmt(value: Decimal) -> str:
    return f"{value:.2f}"


_TOTAL_RX = re.compile(r"^\s*(sub\s*-?\s*total|grand\s+total|total)\b", re.I)


def _grid(tb: TableBlock) -> dict[tuple[int, int], str]:
    return {(cell.row, cell.col): cell.raw_text for cell in tb.cells}


def check_table_arithmetic(tb: TableBlock, tol: Decimal) -> list[CheckResult]:
    out: list[CheckResult] = []
    grid = _grid(tb)
    if not grid:
        return out
    rows = sorted({row for row, _ in grid})
    cols = sorted({col for _, col in grid})
    header_rows = {cell.row for cell in tb.cells if cell.is_header}
    if not header_rows:
        header_rows = {rows[0]}
    last_header = max(header_rows)

    def label_of(row: int) -> Optional[str]:
        for col in cols:
            text = grid.get((row, col), "")
            if text.strip():
                return text if _TOTAL_RX.match(text) else None
        return None

    kinds: dict[int, str] = {}
    for row in rows:
        if row <= last_header:
            continue
        label = label_of(row)
        if label:
            compact = label.lower().replace(" ", "").replace("-", "")
            kinds[row] = "sub" if compact.startswith("subtotal") else "total"

    segment_start = last_header
    sub_rows_in_segment: list[int] = []
    prev_sub_or_total = last_header
    for row in rows:
        if row <= last_header or row not in kinds:
            continue
        kind = kinds[row]
        for col in cols:
            stated = parse_number(grid.get((row, col), ""))
            if stated is None:
                continue
            if kind == "sub":
                addend_rows = [r for r in rows if prev_sub_or_total < r < row and r not in kinds]
            else:
                subs = [r for r in sub_rows_in_segment if r < row]
                addend_rows = subs if subs else [
                    r for r in rows if segment_start < r < row and r not in kinds
                ]
            values = [parse_number(grid.get((r, col), "")) for r in addend_rows]
            values = [value for value in values if value is not None]
            if len(values) < 2:
                continue
            total = sum(values, Decimal(0))
            ok = abs(total - stated) <= tol
            out.append(
                CheckResult(
                    name="arithmetic.column_total",
                    status="pass" if ok else "fail",
                    detail=f"column {col}: {len(values)} values sum to {_fmt(total)}; "
                    f"stated {'subtotal' if kind == 'sub' else 'total'} {_fmt(stated)}",
                )
            )
        if kind == "sub":
            sub_rows_in_segment.append(row)
            prev_sub_or_total = row
        else:
            sub_rows_in_segment = []
            segment_start = row
            prev_sub_or_total = row

    out.extend(_line_items(grid, rows, cols, last_header, kinds, tol))
    return out


_QTY = re.compile(r"^\s*(qty|quantity)\b", re.I)
_RATE = re.compile(r"\b(rate|unit price|price)\b", re.I)
_AMT = re.compile(r"^\s*(amount|line total|total)\b", re.I)


def _line_items(grid: dict[tuple[int, int], str], rows: list[int], cols: list[int],
                last_header: int, kinds: dict[int, str], tol: Decimal) -> list[CheckResult]:
    header = {col: grid.get((last_header, col), "") for col in cols}
    quantities = [col for col, text in header.items() if _QTY.search(text)]
    rates = [col for col, text in header.items() if _RATE.search(text)]
    amounts = [col for col, text in header.items() if _AMT.search(text)]
    if len(quantities) != 1 or len(rates) != 1 or len(amounts) != 1:
        return []
    bad: list[int] = []
    checked = 0
    for row in rows:
        if row <= last_header or row in kinds:
            continue
        qty, rate, amount = (
            parse_number(grid.get((row, col), "")) for col in (quantities[0], rates[0], amounts[0])
        )
        if qty is None or rate is None or amount is None:
            continue
        checked += 1
        if abs(qty * rate - amount) > tol:
            bad.append(row)
    if not checked:
        return []
    if bad:
        return [
            CheckResult(
                name="arithmetic.line_item",
                status="fail",
                detail=f"qty x rate != amount on row(s) {bad} ({checked} rows checked)",
            )
        ]
    return [
        CheckResult(
            name="arithmetic.line_item",
            status="pass",
            detail=f"qty x rate = amount on all {checked} rows",
        )
    ]


_MONTHS = {
    month: index
    for index, month in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1
    )
}
_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_NUM = re.compile(r"\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b")
_TXT = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
    r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b",
    re.I,
)


def _mk(year: int, month: int, day: int) -> Optional[date]:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def find_dates(text: str, day_first: bool) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    taken: list[tuple[int, int]] = []

    def free(start: int, end: int) -> bool:
        return all(end <= a or start >= b for a, b in taken)

    for match in _ISO.finditer(text):
        if free(*match.span()):
            taken.append(match.span())
            parsed = _mk(int(match[1]), int(match[2]), int(match[3]))
            found.append({"raw": match[0], "span": match.span(), "date": parsed,
                          "valid": parsed is not None, "note": None})
    for match in _TXT.finditer(text):
        if free(*match.span()):
            taken.append(match.span())
            parsed = _mk(int(match[3]), _MONTHS[match[2].lower()[:3]], int(match[1]))
            found.append({"raw": match[0], "span": match.span(), "date": parsed,
                          "valid": parsed is not None, "note": None})
    for match in _NUM.finditer(text):
        if free(*match.span()):
            taken.append(match.span())
            a, b, year = int(match[1]), int(match[2]), int(match[3])
            preferred = _mk(year, b, a) if day_first else _mk(year, a, b)
            alternate = _mk(year, a, b) if day_first else _mk(year, b, a)
            if preferred is not None:
                found.append({"raw": match[0], "span": match.span(), "date": preferred,
                              "valid": True, "note": None})
            elif alternate is not None:
                found.append(
                    {"raw": match[0], "span": match.span(), "date": alternate, "valid": True,
                     "note": f"valid only as {'month-first' if day_first else 'day-first'}"}
                )
            else:
                found.append({"raw": match[0], "span": match.span(), "date": None,
                              "valid": False, "note": None})
    found.sort(key=lambda item: item["span"][0])
    return found


_RANGE_SEP = re.compile(r"^\s*(?:to|until|through|till|[-–—])\s*$", re.I)


def check_dates(text: str, day_first: bool) -> list[CheckResult]:
    dates = find_dates(text, day_first)
    if not dates:
        return []
    out: list[CheckResult] = []
    bad = [item["raw"] for item in dates if not item["valid"]]
    ambiguous = [f"{item['raw']} ({item['note']})" for item in dates if item["valid"] and item["note"]]
    if bad:
        out.append(
            CheckResult(name="date_validity", status="fail",
                        detail=f"not a real calendar date: {', '.join(bad)}")
        )
    elif ambiguous:
        out.append(
            CheckResult(name="date_validity", status="warn",
                        detail="ambiguous day/month order: " + ", ".join(ambiguous))
        )
    else:
        out.append(CheckResult(name="date_validity", status="pass", detail=f"{len(dates)} date(s) valid"))
    for first, second in zip(dates, dates[1:]):
        if first["date"] and second["date"] and _RANGE_SEP.match(text[first["span"][1]:second["span"][0]]):
            if first["date"] > second["date"]:
                out.append(
                    CheckResult(name="date_ordering", status="fail",
                                detail=f"range ends before it starts: {first['raw']} to {second['raw']}")
                )
            else:
                out.append(
                    CheckResult(name="date_ordering", status="pass",
                                detail=f"range ordered: {first['raw']} to {second['raw']}")
                )
    return out


_START_LABEL = re.compile(
    r"(invoice date|issue date|date of issue|start date|effective date|order date)\s*[:\-]?\s*$", re.I
)
_END_LABEL = re.compile(
    r"(due date|end date|expiry date|expiration date|valid until|payment due)\s*[:\-]?\s*$", re.I
)


def labelled_dates(text: str, day_first: bool) -> list[tuple[str, date, str]]:
    """Return date values immediately preceded by a recognized start/end label."""
    out: list[tuple[str, date, str]] = []
    for item in find_dates(text, day_first):
        if not item["date"]:
            continue
        start = max(0, item["span"][0] - 30)
        before = text[start:item["span"][0]]
        if _START_LABEL.search(before):
            out.append(("start", item["date"], item["raw"]))
        elif _END_LABEL.search(before):
            out.append(("end", item["date"], item["raw"]))
    return out


_AMOUNT = re.compile(r"(?:₹|Rs\.?|INR|USD|EUR|GBP|\$|€|£)\s*(\d[\d,]*(?:\.\d+)?)", re.I)


def check_currency_format(text: str) -> list[CheckResult]:
    tokens = [match[1] for match in _AMOUNT.finditer(text)]
    if not tokens:
        return []
    bad = [token for token in tokens if not (
        _NUM_WESTERN.match(token) or _NUM_INDIAN.match(token) or _NUM_PLAIN.match(token)
    )]
    if bad:
        return [
            CheckResult(name="currency_format", status="fail",
                        detail=f"malformed digit grouping: {', '.join(bad[:5])}")
        ]
    return [CheckResult(name="currency_format", status="pass", detail=f"{len(tokens)} amount(s) well-formed")]


def iban_valid(iban: str) -> bool:
    value = re.sub(r"\s+", "", iban).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{11,30}", value):
        return False
    rearranged = value[4:] + value[:4]
    number = "".join(str(int(char, 36)) for char in rearranged)
    return int(number) % 97 == 1


def luhn_valid(number: str) -> bool:
    digits = [int(char) for char in re.sub(r"[ -]", "", number)]
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    for index, digit in enumerate(reversed(digits)):
        if index % 2 == 1:
            digit *= 2
            digit -= 9 if digit > 9 else 0
        total += digit
    return total % 10 == 0


_GST_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_valid(gstin: str) -> bool:
    value = gstin.upper()
    if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", value):
        return False
    total = 0
    for index, char in enumerate(value[:14]):
        product = _GST_CHARS.index(char) * (1 if index % 2 == 0 else 2)
        total += product // 36 + product % 36
    return _GST_CHARS[(36 - total % 36) % 36] == value[14]


_IBAN_RX = re.compile(r"\bIBAN\b[:\s]*([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}\s?[A-Z0-9]{1,4})", re.I)
_CARD_RX = re.compile(r"\b(?:credit card|debit card|card)\b[^0-9]{0,15}((?:\d[ -]?){13,19})", re.I)
_GST_RX = re.compile(r"\bGSTIN\b[:\s#.-]*([0-9A-Z]{15})\b", re.I)
_PAN_RX = re.compile(r"\bPAN\b[:\s#.-]*([0-9A-Z]{10})\b", re.I)


def check_identifiers(text: str) -> list[CheckResult]:
    out: list[CheckResult] = []
    for match in _IBAN_RX.finditer(text):
        valid = iban_valid(match[1])
        out.append(CheckResult(name="checksum.iban", status="pass" if valid else "fail",
                               detail="IBAN mod-97 " + ("valid" if valid else "invalid")))
    for match in _CARD_RX.finditer(text):
        valid = luhn_valid(match[1])
        out.append(CheckResult(name="checksum.luhn", status="pass" if valid else "fail",
                               detail="Luhn " + ("valid" if valid else "invalid")))
    for match in _GST_RX.finditer(text):
        valid = gstin_valid(match[1])
        out.append(CheckResult(name="checksum.gstin", status="pass" if valid else "fail",
                               detail="GSTIN format/checksum " + ("valid" if valid else "invalid")))
    for match in _PAN_RX.finditer(text):
        valid = bool(re.fullmatch(r"[A-Z]{5}\d{4}[A-Z]", match[1].upper()))
        out.append(CheckResult(name="format.pan", status="pass" if valid else "fail",
                               detail="PAN format " + ("valid" if valid else "invalid")))
    return out


_PERCENT = re.compile(r"(-?\d+(?:\.\d+)?)\s*%")


def check_units(text: str) -> list[CheckResult]:
    values = [Decimal(match[1]) for match in _PERCENT.finditer(text)]
    if not values:
        return []
    over = [value for value in values if value > 100]
    if over:
        return [
            CheckResult(name="unit_sanity", status="warn",
                        detail=f"percentage above 100%: {', '.join(str(value) for value in over[:5])}")
        ]
    return [
        CheckResult(name="unit_sanity", status="pass",
                    detail=f"{len(values)} percentage(s) within 0-100%")
    ]


_LABEL_VALUE = re.compile(r"^\s*([A-Za-z][A-Za-z .#/]{2,40}?)\s*[:#]\s*(\S.{0,39}?)\s*$")


def label_values(text: str) -> list[tuple[str, str]]:
    values = []
    for line in text.splitlines():
        match = _LABEL_VALUE.match(line)
        if match and re.search(r"\d", match[2]):
            label = re.sub(r"\s+", " ", match[1].strip().lower())
            value = re.sub(r"\s+", " ", match[2].strip().lower())
            values.append((label, value))
    return values
