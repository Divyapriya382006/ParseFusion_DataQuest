from __future__ import annotations

import re
import threading
import time
import uuid
from datetime import timedelta
from typing import Any, Literal, Optional, Union

from fastapi import APIRouter, Body, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Column, Integer, MetaData, String, Table, Text, column, insert, inspect, literal, select, table, update

try:
    from . import e_common as ec
except ImportError:  # pragma: no cover
    import e_common as ec

AGENT = "23-access"
_DOCUMENT_REQUEST_KIND = "document_access_request"
_DOCUMENT_GRANT_KIND = "document_access_grant"
_DOCUMENT_VISIBILITY_KIND = "document_access_visibility"
_DOCUMENT_REQUEST_LOCK = threading.RLock()

acl_requests = Table(
    "acl_requests", ec.APP_META,
    Column("request_id", String(36), primary_key=True),
    Column("tenant_id", String(64), nullable=False), Column("user_id", String(128), nullable=False),
    Column("resource", String(128), nullable=False), Column("columns", Text, nullable=False),
    Column("reason", Text, nullable=False), Column("duration_seconds", Integer, nullable=False),
    Column("status", String(16), nullable=False), Column("created_at", String(32), nullable=False),
    Column("decided_by", String(128)), Column("decided_at", String(32)), Column("notes", Text), Column("grant_id", String(36)),
)
acl_grants = Table(
    "acl_grants", ec.APP_META,
    Column("grant_id", String(36), primary_key=True),
    Column("tenant_id", String(64), nullable=False), Column("request_id", String(36)),
    Column("subject_type", String(8), nullable=False), Column("subject_id", String(128), nullable=False),
    Column("resource", String(128), nullable=False), Column("columns", Text, nullable=False),
    Column("valid_until", String(32), nullable=False), Column("granted_by", String(128)), Column("granted_at", String(32)),
    Column("signature", Text), Column("revoked", Integer, nullable=False, default=0), Column("expiry_logged", Integer, nullable=False, default=0),
)

_IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")
_INTERNAL_PREFIXES = ("pg_", "sqlite_", "sql_", "information_schema", "alembic_")
_INTERNAL_TABLES = {"audit_events", "audit_checkpoints", "audit_status", "notify_outbox", "action_state", "action_events", "executed_keys",
                    "exports", "acl_requests", "acl_grants", "chat_approvals", "chat_questions", "chat_blocks"}


# ---------------------------------------------------------------------------
# registry (reflected from the data DB, cached)
# ---------------------------------------------------------------------------
_reg_cache: dict = {"at": 0.0, "url": None, "data": {}}
_reg_lock = threading.Lock()


def registry(force: bool = False) -> dict:
    """{resource: {"columns": {col: type_str}, "pk": [cols]}}"""
    eng = ec.data_engine()
    ttl = float(ec.cfg("access.registry_ttl_seconds", 60))
    with _reg_lock:
        if not force and _reg_cache["url"] == str(eng.url) and time.time() - _reg_cache["at"] < ttl:
            return _reg_cache["data"]
        t0 = time.perf_counter()
        insp = inspect(eng)
        hidden = {str(x).lower() for x in ec.cfg("access.hidden_tables", [])}
        data: dict = {}
        for tname in insp.get_table_names():
            if tname in _INTERNAL_TABLES or tname.lower() in hidden or tname.startswith(_INTERNAL_PREFIXES):
                continue
            if not _IDENT.match(tname):
                ec.dbg(AGENT, "table_hidden_bad_identifier", table=tname)
                continue
            cols: dict = {}
            for col in insp.get_columns(tname):
                if _IDENT.match(col["name"]):
                    cols[col["name"]] = str(col["type"])
                else:
                    ec.dbg(AGENT, "column_hidden_bad_identifier", table=tname, column=col["name"])
            if cols:
                data[tname] = {"columns": cols, "pk": [p for p in (insp.get_pk_constraint(tname).get("constrained_columns") or []) if p in cols]}
        _reg_cache.update(at=time.time(), url=str(eng.url), data=data)
        ec.dbg(AGENT, "registry_reflected", tables=len(data), ms=round((time.perf_counter() - t0) * 1000, 1))
        return data


def is_sensitive(resource: str, col: str) -> bool:
    """Used by agent 24 to decide CONFIRM. Config: access.sensitive_columns = ["table.col", "col", ...]."""
    items = {str(x).lower() for x in ec.cfg("access.sensitive_columns", [])}
    return f"{resource}.{col}".lower() in items or col.lower() in items


# ---------------------------------------------------------------------------
# effective permissions
# ---------------------------------------------------------------------------
def unlocked_columns(user: dict, resource: str) -> set:
    reg = registry().get(resource)
    if not reg:
        return set()
    allc = set(reg["columns"])
    if ec.cfg("access.admin_sees_all", False) and ec.is_admin(user):
        return allc
    out: set = set()
    g = (ec.cfg("access.role_grants", {}) or {}).get(user.get("role"), {}).get(resource)
    if g == "*":
        out |= allc
    elif isinstance(g, list):
        out |= set(g)
    now_s = ec.iso_now()
    with ec.app_engine().connect() as c:
        rows = c.execute(select(acl_grants.c.columns, acl_grants.c.subject_type, acl_grants.c.subject_id).where(
            acl_grants.c.resource == resource, acl_grants.c.revoked == 0, acl_grants.c.valid_until > now_s,
            acl_grants.c.tenant_id == user.get("tenant_id", "default"))).all()
    for r in rows:
        if (r.subject_type == "user" and r.subject_id == user["user_id"]) or (r.subject_type == "role" and r.subject_id == user.get("role")):
            cols = ec.jloads(r.columns, [])
            out |= allc if "*" in cols else set(cols)
    return out & allc  # columns renamed/dropped since the grant are silently ignored


def locked_field_names(user: dict, resource: str) -> set:
    """Used by agent 20: column names locked for this caller (empty set if the resource is not in the registry)."""
    reg = registry().get(resource)
    return set(reg["columns"]) - unlocked_columns(user, resource) if reg else set()


def user_schema(user: dict, only: Optional[list] = None) -> tuple:
    """Used by agent 24 -> (allowed {table:{col:type}} with >=1 unlocked col, all {table:{col:type}})."""
    reg, allowed = registry(), {}
    for res, meta in reg.items():
        if only and res not in only:
            continue
        un = unlocked_columns(user, res)
        if un:
            allowed[res] = {c: t for c, t in meta["columns"].items() if c in un}
    return allowed, {r: m["columns"] for r, m in reg.items()}


def parse_duration(v: Union[int, str]) -> int:
    """-> seconds. int = hours; strings '30m','24h','7d'."""
    if isinstance(v, bool):
        raise ec.AgentError("INVALID_INPUT", "Invalid duration")
    if isinstance(v, int):
        secs = v * 3600
    else:
        m = re.fullmatch(r"\s*(\d+)\s*([mhd])\s*", str(v).lower())
        if not m:
            raise ec.AgentError("INVALID_INPUT", "duration must be hours (int) or like 30m / 24h / 7d")
        secs = int(m.group(1)) * {"m": 60, "h": 3600, "d": 86400}[m.group(2)]
    if secs <= 0 or secs > int(ec.cfg("access.max_duration_hours", 720)) * 3600:
        raise ec.AgentError("INVALID_INPUT", "duration is outside the allowed range")
    return secs


def _req_dict(r: Any) -> dict:
    return {"request_id": r.request_id, "user_id": r.user_id, "resource": r.resource, "columns": ec.jloads(r.columns, []), "reason": r.reason,
            "duration_seconds": r.duration_seconds, "status": r.status, "created_at": r.created_at, "decided_by": r.decided_by,
            "decided_at": r.decided_at, "notes": r.notes, "grant_id": r.grant_id}


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------
class PreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resource: str
    columns: Optional[list] = None
    limit: Optional[int] = None
    offset: int = 0


class RequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resource: str
    columns: list
    reason: str
    duration: Union[int, str]


class DecisionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str
    decision: str
    valid_until: Optional[str] = None
    notes: Optional[str] = None


class DocumentRequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str = Field(min_length=1, max_length=128)
    reason: str = Field(min_length=3, max_length=2000)


class DocumentDecisionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=64)
    decision: str
    notes: Optional[str] = Field(default=None, max_length=2000)


class DocumentVisibilityIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str = Field(min_length=1, max_length=128)
    visibility: Literal["public", "private"]


def _document_store():
    from backend.common import store
    return store


def _document_access(user: dict, source_id: str) -> bool:
    if ec.is_admin(user):
        return True
    store = _document_store()
    tenant_id = user.get("tenant_id", "default")
    meta = store.get("source_meta", source_id)
    if not isinstance(meta, dict) or meta.get("tenant_id") != tenant_id or meta.get("status") != "accepted":
        return False
    visibility = store.get(_DOCUMENT_VISIBILITY_KIND, f"{tenant_id}:{source_id}")
    if isinstance(visibility, dict) and visibility.get("visibility") == "public":
        return True
    grant = store.get(_DOCUMENT_GRANT_KIND, f"{tenant_id}:{user['user_id']}:{source_id}")
    return bool(grant)


def _document_visibility(store: Any, tenant_id: str, source_id: str) -> str:
    value = store.get(_DOCUMENT_VISIBILITY_KIND, f"{tenant_id}:{source_id}")
    return "public" if isinstance(value, dict) and value.get("visibility") == "public" else "private"


def _document_source(source_id: str, user: dict) -> Optional[dict]:
    meta = _document_store().get("source_meta", source_id)
    if not isinstance(meta, dict) or meta.get("tenant_id") != user.get("tenant_id", "default"):
        return None
    if meta.get("status") != "accepted":
        return None
    return meta


def op_document_sources(user: dict) -> dict:
    store = _document_store()
    list_by_kind = getattr(store, "list_by_kind", None)
    if not callable(list_by_kind):
        raise ec.AgentError("ENGINE_FAILED", "The local document catalog is unavailable")
    items = []
    for source_id, meta in list_by_kind("source_meta"):
        if not isinstance(meta, dict) or meta.get("tenant_id") != user.get("tenant_id", "default") or meta.get("status") != "accepted":
            continue
        items.append({
            "source_id": str(source_id),
            "filename": str(meta.get("sanitized_filename") or source_id),
            "kind": str(meta.get("detected_mime") or ""),
            "created_at": meta.get("created_at"),
            "visibility": _document_visibility(store, user.get("tenant_id", "default"), str(source_id)),
            "has_access": _document_access(user, str(source_id)),
        })
    items.sort(key=lambda item: (str(item.get("created_at") or ""), item["filename"].lower()), reverse=True)
    return {"documents": items}


def op_document_visibility(inp: DocumentVisibilityIn, user: dict) -> dict:
    if not ec.is_admin(user):
        raise ec.AgentError("FORBIDDEN", "Admin only")
    if not _document_source(inp.source_id, user):
        raise ec.AgentError("NOT_FOUND", "Document not found")
    store = _document_store()
    tenant_id = user.get("tenant_id", "default")
    key = f"{tenant_id}:{inp.source_id}"
    previous = store.get(_DOCUMENT_VISIBILITY_KIND, key)
    value = {"tenant_id": tenant_id, "source_id": inp.source_id, "visibility": inp.visibility,
             "updated_by": user["user_id"], "updated_at": ec.iso_now()}
    with _DOCUMENT_REQUEST_LOCK:
        store.put(_DOCUMENT_VISIBILITY_KIND, key, value)
    try:
        ec.audit("document_visibility_changed", "document", inp.source_id, "success",
                 {"visibility": inp.visibility}, strict=True, user=user)
    except Exception:
        with _DOCUMENT_REQUEST_LOCK:
            if previous is None:
                store.delete(_DOCUMENT_VISIBILITY_KIND, key)
            else:
                store.put(_DOCUMENT_VISIBILITY_KIND, key, previous)
        raise
    ec.notify_send(
        "document_visibility_changed",
        message=f"Document {inp.source_id} visibility was set to {inp.visibility} by {user['user_id']}.",
        link="/access",
    )
    return {"source_id": inp.source_id, "visibility": inp.visibility}


def op_document_request(inp: DocumentRequestIn, user: dict) -> dict:
    if ec.is_admin(user):
        raise ec.AgentError("FORBIDDEN", "Administrators do not need to request document access")
    if user.get("role") != "viewer":
        raise ec.AgentError("FORBIDDEN", "Only viewer accounts can request document access")
    reason = inp.reason.strip()
    if len(reason) < 3:
        raise ec.AgentError("INVALID_INPUT", "A reason is required")
    meta = _document_source(inp.source_id, user)
    if not meta:
        raise ec.AgentError("NOT_FOUND", "Document not found")
    if _document_access(user, inp.source_id):
        raise ec.AgentError("CONFLICT", "You already have access to this document")
    store = _document_store()
    now = ec.iso_now()
    request_id = str(uuid.uuid4())
    request = {
        "request_id": request_id, "tenant_id": user.get("tenant_id", "default"),
        "user_id": user["user_id"], "source_id": inp.source_id,
        "filename": str(meta.get("sanitized_filename") or inp.source_id),
        "reason": reason, "status": "pending", "created_at": now,
        "decided_by": None, "decided_at": None, "notes": None,
    }
    with _DOCUMENT_REQUEST_LOCK:
        if _document_access(user, inp.source_id):
            raise ec.AgentError("CONFLICT", "You already have access to this document")
        existing = [pending for _, pending in store.list_by_kind(_DOCUMENT_REQUEST_KIND)
                    if isinstance(pending, dict) and pending.get("tenant_id") == user.get("tenant_id", "default")
                    and pending.get("user_id") == user["user_id"] and pending.get("source_id") == inp.source_id
                    and pending.get("status") == "pending"]
        if existing:
            raise ec.AgentError("CONFLICT", "A request for this document is already pending",
                                {"request_id": existing[0]["request_id"]})
        store.put(_DOCUMENT_REQUEST_KIND, request_id, request)
        try:
            ec.audit("document_access_requested", "document_access_request", request_id, "success",
                     {"source_id": inp.source_id}, strict=True, user=user)
        except Exception:
            store.delete(_DOCUMENT_REQUEST_KIND, request_id)
            raise
    ec.notify_send("document_access_requested",
                   message=f"Viewer {user['user_id']} requested access to document {inp.source_id}. Request {request_id}.",
                   link="/access")
    return {key: value for key, value in request.items() if key != "tenant_id"}


def op_document_requests(user: dict, status: Optional[str] = None) -> dict:
    store = _document_store()
    rows = []
    for _, request in store.list_by_kind(_DOCUMENT_REQUEST_KIND):
        if not isinstance(request, dict) or request.get("tenant_id") != user.get("tenant_id", "default"):
            continue
        if not ec.is_admin(user) and request.get("user_id") != user["user_id"]:
            continue
        if status and request.get("status") != status:
            continue
        rows.append({key: value for key, value in request.items() if key != "tenant_id"})
    rows.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return {"requests": rows}


def op_document_decision(inp: DocumentDecisionIn, user: dict) -> dict:
    if not ec.is_admin(user):
        raise ec.AgentError("FORBIDDEN", "Admin only")
    if inp.decision not in ("approve", "reject"):
        raise ec.AgentError("INVALID_INPUT", "decision must be approve or reject")
    store = _document_store()
    previous_request = None
    with _DOCUMENT_REQUEST_LOCK:
        request = store.get(_DOCUMENT_REQUEST_KIND, inp.request_id)
        if not isinstance(request, dict) or request.get("tenant_id") != user.get("tenant_id", "default"):
            raise ec.AgentError("NOT_FOUND", "Document access request not found")
        if request.get("status") != "pending":
            raise ec.AgentError("CONFLICT", "Document access request was already decided",
                                {"status": request.get("status")})
        previous_request = dict(request)
        request = dict(request)
        request.update(status="approved" if inp.decision == "approve" else "rejected",
                       decided_by=user["user_id"], decided_at=ec.iso_now(), notes=(inp.notes or "").strip() or None)
        store.put(_DOCUMENT_REQUEST_KIND, inp.request_id, request)
        if inp.decision == "approve":
            store.put(_DOCUMENT_GRANT_KIND,
                      f"{request['tenant_id']}:{request['user_id']}:{request['source_id']}",
                      {"tenant_id": request["tenant_id"], "user_id": request["user_id"],
                       "source_id": request["source_id"], "request_id": inp.request_id,
                       "granted_by": user["user_id"], "granted_at": request["decided_at"]})
    try:
        ec.audit("document_access_decided", "document_access_request", inp.request_id, "success",
                 {"decision": inp.decision, "source_id": request["source_id"]}, strict=True, user=user)
    except Exception:
        with _DOCUMENT_REQUEST_LOCK:
            store.put(_DOCUMENT_REQUEST_KIND, inp.request_id, previous_request)
            if inp.decision == "approve":
                store.delete(_DOCUMENT_GRANT_KIND,
                             f"{request['tenant_id']}:{request['user_id']}:{request['source_id']}")
        raise
    event = "document_access_approved" if inp.decision == "approve" else "document_access_rejected"
    ec.notify_send(event,
                   message=f"Document access request {inp.request_id} for viewer {request['user_id']} was {request['status']} by {user['user_id']}.",
                   link="/access")
    return {key: value for key, value in request.items() if key != "tenant_id"}


# ---------------------------------------------------------------------------
# operations
# ---------------------------------------------------------------------------
def op_schema(user: dict) -> dict:
    ec.dbg(AGENT, "schema_start", user=user["user_id"])
    out = []
    for res, meta in sorted(registry().items()):
        un = unlocked_columns(user, res)
        out.append({"resource": res, "columns": [{"name": c, "type": t, "locked": c not in un} for c, t in meta["columns"].items()]})
    ec.audit("access_schema_viewed", "access", "schema", "success", {"resources": len(out)}, user=user)
    ec.dbg(AGENT, "schema_done", resources=len(out))
    return {"resources": out}


def op_preview(inp: PreviewIn, user: dict) -> dict:
    ec.dbg(AGENT, "preview_start", resource=inp.resource, user=user["user_id"])
    reg = registry().get(inp.resource)
    if not reg:
        raise ec.AgentError("NOT_FOUND", "Resource not found")
    all_cols = list(reg["columns"])
    req_cols = inp.columns if inp.columns else all_cols
    unknown = [c for c in req_cols if c not in reg["columns"]]
    if unknown:
        raise ec.AgentError("INVALID_INPUT", "Unknown columns", {"columns": unknown})
    max_limit = int(ec.cfg("access.preview_max_rows", 100))
    limit = min(max(int(inp.limit or max_limit), 1), max_limit)
    if inp.offset < 0:
        raise ec.AgentError("INVALID_INPUT", "offset must be >= 0")
    un = unlocked_columns(user, inp.resource)
    read_cols = [c for c in req_cols if c in un]
    locked = [c for c in req_cols if c not in un]
    ec.dbg(AGENT, "projection", read=len(read_cols), locked=len(locked), limit=limit)
    t = table(inp.resource, *[column(c) for c in all_cols])
    sel = select(*[t.c[c] for c in read_cols]) if read_cols else select(literal(1).label("_n"))
    sel = sel.select_from(t)
    tcol = (ec.cfg("access.tenant_columns", {}) or {}).get(inp.resource)
    if tcol:
        if tcol not in reg["columns"]:
            raise ec.AgentError("ENGINE_FAILED", "Row filter column is misconfigured")
        sel = sel.where(t.c[tcol] == user.get("tenant_id", "default"))  # row-level filter lives IN the query
    if reg["pk"]:
        sel = sel.order_by(*[t.c[p] for p in reg["pk"]])
    sel = sel.limit(limit + 1).offset(inp.offset)
    with ec.data_engine().connect() as c:
        raw = c.execute(sel).all()
    has_more = len(raw) > limit
    rows = []
    for r in raw[:limit]:
        d = {col: _jsonable(r[i]) for i, col in enumerate(read_cols)}
        d.update({col: None for col in locked})
        rows.append({col: d[col] for col in req_cols})
    ec.audit("access_preview", "resource", inp.resource, "success", {"rows": len(rows), "columns_read": read_cols, "columns_locked": locked}, strict=True, user=user)
    ec.dbg(AGENT, "preview_done", rows=len(rows), has_more=has_more)
    return {"resource": inp.resource, "columns": [{"name": c, "locked": c in locked} for c in req_cols], "rows": rows,
            "locked_columns": locked, "limit": limit, "offset": inp.offset, "row_count": len(rows), "has_more": has_more}


def _jsonable(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v
    if isinstance(v, (bytes, bytearray)):
        return f"<{len(v)} bytes>"
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)


def op_request(inp: RequestIn, user: dict) -> dict:
    ec.dbg(AGENT, "request_start", resource=inp.resource, n_cols=len(inp.columns), user=user["user_id"])
    reason = (inp.reason or "").strip()
    if len(reason) < 3:
        raise ec.AgentError("INVALID_INPUT", "A reason is required")
    if len(reason) > 2000:
        raise ec.AgentError("INVALID_INPUT", "Reason is too long")
    reg = registry().get(inp.resource)
    if not reg:
        raise ec.AgentError("NOT_FOUND", "Resource not found")
    cols = sorted({str(c) for c in inp.columns})
    if not cols:
        raise ec.AgentError("INVALID_INPUT", "At least one column is required")
    bad = [c for c in cols if c not in reg["columns"]]
    if bad:
        raise ec.AgentError("INVALID_INPUT", "Unknown columns", {"columns": bad})
    secs = parse_duration(inp.duration)
    if set(cols) <= unlocked_columns(user, inp.resource):
        raise ec.AgentError("CONFLICT", "You already have access to all requested columns")
    rid, stamp = str(uuid.uuid4()), ec.iso_now()
    with ec.app_engine().begin() as c:
        pend = c.execute(select(acl_requests).where(acl_requests.c.user_id == user["user_id"], acl_requests.c.resource == inp.resource,
                                                    acl_requests.c.status == "pending", acl_requests.c.tenant_id == user.get("tenant_id", "default"))).all()
        for p in pend:
            if set(ec.jloads(p.columns, [])) & set(cols):
                raise ec.AgentError("CONFLICT", "A pending request already covers some of these columns", {"request_id": p.request_id})
        c.execute(insert(acl_requests).values(request_id=rid, tenant_id=user.get("tenant_id", "default"), user_id=user["user_id"], resource=inp.resource,
                                              columns=ec.jdumps(cols), reason=reason, duration_seconds=secs, status="pending", created_at=stamp))
        ec.audit("access_requested", "access_request", rid, "success", {"resource": inp.resource, "columns": cols, "duration_seconds": secs,
                                                                        "reason_len": len(reason)}, strict=True, user=user)
    ec.notify_send("access_requested", message=f"Request {rid} by {user['user_id']} (role {user['role']}) for resource {inp.resource}, {len(cols)} column(s).",
                   link="/access")
    ec.dbg(AGENT, "request_done", request_id=rid)
    return {"request_id": rid, "user_id": user["user_id"], "resource": inp.resource, "columns": cols, "reason": reason,
            "duration_seconds": secs, "status": "pending", "created_at": stamp}


def op_requests(user: dict, status: Optional[str] = None) -> dict:
    q = select(acl_requests).where(acl_requests.c.tenant_id == user.get("tenant_id", "default")).order_by(acl_requests.c.created_at.desc()).limit(500)
    if not ec.is_admin(user):
        q = q.where(acl_requests.c.user_id == user["user_id"])
    if status:
        q = q.where(acl_requests.c.status == status)
    with ec.app_engine().connect() as c:
        rows = [_req_dict(r) for r in c.execute(q)]
    ec.audit("access_requests_viewed", "access", "requests", "success", {"returned": len(rows), "admin_view": ec.is_admin(user)}, user=user)
    ec.notify_send(
        "access_requests_viewed",
        message=f"{user['user_id']} (role {user['role']}) viewed {len(rows)} access request(s)"
                f"{' as an administrator' if ec.is_admin(user) else ''}.",
        link="/access",
        dedupe_key=f"access-requests-viewed:{user['user_id']}",
    )
    ec.dbg(AGENT, "requests_listed", n=len(rows))
    return {"requests": rows}


def op_decision(inp: DecisionIn, user: dict) -> dict:
    ec.dbg(AGENT, "decision_start", request_id=inp.request_id, decision=inp.decision, user=user["user_id"])
    if inp.decision not in ("approve", "reject"):
        raise ec.AgentError("INVALID_INPUT", "decision must be approve or reject")
    if not ec.is_admin(user):
        ec.audit("access_denied", "access_request", inp.request_id, "denied", {"reason": "not admin"}, user=user)
        ec.notify_send(
            "access_denied",
            message=f"{user['user_id']} (role {user['role']}) was denied access to decide request {inp.request_id}.",
            link="/access",
        )
        raise ec.AgentError("FORBIDDEN", "Admin only")
    valid_until = None
    if inp.decision == "approve":
        if not inp.valid_until:
            raise ec.AgentError("INVALID_INPUT", "valid_until is required to approve")
        vu = ec.parse_iso(inp.valid_until)
        if vu <= ec.now():
            raise ec.AgentError("INVALID_INPUT", "valid_until must be in the future")
        if vu > ec.now() + timedelta(hours=int(ec.cfg("access.max_duration_hours", 720))):
            raise ec.AgentError("INVALID_INPUT", "valid_until exceeds the maximum grant duration")
        valid_until = ec.iso(vu)
    if inp.decision == "reject" and not (inp.notes or "").strip():
        raise ec.AgentError("INVALID_INPUT", "Rejection notes are required")
    stamp = ec.iso_now()
    grant = signature = None
    with ec.app_engine().begin() as c:
        r = c.execute(select(acl_requests).where(acl_requests.c.request_id == inp.request_id,
                                                 acl_requests.c.tenant_id == user.get("tenant_id", "default")).with_for_update()).first()
        if not r:
            raise ec.AgentError("NOT_FOUND", "Request not found")
        if r.status != "pending":
            raise ec.AgentError("CONFLICT", "Request was already decided", {"status": r.status})
        if r.user_id == user["user_id"]:
            ec.audit("access_denied", "access_request", inp.request_id, "denied", {"reason": "self-approval"}, user=user)
            raise ec.AgentError("FORBIDDEN", "You cannot decide your own request")
        gid = None
        if inp.decision == "approve":
            gid = str(uuid.uuid4())
            cols = ec.jloads(r.columns, [])
            signature = ec.sign(ec.canon({"grant_id": gid, "request_id": r.request_id, "user_id": r.user_id, "resource": r.resource, "columns": cols,
                                          "valid_until": valid_until, "decided_by": user["user_id"], "decided_at": stamp}))
            c.execute(insert(acl_grants).values(grant_id=gid, tenant_id=r.tenant_id, request_id=r.request_id, subject_type="user", subject_id=r.user_id,
                                                resource=r.resource, columns=r.columns, valid_until=valid_until, granted_by=user["user_id"],
                                                granted_at=stamp, signature=ec.jdumps(signature), revoked=0, expiry_logged=0))
            grant = {"grant_id": gid, "valid_until": valid_until}
        res = c.execute(update(acl_requests).where(acl_requests.c.request_id == r.request_id, acl_requests.c.status == "pending").values(
            status="approved" if inp.decision == "approve" else "rejected", decided_by=user["user_id"], decided_at=stamp, notes=inp.notes, grant_id=gid))
        if res.rowcount != 1:
            raise ec.AgentError("CONFLICT", "Request was already decided")
        ec.audit("access_decided", "access_request", r.request_id, "success",
                 {"decision": inp.decision, "resource": r.resource, "valid_until": valid_until, "grant_id": gid,
                  "kid": signature["kid"] if signature else None}, strict=True, user=user)
        new = c.execute(select(acl_requests).where(acl_requests.c.request_id == r.request_id)).one()
    ec.notify_send("access_approved" if inp.decision == "approve" else "access_rejected",
                   message=f"Request {r.request_id} for {r.user_id} {inp.decision}d by {user['user_id']}.", link="/access")
    ec.dbg(AGENT, "decision_done", decision=inp.decision, grant=bool(grant))
    out: dict = {"request": _req_dict(new)}
    if grant:
        out["grant"], out["signature"] = grant, signature
    return out


def sweep_expired() -> int:
    """Audit + notify each expired grant exactly once. Enforcement itself happens at read time."""
    now_s, done = ec.iso_now(), []
    with ec.app_engine().begin() as c:
        rows = c.execute(select(acl_grants).where(acl_grants.c.valid_until <= now_s, acl_grants.c.expiry_logged == 0, acl_grants.c.revoked == 0)).all()
        for g in rows:
            r = c.execute(update(acl_grants).where(acl_grants.c.grant_id == g.grant_id, acl_grants.c.expiry_logged == 0).values(expiry_logged=1))
            if r.rowcount != 1:
                continue
            ec.audit("grant_expired", "access_grant", g.grant_id, "success", {"resource": g.resource, "subject": g.subject_id},
                     strict=True, user={"user_id": "system", "role": "system", "tenant_id": g.tenant_id})
            done.append(g)
    for g in done:  # after commit: never queue a notification while holding the app-DB write lock
        ec.notify_send("grant_expired", message=f"Grant {g.grant_id} for {g.subject_id} on {g.resource} expired.", link="/access")
    ec.dbg(AGENT, "sweep_done", expired=len(done))
    return len(done)


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------
router = APIRouter()


@router.get("/agents/access/schema")
def get_schema(request: Request):
    return ec.handle(request, lambda: op_schema(ec.current_user()))


@router.post("/agents/access/preview")
def post_preview(request: Request, body: dict = Body(default=None)):
    return ec.handle(request, lambda: op_preview(PreviewIn.model_validate(body or {}), ec.current_user()))


@router.post("/agents/access/request")
def post_request(request: Request, body: dict = Body(default=None)):
    return ec.handle(request, lambda: op_request(RequestIn.model_validate(body or {}), ec.current_user()), 201)


@router.get("/agents/access/requests")
def get_requests(request: Request, status: Optional[str] = Query(None)):
    return ec.handle(request, lambda: op_requests(ec.current_user(), status))


@router.post("/agents/access/decision")
def post_decision(request: Request, body: dict = Body(default=None)):
    return ec.handle(request, lambda: op_decision(DecisionIn.model_validate(body or {}), ec.current_user()))


@router.get("/agents/access/documents")
def get_access_documents(request: Request):
    return ec.handle(request, lambda: op_document_sources(ec.current_user()))


@router.post("/agents/access/document-request")
def post_document_request(request: Request, body: dict = Body(default=None)):
    return ec.handle(request, lambda: op_document_request(
        DocumentRequestIn.model_validate(body or {}), ec.current_user()), 201)


@router.get("/agents/access/document-requests")
def get_document_requests(request: Request, status: Optional[str] = Query(None)):
    return ec.handle(request, lambda: op_document_requests(ec.current_user(), status))


@router.post("/agents/access/document-decision")
def post_document_decision(request: Request, body: dict = Body(default=None)):
    return ec.handle(request, lambda: op_document_decision(
        DocumentDecisionIn.model_validate(body or {}), ec.current_user()))


@router.post("/agents/access/document-visibility")
def post_document_visibility(request: Request, body: dict = Body(default=None)):
    return ec.handle(request, lambda: op_document_visibility(
        DocumentVisibilityIn.model_validate(body or {}), ec.current_user()))


def _sweeper_loop() -> None:
    while True:
        time.sleep(int(ec.cfg("access.sweep_interval_seconds", 60)))
        try:
            sweep_expired()
        except Exception as e:
            print(f"[WARN] grant sweeper error: {type(e).__name__}", flush=True)


def install(app) -> None:
    if ec.autostart():
        threading.Thread(target=_sweeper_loop, name="grant-sweeper", daemon=True).start()
