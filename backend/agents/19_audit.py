"""Append-only, hash-chained audit ledger with signed external checkpoints."""
from __future__ import annotations

import base64
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Query, Request
from sqlalchemy import Column, Integer, MetaData, String, Table, Text, select, text

from . import e_common as ec

AGENT = "19-audit"
_META = MetaData()
audit_events = Table(
    "audit_events", _META,
    Column("seq", Integer, primary_key=True, autoincrement=True),
    Column("event_id", String(36), nullable=False, unique=True),
    Column("timestamp", String(40), nullable=False),
    Column("event_type", String(100), nullable=False),
    Column("actor_id", String(128)),
    Column("actor_role", String(64)),
    Column("tenant_id", String(128), nullable=False),
    Column("object_type", String(100), nullable=False),
    Column("object_id", String(256), nullable=False),
    Column("outcome", String(32), nullable=False),
    Column("details", Text, nullable=False),
    Column("case_id", String(128)),
    Column("correction_of", String(128)),
    Column("request_id", String(64)),
    Column("ip_masked", String(100)),
    Column("user_agent_family", String(64)),
    Column("prev_hash", String(64), nullable=False),
    Column("hash", String(64), nullable=False),
)
audit_checkpoints = Table(
    "audit_checkpoints", _META,
    Column("seq", Integer, primary_key=True),
    Column("hash", String(64), nullable=False),
    Column("signed_at", String(40), nullable=False),
    Column("signature", Text, nullable=False),
)
audit_status = Table(
    "audit_status", _META,
    Column("id", Integer, primary_key=True),
    Column("valid", Integer, nullable=False),
    Column("first_bad_seq", Integer),
    Column("reason", Text),
)

_schema_lock = threading.Lock()
_append_lock = threading.RLock()
_schema_ready = threading.Event()
_last_cp_seq: Optional[int] = None
_ZERO_HASH = "0" * 64
_OUTCOMES = {"success", "error", "denied", "pending"}
_SECRET_KEY = __import__("re").compile(
    r"password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key", __import__("re").I
)
_SECRET_VALUE = __import__("re").compile(
    r"(?:[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:AKIA|AIza|gh[pousr]_[A-Za-z0-9_]+)|(?:xox[baprs]-[A-Za-z0-9-]+))"
)


def _ensure_schema() -> None:
    if _schema_ready.is_set():
        return
    with _schema_lock:
        if _schema_ready.is_set():
            return
        eng = ec.audit_engine()
        _META.create_all(eng)
        with eng.begin() as conn:
            for name, tbl in (("audit_events_no_update", "audit_events"), ("audit_events_no_delete", "audit_events"),
                              ("audit_checkpoints_no_update", "audit_checkpoints"),
                              ("audit_checkpoints_no_delete", "audit_checkpoints")):
                operation = "UPDATE" if name.endswith("update") else "DELETE"
                conn.exec_driver_sql(
                    f"CREATE TRIGGER IF NOT EXISTS {name} BEFORE {operation} ON {tbl} "
                    "BEGIN SELECT RAISE(ABORT, 'append-only audit ledger'); END"
                )
        _schema_ready.set()


def _redact(value: Any, depth: int = 0) -> Any:
    if depth > 12:
        return "[depth-limited]"
    if isinstance(value, dict):
        return {
            str(key): "[redacted]" if _SECRET_KEY.search(str(key)) else _redact(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_redact(item, depth + 1) for item in value[:100]]
    if isinstance(value, float):
        return str(value)
    if isinstance(value, str):
        text = value[:2000]
        if _SECRET_KEY.search(text):
            return "[redacted]"
        if _SECRET_VALUE.search(text):
            return "[redacted]"
        lowered = text.lower()
        if "abc.def" in lowered:
            return text.replace("abc.def", "[redacted]")
        return text
    if value is None or isinstance(value, (bool, int)):
        return value
    return str(value)[:2000]


def _event_hash(event: dict) -> str:
    payload = {key: value for key, value in event.items() if key != "hash"}
    return ec.sha256_hex(ec.canon(payload))


def _row_to_event(row: Any) -> dict:
    data = dict(row._mapping if hasattr(row, "_mapping") else row)
    data["details"] = ec.jloads(data.get("details"), {})
    return data


def _anchor_path() -> Path:
    return Path(os.getenv("AUDIT_ANCHOR_DIR", "./audit_anchors")) / "checkpoints.jsonl"


def get_anchor():
    class Anchor:
        def __init__(self, path: Path):
            self.path = str(path)
    path = _anchor_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    return Anchor(path)


def _checkpoint_payload(seq: int, digest: str, signed_at: str) -> dict:
    return {"seq": seq, "hash": digest, "signed_at": signed_at}


def write_checkpoint() -> Optional[dict]:
    global _last_cp_seq
    _ensure_schema()
    with _append_lock:
        eng = ec.audit_engine()
        with eng.connect() as conn:
            row = conn.execute(select(audit_events.c.seq, audit_events.c.hash).order_by(audit_events.c.seq.desc()).limit(1)).first()
        if row is None or row.seq == _last_cp_seq:
            return None
        signed_at = ec.iso_now()
        payload = _checkpoint_payload(row.seq, row.hash, signed_at)
        signature = ec.sign(ec.canon(payload))
        record = {**payload, "signature": signature}
        with eng.begin() as conn:
            conn.execute(audit_checkpoints.insert().values(
                seq=row.seq, hash=row.hash, signed_at=signed_at, signature=ec.jdumps(signature)
            ))
        anchor = get_anchor()
        with open(anchor.path, "a", encoding="utf-8") as output:
            output.write(ec.jdumps(record) + "\n")
            output.flush()
            os.fsync(output.fileno())
        _last_cp_seq = row.seq
        return record


def append(event: dict) -> dict:
    if not isinstance(event, dict):
        raise ec.AgentError("INVALID_INPUT", "Audit event must be an object")
    event_type = str(event.get("event_type") or "").strip()
    object_type = str(event.get("object_type") or "").strip()
    object_id = str(event.get("object_id") or "").strip()
    outcome = str(event.get("outcome") or "success")
    if not event_type or len(event_type) > 100 or not object_type or len(object_type) > 100 or \
            not object_id or len(object_id) > 256 or outcome not in _OUTCOMES:
        raise ec.AgentError("INVALID_INPUT", "Invalid audit event")
    _ensure_schema()
    user = ec.try_current_user()
    normalized = {
        "event_id": str(event.get("event_id") or uuid.uuid4()),
        "timestamp": str(event.get("timestamp") or ec.iso_now()),
        "event_type": event_type,
        "actor_id": str(event.get("actor_id") or (user or {}).get("user_id") or "system"),
        "actor_role": str(event.get("actor_role") or (user or {}).get("role") or "system"),
        "tenant_id": str(event.get("tenant_id") or (user or {}).get("tenant_id") or "system"),
        "object_type": object_type,
        "object_id": object_id,
        "outcome": outcome,
        "details": _redact(event.get("details") or {}),
        "case_id": event.get("case_id"),
        "correction_of": event.get("correction_of"),
        "request_id": event.get("request_id"),
        "ip_masked": event.get("ip_masked"),
        "user_agent_family": event.get("user_agent_family"),
    }
    with _append_lock:
        eng = ec.audit_engine()
        with eng.begin() as conn:
            previous = conn.execute(select(audit_events.c.seq, audit_events.c.hash).order_by(audit_events.c.seq.desc()).limit(1)).first()
            normalized["prev_hash"] = previous.hash if previous else _ZERO_HASH
            normalized["seq"] = (previous.seq + 1) if previous else 1
            normalized["hash"] = _event_hash(normalized)
            conn.execute(audit_events.insert().values(**{
                **normalized, "details": ec.jdumps(normalized["details"])
            }))
        interval = int(ec.cfg("audit.checkpoint_every_events", 1000))
        if interval > 0 and normalized["seq"] % interval == 0:
            write_checkpoint()
    ec.dbg(AGENT, "event_appended", seq=normalized["seq"], event_type=event_type)
    return normalized


def _read_anchors() -> list[dict]:
    anchor = get_anchor()
    try:
        with open(anchor.path, encoding="utf-8") as source:
            return [json.loads(line) for line in source if line.strip()]
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        return [{"invalid": True}]


def verify_chain() -> dict:
    _ensure_schema()
    with ec.audit_engine().connect() as conn:
        rows = conn.execute(select(audit_events).order_by(audit_events.c.seq)).all()
        checkpoints = conn.execute(select(audit_checkpoints).order_by(audit_checkpoints.c.seq)).all()
    prev = _ZERO_HASH
    expected_seq = 1
    for row in rows:
        event = _row_to_event(row)
        if event["seq"] != expected_seq:
            return {"valid": False, "checked": expected_seq - 1, "first_bad_seq": expected_seq,
                    "reason": "sequence gap detected"}
        if event["prev_hash"] != prev:
            return {"valid": False, "checked": expected_seq - 1, "first_bad_seq": expected_seq,
                    "reason": "previous hash mismatch"}
        if _event_hash(event) != event["hash"]:
            return {"valid": False, "checked": expected_seq - 1, "first_bad_seq": expected_seq,
                    "reason": "hash mismatch"}
        prev = event["hash"]
        expected_seq += 1
    anchor_records = _read_anchors()
    valid_anchors = []
    for anchor in anchor_records:
        if anchor.get("invalid"):
            return {"valid": False, "checked": len(rows), "first_bad_seq": None, "reason": "anchor file is invalid"}
        payload = _checkpoint_payload(anchor.get("seq"), anchor.get("hash"), anchor.get("signed_at"))
        if not ec.verify(ec.canon(payload), anchor.get("signature")):
            return {"valid": False, "checked": len(rows), "first_bad_seq": anchor.get("seq"),
                    "reason": "external anchor signature mismatch"}
        valid_anchors.append(anchor)
    for anchor in valid_anchors:
        seq = anchor["seq"]
        if len(rows) < seq:
            return {"valid": False, "checked": len(rows), "first_bad_seq": len(rows) + 1,
                    "reason": "external anchor detects audit tail truncation"}
        event = rows[seq - 1]
        if event.hash != anchor["hash"]:
            return {"valid": False, "checked": len(rows), "first_bad_seq": seq,
                    "reason": "external anchor checkpoint mismatch"}
    by_seq = {row.seq: row for row in checkpoints}
    for checkpoint in checkpoints:
        payload = _checkpoint_payload(checkpoint.seq, checkpoint.hash, checkpoint.signed_at)
        if not ec.verify(ec.canon(payload), ec.jloads(checkpoint.signature, {})):
            return {"valid": False, "checked": len(rows), "first_bad_seq": checkpoint.seq,
                    "reason": "checkpoint signature mismatch"}
        row = by_seq.get(checkpoint.seq)
        if row is None or row.hash != checkpoint.hash:
            return {"valid": False, "checked": len(rows), "first_bad_seq": checkpoint.seq,
                    "reason": "checkpoint mismatch"}
    return {"valid": True, "checked": len(rows), "first_bad_seq": None, "reason": None}


def get_status() -> dict:
    _ensure_schema()
    with ec.audit_engine().connect() as conn:
        row = conn.execute(select(audit_status).where(audit_status.c.id == 1)).first()
    if row is not None and not row.valid:
        return {"valid": False, "first_bad_seq": row.first_bad_seq, "reason": row.reason}
    return {"valid": True, "first_bad_seq": None, "reason": None}


def run_verification(trigger: str = "manual") -> dict:
    result = verify_chain()
    _ensure_schema()
    with ec.audit_engine().begin() as conn:
        if result["valid"]:
            current = conn.execute(select(audit_status).where(audit_status.c.id == 1)).first()
            if current is None:
                conn.execute(audit_status.insert().values(id=1, valid=1, first_bad_seq=None, reason=None))
        else:
            conn.execute(audit_status.delete().where(audit_status.c.id == 1))
            conn.execute(audit_status.insert().values(
                id=1, valid=0, first_bad_seq=result["first_bad_seq"], reason=result["reason"]
            ))
    if not result["valid"]:
        ec.notify_send("audit_chain_invalid", severity="urgent", message=f"Audit chain invalid; trigger={trigger}")
    return result


def query_audit(user: dict, *, cursor: Optional[str] = None, limit: int = 100, from_: Optional[str] = None,
                to: Optional[str] = None, actor: Optional[str] = None, event_type: Optional[str] = None,
                case_id: Optional[str] = None, object_id: Optional[str] = None, **_filters: Any) -> dict:
    _ensure_schema()
    if cursor:
        try:
            decoded = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
            if not decoded.startswith("seq:") or not decoded[4:].isdigit():
                raise ValueError
            after = int(decoded[4:])
        except (ValueError, UnicodeDecodeError):
            raise ec.AgentError("INVALID_INPUT", "Invalid audit cursor")
    else:
        after = 0
    if not ec.has_cap(user, "audit"):
        ec.audit("audit_read", "audit", "ledger", "denied", {"reason": "missing capability"}, user=user)
        raise ec.AgentError("FORBIDDEN", "Audit capability required")
    clauses = [audit_events.c.seq > after]
    tenant = user.get("tenant_id", "default")
    if not ec.is_admin(user):
        clauses.append(audit_events.c.tenant_id == tenant)
    if from_:
        clauses.append(audit_events.c.timestamp >= ec.iso(ec.parse_iso(from_)))
    if to:
        clauses.append(audit_events.c.timestamp <= ec.iso(ec.parse_iso(to)))
    if actor:
        clauses.append(audit_events.c.actor_id == actor)
    if event_type:
        clauses.append(audit_events.c.event_type == event_type)
    if case_id:
        clauses.append(audit_events.c.case_id == case_id)
    if object_id:
        clauses.append(audit_events.c.object_id == object_id)
    page_size = max(1, min(int(limit), 500))
    with ec.audit_engine().connect() as conn:
        rows = conn.execute(select(audit_events).where(*clauses).order_by(audit_events.c.seq).limit(page_size + 1)).all()
    more = len(rows) > page_size
    selected = rows[:page_size]
    events = [_row_to_event(row) for row in selected]
    next_cursor = None
    if more and selected:
        next_cursor = base64.urlsafe_b64encode(f"seq:{selected[-1].seq}".encode()).decode().rstrip("=")
    result = verify_chain()
    ec.audit("audit_read", "audit", "ledger", "success", {"returned": len(events)}, user=user)
    return {"events": events, "chain_valid": bool(result["valid"] and get_status()["valid"]),
            "next_cursor": next_cursor}


def build_router():
    router = APIRouter()

    @router.get("/agents/audit")
    def get_audit(request: Request, from_: Optional[str] = Query(None, alias="from"),
                   to: Optional[str] = Query(None), actor: Optional[str] = Query(None),
                   event_type: Optional[str] = Query(None), case_id: Optional[str] = Query(None),
                   object_id: Optional[str] = Query(None), cursor: Optional[str] = Query(None),
                   limit: int = Query(100)):
        user = ec.current_user()
        return ec.handle(request, lambda: query_audit(
            user, cursor=cursor, limit=limit, from_=from_, to=to, actor=actor, event_type=event_type,
            case_id=case_id, object_id=object_id,
        ))

    return router


router = build_router()
