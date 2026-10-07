"""Agent 08 - Spreadsheet  (POST /agents/spreadsheet).  Owner: Person A.

README
  Inputs : {source_id}   (sources of kind xlsx / csv / tsv)
  Outputs: {sheets:[{name, hidden, used_range, merged_ranges, probable_tables,
                     cells:[{ref, raw_value, displayed_value, formula?, number_format?, hidden?}]}], warnings[]}
  Algorithm:
    1 authorise, return cached result when present
    2 XLSX: openpyxl twice (data_only=False for formulas/formats, data_only=True for cached values).
      Normal mode keeps merged cells + hidden rows/columns; workbooks whose sheet XML exceeds
      settings spreadsheet.full_mode_max_xml_bytes use read_only streaming (merged/hidden info then unavailable -> warning)
    3 every non-empty cell is emitted row-major: raw_value = stored (or cached formula result), displayed_value =
      value rendered through a built-in Excel number-format engine (sections, conditions such as Indian grouping,
      currency/percent/scientific/fraction, dates incl. 1900/1904 epochs, [h]:mm elapsed, AM/PM, text sections)
    4 hidden sheets/rows/columns are kept with hidden:true; merged ranges are expanded (value repeated in covered
      cells, merged_ranges lists them so consumers can de-duplicate)
    5 probable_tables: Excel-defined tables + contiguous blocks separated by empty rows/columns whose first row
      looks like a header (all text, mostly unique) with >=1 data row
    6 CSV/TSV: delimiter/encoding sniffed (charset-normalizer + csv.Sniffer), one sheet named "csv", values kept as text
    7 cell cap /config.limits.max_cells_per_sheet: output truncated + CELLS_TRUNCATED warning with true counts
  Formulas are never recalculated; formulas without cached values -> FORMULA_NOT_CACHED warning.
  Libraries: openpyxl, charset-normalizer (optional).  Limits: unusual number formats fall back to General.
"""
from __future__ import annotations

import csv
import io
import math
import re
import time
import zipfile
from datetime import date, datetime, time as dtime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from typing import Any, Dict, List, Optional, Set, Tuple

from pydantic import BaseModel

from backend.agents._support import (AgentError, Code, S, Timer, WarningItem, audit_event, commit, current_user, dbg,
                                     endpoint, get_original_bytes, kind_of, limit, load_meta, store_get)

AGENT = "08-spreadsheet"


class SpreadsheetInput(BaseModel):
    source_id: str


class Cell(BaseModel):
    ref: str
    raw_value: Any = None
    displayed_value: str = ""
    formula: Optional[str] = None
    number_format: Optional[str] = None
    hidden: Optional[bool] = None


class Sheet(BaseModel):
    name: str
    hidden: bool = False
    used_range: Optional[str] = None
    merged_ranges: List[str] = []
    probable_tables: List[str] = []
    cells: List[Cell] = []


class SpreadsheetOutput(BaseModel):
    sheets: List[Sheet]
    warnings: List[WarningItem] = []


# =============================================================================== Excel number-format engine
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_COND = re.compile(r"^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$")
_COLOR = re.compile(r"^(black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+)$", re.I)
Token = Tuple[Any, ...]


def _split_sections(fmt: str) -> List[str]:
    out, cur, q, br, esc = [], [], False, False, False
    for ch in fmt:
        if esc:
            cur.append(ch)
            esc = False
        elif ch == "\\":
            cur.append(ch)
            esc = True
        elif ch == '"':
            cur.append(ch)
            q = not q
        elif ch == "[" and not q:
            cur.append(ch)
            br = True
        elif ch == "]" and not q:
            cur.append(ch)
            br = False
        elif ch == ";" and not q and not br:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return out


def _tokenize(sec: str) -> Tuple[List[Token], Optional[Tuple[str, float]]]:
    toks: List[Token] = []
    cond: Optional[Tuple[str, float]] = None
    i, n = 0, len(sec)
    while i < n:
        ch = sec[i]
        low = sec[i:i + 7].lower()
        if ch == '"':
            j = sec.find('"', i + 1)
            j = n if j < 0 else j
            toks.append(("lit", sec[i + 1:j]))
            i = j + 1
        elif ch == "\\" and i + 1 < n:
            toks.append(("lit", sec[i + 1]))
            i += 2
        elif ch == "_" and i + 1 < n:
            toks.append(("lit", " "))
            i += 2
        elif ch == "*" and i + 1 < n:
            i += 2
        elif ch == "[":
            j = sec.find("]", i)
            j = n - 1 if j < 0 else j
            body = sec[i + 1:j]
            m = _COND.match(body.strip())
            if body.startswith("$"):
                toks.append(("lit", body[1:].split("-")[0]))
            elif m:
                cond = (m.group(1), float(m.group(2)))
            elif _COLOR.match(body.strip()):
                pass
            elif re.fullmatch(r"[hHmMsS]+", body):
                toks.append(("elapsed", body[0].lower(), len(body)))
            i = j + 1
        elif low.startswith("am/pm") or low.startswith("a/p"):
            long = low.startswith("am/pm")
            toks.append(("ampm", "AM/PM" if long else "A/P"))
            i += 5 if long else 3
        elif low.startswith("general"):
            toks.append(("general",))
            i += 7
        elif ch in "Ee" and i + 1 < n and sec[i + 1] in "+-":
            toks.append(("exp", "E" + sec[i + 1]))
            i += 2
        elif ch.lower() in "ymdhs":
            j = i
            while j < n and sec[j].lower() == ch.lower():
                j += 1
            toks.append((ch.lower(), j - i))
            i = j
            if ch.lower() == "s" and i + 1 < n and sec[i] == "." and sec[i + 1] == "0":
                j = i + 1
                while j < n and sec[j] == "0":
                    j += 1
                toks.append(("subsec", j - i - 1))
                i = j
        elif ch in "0#?":
            toks.append(("ph", ch))
            i += 1
        elif ch == ".":
            toks.append(("dot",))
            i += 1
        elif ch == ",":
            toks.append(("comma",))
            i += 1
        elif ch == "%":
            toks.append(("pct",))
            i += 1
        elif ch == "/":
            toks.append(("slash",))
            i += 1
        elif ch == "@":
            toks.append(("at",))
            i += 1
        else:
            toks.append(("lit", ch))
            i += 1
    return toks, cond


def _is_date(toks: List[Token]) -> bool:
    return any(t[0] in ("y", "m", "d", "h", "s", "elapsed", "ampm") for t in toks) and not any(t[0] == "ph" for t in toks)


def _cond_ok(cond: Tuple[str, float], v: float) -> bool:
    op, x = cond
    return {"<": v < x, "<=": v <= x, ">": v > x, ">=": v >= x, "=": v == x, "<>": v != x}[op]


def _general(v: float) -> str:
    if isinstance(v, int) or (float(v).is_integer() and abs(v) < 1e11):
        return str(int(v))
    s = f"{v:.10g}"
    if "e" in s:
        mant, exp = s.split("e")
        s = f"{mant}E{exp[0]}{exp[1:].lstrip('0').rjust(2, '0')}"
    return s


def _group3(digits: str) -> str:
    lead = len(digits) - len(digits.lstrip(" "))
    core = digits.lstrip(" ")
    return " " * lead + re.sub(r"(?<=\d)(?=(\d{3})+$)", ",", core)


def _fmt_plain(value: float, toks: List[Token], auto_minus: bool) -> str:
    pct = sum(1 for t in toks if t[0] == "pct")
    dot = next((i for i, t in enumerate(toks) if t[0] == "dot"), None)
    int_t = toks if dot is None else toks[:dot]
    frac_t = [] if dot is None else toks[dot + 1:]
    ph_pos = [i for i, t in enumerate(int_t) if t[0] == "ph"]
    grouping, scale = False, 0
    if ph_pos:
        for i, t in enumerate(int_t):
            if t[0] == "comma":
                if ph_pos[0] < i < ph_pos[-1]:
                    grouping = True
                elif i > ph_pos[-1]:
                    scale += 1
    v = Decimal(repr(abs(float(value)))) * (Decimal(100) ** pct) / (Decimal(1000) ** scale)
    d = sum(1 for t in frac_t if t[0] == "ph")
    q = v.quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP)
    s = format(q, f".{d}f")
    ip, _, fp = s.partition(".")
    ds = ip.lstrip("0")
    # --- integer part
    assigned: List[str] = []
    rem = ds
    for i in reversed(ph_pos):
        ch = int_t[i][1]
        if rem:
            assigned.append(rem[-1])
            rem = rem[:-1]
        else:
            assigned.append({"0": "0", "#": "", "?": " "}[ch])
    assigned.reverse()
    if rem and assigned:
        assigned[0] = rem + assigned[0]
    elif rem:
        assigned = [rem]
    out: List[str] = []
    if grouping:
        D = _group3("".join(assigned))
        placed = False
        for i, t in enumerate(int_t):
            if t[0] == "ph":
                if not placed:
                    out.append(D)
                    placed = True
            elif t[0] == "lit" and (not ph_pos or i < ph_pos[0] or i > ph_pos[-1]):
                out.append(t[1])
            elif t[0] == "pct":
                out.append("%")
    else:
        k = 0
        started = False
        for i, t in enumerate(int_t):
            if t[0] == "ph":
                piece = assigned[k] if k < len(assigned) else ""
                k += 1
                if piece.strip():
                    started = True
                out.append(piece)
            elif t[0] == "lit":
                inside = bool(ph_pos) and ph_pos[0] < i < ph_pos[-1]
                if not inside or started:
                    out.append(t[1])
            elif t[0] == "pct":
                out.append("%")
        if not ph_pos and ds:
            out.insert(0, ds)
    # --- fractional part
    if dot is not None:
        out.append(".")
        digits = list(fp.ljust(d, "0"))
        ph_idx = [i for i, t in enumerate(frac_t) if t[0] == "ph"]
        keep: Dict[int, str] = {}
        trimming = True
        for pos in range(len(ph_idx) - 1, -1, -1):
            ch, dg = frac_t[ph_idx[pos]][1], digits[pos]
            if trimming and dg == "0" and ch in "#?":
                keep[pos] = "" if ch == "#" else " "
            else:
                trimming = False
                keep[pos] = dg
        k = 0
        for t in frac_t:
            if t[0] == "ph":
                out.append(keep[k])
                k += 1
            elif t[0] == "lit":
                out.append(t[1])
            elif t[0] == "pct":
                out.append("%")
    return ("-" if (auto_minus and value < 0) else "") + "".join(out)


def _fmt_sci(value: float, toks: List[Token], auto_minus: bool) -> str:
    e_idx = next(i for i, t in enumerate(toks) if t[0] == "exp")
    mant_t, exp_t = toks[:e_idx], toks[e_idx + 1:]
    dot = next((i for i, t in enumerate(mant_t) if t[0] == "dot"), None)
    int_ph = max(1, sum(1 for t in (mant_t if dot is None else mant_t[:dot]) if t[0] == "ph"))
    frac_ph = 0 if dot is None else sum(1 for t in mant_t[dot + 1:] if t[0] == "ph")
    exp_digits = max(1, sum(1 for t in exp_t if t[0] == "ph"))
    v = abs(float(value))
    e = 0 if v == 0 else math.floor(math.log10(v)) - (int_ph - 1)
    for _ in range(2):
        m = 0.0 if v == 0 else v / (10 ** e)
        ms = f"{m:.{frac_ph}f}"
        if float(ms) >= 10 ** int_ph:
            e += 1
            continue
        break
    sign = ("+" if e >= 0 else "-") if toks[e_idx][1] == "E+" else ("" if e >= 0 else "-")
    return ("-" if (auto_minus and value < 0) else "") + ms + "E" + sign + f"{abs(e):0{exp_digits}d}"


def _fmt_fraction(value: float, toks: List[Token], auto_minus: bool) -> Optional[str]:
    s_idx = next(i for i, t in enumerate(toks) if t[0] == "slash")
    after = toks[s_idx + 1:]
    den_ph = 0
    for t in after:
        if t[0] == "ph":
            den_ph += 1
        else:
            break
    fixed = None
    if den_ph == 0:
        digs = ""
        for t in after:
            if t[0] == "lit" and t[1].isdigit():
                digs += t[1]
            else:
                break
        fixed = int(digs) if digs else None
        if fixed is None:
            return None
    num_start = s_idx
    while num_start > 0 and toks[num_start - 1][0] == "ph":
        num_start -= 1
    whole_present = any(t[0] == "ph" for t in toks[:num_start])
    val = abs(float(value))
    whole = int(val) if whole_present else 0
    fr = Fraction(val - whole).limit_denominator(fixed if fixed else 10 ** den_ph - 1)
    n, dnm = fr.numerator, fr.denominator
    if n >= dnm and whole_present:
        whole, n = whole + 1, 0
    if whole_present:
        text = (str(whole) if (whole or n == 0) else "") + (f" {n}/{dnm}" if n else "")
    else:
        text = f"{n}/{dnm}"
    return ("-" if (auto_minus and value < 0) else "") + text.strip()


def _serial_to_dt(serial: float, epoch: int, subsec: bool) -> datetime:
    total_ms = round(serial * 86_400_000)
    if not subsec:
        total_ms = int(round(total_ms / 1000.0)) * 1000
    days, rem = divmod(total_ms, 86_400_000)
    base = datetime(1904, 1, 1) if epoch == 1904 else (datetime(1899, 12, 30) if serial >= 61 else datetime(1899, 12, 31))
    return base + timedelta(days=days, milliseconds=rem)


def _to_serial(value: Any, epoch: int) -> Optional[float]:
    if isinstance(value, datetime):
        base = datetime(1904, 1, 1) if epoch == 1904 else datetime(1899, 12, 30)
        v = value.replace(tzinfo=None) if value.tzinfo else value
        s = (v - base).total_seconds() / 86400.0
        return s if epoch == 1904 or s >= 61 else s + 1
    if isinstance(value, date):
        return _to_serial(datetime(value.year, value.month, value.day), epoch)
    if isinstance(value, dtime):
        return (value.hour * 3600 + value.minute * 60 + value.second + value.microsecond / 1e6) / 86400.0
    if isinstance(value, timedelta):
        return value.total_seconds() / 86400.0
    return None


def _fmt_date(serial: float, toks: List[Token], epoch: int) -> Optional[str]:
    if serial < 0:
        return None
    has_sub = any(t[0] == "subsec" for t in toks)
    dt = _serial_to_dt(serial, epoch, has_sub)
    total_s = serial * 86400.0
    ampm = any(t[0] == "ampm" for t in toks)
    sig = [i for i, t in enumerate(toks) if t[0] != "lit"]
    minute_idx: Set[int] = set()
    for pos, i in enumerate(sig):
        if toks[i][0] == "m" and toks[i][1] <= 2:
            prev = toks[sig[pos - 1]] if pos > 0 else None
            nxt = toks[sig[pos + 1]] if pos + 1 < len(sig) else None
            if (prev and (prev[0] == "h" or (prev[0] == "elapsed" and prev[1] == "h"))) or (nxt and nxt[0] in ("s",)):
                minute_idx.add(i)
    out: List[str] = []
    for i, t in enumerate(toks):
        k = t[0]
        if k == "lit":
            out.append(t[1])
        elif k in ("slash", "comma", "dot", "pct"):
            out.append({"slash": "/", "comma": ",", "dot": ".", "pct": "%"}[k])
        elif k == "y":
            out.append(f"{dt.year % 100:02d}" if t[1] <= 2 else f"{dt.year:04d}")
        elif k == "m":
            if i in minute_idx:
                out.append(f"{dt.minute:0{t[1]}d}")
            elif t[1] <= 2:
                out.append(f"{dt.month:0{t[1]}d}")
            elif t[1] == 3:
                out.append(MONTHS[dt.month - 1][:3])
            elif t[1] == 4:
                out.append(MONTHS[dt.month - 1])
            else:
                out.append(MONTHS[dt.month - 1][0])
        elif k == "d":
            out.append(f"{dt.day:0{t[1]}d}" if t[1] <= 2 else (DAYS[dt.weekday()][:3] if t[1] == 3 else DAYS[dt.weekday()]))
        elif k == "h":
            h = (dt.hour % 12 or 12) if ampm else dt.hour
            out.append(f"{h:0{t[1]}d}")
        elif k == "s":
            out.append(f"{dt.second:0{t[1]}d}")
        elif k == "subsec":
            out.append("." + f"{dt.microsecond // 1000:03d}"[: t[1]].ljust(t[1], "0"))
        elif k == "ampm":
            am = dt.hour < 12
            out.append(("AM" if am else "PM") if t[1] == "AM/PM" else ("A" if am else "P"))
        elif k == "elapsed":
            unit = {"h": 3600, "m": 60, "s": 1}[t[1]]
            out.append(f"{int(total_s // unit):0{t[2]}d}")
    return "".join(out)


def format_value(value: Any, fmt: Optional[str], epoch: int = 1900) -> str:
    """Render `value` the way Excel would display it for number format `fmt`."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    fmt = (fmt or "General").strip() or "General"
    try:
        secs = [_tokenize(s) for s in _split_sections(fmt)]
        n = len(secs)
        if isinstance(value, str):
            tsec = secs[3] if n >= 4 else next((s for s in secs if any(t[0] == "at" for t in s[0])), None)
            if tsec is None:
                return value
            return "".join(value if t[0] == "at" else (t[1] if t[0] == "lit" else "") for t in tsec[0])
        serial = _to_serial(value, epoch)
        num = serial if serial is not None else float(value)
        idx = None
        for i, (toks, cond) in enumerate(secs[:3]):
            if cond is not None:
                ok = _cond_ok(cond, num)
            elif n == 1:
                ok = True
            elif n == 2:
                ok = num >= 0 if i == 0 else True
            else:
                ok = (num > 0) if i == 0 else ((num < 0) if i == 1 else True)
            if ok:
                idx = i
                break
        if idx is None:
            idx = min(n, 3) - 1
        toks, cond = secs[idx]
        default_negative_section = n >= 2 and idx == 1 and cond is None
        auto_minus = not default_negative_section
        if _is_date(toks):
            s = _fmt_date(abs(num) if serial is None else serial, toks, epoch)
            return s if s is not None else _general(num)
        if serial is not None:  # date/time value with a non-date format
            return _general(num)
        if any(t[0] == "general" for t in toks):
            body = _general(abs(num) if default_negative_section else num)
            return "".join(body if t[0] == "general" else (t[1] if t[0] == "lit" else "") for t in toks)
        if any(t[0] == "exp" for t in toks):
            return _fmt_sci(num, toks, auto_minus)
        if any(t[0] == "slash" for t in toks) and any(t[0] == "ph" for t in toks):
            r = _fmt_fraction(num, toks, auto_minus)
            return r if r is not None else _general(num)
        if not any(t[0] == "ph" for t in toks):
            return "".join(t[1] for t in toks if t[0] == "lit") or _general(num)
        return _fmt_plain(num, toks, auto_minus)
    except Exception:
        return _general(value) if isinstance(value, (int, float)) else str(value)


# =============================================================================== helpers
def _raw(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    if isinstance(v, (datetime, date, dtime)):
        return v.isoformat()
    if isinstance(v, timedelta):
        return str(v)
    if isinstance(v, Decimal):
        return str(v)
    if hasattr(v, "text"):
        return v.text
    return str(v)


def _kind(v: Any) -> str:
    if isinstance(v, str):
        s = v.strip().replace(",", "")
        try:
            float(s)
            return "n"
        except ValueError:
            return "s"
    return "n" if isinstance(v, (int, float, datetime, date, dtime, timedelta)) and not isinstance(v, bool) else "o"


def probable_tables(grid: Dict[Tuple[int, int], str]) -> List[str]:
    """grid maps (row, col) -> kind in {'s','n','o'}.  Returns A1 ranges."""
    from openpyxl.utils import get_column_letter as L
    if not grid:
        return []
    min_rows, min_cols = int(S("spreadsheet.table_min_rows")), int(S("spreadsheet.table_min_cols"))
    rows = sorted({r for r, _ in grid})
    bands: List[List[int]] = []
    for r in rows:
        if bands and r == bands[-1][-1] + 1:
            bands[-1].append(r)
        else:
            bands.append([r])
    found: List[str] = []
    for band in bands:
        rs = set(band)
        cols = sorted({c for (r, c) in grid if r in rs})
        groups: List[List[int]] = []
        for c in cols:
            if groups and c == groups[-1][-1] + 1:
                groups[-1].append(c)
            else:
                groups.append([c])
        for g in groups:
            cs = set(g)
            cells = {(r, c): k for (r, c), k in grid.items() if r in rs and c in cs}
            if not cells:
                continue
            r1, r2 = min(r for r, _ in cells), max(r for r, _ in cells)
            c1, c2 = min(c for _, c in cells), max(c for _, c in cells)
            if (r2 - r1 + 1) < min_rows or (c2 - c1 + 1) < min_cols:
                continue
            header = [(c, k) for (r, c), k in cells.items() if r == r1]
            if len(header) < 2 or any(k != "s" for _, k in header):
                continue
            if sum(1 for (r, _) in cells if r > r1) < 1:
                continue
            found.append(f"{L(c1)}{r1}:{L(c2)}{r2}")
    return found


# =============================================================================== XLSX
def _xml_bytes(data: bytes) -> int:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            return sum(i.file_size for i in z.infolist() if i.filename.startswith("xl/worksheets/"))
    except Exception:
        return 0


def _sheet_full(ws_f: Any, ws_v: Any, epoch: int, cap: int, deadline: float, warnings: List[WarningItem]) -> Sheet:
    from openpyxl.utils import get_column_letter as L
    hidden_rows = {r for r, d in ws_f.row_dimensions.items() if d.hidden}
    hidden_cols: Set[int] = set()
    maxc = ws_f.max_column or 1
    for _, d in ws_f.column_dimensions.items():
        if d.hidden and d.min:
            hidden_cols.update(range(d.min, min(d.max or d.min, maxc) + 1))
    cells: Dict[Tuple[int, int], Cell] = {}
    kinds: Dict[Tuple[int, int], str] = {}
    total = 0
    uncached = 0
    r_min = c_min = 10 ** 9
    r_max = c_max = 0
    timed_out = False

    def make(cell: Any, r: int, c: int, value: Any, formula: Optional[str], fmt: str) -> Cell:
        disp = format_value(value, fmt, epoch) if value is not None else ""
        is_h = (r in hidden_rows) or (c in hidden_cols)
        return Cell(ref=f"{L(c)}{r}", raw_value=_raw(value), displayed_value=disp, formula=formula,
                    number_format=None if fmt in (None, "General") else fmt, hidden=True if is_h else None)

    for row in ws_f.iter_rows():
        if time.time() > deadline:
            timed_out = True
            break
        for cell in row:
            v = cell.value
            if v is None:
                continue
            r, c = cell.row, cell.column
            total += 1
            r_min, r_max, c_min, c_max = min(r_min, r), max(r_max, r), min(c_min, c), max(c_max, c)
            formula = None
            fmt = cell.number_format
            if cell.data_type == "f":
                formula = v if isinstance(v, str) else getattr(v, "text", str(v))
                if formula and not formula.startswith("="):
                    formula = "=" + formula
                v = ws_v.cell(row=r, column=c).value
                if v is None:
                    uncached += 1
            if total <= cap:
                cells[(r, c)] = make(cell, r, c, v, formula, fmt)
                kinds[(r, c)] = _kind(v)
    merged = sorted(str(m) for m in ws_f.merged_cells.ranges)
    for m in ws_f.merged_cells.ranges:  # expand merged ranges
        tl = cells.get((m.min_row, m.min_col))
        if tl is None:
            continue
        for r in range(m.min_row, m.max_row + 1):
            for c in range(m.min_col, m.max_col + 1):
                if (r, c) in cells:
                    continue
                total += 1
                r_min, r_max, c_min, c_max = min(r_min, r), max(r_max, r), min(c_min, c), max(c_max, c)
                if len(cells) < cap:
                    cells[(r, c)] = Cell(ref=f"{L(c)}{r}", raw_value=tl.raw_value, displayed_value=tl.displayed_value,
                                         number_format=tl.number_format,
                                         hidden=True if (r in hidden_rows or c in hidden_cols) else None)
                    kinds[(r, c)] = kinds.get((m.min_row, m.min_col), "o")
    tables = probable_tables(kinds)
    try:
        for _, tb in ws_f.tables.items():
            ref = tb.ref if hasattr(tb, "ref") else str(tb)
            if ref and ref not in tables:
                tables.append(ref)
    except Exception:
        pass
    if total > len(cells):
        warnings.append(WarningItem(code="CELLS_TRUNCATED", message="Cell output truncated at the configured cap",
                                    details={"sheet": ws_f.title, "returned": len(cells), "total": total}))
    if uncached:
        warnings.append(WarningItem(code="FORMULA_NOT_CACHED", message="Formulas without cached values (open and save in Excel to compute)",
                                    details={"sheet": ws_f.title, "count": uncached}))
    if timed_out:
        warnings.append(WarningItem(code="SCAN_TIMEOUT", message="Sheet scan stopped at the time budget; counts are lower bounds",
                                    details={"sheet": ws_f.title}))
    used = f"{L(c_min)}{r_min}:{L(c_max)}{r_max}" if r_max else None
    return Sheet(name=ws_f.title, hidden=ws_f.sheet_state != "visible", used_range=used, merged_ranges=merged,
                 probable_tables=sorted(set(tables)), cells=[cells[k] for k in sorted(cells)])


def _sheet_stream(ws_f: Any, ws_v: Any, epoch: int, cap: int, deadline: float, warnings: List[WarningItem]) -> Sheet:
    from openpyxl.utils import get_column_letter as L
    try:
        ws_f.reset_dimensions()
        ws_v.reset_dimensions()
    except Exception:
        pass
    cells: List[Cell] = []
    kinds: Dict[Tuple[int, int], str] = {}
    total = uncached = 0
    r_min = c_min = 10 ** 9
    r_max = c_max = 0
    timed_out = False
    for r, (row_f, row_v) in enumerate(zip(ws_f.iter_rows(min_row=1, min_col=1), ws_v.iter_rows(min_row=1, min_col=1)), start=1):
        if time.time() > deadline:
            timed_out = True
            break
        for c, (cf, cv) in enumerate(zip(row_f, row_v), start=1):
            v = getattr(cf, "value", None)
            if v is None:
                continue
            total += 1
            r_min, r_max, c_min, c_max = min(r_min, r), max(r_max, r), min(c_min, c), max(c_max, c)
            formula = None
            fmt = getattr(cf, "number_format", "General")
            if getattr(cf, "data_type", "") == "f":
                formula = v if isinstance(v, str) else getattr(v, "text", str(v))
                v = getattr(cv, "value", None)
                if v is None:
                    uncached += 1
            if total <= cap:
                cells.append(Cell(ref=f"{L(c)}{r}", raw_value=_raw(v), displayed_value=format_value(v, fmt, epoch) if v is not None else "",
                                  formula=formula, number_format=None if fmt in (None, "General") else fmt))
                kinds[(r, c)] = _kind(v)
    warnings.append(WarningItem(code="STREAMING_MODE", message="Large workbook read in streaming mode; merged ranges and hidden rows/columns are unavailable",
                                details={"sheet": ws_f.title}))
    if total > len(cells):
        warnings.append(WarningItem(code="CELLS_TRUNCATED", message="Cell output truncated at the configured cap",
                                    details={"sheet": ws_f.title, "returned": len(cells), "total": total}))
    if uncached:
        warnings.append(WarningItem(code="FORMULA_NOT_CACHED", message="Formulas without cached values",
                                    details={"sheet": ws_f.title, "count": uncached}))
    if timed_out:
        warnings.append(WarningItem(code="SCAN_TIMEOUT", message="Sheet scan stopped at the time budget; counts are lower bounds",
                                    details={"sheet": ws_f.title}))
    used = f"{L(c_min)}{r_min}:{L(c_max)}{r_max}" if r_max else None
    return Sheet(name=ws_f.title, hidden=ws_f.sheet_state != "visible", used_range=used, merged_ranges=[],
                 probable_tables=probable_tables(kinds), cells=cells)


def _extract_xlsx(data: bytes, cap: int, warnings: List[WarningItem]) -> List[Sheet]:
    import openpyxl
    stream = _xml_bytes(data) > int(S("spreadsheet.full_mode_max_xml_bytes"))
    dbg(AGENT, "step2-load", f"mode={'stream' if stream else 'full'} (loading workbook twice: formulas + cached values)")
    try:
        wb_f = openpyxl.load_workbook(io.BytesIO(data), data_only=False, read_only=stream, keep_links=False)
        wb_v = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=stream, keep_links=False)
    except Exception as exc:
        raise AgentError(Code.CORRUPT_FILE, "Workbook could not be read") from exc
    epoch = 1904 if getattr(wb_f.epoch, "year", 1900) == 1904 else 1900
    deadline = time.time() + float(S("spreadsheet.timeout_s"))
    sheets: List[Sheet] = []
    try:
        for ws_f in wb_f.worksheets:
            ws_v = wb_v[ws_f.title]
            sh = (_sheet_stream if stream else _sheet_full)(ws_f, ws_v, epoch, cap, deadline, warnings)
            dbg(AGENT, "step3-sheet", f"'{ws_f.title[:20]}' hidden={sh.hidden} cells={len(sh.cells)} merged={len(sh.merged_ranges)} tables={len(sh.probable_tables)}")
            sheets.append(sh)
    finally:
        wb_f.close()
        wb_v.close()
    return sheets


# =============================================================================== CSV / TSV
def _decode_csv(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        import charset_normalizer
        best = charset_normalizer.from_bytes(data[:262144]).best()
        if best is not None and best.encoding:
            return data.decode(best.encoding, errors="replace")
    except Exception:
        pass
    return data.decode("cp1252", errors="replace")


def _extract_csv(data: bytes, mime: str, cap: int, warnings: List[WarningItem]) -> List[Sheet]:
    from openpyxl.utils import get_column_letter as L
    text = _decode_csv(data).replace("\x00", "")
    sample = text[:65536]
    delim = "\t" if mime == "text/tab-separated-values" else None
    if delim is None:
        try:
            delim = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            counts = {d: sample.count(d) for d in ",;\t|"}
            delim = max(counts, key=counts.get) if max(counts.values()) else ","
    dbg(AGENT, "step2-csv", f"delimiter={'TAB' if delim == chr(9) else delim} chars={len(text)}")
    csv.field_size_limit(10_000_000)
    cells: List[Cell] = []
    kinds: Dict[Tuple[int, int], str] = {}
    total = 0
    r_max = c_max = 0
    r_min = c_min = 10 ** 9
    try:
        for r, row in enumerate(csv.reader(io.StringIO(text, newline=""), delimiter=delim), start=1):
            for c, v in enumerate(row, start=1):
                if v == "":
                    continue
                total += 1
                r_min, r_max, c_min, c_max = min(r_min, r), max(r_max, r), min(c_min, c), max(c_max, c)
                if total <= cap:
                    cells.append(Cell(ref=f"{L(c)}{r}", raw_value=v, displayed_value=v))
                    kinds[(r, c)] = _kind(v)
    except csv.Error as exc:
        raise AgentError(Code.CORRUPT_FILE, "Delimited file could not be parsed") from exc
    if total > len(cells):
        warnings.append(WarningItem(code="CELLS_TRUNCATED", message="Cell output truncated at the configured cap",
                                    details={"sheet": "csv", "returned": len(cells), "total": total}))
    used = f"{L(c_min)}{r_min}:{L(c_max)}{r_max}" if r_max else None
    return [Sheet(name="csv", hidden=False, used_range=used, merged_ranges=[], probable_tables=probable_tables(kinds), cells=cells)]


# =============================================================================== main
def run(inp: SpreadsheetInput) -> SpreadsheetOutput:
    timer = Timer()
    user = current_user()
    sid = inp.source_id
    meta = load_meta(sid, user)
    kind = kind_of(meta["detected_mime"])
    dbg(AGENT, "step1-load", f"source={sid[:8]} kind={kind}")
    if kind not in ("xlsx", "csv"):
        raise AgentError(Code.UNSUPPORTED_FORMAT, "This agent handles XLSX, CSV and TSV sources only")
    cached = store_get("spreadsheet", sid)
    if isinstance(cached, dict) and "sheets" in cached:
        audit_event("spreadsheet_run", "source", sid, details={"cached": True}, user=user, fail_closed=True)
        dbg(AGENT, "done", "served from cache")
        return SpreadsheetOutput(**cached)
    cap = limit(("max_cells_per_sheet", "maxCellsPerSheet"), "max_cells_per_sheet")
    warnings: List[WarningItem] = []
    data = get_original_bytes(sid)
    sheets = _extract_xlsx(data, cap, warnings) if kind == "xlsx" else _extract_csv(data, meta["detected_mime"], cap, warnings)
    out = SpreadsheetOutput(sheets=sheets, warnings=warnings)
    n_cells = sum(len(s.cells) for s in sheets)
    dbg(AGENT, "step7-persist", f"sheets={len(sheets)} cells={n_cells} warnings={len(warnings)}")
    commit([("spreadsheet", sid, out.model_dump(mode="json"))],
           dict(event_type="spreadsheet_run", object_type="source", object_id=sid,
                details={"sheets": len(sheets), "cells": n_cells, "warnings": len(warnings), "cached": False,
                         "duration_ms": timer.ms()}), user)
    dbg(AGENT, "done", f"ms={timer.ms()}")
    return out


try:
    from fastapi import APIRouter, Body, Request
except ImportError:  # fastapi not installed
    APIRouter = None


def build_router():
    r = APIRouter()

    @r.post("/agents/spreadsheet")
    def spreadsheet(request: Request, payload: dict = Body(...)):
        return endpoint(request, lambda: run(SpreadsheetInput.model_validate(payload)))

    return r


router = build_router() if APIRouter is not None else None
