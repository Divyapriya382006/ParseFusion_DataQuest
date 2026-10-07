"""
Agent 14: Case Linker (deterministic, NO LLM).  Owner: Person D.

Suggests (or records) links between sources and a case. Suggestions are NEVER
auto-confirmed. Every link traces to an anchor source and to signals that were
recomputed from stored document content. Nothing is invented.

CONFIDENCE FORMULA (suggest mode)
    confidence = clamp( sum_i( w_i * s_i ), 0, 1 )   over signals that fired
    w_i  : weights from config["case_linker"]["weights"] (sum to 1.0)
    s_i  : signal strength in [0,1]
           shared_reference    1.0 on an exact match of a normalized identifier
           shared_entity       fuzzy ratio (>= entity_threshold)
           address             Jaccard of address-line tokens (>= 0.8)
           date_proximity      1 - days_apart / date_window_days
           same_sender_domain  1.0 (free-mail domains ignored)
           text_similarity     cosine of char-3gram vectors (>= similarity_min)
    A suggestion is created only if confidence >= min_confidence.
    Explicit mode: confidence 1.0, signals ["user_assigned"], human_verified=True.

SECURITY LAYERS
    1. Strict input validation (ids, sizes, extra="forbid").
    2. Prompt-injection scan of untrusted document text (NFKC + zero-width
       stripping first). A flagged source cannot use text-derived signals and
       its confidence is capped; a visible flag signal is added.
    3. Sensitive-data detection (Aadhaar, PAN, IBAN, SSN, Luhn cards, email,
       phone). Identifiers are compared as SHA-256 fingerprints and displayed
       masked. Audit details are recursively redacted.
    4. Locked/masked blocks are never read.
    5. Capability check, tenant scoping via store, audit on success AND
       failure, fail-closed rollback if audit.append fails.
    6. Anchors are only case sources and human-verified links, so
       unconfirmed suggestions cannot chain into new ones.

NOTE: layers 2 and 3 move to common/llm_guard.security once that ships;
agents 15/16/17 will import the same detectors.
"""
from __future__ import annotations

import copy
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from math import sqrt
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator
from rapidfuzz import fuzz

from backend.common import audit, auth, config, crypto, store
from backend.common.errors import AgentError, ErrorCode

# ---- contract-dependent names (single place to change) -----------------------
KIND_SOURCE = "source"
KIND_SOURCE_DOC = "source_document"      # SourceDocument produced by agent 11
KIND_CASE = "case"
KIND_LINK = "case_link"
KIND_CASE_INDEX = "case_link_index"
KIND_SRC_CASES = "source_case_index"
CAPABILITY = "case.link"
SYSTEM_ACTOR = "agent:case-linker"
RELATIONSHIP_TYPES = ("same_party", "supporting_document", "supersedes", "unknown")
# "supersedes" is never auto-suggested: it is only a human judgement.

DEFAULTS = {
    "weights": {"shared_reference": 0.50, "shared_entity": 0.20, "address": 0.05,
                "date_proximity": 0.05, "same_sender_domain": 0.10, "text_similarity": 0.10},
    "min_confidence": 0.35, "entity_threshold": 92, "date_window_days": 30,
    "similarity_min": 0.60, "injection_conf_cap": 0.50,
    "max_sources": 200, "max_case_sources": 500, "max_chars": 200_000,
    "free_mail_domains": ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me"],
}


def _cfg() -> dict:
    user_cfg = config.get("case_linker") or {}
    cfg = {**DEFAULTS, **{k: v for k, v in user_cfg.items() if k != "weights"}}
    cfg["weights"] = {**DEFAULTS["weights"], **(user_cfg.get("weights") or {})}
    return cfg


# ---- models -------------------------------------------------------------------
_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LinkerInput(_Strict):
    case_id: str
    source_ids: list[str] = Field(min_length=1)
    mode: Literal["explicit", "suggest"]

    @field_validator("case_id")
    @classmethod
    def _case(cls, v: str) -> str:
        if not _ID_RE.match(v):
            raise ValueError("invalid case_id")
        return v

    @field_validator("source_ids")
    @classmethod
    def _sources(cls, v: list[str]) -> list[str]:
        if any(not _ID_RE.match(s) for s in v):
            raise ValueError("invalid source_id")
        return sorted(set(v))


class Link(_Strict):
    link_id: str
    case_id: str
    source_id: str
    relationship_type: str
    relationship_confidence: float = Field(ge=0, le=1)
    matching_signals: list[str]
    linked_by: str
    linked_at: str
    human_verified: bool


class LinkerOutput(_Strict):
    links: list[Link]


class DecisionInput(_Strict):
    link_id: str
    decision: Literal["confirm", "reject"]

    @field_validator("link_id")
    @classmethod
    def _lid(cls, v: str) -> str:
        if not _ID_RE.match(v):
            raise ValueError("invalid link_id")
        return v


class DecisionOutput(_Strict):
    link_id: str
    human_verified: bool


# ---- security: normalization, injection, sensitive data -----------------------
_ZW = re.compile("[\u200b-\u200f\u202a-\u202e\u2060\ufeff]")


def _norm(s: str) -> str:
    return _ZW.sub("", unicodedata.normalize("NFKC", s))


_INJECTION = [re.compile(p, re.I) for p in (
    r"ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts?|rules)",
    r"disregard (the )?(system|previous|above|prior)",
    r"\byou are now\b", r"\bsystem prompt\b", r"act as (an? )?(admin|system|developer|root)",
    r"</?\s*(system|assistant|instructions?)\s*>", r"\bjailbreak\b",
    r"reveal (your|the) (prompt|instructions|secrets?|keys?)",
    r"override (the )?(policy|rules|security|guard)",
    r"(auto[- ]?)?(confirm|approve|verify) (this|the) link",
)]


def detect_injection(text: str) -> bool:
    t = _norm(text)
    if len(text) - len(t) > 20:          # heavy zero-width obfuscation is itself a signal
        return True
    return any(p.search(t) for p in _INJECTION)


_SENSITIVE = {
    "aadhaar": re.compile(r"(?<![\w])\d{4}\s?\d{4}\s?\d{4}(?![\w])"),
    "pan": re.compile(r"(?<![\w])[A-Z]{5}\d{4}[A-Z](?![\w])"),
    "iban": re.compile(r"(?<![\w])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![\w])"),
    "ssn": re.compile(r"(?<![\w])\d{3}-\d{2}-\d{4}(?![\w])"),
    "card": re.compile(r"(?<![\w])(?:\d[ -]?){13,19}(?![\w])"),
    "email": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "phone": re.compile(r"(?<![\w])\+?\d[\d\s-]{8,14}\d(?![\w])"),
}


def _luhn(digits: str) -> bool:
    d = [int(c) for c in digits][::-1]
    return sum(d[0::2]) + sum(sum(divmod(x * 2, 10)) for x in d[1::2]) % 10 == 0 if d else False


def classify_sensitive(value: str) -> str | None:
    for kind, rx in _SENSITIVE.items():
        for m in rx.finditer(value):
            if kind == "card":
                digits = re.sub(r"\D", "", m.group())
                if not (13 <= len(digits) <= 19 and _luhn(digits)):
                    continue
            return kind
    return None


def mask(value: str) -> str:
    if "@" in value:
        local, dom = value.split("@", 1)
        return f"{local[:1]}***@{dom}"
    c = re.sub(r"\s", "", value)
    return "*" * len(c) if len(c) <= 4 else "*" * (len(c) - 4) + c[-4:]


def _redact(obj):
    if isinstance(obj, str):
        return mask(obj) if classify_sensitive(obj) else obj[:200]
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    if isinstance(obj, (list, tuple)):
        return [_redact(x) for x in list(obj)[:100]]
    if isinstance(obj, dict):
        return {str(k)[:64]: _redact(v) for k, v in obj.items()}
    return type(obj).__name__


# ---- feature extraction (from SourceDocument; deterministic) ------------------
_REF_LABEL = re.compile(
    r"(?i)\b(?:invoice|inv|ref(?:erence)?|account|a/c|acct|policy|claim|case|order|po|customer|employee|id)\b"
    r"\s*(?:no\.?|number|num|#)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]{4,30})")
_ORG = re.compile(r"\b((?:[A-Z][A-Za-z0-9&'.-]*\s+){1,4}(?:Ltd|Limited|LLC|LLP|Inc|Corp|Corporation|Pvt|Private|GmbH|Co|Company|Bank|Traders|Industries|Enterprises|Services))\b")
_LABELED = re.compile(r"(?im)^\s*(?:name|customer|client|applicant|employee|payee|payer|insured|borrower|account holder|bill(?:ed)? to|sold to|vendor|supplier)\s*[:\-]\s*([^\n,]{3,80})")
_ADDR_KW = re.compile(r"(?i)\b(road|rd|street|st|avenue|ave|lane|nagar|colony|sector|block|floor|apartment|apt|flat)\b|\b\d{6}\b")
_SUFFIX = {"ltd", "limited", "pvt", "private", "llc", "llp", "inc", "corp", "corporation", "co", "company", "gmbh"}
_MONTHS = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
_D_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_D_TXT = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b")
_D_NUM = re.compile(r"\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b")


@dataclass
class Features:
    source_id: str
    refs: dict[str, str] = field(default_factory=dict)       # sha256 -> masked display
    entities: dict[str, str] = field(default_factory=dict)   # normalized -> display
    dates: set[date] = field(default_factory=set)
    addr_lines: list[frozenset] = field(default_factory=list)
    domain: str | None = None
    grams: Counter = field(default_factory=Counter)
    injection: bool = False
    truncated: bool = False


def _blocks(doc: dict):
    if isinstance(doc.get("blocks"), list):
        yield from doc["blocks"]
    for p in doc.get("pages") or []:
        yield from (p.get("blocks") or [])


def _block_text(b: dict) -> str:
    if b.get("locked") or b.get("masked"):        # never read locked/masked data
        return ""
    parts = [b["text"]] if isinstance(b.get("text"), str) else []
    parts += [c["raw_text"] for c in (b.get("cells") or []) if isinstance(c.get("raw_text"), str)]
    return "\n".join(parts)


def _mk_date(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d) if 1990 <= y <= 2100 else None
    except ValueError:
        return None


def _norm_entity(s: str) -> str:
    s = re.sub(r"[^\w\s&]", " ", _norm(s).casefold())
    return " ".join(t for t in s.split() if t not in _SUFFIX)


def _extract_dates(text: str) -> set[date]:
    out: set[date] = set()
    for y, m, d in _D_ISO.findall(text):
        out.add(_mk_date(int(y), int(m), int(d)))
    for d, mon, y in _D_TXT.findall(text):
        mm = _MONTHS.get(mon[:3].lower())
        if mm:
            out.add(_mk_date(int(y), mm, int(d)))
    for a, b, y in _D_NUM.findall(text):
        a, b = int(a), int(b)
        if a > 12 >= b:
            out.add(_mk_date(int(y), b, a))
        elif b > 12 >= a or a == b:
            out.add(_mk_date(int(y), a, b))
        # else: dd/mm vs mm/dd is ambiguous -> abstain, never guess
    out.discard(None)
    return out


def _domain(doc: dict, free: set[str]) -> str | None:
    origin = doc.get("origin") or {}
    sender = origin.get("sender") or (doc.get("metadata") or {}).get("from")
    dom = None
    if isinstance(sender, str) and "@" in sender:
        dom = sender.rsplit("@", 1)[1].strip(" >").lower()
    elif isinstance(origin.get("url"), str):
        dom = (urlparse(origin["url"]).hostname or "").lower() or None
    return None if dom in free else dom


def extract_features(source_id: str, doc: dict, cfg: dict) -> Features:
    f = Features(source_id)
    buf, total = [], 0
    for b in _blocks(doc):
        t = _block_text(b)
        if not t:
            continue
        if total + len(t) > cfg["max_chars"]:
            f.truncated = True
            break
        buf.append(t)
        total += len(t)
    raw = "\n".join(buf)
    f.injection = detect_injection(raw)
    text = _norm(raw)

    for m in _REF_LABEL.finditer(text):
        v = re.sub(r"[\s\-/]", "", m.group(1)).upper()
        if sum(c.isdigit() for c in v) >= 3:
            f.refs.setdefault(crypto.sha256_hex(v.encode()), mask(v))
    for kind in ("pan", "iban"):
        for m in _SENSITIVE[kind].finditer(text):
            v = m.group()
            f.refs.setdefault(crypto.sha256_hex(v.encode()), mask(v))

    ents = {_norm_entity(m) : m.strip() for m in _ORG.findall(text)}
    ents.update({_norm_entity(m): m.strip() for m in _LABELED.findall(text)})
    for k in sorted(ents)[:50]:
        if len(k) >= 4 and any(c.isalpha() for c in k):
            f.entities[k] = ents[k]

    f.dates = _extract_dates(text)
    for line in text.splitlines()[:2000]:
        if len(f.addr_lines) >= 30:
            break
        if _ADDR_KW.search(line):
            toks = frozenset(w for w in re.findall(r"[a-z0-9]+", line.casefold()) if len(w) >= 3 or w.isdigit())
            if len(toks) >= 4:
                f.addr_lines.append(toks)

    f.domain = _domain(doc, {d.lower() for d in cfg["free_mail_domains"]})
    flat = re.sub(r"[^a-z0-9]+", " ", text.casefold())[:20_000]
    f.grams = Counter(flat[i:i + 3] for i in range(max(0, len(flat) - 2)))
    return f


def _cosine(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    dot = sum(v * b.get(k, 0) for k, v in a.items())
    na, nb = sqrt(sum(v * v for v in a.values())), sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


# ---- scoring ------------------------------------------------------------------
def score_pair(a: Features, b: Features, cfg: dict) -> tuple[float, list[str], str]:
    w, sigs, total = cfg["weights"], [], 0.0
    flagged = a.injection or b.injection

    shared = sorted(set(a.refs) & set(b.refs))
    if shared:
        total += w["shared_reference"]
        extra = f" (+{len(shared) - 1} more)" if len(shared) > 1 else ""
        sigs.append(f"shared_reference={a.refs[shared[0]]}{extra}")
    if a.domain and a.domain == b.domain:
        total += w["same_sender_domain"]
        sigs.append(f"same_sender_domain={a.domain}")
    if a.dates and b.dates:
        gap = min(abs((x - y).days) for x in a.dates for y in b.dates)
        if gap <= cfg["date_window_days"]:
            s = 1 - gap / cfg["date_window_days"]
            total += w["date_proximity"] * s
            sigs.append(f"date_proximity={gap}_days_apart")

    if flagged:   # attacker-steerable, text-derived signals are disabled
        sigs.append("flag=prompt_injection_suspected")
    else:
        best = (0.0, "")
        for ka, da in a.entities.items():
            for kb in b.entities:
                r = fuzz.token_sort_ratio(ka, kb) / 100
                if r > best[0]:
                    best = (r, da)
        if best[0] >= cfg["entity_threshold"] / 100:
            total += w["shared_entity"] * best[0]
            sigs.append(f"shared_entity={best[1]} (similarity {best[0]:.2f})")
        j = max((len(x & y) / len(x | y) for x in a.addr_lines for y in b.addr_lines), default=0.0)
        if j >= 0.8:
            total += w["address"] * j
            sigs.append(f"address_match (jaccard {j:.2f})")
        c = _cosine(a.grams, b.grams)
        if c >= cfg["similarity_min"]:
            total += w["text_similarity"] * c
            sigs.append(f"text_similarity={c:.2f}")

    conf = max(0.0, min(1.0, total))
    if flagged:
        conf = min(conf, cfg["injection_conf_cap"])
    if any(s.startswith("shared_reference") for s in sigs):
        rel = "supporting_document"
    elif any(s.startswith(("shared_entity", "same_sender_domain")) for s in sigs):
        rel = "same_party"
    else:
        rel = "unknown"
    return round(conf, 4), sigs, rel


# ---- storage helpers with rollback --------------------------------------------
_VOID = {"_void": True}


def _load(kind: str, id_: str):
    v = store.get(kind, id_)
    return None if v is None or v.get("_void") else v


class _Tx:
    def __init__(self):
        self._undo: list[tuple[str, str, dict | None]] = []

    def put(self, kind: str, id_: str, obj: dict) -> None:
        self._undo.append((kind, id_, copy.deepcopy(store.get(kind, id_))))
        store.put(kind, id_, obj)

    def rollback(self) -> None:
        for kind, id_, prev in reversed(self._undo):
            store.put(kind, id_, prev if prev is not None else _VOID)

    def index_add(self, kind: str, key: str, fld: str, value: str) -> None:
        cur = _load(kind, key) or {fld: []}
        self.put(kind, key, {fld: sorted(set(cur.get(fld, [])) | {value})})


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _link_id(case_id: str, source_id: str) -> str:
    return crypto.sha256_hex(f"{case_id}|{source_id}".encode())[:32]


def _audit(event_type: str, object_id: str, outcome: str = "success", details: dict | None = None):
    return audit.append({"event_type": event_type, "object_type": "case_link",
                         "object_id": object_id, "outcome": outcome, "details": _redact(details or {})})


def _audit_best_effort(event_type, object_id, outcome, details):
    try:
        _audit(event_type, object_id, outcome, details)
    except Exception:
        pass


def _emit(events: list[tuple[str, str, dict]], tx: _Tx) -> None:
    try:
        for et, oid, det in events:
            _audit(et, oid, "success", det)
    except Exception:
        tx.rollback()
        _audit_best_effort("link_action_rolled_back", "n/a", "error", {"reason": "audit_write_failed"})
        raise AgentError(ErrorCode.ENGINE_FAILED, "Audit write failed; action rolled back.")


def _user() -> dict:
    user = auth.current_user()
    if CAPABILITY not in (user.get("capabilities") or []):
        _audit_best_effort("link_denied", "n/a", "denied", {"actor": user.get("user_id")})
        raise AgentError(ErrorCode.FORBIDDEN, "Missing capability for case linking.")
    return user


# ---- agent entry points -------------------------------------------------------
def run(inp: LinkerInput) -> LinkerOutput:
    try:
        return _run(inp)
    except AgentError as e:
        if e.code != ErrorCode.FORBIDDEN:
            _audit_best_effort("link_failed", inp.case_id, "error", {"code": str(e.code), "mode": inp.mode})
        raise
    except Exception as e:  # never leak internals
        _audit_best_effort("link_failed", inp.case_id, "error", {"code": "ENGINE_FAILED", "type": type(e).__name__})
        raise AgentError(ErrorCode.ENGINE_FAILED, "Case linker failed.") from None


def _run(inp: LinkerInput) -> LinkerOutput:
    user, cfg = _user(), _cfg()
    if len(inp.source_ids) > cfg["max_sources"]:
        raise AgentError(ErrorCode.TOO_LARGE, "Too many source_ids.", {"max": cfg["max_sources"]})
    case = _load(KIND_CASE, inp.case_id)
    if case is None:
        raise AgentError(ErrorCode.NOT_FOUND, "Case not found.")
    for sid in inp.source_ids:
        if _load(KIND_SOURCE, sid) is None:
            raise AgentError(ErrorCode.NOT_FOUND, "Source not found.", {"source_id": sid})

    tx, events, warnings = _Tx(), [], []
    try:
        links = (_explicit if inp.mode == "explicit" else _suggest)(inp, user, case, cfg, tx, events, warnings)
        events.append(("link_explicit_run" if inp.mode == "explicit" else "link_suggest_run", inp.case_id,
                       {"mode": inp.mode, "requested": len(inp.source_ids), "links": len(links),
                        "warnings": sorted(set(warnings))[:50]}))
    except Exception:
        tx.rollback()
        raise
    _emit(events, tx)
    return LinkerOutput(links=sorted((Link.model_validate(l) for l in links), key=lambda x: (x.source_id, x.link_id)))


def _save_link(tx: _Tx, link: dict, state: str, by: str) -> None:
    tx.put(KIND_LINK, link["link_id"], {"link": link, "state": state, "decided_by": by})
    tx.index_add(KIND_CASE_INDEX, link["case_id"], "link_ids", link["link_id"])
    tx.index_add(KIND_SRC_CASES, link["source_id"], "case_ids", link["case_id"])


def _explicit(inp, user, case, cfg, tx, events, warnings) -> list[dict]:
    out = []
    for sid in inp.source_ids:
        lid, existing = _link_id(inp.case_id, sid), None
        existing = _load(KIND_LINK, _link_id(inp.case_id, sid))
        if existing and existing["state"] == "active" and existing["link"]["human_verified"] \
                and existing["link"]["linked_by"] == user["user_id"]:
            out.append(existing["link"])          # idempotent
            continue
        others = [c for c in (_load(KIND_SRC_CASES, sid) or {}).get("case_ids", []) if c != inp.case_id]
        if others:
            warnings.append(f"SOURCE_IN_OTHER_CASES:{sid}")
        link = Link(link_id=lid, case_id=inp.case_id, source_id=sid, relationship_type="unknown",
                    relationship_confidence=1.0, matching_signals=["user_assigned"],
                    linked_by=user["user_id"], linked_at=_now(), human_verified=True).model_dump()
        _save_link(tx, link, "active", user["user_id"])
        events.append(("link_confirmed", lid, {"mode": "explicit", "case_id": inp.case_id, "source_id": sid,
                                               "upgraded": existing is not None, "other_cases": len(others)}))
        out.append(link)
    return out


def _suggest(inp, user, case, cfg, tx, events, warnings) -> list[dict]:
    active, rejected, anchors = {}, set(), set(case.get("source_ids") or [])
    for lid in (_load(KIND_CASE_INDEX, inp.case_id) or {}).get("link_ids", []):
        rec = _load(KIND_LINK, lid)
        if not rec:
            continue
        sid = rec["link"]["source_id"]
        if rec["state"] == "rejected":
            rejected.add(sid)
        else:
            active[sid] = rec
            if rec["link"]["human_verified"]:   # unconfirmed suggestions never become anchors
                anchors.add(sid)
    anchor_list = sorted(anchors)
    if len(anchor_list) > cfg["max_case_sources"]:
        warnings.append("ANCHORS_TRUNCATED")
        anchor_list = anchor_list[: cfg["max_case_sources"]]

    cache: dict[str, Features | None] = {}

    def feat(sid: str) -> Features | None:
        if sid not in cache:
            doc = _load(KIND_SOURCE_DOC, sid)
            cache[sid] = extract_features(sid, doc, cfg) if doc else None
            if cache[sid] and cache[sid].injection:
                warnings.append(f"INJECTION_SUSPECTED:{sid}")
            if cache[sid] and cache[sid].truncated:
                warnings.append(f"TEXT_TRUNCATED:{sid}")
        return cache[sid]

    out = []
    if not anchor_list:
        warnings.append("NO_ANCHORS")
    for sid in inp.source_ids:
        if sid in rejected:
            warnings.append(f"SKIPPED_REJECTED:{sid}")
        elif sid in active:
            out.append(active[sid]["link"])
        elif sid in anchors:
            warnings.append(f"ALREADY_IN_CASE:{sid}")
        elif anchor_list:
            fc = feat(sid)
            if fc is None:
                warnings.append(f"SOURCE_NOT_ASSEMBLED:{sid}")
                continue
            best = None
            for aid in anchor_list:
                fa = feat(aid)
                if fa is None:
                    continue
                conf, sigs, rel = score_pair(fc, fa, cfg)
                if best is None or conf > best[0]:
                    best = (conf, sigs, rel, aid)
            if best and best[0] >= cfg["min_confidence"]:
                conf, sigs, rel, aid = best
                lid = _link_id(inp.case_id, sid)
                link = Link(link_id=lid, case_id=inp.case_id, source_id=sid, relationship_type=rel,
                            relationship_confidence=conf, matching_signals=[f"matched_source={aid}"] + sigs,
                            linked_by=SYSTEM_ACTOR, linked_at=_now(), human_verified=False).model_dump()
                _save_link(tx, link, "active", user["user_id"])
                events.append(("link_suggested", lid, {"case_id": inp.case_id, "source_id": sid,
                                                       "anchor": aid, "confidence": conf, "type": rel}))
                out.append(link)
    return out


def decide(inp: DecisionInput) -> DecisionOutput:
    try:
        return _decide(inp)
    except AgentError as e:
        if e.code != ErrorCode.FORBIDDEN:
            _audit_best_effort("link_failed", inp.link_id, "error", {"code": str(e.code)})
        raise
    except Exception as e:
        _audit_best_effort("link_failed", inp.link_id, "error", {"type": type(e).__name__})
        raise AgentError(ErrorCode.ENGINE_FAILED, "Case linker decision failed.") from None


def _decide(inp: DecisionInput) -> DecisionOutput:
    user = _user()
    rec = _load(KIND_LINK, inp.link_id)
    if rec is None:
        raise AgentError(ErrorCode.NOT_FOUND, "Link not found.")
    link, state = copy.deepcopy(rec["link"]), rec["state"]
    tx, events = _Tx(), []
    if inp.decision == "confirm":
        if state == "rejected":
            raise AgentError(ErrorCode.CONFLICT, "Link was rejected; re-link explicitly to restore it.")
        if link["human_verified"]:
            return DecisionOutput(link_id=inp.link_id, human_verified=True)
        link["human_verified"] = True
        tx.put(KIND_LINK, inp.link_id, {"link": link, "state": "active", "decided_by": user["user_id"]})
        events.append(("link_confirmed", inp.link_id, {"case_id": link["case_id"], "source_id": link["source_id"]}))
    else:
        if state == "rejected":
            return DecisionOutput(link_id=inp.link_id, human_verified=False)
        was = link["human_verified"]
        link["human_verified"] = False
        tx.put(KIND_LINK, inp.link_id, {"link": link, "state": "rejected", "decided_by": user["user_id"],
                                        "rejected_at": _now()})
        events.append(("link_rejected", inp.link_id, {"case_id": link["case_id"], "source_id": link["source_id"],
                                                      "reversed_confirmation": was}))
    _emit(events, tx)
    return DecisionOutput(link_id=inp.link_id, human_verified=link["human_verified"])


# ---- thin router (backend/routers/case_linker.py: `from backend.agents... import router`)
def build_router():
    from fastapi import APIRouter, Request
    r = APIRouter(prefix="/agents/case-linker", tags=["case-linker"])

    @r.post("")
    def post_link(inp: LinkerInput, request: Request):
        return {"ok": True, "data": run(inp).model_dump(mode="json"), "request_id": request.state.request_id}

    @r.post("/decision")
    def post_decision(inp: DecisionInput, request: Request):
        return {"ok": True, "data": decide(inp).model_dump(mode="json"), "request_id": request.state.request_id}

    return r


router = build_router()