"""
12_confidence_validation.py - Agent 12: Confidence & Validation  (Person C).   POST /agents/confidence-validation   In {source_id, page_number?}  ->  Out ValidationReport

Reads the assembled document (agent 11, SHA-256 integrity checked before use), scores every block, runs deterministic validators and emits badges.
Never edits extracted values and never decides anything: a failed check is a "potential discrepancy - manual review recommended".  Stored under kind "validation".

CONFIDENCE FORMULA (documented, deterministic; weights in config confidence.weights, bands in config bands)
  per block   c = sum_i(w_i * s_i) / sum_i(w_i)   over the components that EXIST for the block (weights are renormalised, a missing component is never guessed):
      engine      s = block.extra.engine_confidence (fallback block.confidence)                                  w = 0.35
      agreement   s = {unanimous 1.0, majority 0.75, split 0.40}, x0.9 when single_source; None if no consensus info   w = 0.25
      layout      s = block.extra.layout_confidence                                                              w = 0.15
      validation  s = (passed + 0.5*warned) / applicable checks; capped at 0.40 when any check FAILED; None if no check applies   w = 0.25
  document_confidence = 0.7 * area-weighted mean(c)  +  0.3 * min(c over critical blocks)     (critical = config confidence.critical_types, default table, equation;
      with no critical block the second term uses the min over all blocks;  bbox-less blocks weigh 1;  null when the document has no blocks)
  page_confidence     = the same formula restricted to the page.
  needs_review(block) = c < bands.review  OR  any failed check  OR  consensus escalated / needs_review.   High band = c >= bands.high.

VALIDATORS (each yields pass | warn | fail with a neutral detail; never the raw document text beyond the compared numbers)
  arithmetic   table rows: qty x unit price = line amount;  column sum = subtotal;  subtotal + tax = total   (tolerance max(abs 0.01, rel 1e-4))
  date         valid calendar date, year within bounds; a sequence "issue date <= due date" in the same block / table row
  format       mixed currency symbols in a table column; percentages outside 0..100; negative quantities
  checksum     IBAN mod-97, GSTIN check character, PAN / EIN format, card numbers by Luhn (only when a card keyword is nearby)
  cross-block  a "total / amount due" figure in text that matches no total row of any table on the document (potential discrepancy)
Badges ({scope, scope_id, label, status pass|mismatch|warn, detail}) at document, page and table scope.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from common import audit, auth, config, store, util
from common.envelope import ApiError, Timer, WarningItem, dbg, handle, import_agent, now_iso, warn

AGENT = "12_confidence_validation"
router = APIRouter()


def _doc_loader():
    return import_agent("11_json_assembly")


# =========================================================================== models
class Check(BaseModel):
    name: str
    status: str                  # pass | warn | fail
    detail: str


class BlockScore(BaseModel):
    block_id: str
    page_number: int
    type: str
    components: dict
    confidence: float = Field(ge=0, le=1)
    band: str                    # high | medium | low
    needs_review: bool
    review_reasons: list[str] = []
    checks: list[Check] = []


class Badge(BaseModel):
    scope: str                   # document | page | table
    scope_id: str
    label: str
    status: str                  # pass | mismatch | warn
    detail: Optional[str] = None


class PageScore(BaseModel):
    page_number: int
    confidence: Optional[float] = None
    blocks_needing_review: int = 0


class ValidationReport(BaseModel):
    source_id: str
    document_sha256: str
    document_confidence: Optional[float] = None
    blocks: list[BlockScore]
    pages: list[PageScore]
    badges: list[Badge]
    warnings: list[WarningItem] = []
    generated_at: str


class ValidationInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    page_number: Optional[int] = Field(default=None, ge=1)


# =========================================================================== number / date parsing
_NUM = re.compile(r"[-+(]?\s*[^\d\s()+-]{0,3}\s*\d[\d.,' ]*\d%?\)?|[-+(]?\d%?\)?")
_CUR = "$€£¥₹"


def parse_number(text: Any) -> Optional[float]:
    """'1,234.50' '(1.234,50)' '12%' '₹ 1,00,000' -> float; None when the text is not a single number"""
    if text is None:
        return None
    t = str(text).strip()
    if not t or len(t) > 40:
        return None
    neg = t.startswith("(") and t.endswith(")") or t.startswith("-") or t.startswith("−")
    t = re.sub(r"[()%\s'\-−+]", "", t)
    t = re.sub(r"(?i)^(usd|eur|gbp|inr|rs\.?)", "", t)
    t = t.lstrip(_CUR)
    t = re.sub(rf"[{_CUR}]$", "", t)
    if not re.fullmatch(r"[\d.,]+", t) or not re.search(r"\d", t):
        return None
    if "," in t and "." in t:
        dec = "," if t.rfind(",") > t.rfind(".") else "."
        t = t.replace("," if dec == "." else ".", "").replace(dec, ".")
    elif "," in t:
        t = t.replace(",", ".") if re.fullmatch(r"\d+,\d{1,2}", t) else t.replace(",", "")
    elif t.count(".") > 1:
        t = t.replace(".", "")
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


def _close(a: float, b: float) -> bool:
    v = config.get("confidence.validators", {})
    return abs(a - b) <= max(float(v.get("arithmetic_tolerance_abs", 0.01)), float(v.get("arithmetic_tolerance_rel", 0.0001)) * max(abs(a), abs(b)))


_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
_D_ISO = re.compile(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b")
_D_DMY = re.compile(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b")
_D_TXT = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b")


def find_dates(text: str) -> list:
    """-> [(raw, date|None, ambiguous)]  dd/mm vs mm/dd: both readable -> the day-first reading is used and `ambiguous` is True"""
    out = []
    for m in _D_ISO.finditer(text):
        y, mo, d = map(int, m.groups())
        out.append((m.group(0), _mk(y, mo, d), False))
    for m in _D_DMY.finditer(text):
        a, b, y = map(int, m.groups())
        dt = _mk(y, b, a)
        amb = a <= 12 and b <= 12 and a != b
        if dt is None and a <= 12:
            dt, amb = _mk(y, a, b), False     # only the month-first reading is a real date
        out.append((m.group(0), dt, amb))
    for m in _D_TXT.finditer(text):
        mon = _MONTHS.get(m.group(2)[:3].lower())
        out.append((m.group(0), _mk(int(m.group(3)), mon, int(m.group(1))) if mon else None, False))
    return out


def _mk(y: int, m: Optional[int], d: int) -> Optional[date]:
    try:
        return date(y, m, d) if m else None
    except ValueError:
        return None


# =========================================================================== checksums
def iban_ok(s: str) -> bool:
    s = re.sub(r"\s", "", s).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{11,30}", s):
        return False
    r = s[4:] + s[:4]
    return int("".join(str(int(c, 36)) for c in r)) % 97 == 1


def luhn_ok(digits: str) -> bool:
    d = [int(c) for c in digits][::-1]
    return (sum(d[0::2]) + sum((x * 2 - 9 if x * 2 > 9 else x * 2) for x in d[1::2])) % 10 == 0


_GST_ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_ok(s: str) -> bool:
    s = s.upper()
    if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", s):
        return False
    total = 0
    for i, ch in enumerate(s[:14]):
        v = _GST_ALPHA.index(ch) * (1 if i % 2 == 0 else 2)
        total += v // 36 + v % 36
    return _GST_ALPHA[(36 - total % 36) % 36] == s[14]


_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b")
_GST_RE = re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b")
_PAN_RE = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")
_EIN_RE = re.compile(r"\b(\d{2})-(\d{7})\b")
_CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_CARD_KW = re.compile(r"(?i)card|credit|debit|visa|master|amex|pan\b")
_EIN_KW = re.compile(r"(?i)\bein\b|employer identification|federal tax id|tax id")
_PAN_KW = re.compile(r"(?i)\bpan\b|permanent account")
_EIN_PREFIX = {f"{i:02d}" for i in list(range(1, 7)) + list(range(10, 17)) + list(range(20, 28)) + list(range(30, 40)) + list(range(40, 49)) + list(range(50, 69)) + list(range(71, 78)) + list(range(80, 89)) + [90, 91, 92, 93, 94, 95, 98, 99]}


def checksum_checks(text: str) -> list:
    out = []
    for m in _IBAN_RE.finditer(text.upper()):
        raw = re.sub(r"\s", "", m.group(0))
        if len(raw) >= 15 and re.search(r"\d", raw[2:4]):
            out.append(Check(name="checksum_iban", status="pass" if iban_ok(raw) else "fail", detail="IBAN mod-97 " + ("verified" if iban_ok(raw) else "does not verify - potential discrepancy, manual review recommended")))
    for m in _GST_RE.finditer(text.upper()):
        ok = gstin_ok(m.group(0))
        out.append(Check(name="checksum_gstin", status="pass" if ok else "fail", detail="GSTIN check character " + ("verified" if ok else "does not verify - potential discrepancy, manual review recommended")))
    if _PAN_KW.search(text):
        for m in _PAN_RE.finditer(text.upper()):
            out.append(Check(name="format_pan", status="pass", detail="PAN format is valid"))
    if _EIN_KW.search(text):
        for m in _EIN_RE.finditer(text):
            ok = m.group(1) in _EIN_PREFIX
            out.append(Check(name="format_ein", status="pass" if ok else "warn", detail="EIN format is valid" if ok else "EIN prefix is not an issued prefix - manual review recommended"))
    if _CARD_KW.search(text):
        for m in _CARD_RE.finditer(text):
            digits = re.sub(r"\D", "", m.group(0))
            if 13 <= len(digits) <= 19:
                ok = luhn_ok(digits)
                out.append(Check(name="checksum_luhn", status="pass" if ok else "fail", detail="Card number Luhn check " + ("verified" if ok else "does not verify - potential discrepancy, manual review recommended")))
    return out


def date_checks(text: str) -> list:
    v = config.get("confidence.validators", {})
    lo, hi = int(v.get("date_min_year", 1900)), int(v.get("date_max_year", 2100))
    out, valid = [], []
    for raw, dt, amb in find_dates(text):
        if dt is None:
            out.append(Check(name="date_valid", status="fail", detail=f"'{raw}' is not a valid calendar date - manual review recommended"))
        elif not lo <= dt.year <= hi:
            out.append(Check(name="date_range", status="warn", detail=f"'{raw}' is outside {lo}-{hi}"))
        else:
            out.append(Check(name="date_valid", status="warn" if amb else "pass", detail=f"'{raw}' is ambiguous (day-first read)" if amb else f"'{raw}' is a valid date"))
            valid.append((raw, dt))
    labels = {}
    marks = list(re.finditer(r"(?i)(invoice date|issue date|date of issue|due date|payment due|\bdate\b)\s*[:\-]?", text))
    for i, m in enumerate(marks):
        seg = text[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(text)].split("\n")[0][:40]
        for raw, dt, _ in find_dates(seg):
            if dt:
                labels.setdefault("due" if "due" in m.group(1).lower() else "issue", dt)
                break
    if "issue" in labels and "due" in labels:
        ok = labels["issue"] <= labels["due"]
        out.append(Check(name="date_order", status="pass" if ok else "fail", detail="issue date is not after due date" if ok else "issue date is after due date - potential discrepancy, manual review recommended"))
    return out


# =========================================================================== table validators
_HDR = {"qty": re.compile(r"(?i)^(qty|quantity|units?|nos?\.?|pcs)$"), "price": re.compile(r"(?i)(unit\s*)?(price|rate|cost)"), "amount": re.compile(r"(?i)^(amount|line\s*total|total|value|net|ext(ended)?\s*(price|amount))$")}
_TOT = {"sub": re.compile(r"(?i)^\s*sub[\s-]*total\b"), "tax": re.compile(r"(?i)^\s*(tax|vat|gst|igst|cgst|sgst|sales tax)\b"), "total": re.compile(r"(?i)^\s*(grand\s*total|total(\s*(due|amount))?|amount\s*due|balance\s*due)\b")}


def _grid(tb: dict) -> list:
    g = [["" for _ in range(tb["n_cols"])] for _ in range(tb["n_rows"])]
    for c in tb["cells"]:
        if c["row"] < tb["n_rows"] and c["col"] < tb["n_cols"]:
            g[c["row"]][c["col"]] = c["raw_text"]
    return g


def table_checks(tb: dict) -> tuple:
    """-> (checks, total_values) ; total_values = numbers on a total row (for the cross-block check)"""
    checks: list = []
    totals: list = []
    if tb["n_rows"] < 2 or tb["n_cols"] < 2:
        return checks, totals
    g = _grid(tb)
    hrow = g[0] if tb.get("header_rows", 0) >= 1 else None
    col = {}
    if hrow:
        for j, h in enumerate(hrow):
            h = h.strip()
            for k, rx in _HDR.items():
                if k not in col and rx.search(h) and (k != "price" or not _HDR["amount"].match(h)):
                    col[k] = j
    start = tb.get("header_rows", 0)
    body_rows = []
    for i in range(start, tb["n_rows"]):
        label = " ".join(x for x in g[i][:max(1, (col.get("qty", 1)))] if x)
        kind = next((k for k, rx in _TOT.items() if rx.search(g[i][0]) or rx.search(label)), None)
        body_rows.append((i, kind))
    amt_col = col.get("amount", tb["n_cols"] - 1 if hrow is None else None)
    if "qty" in col and "price" in col and amt_col is not None:
        for i, kind in body_rows:
            if kind:
                continue
            q, p, a = (parse_number(g[i][col["qty"]]), parse_number(g[i][col["price"]]), parse_number(g[i][amt_col]))
            if None in (q, p, a):
                continue
            if q < 0:
                checks.append(Check(name="unit_sanity", status="warn", detail=f"row {i}: negative quantity"))
            ok = _close(q * p, a)
            checks.append(Check(name="arithmetic_line", status="pass" if ok else "fail",
                                detail=f"row {i}: qty x price = {q * p:.2f}, stated {a:.2f}" + ("" if ok else " - potential discrepancy, manual review recommended")))
    if amt_col is not None:
        lines = [(i, parse_number(g[i][amt_col])) for i, k in body_rows if not k]
        lines = [(i, v) for i, v in lines if v is not None]
        sub = next(((i, parse_number(g[i][amt_col])) for i, k in body_rows if k == "sub" and parse_number(g[i][amt_col]) is not None), None)
        tax = next((parse_number(g[i][amt_col]) for i, k in body_rows if k == "tax" and parse_number(g[i][amt_col]) is not None), None)
        tot = next(((i, parse_number(g[i][amt_col])) for i, k in body_rows if k == "total" and parse_number(g[i][amt_col]) is not None), None)
        if tot:
            totals.append(tot[1])
        if sub and lines:
            s = sum(v for i, v in lines if i < sub[0])
            if any(i < sub[0] for i, _ in lines):
                ok = _close(s, sub[1])
                checks.append(Check(name="arithmetic_subtotal", status="pass" if ok else "fail", detail=f"sum of lines {s:.2f}, stated subtotal {sub[1]:.2f}" + ("" if ok else " - potential discrepancy, manual review recommended")))
        if tot:
            base = sub[1] if sub else None
            if base is None:
                prior = [v for i, v in lines if i < tot[0]]
                base = sum(prior) if prior else None
            if base is not None:
                expect = base + (tax or 0.0)
                ok = _close(expect, tot[1])
                checks.append(Check(name="arithmetic_total", status="pass" if ok else "fail",
                                    detail=f"{'subtotal' if sub else 'sum of lines'} + tax = {expect:.2f}, stated total {tot[1]:.2f}" + ("" if ok else " - potential discrepancy, manual review recommended")))
        # currency / format of the amount column
        syms = {ch for i, _ in lines for ch in g[i][amt_col] if ch in _CUR}
        if len(syms) > 1:
            checks.append(Check(name="format_currency", status="warn", detail="more than one currency symbol in the amount column"))
    for j in range(tb["n_cols"]):
        hdr = (g[0][j] if hrow else "").lower()
        if "%" in hdr or re.search(r"discount|tax rate|rate %", hdr):
            for i in range(start, tb["n_rows"]):
                v = parse_number(g[i][j])
                if v is not None and "%" in g[i][j] and not 0 <= v <= 100:
                    checks.append(Check(name="unit_sanity", status="warn", detail=f"row {i}: percentage {v:g} is outside 0-100"))
    return checks, totals


# =========================================================================== scoring
_AGR = {"unanimous": 1.0, "majority": 0.75, "split": 0.4}


def block_components(b: dict, checks: list) -> dict:
    ex = b.get("extra") or {}
    comp = {"engine": util.clamp01(ex.get("engine_confidence", b["confidence"])), "agreement": None, "layout": None, "validation": None}
    if ex.get("agreement") in _AGR:
        s = _AGR[ex["agreement"]]
        comp["agreement"] = round(s * (0.9 if ex.get("single_source") else 1.0), 4)
    if ex.get("layout_confidence") is not None:
        comp["layout"] = util.clamp01(ex["layout_confidence"])
    if checks:
        p = sum(1 for c in checks if c.status == "pass")
        w = sum(1 for c in checks if c.status == "warn")
        s = (p + 0.5 * w) / len(checks)
        comp["validation"] = round(min(s, 0.4) if any(c.status == "fail" for c in checks) else s, 4)
    return comp


def combine(comp: dict) -> float:
    w = config.get("confidence.weights", {"engine": 0.35, "agreement": 0.25, "layout": 0.15, "validation": 0.25})
    num = sum(float(w[k]) * v for k, v in comp.items() if v is not None and k in w)
    den = sum(float(w[k]) for k, v in comp.items() if v is not None and k in w)
    return round(num / den, 4) if den else 0.0


def aggregate(items: list) -> Optional[float]:
    """items = [(confidence, area, type)] -> document / page confidence"""
    if not items:
        return None
    a = config.get("confidence.aggregation", {"area_weighted": 0.7, "min_pool": 0.3})
    crit = set(config.get("confidence.critical_types", ["table", "equation"]))
    wsum = sum(max(ar, 1.0) for _, ar, _ in items)
    mean = sum(c * max(ar, 1.0) for c, ar, _ in items) / wsum
    pool = [c for c, _, t in items if t in crit] or [c for c, _, _ in items]
    return round(float(a["area_weighted"]) * mean + float(a["min_pool"]) * min(pool), 4)


def band(c: float) -> str:
    b = config.get("bands", {"high": 0.85, "review": 0.60})
    return "high" if c >= b["high"] else "low" if c < b["review"] else "medium"


def _flat_text(b: dict) -> str:
    return b.get("text") or ""


def validate(doc: dict, pages_filter: Optional[int] = None) -> tuple:
    """-> (block_scores, page_scores, badges, warnings)"""
    scores: list = []
    badges: list = []
    warns: list = []
    text_totals: list = []   # (block_id, value) from "total / amount due" lines in text blocks
    table_totals: list = []
    per_page: dict = {}
    for p in doc["pages"]:
        if pages_filter and p["page_number"] != pages_filter:
            continue
        page_bad = 0
        for b in p["blocks"]:
            checks: list = []
            if b["type"] == "table":
                tc, tv = table_checks(b)
                checks += tc
                table_totals += tv
                for c in b["cells"]:
                    checks += checksum_checks(c["raw_text"]) + date_checks(c["raw_text"])
                tbl_fail = [c for c in tc if c.status == "fail"]
                tbl_warn = [c for c in tc if c.status == "warn"]
                if tc:
                    badges.append(Badge(scope="table", scope_id=b["block_id"], label="Table arithmetic",
                                        status="mismatch" if tbl_fail else "warn" if tbl_warn else "pass",
                                        detail="; ".join(c.detail for c in (tbl_fail or tbl_warn or tc))[:500]))
            elif b["type"] in ("text", "title", "header", "footer", "list", "caption", "form_field", "signature", "stamp"):
                t = _flat_text(b)
                checks += checksum_checks(t) + date_checks(t)
                for m in re.finditer(r"(?i)\b(grand total|total due|amount due|balance due|total amount|total)\b\D{0,6}([^\n]{1,30})", t):
                    v = parse_number(re.sub(r"^[:\s]+", "", m.group(2)).split(" ")[0])
                    if v is not None:
                        text_totals.append((b["block_id"], v))
            elif b["type"] == "equation" and not b.get("verified"):
                checks.append(Check(name="equation_verification", status="warn", detail="the equation could not be verified - manual review recommended"))
            comp = block_components(b, checks)
            conf = combine(comp)
            ex = b.get("extra") or {}
            reasons = []
            if conf < config.get("bands.review", 0.6):
                reasons.append("confidence_below_review_band")
            if any(c.status == "fail" for c in checks):
                reasons.append("failed_check")
            if ex.get("escalated"):
                reasons.append("consensus_escalated")
            elif ex.get("needs_review"):
                reasons.append("consensus_needs_review")
            scores.append(BlockScore(block_id=b["block_id"], page_number=p["page_number"], type=b["type"], components=comp, confidence=conf, band=band(conf),
                                     needs_review=bool(reasons), review_reasons=reasons, checks=checks))
            page_bad += bool(reasons)
            bb = (b["location"] or {}).get("bbox")
            per_page.setdefault(p["page_number"], []).append((conf, util.area(bb) if bb else 1.0, b["type"]))
        per_page.setdefault(p["page_number"], per_page.get(p["page_number"], []))
    # cross-block: a stated total in text that matches no table total (only when a table total exists)
    if text_totals and table_totals:
        for bid, v in text_totals:
            if not any(_close(v, t) for t in table_totals):
                for s in scores:
                    if s.block_id == bid:
                        s.checks.append(Check(name="cross_block_total", status="warn", detail=f"stated total {v:.2f} matches no table total on the document - potential discrepancy, manual review recommended"))
                        s.components = block_components(next(x for p in doc["pages"] for x in p["blocks"] if x["block_id"] == bid), s.checks)
                        s.confidence = combine(s.components)
                        s.band = band(s.confidence)
                        if "failed_check" not in s.review_reasons and s.confidence < config.get("bands.review", 0.6):
                            s.review_reasons.append("confidence_below_review_band")
                        s.needs_review = bool(s.review_reasons)
                badges.append(Badge(scope="document", scope_id=doc["source_id"], label="Total cross-check", status="mismatch",
                                    detail="a total stated in the text matches no table total - potential discrepancy, manual review recommended"))
    elif text_totals or table_totals:
        pass
    page_scores = []
    for pn in sorted(per_page):
        bad = sum(1 for s in scores if s.page_number == pn and s.needs_review)
        page_scores.append(PageScore(page_number=pn, confidence=aggregate(per_page[pn]), blocks_needing_review=bad))
        pf = [s for s in scores if s.page_number == pn]
        failed = [c for s in pf for c in s.checks if c.status == "fail"]
        if pf:
            badges.append(Badge(scope="page", scope_id=f"{doc['source_id']}:p{pn}", label="Page checks", status="mismatch" if failed else "warn" if bad else "pass",
                                detail=f"{len(failed)} failed check(s), {bad} block(s) with manual review recommended"))
    if doc.get("status") == "partial":
        warns.append(warn("DOCUMENT_PARTIAL", "The assembled document is partial; scores cover the pages that exist"))
    return scores, page_scores, badges, warns, per_page


def run(req: ValidationInput, user: Optional[dict] = None) -> ValidationReport:
    user = user or auth.require("run_agents")
    t = Timer()
    dbg(AGENT, "start", source_id=req.source_id, page=req.page_number, user=user["user_id"])
    util.need_source(req.source_id)
    asm = _doc_loader()
    doc = asm.load_verified_document(req.source_id)
    dbg(AGENT, "document_loaded", pages=len(doc["pages"]), ms=t.ms())
    if req.page_number is not None and req.page_number not in [p["page_number"] for p in doc["pages"]]:
        raise ApiError("INVALID_INPUT", "page_number is not a page of this source", {"pages": len(doc["pages"])})
    scores, page_scores, badges, warns, per_page = validate(doc, req.page_number)
    allitems = [i for v in per_page.values() for i in v]
    dconf = aggregate(allitems)
    failed = sum(1 for s in scores for c in s.checks if c.status == "fail")
    review = sum(1 for s in scores if s.needs_review)
    badges.insert(0, Badge(scope="document", scope_id=req.source_id, label="Document checks", status="mismatch" if failed else "warn" if review else "pass",
                           detail=f"{failed} failed check(s); manual review recommended for {review} of {len(scores)} block(s); no final decision has been made"))
    sha = (store.get("document_hash", req.source_id) or {}).get("sha256", "")
    report = ValidationReport(source_id=req.source_id, document_sha256=sha, document_confidence=dconf, blocks=scores, pages=page_scores, badges=badges, warnings=warns, generated_at=now_iso())
    dbg(AGENT, "scored", blocks=len(scores), failed=failed, review=review, doc_conf=dconf, ms=t.ms())
    if req.page_number is None:   # a page-filtered call is a preview; only a full run is stored
        audit.append({"event_type": "confidence_validated", "object_type": "source", "object_id": req.source_id, "outcome": "success", "actor_id": user["user_id"], "actor_role": user["role"],
                      "tenant_id": user["tenant_id"], "details": {"blocks": len(scores), "failed_checks": failed, "needs_review": review, "document_confidence": dconf}})
        store.put("validation", req.source_id, report.model_dump(mode="json"))
    return report


@router.post("/agents/confidence-validation")
def confidence_endpoint(body: dict, request: Request):
    return handle(request, lambda: run(ValidationInput.model_validate(body)))
