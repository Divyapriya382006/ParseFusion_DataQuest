"""
e_common.py - Person E shared helpers.  Used ONLY by agents 18, 19, 20, 23, 24.

Contents (in order):
  1. debug printing          dbg()
  2. errors + envelope        AgentError, handle()
  3. request context          begin_request(), ReqCtx
  4. adapters to teammates'   current_user(), cfg(), canon(), sign(), verify(), encrypt(), ...
     modules (common.*)       -> every assumption about Person C/D's APIs lives in THIS section only
  5. database engines         app_engine(), audit_engine(), data_engine()
  6. audit adapter            audit()
  7. NOTIFICATION SYSTEM      notify_send(), process_outbox_once(), start_notifier()  (ntfy.sh/dataquest)
  8. register_all(app)        one call that mounts all five agents

Environment variables (secrets never go in the repo):
  E_DEBUG=1|0                 debug prints (default 1)
  E_DB_URL                    app DB (approvals, grants, exports, outbox)       default sqlite:///./e_app.db
  AUDIT_DB_URL                audit DB (INSERT/SELECT-only role in production)   default sqlite:///./e_audit.db
  E_DATA_DB_URL               read-only DB that agents 23/24 query                (required for 23/24)
  NTFY_ENABLED=1|0            default 1
  NTFY_BASE_URL               default https://ntfy.sh
  NTFY_TOPIC_ADMIN            default dataquest      (-> https://ntfy.sh/dataquest)
  NTFY_TOKEN                  optional bearer token
  NTFY_MAX_ATTEMPTS           default 8
  APP_BASE_URL                used to build the ntfy "Click" deep link (optional)
  URL_SIGNING_KEY             only used if common.crypto has no hmac_sign()
"""
from __future__ import annotations

import contextvars
import hashlib
import hmac
import importlib
import json
import os
import re
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import Column, Integer, MetaData, String, Table, Text, create_engine, event, insert, select, update
from sqlalchemy.exc import IntegrityError  # noqa: F401  (re-exported for agents)

# ---------------------------------------------------------------------------
# 1. DEBUG PRINTS
# ---------------------------------------------------------------------------
DEBUG = os.getenv("E_DEBUG", "1") != "0"
_SECRET_KEY_RE = re.compile(r"pass|secret|token|authorization|api[_-]?key|cookie|signature|private|bearer", re.I)


def _short(v: Any, n: int = 160) -> str:
    s = v if isinstance(v, str) else repr(v)
    return s if len(s) <= n else s[:n] + f"...(+{len(s) - n})"


def dbg(agent: str, step: str, **kv: Any) -> None:
    """One debug line per step. Secret-looking keys are always redacted."""
    if not DEBUG:
        return
    parts = []
    for k, v in kv.items():
        parts.append(f"{k}=<redacted>" if _SECRET_KEY_RE.search(k) else f"{k}={_short(v)}")
    rid = _ctx.get().request_id
    print(f"[DEBUG {iso_now()}] [{agent}] [req={rid}] {step}" + (" | " + " ".join(parts) if parts else ""), flush=True)


# ---------------------------------------------------------------------------
# time + json helpers
# ---------------------------------------------------------------------------
def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def iso_now() -> str:
    return iso(now())


def parse_iso(s: str) -> datetime:
    if not isinstance(s, str) or not s.strip():
        raise AgentError("INVALID_INPUT", "Invalid timestamp")
    try:
        dt = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError as e:
        raise AgentError("INVALID_INPUT", f"Invalid ISO-8601 timestamp: {_short(s, 40)}") from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def jdumps(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def jloads(s: Optional[str], default: Any = None) -> Any:
    if s is None or s == "":
        return default
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# 2. ERRORS + RESPONSE ENVELOPE
# ---------------------------------------------------------------------------
HTTP_STATUS = {
    "INVALID_INPUT": 400, "NOT_FOUND": 404, "UNSUPPORTED_FORMAT": 415, "PASSWORD_REQUIRED": 401,
    "CORRUPT_FILE": 422, "TOO_LARGE": 413, "FORBIDDEN": 403, "ENGINE_FAILED": 500, "TIMEOUT": 504, "CONFLICT": 409,
}


class AgentError(Exception):
    """Stable error codes only (see shared preamble rule 8)."""

    def __init__(self, code: str, message: str, details: Optional[dict] = None):
        assert code in HTTP_STATUS, f"unknown error code {code}"
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def error_response(err: AgentError, request_id: str) -> JSONResponse:
    body: dict = {"ok": False, "error": {"code": err.code, "message": err.message}, "request_id": request_id}
    if err.details:
        body["error"]["details"] = jsonable_encoder(err.details)
    return JSONResponse(body, status_code=HTTP_STATUS[err.code])


def handle(request: Request, fn: Callable[[], Any], success_status: int = 200) -> JSONResponse:
    """Runs fn() and wraps the result in {ok,data,request_id} / {ok:false,error,request_id}."""
    ctx = begin_request(request)
    try:
        data = fn()
        return JSONResponse({"ok": True, "data": jsonable_encoder(data), "request_id": ctx.request_id}, status_code=success_status)
    except AgentError as e:
        dbg("http", "agent_error", code=e.code, message=e.message)
        return error_response(e, ctx.request_id)
    except ValidationError as e:
        errs = [{"loc": [str(p) for p in x["loc"]], "msg": x["msg"]} for x in e.errors()]
        dbg("http", "validation_error", errors=errs)
        return error_response(AgentError("INVALID_INPUT", "Request does not match the contract", {"errors": errs}), ctx.request_id)
    except Exception:  # never leak internals / paths
        print(f"[ERROR] unhandled exception req={ctx.request_id}\n{traceback.format_exc()}", flush=True)
        return error_response(AgentError("ENGINE_FAILED", "Internal error"), ctx.request_id)


# ---------------------------------------------------------------------------
# 3. REQUEST CONTEXT
# ---------------------------------------------------------------------------
@dataclass
class ReqCtx:
    request_id: str = "-"
    ip_masked: Optional[str] = None
    user_agent_family: Optional[str] = None
    method: str = ""
    path: str = ""


_ctx: contextvars.ContextVar[ReqCtx] = contextvars.ContextVar("e_req_ctx", default=ReqCtx())
_RID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")


def mask_ip(ip: Optional[str]) -> Optional[str]:
    if not ip:
        return None
    if ":" in ip:  # IPv6: keep first 3 groups
        return ":".join(ip.split(":")[:3]) + "::x"
    parts = ip.split(".")
    return ".".join(parts[:3]) + ".x" if len(parts) == 4 else None


def ua_family(ua: Optional[str]) -> Optional[str]:
    if not ua:
        return None
    u = ua.lower()
    for needle, name in (("edg/", "Edge"), ("firefox", "Firefox"), ("chrome", "Chrome"), ("crios", "Chrome"),
                         ("safari", "Safari"), ("curl", "curl"), ("python", "Python"), ("httpx", "Python"), ("postman", "Postman")):
        if needle in u:
            return name
    return "Other"


def begin_request(request: Request) -> ReqCtx:
    rid = request.headers.get("x-request-id", "")
    if not _RID_RE.match(rid):
        rid = uuid.uuid4().hex
    xff = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    ip = xff or (request.client.host if request.client else None)
    ctx = ReqCtx(rid, mask_ip(ip), ua_family(request.headers.get("user-agent")), request.method, request.url.path)
    _ctx.set(ctx)
    return ctx


def get_ctx() -> ReqCtx:
    return _ctx.get()


# ---------------------------------------------------------------------------
# 4. ADAPTERS TO TEAMMATES' MODULES (common.*)
#    If Person C / D publish different names, change ONLY this section.
# ---------------------------------------------------------------------------
_CAP_ALIASES = {
    "approve": ("approve", "approve_action", "approve_actions", "actions.approve"),
    "execute": ("execute", "execute_action", "execute_actions", "actions.execute"),
    "audit": ("audit", "view_audit", "audit.read", "read_audit", "audit:view"),
    "unmask": ("unmask", "unmask_data", "export.unmask"),
    "admin": ("admin", "access_admin", "administrator"),
}


def try_current_user() -> Optional[dict]:
    try:
        return current_user()
    except Exception:
        return None


def current_user() -> dict:
    """auth.current_user() -> {user_id, role, capabilities}. Raises FORBIDDEN if unauthenticated."""
    from common import auth  # type: ignore
    try:
        u = auth.current_user()
    except Exception as e:
        raise AgentError("FORBIDDEN", "Authentication required") from e
    if not u or not u.get("user_id"):
        raise AgentError("FORBIDDEN", "Authentication required")
    out = dict(u)
    out["user_id"] = str(out["user_id"])
    out.setdefault("role", "user")
    out.setdefault("tenant_id", "default")
    return out


def _caps(user: dict) -> set:
    c = user.get("capabilities") or []
    if isinstance(c, dict):
        return {str(k) for k, v in c.items() if v}
    return {str(x) for x in c}


def has_cap(user: dict, logical: str) -> bool:
    names = _CAP_ALIASES.get(logical, (logical,))
    capabilities = _caps(user)
    return bool(capabilities & {"*", "admin:*", "superuser"}) or any(n in capabilities for n in names)


def is_admin(user: dict) -> bool:
    return user.get("role") == "admin" or has_cap(user, "admin")


def cfg(path: str, default: Any = None) -> Any:
    """Reads /config via common.config (dotted path). Falls back to `default` - never hardcode limits elsewhere."""
    try:
        from common import config  # type: ignore
    except Exception:
        return default
    try:
        if hasattr(config, "get"):
            try:
                v = config.get(path, default)
            except TypeError:
                v = config.get(path)
            return default if v is None else v
        for loader in ("get_config", "load", "all"):
            if hasattr(config, loader):
                node: Any = getattr(config, loader)()
                for part in path.split("."):
                    node = node.get(part) if isinstance(node, dict) else None
                return default if node is None else node
    except Exception as e:  # config service hiccup must not take the agent down
        dbg("config", "read_failed_using_default", path=path, err=type(e).__name__)
    return default


def _crypto():
    from common import crypto  # type: ignore
    return crypto


def _b(x: Any) -> bytes:
    return x if isinstance(x, (bytes, bytearray)) else str(x).encode("utf-8")


def canon(obj: Any) -> bytes:
    return _b(_crypto().canonical_json(obj))


def sha256_hex(data: Any) -> str:
    return _crypto().sha256_hex(_b(data))


def sign(payload: bytes) -> dict:
    s = _crypto().sign(payload)
    if not isinstance(s, dict) or not {"kid", "algorithm", "value"} <= set(s):
        raise AgentError("ENGINE_FAILED", "Signing failed")
    return s


def verify(payload: bytes, sig: Optional[dict]) -> bool:
    if not sig:
        return False
    try:
        return bool(_crypto().verify(payload, sig))
    except Exception:
        return False


def encrypt(plaintext: bytes, aad: bytes) -> bytes:
    return _b(_crypto().encrypt(plaintext, aad))


def decrypt(blob: bytes, aad: bytes) -> bytes:
    return _b(_crypto().decrypt(blob, aad))


def url_sign(message: str) -> str:
    c = _crypto()
    fn = getattr(c, "hmac_sign", None)
    if fn:
        v = fn(message.encode())
        return v if isinstance(v, str) else bytes(v).hex()
    key = os.getenv("URL_SIGNING_KEY")
    if not key:
        raise AgentError("ENGINE_FAILED", "URL signing key not configured")
    return hmac.new(key.encode(), message.encode(), hashlib.sha256).hexdigest()


def url_verify(message: str, sig: str) -> bool:
    try:
        fn = getattr(_crypto(), "hmac_verify", None)
        if fn:
            return bool(fn(message.encode(), sig))
        return hmac.compare_digest(url_sign(message), sig or "")
    except Exception:
        return False


def store():
    from common import store as s  # type: ignore
    return s


def import_agent(name: str):
    """import_agent('23_access_control') - digit-leading module names cannot use normal import syntax."""
    pkg = __package__ or "backend.agents"
    return importlib.import_module(f"{pkg}.{name}")


# ---------------------------------------------------------------------------
# 5. DATABASE ENGINES
# ---------------------------------------------------------------------------
APP_META = MetaData()  # every app-side table of agents 18/20/23/24 registers here
_engines: dict = {}
_eng_lock = threading.Lock()
_ready: set = set()


def _make_engine(url: str, mode: str):
    kw: dict = {"future": True, "pool_pre_ping": True}
    sqlite = url.startswith("sqlite")
    if sqlite:
        kw["connect_args"] = {"check_same_thread": False, "timeout": 30}
    eng = create_engine(url, **kw)
    if sqlite:
        @event.listens_for(eng, "connect")
        def _on_connect(dbapi_conn, _rec):  # noqa
            dbapi_conn.isolation_level = None  # we emit BEGIN ourselves (SQLAlchemy recipe)
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA busy_timeout=30000")
            if mode == "write":
                cur.execute("PRAGMA journal_mode=WAL")
            if mode == "readonly":
                cur.execute("PRAGMA query_only=ON")
            cur.close()

        @event.listens_for(eng, "begin")
        def _on_begin(conn):  # noqa
            conn.exec_driver_sql("BEGIN IMMEDIATE" if mode == "write" else "BEGIN")
    return eng


def _get_engine(kind: str, url: str, mode: str):
    key = f"{kind}|{url}"
    with _eng_lock:
        if key not in _engines:
            dbg("db", "engine_created", kind=kind, dialect=url.split(":")[0])
            _engines[key] = _make_engine(url, mode)
        return _engines[key]


def app_engine():
    """Engine for E's own mutable tables. Tables are created on first use."""
    url = os.getenv("E_DB_URL", "sqlite:///./e_app.db")
    eng = _get_engine("app", url, "write")
    key = (url, len(APP_META.tables))
    if key not in _ready:
        APP_META.create_all(eng)
        _ready.add(key)
        dbg("db", "app_schema_ready", tables=len(APP_META.tables))
    return eng


def audit_engine():
    return _get_engine("audit", os.getenv("AUDIT_DB_URL", "sqlite:///./e_audit.db"), "write")


def data_engine():
    url = os.getenv("E_DATA_DB_URL")
    if not url:
        raise AgentError("ENGINE_FAILED", "Data database is not configured")
    return _get_engine("data", url, "readonly")


def reset_engines() -> None:
    """Used by tests and shutdown."""
    with _eng_lock:
        for e in _engines.values():
            e.dispose()
        _engines.clear()
        _ready.clear()


# ---------------------------------------------------------------------------
# 6. AUDIT ADAPTER (calls agent 19 directly - it is Person E's own module)
# ---------------------------------------------------------------------------
def audit(event_type: str, object_type: str, object_id: Any, outcome: str = "success", details: Optional[dict] = None, *,
          strict: bool = False, user: Optional[dict] = None, case_id: Optional[str] = None,
          correction_of: Optional[str] = None) -> Optional[dict]:
    """strict=True -> if the audit write fails raise ENGINE_FAILED (use for every state-changing step)."""
    ctx = get_ctx()
    ev: dict = {"event_type": event_type, "object_type": object_type, "object_id": str(object_id), "outcome": outcome,
                "details": details or {}, "case_id": case_id, "correction_of": correction_of,
                "request_id": ctx.request_id, "ip_masked": ctx.ip_masked, "user_agent_family": ctx.user_agent_family}
    u = user or try_current_user()
    if u:
        ev.update(actor_id=u.get("user_id"), actor_role=u.get("role"), tenant_id=u.get("tenant_id", "default"))
    try:
        res = import_agent("19_audit").append(ev)
        dbg("audit", "appended", event_type=event_type, outcome=outcome, seq=res.get("seq") if res else None)
        return res
    except Exception as e:
        dbg("audit", "APPEND_FAILED", event_type=event_type, err=f"{type(e).__name__}: {_short(str(e), 120)}")
        if strict:
            raise AgentError("ENGINE_FAILED", "Audit write failed; the action was not performed.") from e
        return None


# ---------------------------------------------------------------------------
# 7. NOTIFICATION SYSTEM  (ntfy)  -> https://ntfy.sh/dataquest
# ---------------------------------------------------------------------------
# Flow: notify_send() -> sanitize -> dedupe -> transactional outbox row -> background worker
#       -> HTTP POST to ntfy with retry/backoff -> audit notification_sent / notification_failed.
# A failure here NEVER blocks the user action. Content = ids, usernames, role, time, event type, link only.
notify_outbox = Table(
    "notify_outbox", APP_META,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("event_type", String(64), nullable=False),
    Column("severity", String(16), nullable=False),
    Column("title", String(200)),
    Column("message", Text),
    Column("link", String(500)),
    Column("dedupe_key", String(200)),
    Column("count", Integer, nullable=False, default=1),
    Column("status", String(16), nullable=False),  # pending | sending | sent | failed
    Column("attempts", Integer, nullable=False, default=0),
    Column("next_attempt_at", String(32)),
    Column("claimed_at", String(32)),
    Column("created_at", String(32)),
    Column("sent_at", String(32)),
    Column("last_error", String(300)),
)

PRIORITY = {"low": 2, "normal": 3, "high": 4, "urgent": 5}
# event_type -> (default severity, ntfy tags, default title, never_collapse)
EVENTS: dict = {
    # platform / auth (Person C calls these)
    "login_success": ("normal", ["key"], "User login", True),
    "login_failures": ("high", ["warning"], "Failed logins over threshold", False),
    "role_change": ("high", ["lock"], "Role or permission changed", True),
    "config_change": ("high", ["gear"], "Configuration changed", True),
    # agent 01 / 16 / 22 (other owners)
    "file_rejected": ("high", ["no_entry"], "Uploaded file rejected", False),
    "finding_high": ("high", ["mag"], "High-severity finding created", False),
    "url_blocked": ("high", ["no_entry_sign"], "Blocked URL attempt", False),
    # agent 18
    "action_submitted": ("high", ["inbox_tray"], "Action submitted for approval", True),
    "action_approved": ("high", ["white_check_mark"], "Action approved", True),
    "action_rejected": ("high", ["x"], "Action rejected", True),
    "action_executed": ("high", ["rocket"], "Action executed", True),
    # agent 19
    "audit_chain_invalid": ("urgent", ["rotating_light", "skull"], "AUDIT CHAIN VERIFICATION FAILED", False),
    "audit_checkpoint_failed": ("high", ["warning"], "Audit checkpoint could not be anchored", False),
    # agent 20
    "export_sensitive": ("high", ["outbox_tray", "warning"], "Unmasked or sensitive export", True),
    "export_history_viewed": ("normal", ["outbox_tray"], "Export history viewed", False),
    # agent 23
    "access_requested": ("high", ["raised_hand"], "New data access request", True),
    "access_approved": ("normal", ["unlock"], "Access request approved", True),
    "access_rejected": ("normal", ["lock"], "Access request rejected", True),
    "access_requests_viewed": ("normal", ["eyes"], "Access requests viewed", False),
    "access_denied": ("high", ["warning"], "Access request action denied", False),
    "document_access_requested": ("high", ["file", "raised_hand"], "Document access requested", False),
    "document_access_approved": ("normal", ["file", "white_check_mark"], "Document access approved", False),
    "document_access_rejected": ("normal", ["file", "no_entry_sign"], "Document access rejected", False),
    "document_visibility_changed": ("high", ["file", "lock"], "Document visibility changed", False),
    "grant_expired": ("normal", ["hourglass"], "Access grant expired", False),
    # agent 24
    "chat_confirm_pending": ("high", ["hourglass_flowing_sand"], "Chat query waiting for approval", True),
    "chat_repeated_block": ("high", ["stop_sign"], "Repeated blocked chat queries", False),
    "chat_confirm_decided": ("normal", ["ballot_box_with_check"], "Chat query approval decided", True),
    # system
    "notification_test": ("low", ["bell"], "Notification test", True),
}

_RE_JWT = re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+\b")
_RE_BEARER = re.compile(r"(?i)\bbearer\s+\S+")
_RE_SECRET_KV = re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key)\b\s*[=:]\s*\S+")
_RE_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
_RE_IPV4 = re.compile(r"\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b")
_RE_LONGNUM = re.compile(r"(?<![\w-])\d{9,}(?![\w-])")


def sanitize_text(s: str, limit: int = 400) -> str:
    """Notification content rules: no tokens, secrets, e-mails, full IPs or long account-like numbers."""
    s = _RE_JWT.sub("[token]", s or "")
    s = _RE_BEARER.sub("[token]", s)
    s = _RE_SECRET_KV.sub(lambda m: m.group(1) + "=[redacted]", s)
    s = _RE_EMAIL.sub("[email]", s)
    s = _RE_IPV4.sub(r"\1.x", s)
    s = _RE_LONGNUM.sub("[number]", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[: limit - 3] + "..."


def _ascii_header(s: str) -> str:
    return re.sub(r"[\r\n]+", " ", s).encode("ascii", "replace").decode("ascii")[:200]


def notify_send(event_type: str, severity: Optional[str] = None, title: Optional[str] = None, message: str = "",
                link: Optional[str] = None, dedupe_key: Optional[str] = None) -> Optional[int]:
    """Standard-3 signature. Returns outbox id, or None when disabled/failed. NEVER raises."""
    try:
        if os.getenv("NTFY_ENABLED", "1") == "0":
            dbg("notify", "disabled_skip", event_type=event_type)
            return None
        if os.getenv("E_USE_COMMON_NOTIFY") == "1":  # switch to Person A's module once it lands
            from common import notify as _n  # type: ignore
            _n.send(event_type, severity or "normal", title or event_type, message, link, dedupe_key)
            return None
        sev_default, _tags, title_default, never_collapse = EVENTS.get(event_type, ("normal", [], event_type, False))
        sev = severity if severity in PRIORITY else sev_default
        t = sanitize_text(title or title_default, 120)
        m = sanitize_text(message)
        eng = app_engine()
        stamp = iso_now()
        collapsible = bool(dedupe_key) and not never_collapse
        window = int(cfg("notify.dedupe_window_seconds", 300))
        with eng.begin() as c:
            if collapsible:
                since = iso(now() - timedelta(seconds=window))
                row = c.execute(select(notify_outbox.c.id).where(
                    notify_outbox.c.dedupe_key == dedupe_key, notify_outbox.c.status == "pending",
                    notify_outbox.c.created_at >= since).limit(1)).first()
                if row:
                    c.execute(update(notify_outbox).where(notify_outbox.c.id == row.id).values(count=notify_outbox.c.count + 1))
                    dbg("notify", "collapsed_into_pending", id=row.id, dedupe_key=dedupe_key)
                    return int(row.id)
            res = c.execute(insert(notify_outbox).values(
                event_type=event_type, severity=sev, title=t, message=m, link=link, dedupe_key=dedupe_key if collapsible else None,
                count=1, status="pending", attempts=0, next_attempt_at=stamp, created_at=stamp))
            oid = int(res.inserted_primary_key[0])
        dbg("notify", "queued", id=oid, event_type=event_type, severity=sev)
        if autostart():
            start_notifier()  # idempotent
        _wake.set()
        return oid
    except Exception as e:
        print(f"[WARN] notify_send failed (action NOT blocked): {type(e).__name__}: {_short(str(e), 120)}", flush=True)
        return None


def _transport(url: str, data: bytes, headers: dict, timeout: float) -> int:
    """HTTP POST. Module-level so tests can replace it with a mock ntfy server."""
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return int(r.status)
    except urllib.error.HTTPError as e:
        return int(e.code)


def _deliver(row: Any) -> int:
    base = os.getenv("NTFY_BASE_URL", "https://ntfy.sh").rstrip("/")
    topic = os.getenv("NTFY_TOPIC_ADMIN", "dataquest")
    url = f"{base}/{urllib.parse.quote(topic, safe='')}"
    prio_map = cfg("notify.priority_map", None) or PRIORITY
    tags = EVENTS.get(row.event_type, ("", [], "", False))[1]
    title = row.title + (f" (x{row.count})" if row.count and row.count > 1 else "")
    headers = {"Title": _ascii_header(title), "Priority": str(prio_map.get(row.severity, 3)),
               "Tags": ",".join(tags), "Content-Type": "text/plain; charset=utf-8"}
    app_base = os.getenv("APP_BASE_URL", "").rstrip("/")
    if row.link:
        headers["Click"] = row.link if row.link.startswith("http") else (app_base + row.link if app_base else "")
        if not headers["Click"]:
            del headers["Click"]
    tok = os.getenv("NTFY_TOKEN")
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    body = f"{row.message}\nevent: {row.event_type} | outbox: {row.id} | {iso_now()}"
    dbg("notify", "POST", url=url, event_type=row.event_type, priority=headers["Priority"], has_token=bool(tok))
    return _transport(url, body.encode("utf-8"), headers, 10.0)


def process_outbox_once(limit: int = 20, now_dt: Optional[datetime] = None) -> dict:
    """Sends due notifications with exponential backoff. Called by the worker thread (and directly by tests)."""
    eng = app_engine()
    t_now = now_dt or now()
    max_attempts = int(os.getenv("NTFY_MAX_ATTEMPTS", "8"))
    base, cap = float(cfg("notify.backoff_base_seconds", 5)), float(cfg("notify.backoff_cap_seconds", 600))
    out = {"sent": 0, "retry": 0, "failed": 0}
    with eng.begin() as c:  # un-stick rows claimed by a crashed worker
        c.execute(update(notify_outbox).where(notify_outbox.c.status == "sending", notify_outbox.c.claimed_at < iso(t_now - timedelta(seconds=300)))
                  .values(status="pending"))
        ids = [r.id for r in c.execute(select(notify_outbox.c.id).where(
            notify_outbox.c.status == "pending", notify_outbox.c.next_attempt_at <= iso(t_now)).order_by(notify_outbox.c.id).limit(limit))]
    for oid in ids:
        with eng.begin() as c:  # claim (safe with several workers)
            r = c.execute(update(notify_outbox).where(notify_outbox.c.id == oid, notify_outbox.c.status == "pending")
                          .values(status="sending", attempts=notify_outbox.c.attempts + 1, claimed_at=iso(t_now)))
            if r.rowcount != 1:
                continue
            row = c.execute(select(notify_outbox).where(notify_outbox.c.id == oid)).one()
        try:
            code = _deliver(row)
            ok, err = 200 <= code < 300, (None if 200 <= code < 300 else f"http {code}")
        except Exception as e:
            ok, err = False, type(e).__name__
        with eng.begin() as c:
            if ok:
                c.execute(update(notify_outbox).where(notify_outbox.c.id == oid).values(status="sent", sent_at=iso(t_now), last_error=None))
            elif row.attempts >= max_attempts:
                c.execute(update(notify_outbox).where(notify_outbox.c.id == oid).values(status="failed", last_error=err))
            else:
                delay = min(cap, base * (2 ** (row.attempts - 1)))
                c.execute(update(notify_outbox).where(notify_outbox.c.id == oid).values(
                    status="pending", last_error=err, next_attempt_at=iso(t_now + timedelta(seconds=delay))))
        if ok:
            out["sent"] += 1
            audit("notification_sent", "notification", oid, "success", {"event_type": row.event_type, "attempts": row.attempts})
        elif row.attempts >= max_attempts:
            out["failed"] += 1
            audit("notification_failed", "notification", oid, "error", {"event_type": row.event_type, "attempts": row.attempts, "error": err})
        else:
            out["retry"] += 1
        dbg("notify", "delivery_result", id=oid, ok=ok, attempts=row.attempts, error=err)
    return out


_wake = threading.Event()
_stop = threading.Event()
_worker: Optional[threading.Thread] = None


def _worker_loop() -> None:
    while not _stop.is_set():
        try:
            process_outbox_once()
        except Exception as e:
            print(f"[WARN] notifier loop error: {type(e).__name__}", flush=True)
        _wake.wait(timeout=float(cfg("notify.poll_seconds", 5)))
        _wake.clear()


def autostart() -> bool:
    """Background threads (notifier, audit verifier, grant sweeper) start unless E_AUTOSTART_WORKERS=0."""
    return os.getenv("E_AUTOSTART_WORKERS", "1") != "0"


def start_notifier() -> None:
    global _worker
    if _worker and _worker.is_alive():
        return
    _stop.clear()
    _worker = threading.Thread(target=_worker_loop, name="ntfy-worker", daemon=True)
    _worker.start()
    dbg("notify", "worker_started", topic=os.getenv("NTFY_TOPIC_ADMIN", "dataquest"))


def stop_notifier() -> None:
    _stop.set()
    _wake.set()


# ---------------------------------------------------------------------------
# 8. ONE-CALL REGISTRATION (give this line to Person C for main.py)
# ---------------------------------------------------------------------------
AGENT_MODULES = ["19_audit", "18_human_approval", "20_export", "23_access_control", "24_chat_sql"]


def register_all(app) -> None:
    """register_all(app): mounts the routers, the audit middleware, and the background workers."""
    for name in AGENT_MODULES:
        m = import_agent(name)
        app.include_router(m.router)
        if hasattr(m, "install"):
            m.install(app)

    @app.middleware("http")
    async def _audit_http_requests(request: Request, call_next):
        ctx = begin_request(request)
        try:
            response = await call_next(request)
            outcome = "success" if response.status_code < 400 else "error"
            audit("http_request", "http", ctx.request_id, outcome, {
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
            }, user=try_current_user())
            return response
        except Exception:
            audit("http_request", "http", ctx.request_id, "error", {
                "method": request.method,
                "path": request.url.path,
                "status_code": 500,
            }, user=try_current_user())
            raise

    app_engine()  # create E's tables now (fail fast if the DB is unreachable)
    if autostart():
        start_notifier()
    dbg("register", "all_agents_mounted", modules=",".join(AGENT_MODULES))


if __name__ == "__main__":  # python -m backend.agents.e_common ntfy-test
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "ntfy-test":
        oid = notify_send("notification_test", message="Test notification from Person E notifier. No data included.")
        print("queued outbox id:", oid)
        print("delivery:", process_outbox_once())
    else:
        print("usage: python -m backend.agents.e_common ntfy-test")
