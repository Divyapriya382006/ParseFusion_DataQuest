"""Human approval lifecycle for proposed actions."""
from __future__ import annotations

import json
import threading
import uuid
from datetime import timedelta
from typing import Any, Optional

from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Column, Integer, MetaData, String, Table, Text, select

from . import e_common as ec

AGENT = "18-human-approval"
_META = ec.APP_META
action_state = Table(
    "action_state", _META,
    Column("action_id", String(128), primary_key=True),
    Column("tenant_id", String(128), nullable=False),
    Column("status", String(32), nullable=False),
    Column("content_hash", String(64), nullable=False),
    Column("approval_signature", Text),
    Column("approved_at", String(40)),
    Column("approved_by", String(128)),
    Column("version", Integer, nullable=False, default=1),
)
action_events = Table(
    "action_events", _META,
    Column("event_id", String(36), primary_key=True),
    Column("action_id", String(128), nullable=False),
    Column("tenant_id", String(128), nullable=False),
    Column("event_type", String(64), nullable=False),
    Column("actor_id", String(128), nullable=False),
    Column("created_at", String(40), nullable=False),
    Column("details", Text, nullable=False),
)
executed_keys = Table(
    "executed_keys", _META,
    Column("idempotency_key", String(256), primary_key=True),
    Column("action_id", String(128), nullable=False, unique=True),
)

_transition_lock = threading.RLock()
_EDITABLE_FIELDS = {"subject", "body", "labels"}
_DECISIONS = {"submit", "approve", "reject", "execute", "save_edit"}


class ApprovalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_id: str
    decision: str
    rejection_reason: Optional[str] = None
    edited_fields: Optional[dict[str, Any]] = None


def _fail(code: str, message: str, details: Optional[dict] = None):
    raise ec.AgentError(code, message, details)


def _content_hash(action: dict) -> str:
    content = {
        key: value for key, value in action.items()
        if key not in {"status", "updated_at", "approved_at", "approved_by", "approval_signature"}
    }
    return ec.sha256_hex(ec.canon(content))


def _load_state(action_id: str, tenant_id: str):
    ec.app_engine()
    with ec.app_engine().connect() as conn:
        row = conn.execute(select(action_state).where(
            action_state.c.action_id == action_id,
            action_state.c.tenant_id == tenant_id,
        )).first()
    return row


def _store_action(action: dict) -> None:
    ec.store().put("action", action["action_id"], action)


def _record_event(action_id: str, tenant_id: str, event_type: str, actor_id: str, details: dict) -> None:
    with ec.app_engine().begin() as conn:
        conn.execute(action_events.insert().values(
            event_id=str(uuid.uuid4()), action_id=action_id, tenant_id=tenant_id, event_type=event_type,
            actor_id=actor_id, created_at=ec.iso_now(), details=ec.jdumps(details),
        ))


def _notify(event_type: str, action_id: str, user: dict, link: str) -> None:
    ec.notify_send(event_type, message=f"Action {action_id} changed by {user['user_id']}.",
                   link=link, dedupe_key=f"{event_type}:{action_id}")


def _transition(action: dict, user: dict, decision: str, inp: ApprovalIn) -> dict:
    action_id = str(action["action_id"])
    tenant_id = str(action.get("tenant_id") or "default")
    if tenant_id != str(user.get("tenant_id") or "default"):
        _fail("NOT_FOUND", "Action not found")
    state = _load_state(action_id, tenant_id)
    status = state.status if state else str(action.get("status") or "draft")
    previous_status = status
    changed = dict(action)
    signature = None
    edited_fields: list[str] = []
    digest = _content_hash(action)
    event_by_decision = {
        "submit": "action_submit", "approve": "action_approve", "reject": "action_reject",
        "execute": "action_execute", "save_edit": "action_edit",
    }
    event_type = event_by_decision[decision]

    if decision == "submit":
        if status != "draft":
            _fail("CONFLICT", "Only draft actions may be submitted",
                  {"allowed_decisions": ["save_edit"], "allowed_next_states": ["draft"]})
        changed["status"] = "in_review"
    elif decision in ("approve", "reject"):
        if status != "in_review":
            _fail("CONFLICT", "Action is not awaiting a decision",
                  {"allowed_decisions": ["submit"] if status == "draft" else [],
                   "allowed_next_states": ["in_review"]})
        if not ec.has_cap(user, "approve"):
            ec.audit(event_type, "action", action_id, "denied", {"reason": "missing capability", "decision": decision}, strict=False, user=user)
            _fail("FORBIDDEN", "Approval capability required")
        if str(action.get("created_by")) == str(user["user_id"]):
            ec.audit(event_type, "action", action_id, "denied", {"reason": "self-approval", "decision": decision}, strict=False, user=user)
            _fail("FORBIDDEN", "Action creators cannot approve or reject their own actions")
        if decision == "reject":
            reason = (inp.rejection_reason or "").strip()
            if not reason:
                _fail("INVALID_INPUT", "A rejection reason is required")
            changed["status"] = "rejected"
        else:
            changed["status"] = "approved"
            signature_payload = ec.canon({
                "action_id": action_id, "tenant_id": tenant_id, "content_hash": digest,
                "approved_by": str(user["user_id"]), "approved_at": ec.iso_now(),
            })
            signature = ec.sign(signature_payload)
    elif decision == "execute":
        if status != "approved" or state is None:
            _fail("CONFLICT", "Only approved actions may be executed")
        if not ec.has_cap(user, "execute"):
            _fail("FORBIDDEN", "Execution capability required")
        if digest != state.content_hash:
            _fail("CONFLICT", "Action changed after approval")
        approved_at = ec.parse_iso(state.approved_at)
        ttl = max(0, int(ec.cfg("actions.signature_ttl_seconds", 3600)))
        if (ec.now() - approved_at).total_seconds() >= ttl:
            _fail("CONFLICT", "Approval signature expired")
        try:
            sig = ec.jloads(state.approval_signature, {})
            signed_payload = ec.canon({
                "action_id": action_id, "tenant_id": tenant_id, "content_hash": state.content_hash,
                "approved_by": state.approved_by, "approved_at": state.approved_at,
            })
            if not ec.verify(signed_payload, sig):
                _fail("CONFLICT", "Approval signature is invalid")
        except ec.AgentError:
            raise
        except Exception as exc:
            raise ec.AgentError("CONFLICT", "Approval signature is invalid") from exc
        idem = str(action.get("idempotency_key") or "")
        if not idem:
            _fail("INVALID_INPUT", "Action idempotency key is required")
        with ec.app_engine().connect() as conn:
            prior = conn.execute(select(executed_keys.c.action_id).where(executed_keys.c.idempotency_key == idem)).first()
        if prior:
            _fail("CONFLICT", "This idempotency key has already been executed")
        changed["status"] = "executed"
    else:
        edits = inp.edited_fields
        if not edits:
            _fail("INVALID_INPUT", "edited_fields must be a non-empty object")
        invalid = set(edits) - _EDITABLE_FIELDS
        if invalid:
            _fail("INVALID_INPUT", "Fields cannot be edited", {"fields": sorted(invalid)})
        if any(not isinstance(value, (str, list)) for value in edits.values()) or \
                any(isinstance(value, str) and len(value) > 10000 for value in edits.values()):
            _fail("INVALID_INPUT", "Editable field values must be bounded strings or string lists")
        if "labels" in edits and (not isinstance(edits["labels"], list) or
                                  any(not isinstance(label, str) for label in edits["labels"])):
            _fail("INVALID_INPUT", "labels must be a list of strings")
        if not (ec.is_admin(user) or str(action.get("created_by")) == str(user["user_id"])):
            _fail("FORBIDDEN", "Only the action creator may edit this action")
        changed.update(edits)
        edited_fields = sorted(edits)
        changed["labels"] = list(dict.fromkeys([*(changed.get("labels") or []), "human_edited"]))
        changed["status"] = "in_review" if status in {"approved", "rejected"} else status
        digest = _content_hash(changed)

    if decision == "reject":
        event_details = {"previous_status": previous_status, "status": changed["status"],
                         "rejection_reason": inp.rejection_reason}
    elif decision == "save_edit":
        event_details = {"previous_status": previous_status, "status": changed["status"],
                         "edited_fields": edited_fields, "content_hash": digest}
    else:
        event_details = {"previous_status": previous_status, "status": changed["status"], "content_hash": digest}

    # Audit before changing either durable state or the source action.
    ec.audit(event_type, "action", action_id, "success", event_details, strict=True, user=user)
    if decision == "approve":
        ec.audit("signature_created", "action", action_id, "success",
                 {"content_hash": digest, "algorithm": signature["algorithm"]}, strict=True, user=user)
    if decision == "execute":
        ec.audit("action_execute", "action", action_id, "success", {"content_hash": digest}, strict=True, user=user)

    stamp = ec.iso_now()
    with ec.app_engine().begin() as conn:
        if decision in {"submit", "save_edit"} and state is None:
            conn.execute(action_state.insert().values(
                action_id=action_id, tenant_id=tenant_id, status=changed["status"],
                content_hash=digest, approval_signature=None, approved_at=None, approved_by=None, version=1,
            ))
        elif decision == "approve":
            signature_payload = ec.canon({
                "action_id": action_id, "tenant_id": tenant_id, "content_hash": digest,
                "approved_by": str(user["user_id"]), "approved_at": stamp,
            })
            signature = ec.sign(signature_payload)
            conn.execute(action_state.update().where(action_state.c.action_id == action_id).values(
                status="approved", content_hash=digest, approval_signature=ec.jdumps(signature),
                approved_at=stamp, approved_by=str(user["user_id"]), version=action_state.c.version + 1,
            ))
        elif decision in {"reject", "save_edit"}:
            if state:
                conn.execute(action_state.update().where(action_state.c.action_id == action_id).values(
                    status=changed["status"], content_hash=digest,
                    approval_signature=None, approved_at=None, approved_by=None,
                    version=action_state.c.version + 1,
                ))
            elif decision == "reject":
                conn.execute(action_state.insert().values(
                    action_id=action_id, tenant_id=tenant_id, status="rejected", content_hash=digest,
                    approval_signature=None, approved_at=None, approved_by=None, version=1,
                ))
        elif decision == "execute":
            conn.execute(action_state.update().where(action_state.c.action_id == action_id).values(
                status="executed", version=action_state.c.version + 1,
            ))
            conn.execute(executed_keys.insert().values(idempotency_key=str(action["idempotency_key"]), action_id=action_id))

    _store_action(changed)
    if decision == "execute":
        ec.store().put("action_result", str(changed["idempotency_key"]), {
            "action_id": action_id, "status": "executed", "executed_by": str(user["user_id"]), "executed_at": stamp,
        })
    _record_event(action_id, tenant_id, event_type, str(user["user_id"]), event_details)
    notify_events = {
        "submit": ("action_submitted", "/actions"),
        "approve": ("action_approved", "/actions"),
        "reject": ("action_rejected", "/actions"),
        "execute": ("action_executed", "/actions"),
    }
    if decision in notify_events:
        notification_type, link = notify_events[decision]
        _notify(notification_type, action_id, user, link)
    event_out = {"event_type": event_type, **event_details}
    if decision == "approve":
        event_out["content_hash"] = digest
    result = {"action": changed, "event": event_out}
    if signature is not None:
        result["signature"] = signature
    return result


def run(inp: ApprovalIn, user: dict) -> dict:
    if inp.decision not in _DECISIONS:
        _fail("INVALID_INPUT", "Unknown action decision")
    if inp.decision == "save_edit" and inp.edited_fields is None:
        _fail("INVALID_INPUT", "edited_fields is required")
    with _transition_lock:
        action = ec.store().get("action", inp.action_id)
        if not isinstance(action, dict) or action.get("tenant_id", "default") != user.get("tenant_id", "default"):
            _fail("NOT_FOUND", "Action not found")
        return _transition(dict(action), user, inp.decision, inp)


def build_router():
    router = APIRouter()

    @router.post("/agents/human-approval")
    def human_approval(request: Request, body: dict = Body(default=None)):
        return ec.handle(request, lambda: run(ApprovalIn.model_validate(body or {}), ec.current_user()))

    return router


router = build_router()
