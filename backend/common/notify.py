"""common/notify - admin push notifications through ntfy (Standard 3).  Owner: Person A.

Public API (everything else is private):
    send(event_type, severity, title, message, link=None, dedupe_key=None) -> outbox_id | None
    send_event(event_type, fields=None, *, severity=None, title=None, link=None, dedupe_key=None)
    login_success(...), login_failed_threshold(...), access_requested(...), ...  (typed helpers)
    mask_ip(ip), ua_family(user_agent)
    drain_once(), flush(timeout), start_worker(), shutdown(), stats(), test_connection()

Guarantees
    * send() NEVER raises and NEVER blocks the caller on the network: it only does one SQLite insert.
    * Delivery runs in a background worker (transactional outbox, exponential backoff + jitter,
      max-attempt cap, Retry-After honoured, stale 'sending' rows reclaimed).
    * Every successful delivery -> audit 'notification_sent' (outbox id); every permanent failure
      -> audit 'notification_failed'.
    * Content is scrubbed: no tokens/JWTs/passwords/long opaque strings, IPs masked, length capped,
      neutral wording enforced on titles.  send_event() additionally whitelists field names.
    * Dedupe: bursts sharing a dedupe_key collapse into one pending digest with a count.
      login_success, access_requested and urgent alerts are NEVER collapsed.

Environment (backend only, never exposed to the frontend)
    NTFY_ENABLED=1            NTFY_BASE_URL=https://ntfy.sh      NTFY_TOPIC_ADMIN=dataquest
    NTFY_TOKEN=               (bearer, optional)                 NOTIFY_APP_BASE_URL=https://app.example
    NOTIFY_OUTBOX_PATH=notify_outbox.sqlite3   NOTIFY_MAX_ATTEMPTS=8   NOTIFY_BACKOFF_BASE_S=2
    NOTIFY_BACKOFF_MAX_S=300  NOTIFY_HTTP_TIMEOUT_S=8   NOTIFY_POLL_INTERVAL_S=1.0
    NOTIFY_DEDUPE_WINDOW_S=300  NOTIFY_MAX_PENDING=5000  NOTIFY_AUTOSTART=1
    NOTIFY_PRIORITY_MAP='{"low":2,"normal":3,"high":4,"urgent":5}'

SECURITY NOTE: ntfy.sh/dataquest is a PUBLIC topic - anyone who knows the name can read it.  Messages only
ever carry IDs/roles/timestamps/links (never document data), but for production use a long random topic
or a self-hosted ntfy with ACL + NTFY_TOKEN.

Manual test:  python -m backend.common.notify --test
"""
from __future__ import annotations

import atexit
import json
import os
import random
import re
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

__all__ = [
    "send", "send_event", "mask_ip", "ua_family", "drain_once", "flush", "start_worker", "shutdown",
    "stats", "test_connection", "configure", "login_success", "login_failed_threshold",
    "access_requested", "access_decided", "action_transition", "chat_confirm_pending",
    "chat_repeated_block", "url_blocked", "file_rejected", "export_sensitive",
    "high_severity_finding", "config_changed", "audit_chain_invalid",
]

_TAG = "notify"


def _dbg(step: str, msg: str = "") -> None:
    if os.getenv("AGENT_DEBUG", "1") != "0":
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        print(f"{ts} [DEBUG][{_TAG}] {step} | {msg}", flush=True)


# --------------------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------------------
@dataclass
class NotifyConfig:
    enabled: bool = True
    base_url: str = "https://ntfy.sh"
    topic: str = "dataquest"
    token: str = ""
    app_base_url: str = ""
    outbox_path: str = "notify_outbox.sqlite3"
    max_attempts: int = 8
    backoff_base_s: float = 2.0
    backoff_max_s: float = 300.0
    http_timeout_s: float = 8.0
    poll_interval_s: float = 1.0
    dedupe_window_s: float = 300.0
    max_pending: int = 5000
    autostart: bool = True
    stale_sending_s: float = 120.0
    max_message_chars: int = 600
    priority_map: Dict[str, int] = field(default_factory=lambda: {"low": 2, "normal": 3, "high": 4, "urgent": 5})

    @classmethod
    def from_env(cls) -> "NotifyConfig":
        def _f(name: str, default: float) -> float:
            try:
                return float(os.getenv(name, default))
            except ValueError:
                return float(default)

        pm = {"low": 2, "normal": 3, "high": 4, "urgent": 5}
        raw = os.getenv("NOTIFY_PRIORITY_MAP")
        if raw:
            try:
                for k, v in json.loads(raw).items():
                    pm[str(k).lower()] = max(1, min(5, int(v)))
            except Exception:
                _dbg("config", "NOTIFY_PRIORITY_MAP invalid -> defaults")
        return cls(
            enabled=os.getenv("NTFY_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off", ""),
            base_url=os.getenv("NTFY_BASE_URL", "https://ntfy.sh").rstrip("/"),
            topic=os.getenv("NTFY_TOPIC_ADMIN", "dataquest").strip().strip("/"),
            token=os.getenv("NTFY_TOKEN", ""),
            app_base_url=os.getenv("NOTIFY_APP_BASE_URL", "").rstrip("/"),
            outbox_path=os.getenv("NOTIFY_OUTBOX_PATH", "notify_outbox.sqlite3"),
            max_attempts=int(_f("NOTIFY_MAX_ATTEMPTS", 8)),
            backoff_base_s=_f("NOTIFY_BACKOFF_BASE_S", 2),
            backoff_max_s=_f("NOTIFY_BACKOFF_MAX_S", 300),
            http_timeout_s=_f("NOTIFY_HTTP_TIMEOUT_S", 8),
            poll_interval_s=_f("NOTIFY_POLL_INTERVAL_S", 1.0),
            dedupe_window_s=_f("NOTIFY_DEDUPE_WINDOW_S", 300),
            max_pending=int(_f("NOTIFY_MAX_PENDING", 5000)),
            autostart=os.getenv("NOTIFY_AUTOSTART", "1") != "0",
            priority_map=pm,
        )


_CFG: NotifyConfig = NotifyConfig.from_env()
_LOCK = threading.RLock()
_CONN: Optional[sqlite3.Connection] = None
_CONN_PATH: Optional[str] = None
_WORKER: Optional[threading.Thread] = None
_STOP = threading.Event()
_WAKE = threading.Event()
_COUNTERS: Dict[str, int] = {"queued": 0, "collapsed": 0, "sent": 0, "retried": 0, "dead": 0, "dropped": 0, "disabled": 0}
_WARNED_PUBLIC = False


def configure(**overrides: Any) -> NotifyConfig:
    """Reload from env and apply overrides (used by tests / app start-up). Closes the DB if the path changed."""
    global _CFG, _CONN, _CONN_PATH
    cfg = NotifyConfig.from_env()
    for k, v in overrides.items():
        if not hasattr(cfg, k):
            raise AttributeError(k)
        setattr(cfg, k, v)
    with _LOCK:
        _CFG = cfg
        if _CONN is not None and _CONN_PATH != cfg.outbox_path:
            try:
                _CONN.close()
            except Exception:
                pass
            _CONN, _CONN_PATH = None, None
    _dbg("configure", f"enabled={cfg.enabled} base={cfg.base_url} topic_len={len(cfg.topic)} outbox_set=True")
    return cfg


# --------------------------------------------------------------------------------------
# event catalogue: event_type -> (default severity, title, tags, default link path, collapsible)
# --------------------------------------------------------------------------------------
EVENTS: Dict[str, Tuple[str, str, List[str], str, bool]] = {
    "login_success": ("normal", "Login", ["key"], "/admin/audit", False),
    "login_failed_threshold": ("high", "Repeated failed logins", ["warning"], "/admin/audit", True),
    "access_requested": ("high", "New access request", ["inbox_tray"], "/admin/access", False),
    "access_approved": ("normal", "Access request approved", ["white_check_mark"], "/admin/access", True),
    "access_rejected": ("normal", "Access request rejected", ["no_entry_sign"], "/admin/access", True),
    "access_expired": ("normal", "Access grant expired", ["hourglass"], "/admin/access", True),
    "action_submitted": ("high", "Action submitted for approval", ["memo"], "/admin/approvals", False),
    "action_approved": ("high", "Action approved", ["white_check_mark"], "/admin/approvals", False),
    "action_rejected": ("high", "Action rejected", ["x"], "/admin/approvals", False),
    "action_executed": ("high", "Action executed", ["rocket"], "/admin/approvals", False),
    "chat_confirm_pending": ("high", "Chat query awaiting confirmation", ["hourglass_flowing_sand"], "/admin/chat", True),
    "chat_repeated_block": ("high", "Repeated blocked chat queries", ["stop_sign"], "/admin/chat", True),
    "url_blocked": ("high", "Blocked URL ingest attempt", ["shield"], "/admin/audit", True),
    "file_rejected_malware": ("high", "Uploaded file rejected by safety checks", ["biohazard"], "/admin/audit", True),
    "export_sensitive": ("high", "Unmasked or sensitive export", ["outbox_tray"], "/admin/exports", False),
    "finding_high_severity": ("high", "High-severity finding created", ["mag"], "/admin/findings", False),
    "role_change": ("high", "Role or permission change", ["busts_in_silhouette"], "/admin/users", False),
    "config_change": ("high", "Configuration change", ["gear"], "/admin/config", False),
    "audit_chain_invalid": ("urgent", "Audit chain verification failed", ["rotating_light"], "/admin/audit", False),
    "notification_test": ("low", "Notification test", ["bell"], "", False),
}
NEVER_COLLAPSE = {"login_success", "access_requested"}  # spec: logins and access requests are never collapsed

# --------------------------------------------------------------------------------------
# scrubbing (no document text / secrets / PII in notifications)
# --------------------------------------------------------------------------------------
_RE_IPV4 = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b")
_RE_IPV6 = re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{0,4}\b")
_RE_JWT = re.compile(r"\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]*\b")
_RE_BEARER = re.compile(r"(?i)\bbearer\s+\S+")
_RE_KV_SECRET = re.compile(r"(?i)\b(password|passwd|pwd|secret|token|api[_\-]?key|authorization|cookie)\b\s*[:=]\s*\S+")
_RE_OPAQUE = re.compile(r"[A-Za-z0-9+/_=\-]{40,}")
_RE_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_BANNED = {"fraud": "potential discrepancy", "fraudulent": "potentially inconsistent", "deceptive": "inconsistent",
           "ineligible": "under review", "false": "inconsistent"}


def mask_ip(ip: Optional[str]) -> str:
    """Mask the last octet (IPv4) / keep first 3 hextets (IPv6)."""
    if not ip:
        return "unknown"
    ip = str(ip).strip()
    m = _RE_IPV4.fullmatch(ip)
    if m:
        return f"{m.group(1)}.{m.group(2)}.{m.group(3)}.x"
    if ":" in ip:
        parts = ip.split(":")
        return ":".join(parts[:3]) + ":x"
    return "unknown"


def ua_family(user_agent: Optional[str]) -> str:
    ua = (user_agent or "").lower()
    if not ua:
        return "unknown"
    for needle, name in (("edg/", "Edge"), ("opr/", "Opera"), ("firefox", "Firefox"), ("chrome", "Chrome"),
                         ("safari", "Safari"), ("curl", "curl"), ("python", "python-client"), ("postman", "Postman")):
        if needle in ua:
            return name
    return "other"


def _scrub(text: Any, max_chars: int) -> str:
    s = "" if text is None else str(text)
    s = _RE_CTRL.sub("", s)
    s = _RE_JWT.sub("[redacted]", s)
    s = _RE_BEARER.sub("[redacted]", s)
    s = _RE_KV_SECRET.sub(lambda m: f"{m.group(1)}=[redacted]", s)
    s = _RE_IPV4.sub(lambda m: f"{m.group(1)}.{m.group(2)}.{m.group(3)}.x", s)
    s = _RE_IPV6.sub(lambda m: mask_ip(m.group(0)), s)
    s = _RE_OPAQUE.sub("[redacted-opaque]", s)
    for bad, good in _BANNED.items():
        s = re.sub(rf"(?i)\b{bad}\b", good, s)
    s = s.strip()
    if len(s) > max_chars:
        s = s[: max_chars - 1].rstrip() + "…"
    return s


def _ascii_header(text: str, max_chars: int = 100) -> str:
    return _scrub(text, max_chars).encode("ascii", "ignore").decode("ascii").replace("\n", " ").strip() or "ParseFusion alert"


# only these keys may be placed in a notification by send_event()
_ALLOWED_FIELDS = (
    "user_id", "username", "role", "time", "ip", "ua_family", "event_id", "object_type", "object_id", "case_id",
    "source_id", "action_id", "request_id", "count", "reason_category", "sha256_prefix", "resource", "decision",
    "kind", "agent", "outbox_id", "from_status", "to_status", "grant_id", "export_id", "finding_id", "severity",
    "columns_count", "seq",
)


def _compose_fields(fields: Dict[str, Any]) -> str:
    lines: List[str] = []
    dropped = []
    for k, v in (fields or {}).items():
        if k not in _ALLOWED_FIELDS:
            dropped.append(k)
            continue
        if k == "ip":
            v = mask_ip(str(v))
        lines.append(f"{k}: {_scrub(v, 80)}")
    if "time" not in (fields or {}):
        lines.append(f"time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC")
    if dropped:
        _dbg("compose", f"dropped non-whitelisted fields: {sorted(dropped)}")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------
# outbox (SQLite; swap for the app DB by replacing _db())
# --------------------------------------------------------------------------------------
_SCHEMA = """
CREATE TABLE IF NOT EXISTS notify_outbox(
  id TEXT PRIMARY KEY, created_at REAL NOT NULL, event_type TEXT NOT NULL, severity TEXT NOT NULL,
  priority INTEGER NOT NULL, title TEXT NOT NULL, message_base TEXT NOT NULL, link TEXT, tags TEXT,
  dedupe_key TEXT, repeat_count INTEGER NOT NULL DEFAULT 1, is_digest INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL NOT NULL,
  claimed_at REAL, last_error TEXT, sent_at REAL, http_status INTEGER);
CREATE INDEX IF NOT EXISTS ix_outbox_due ON notify_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_outbox_key ON notify_outbox(dedupe_key, created_at);
"""


def _db() -> sqlite3.Connection:
    global _CONN, _CONN_PATH
    with _LOCK:
        if _CONN is None:
            path = _CFG.outbox_path
            d = os.path.dirname(os.path.abspath(path))
            os.makedirs(d, exist_ok=True)
            conn = sqlite3.connect(path, timeout=30, check_same_thread=False, isolation_level=None)
            conn.row_factory = sqlite3.Row
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
            except sqlite3.DatabaseError:
                pass
            conn.executescript(_SCHEMA)
            _CONN, _CONN_PATH = conn, path
            _dbg("outbox", "opened outbox database")
        return _CONN


def _x(sql: str, args: tuple = ()) -> sqlite3.Cursor:
    with _LOCK:
        return _db().execute(sql, args)


# --------------------------------------------------------------------------------------
# public send API
# --------------------------------------------------------------------------------------
def _norm_sev(sev: Optional[str], default: str = "normal") -> str:
    s = (sev or default).strip().lower()
    return s if s in _CFG.priority_map else default


def _click_url(link: Optional[str]) -> Optional[str]:
    if not link:
        return None
    link = str(link).strip()
    if link.lower().startswith(("http://", "https://")):
        url = link
    elif _CFG.app_base_url:
        url = _CFG.app_base_url + (link if link.startswith("/") else "/" + link)
    else:
        return None
    return urllib.parse.quote(url, safe=":/?&=#%@+,;~-._")


def send(event_type: str, severity: Optional[str], title: str, message: str,
         link: Optional[str] = None, dedupe_key: Optional[str] = None) -> Optional[str]:
    """Queue one admin notification. Never raises, never blocks on the network. Returns the outbox id."""
    try:
        cfg = _CFG
        cat = EVENTS.get(event_type)
        sev = _norm_sev(severity, cat[0] if cat else "normal")
        if not cfg.enabled:
            _COUNTERS["disabled"] += 1
            _dbg("send", f"{event_type} skipped (NTFY_ENABLED=0)")
            return None
        _warn_if_public_topic()
        title_s = _ascii_header(title or (cat[1] if cat else event_type))
        msg_s = _scrub(message, cfg.max_message_chars)
        tags = ",".join((cat[2] if cat else ["bell"]))
        link_path = link if link is not None else (cat[3] if cat else "")
        now = time.time()
        collapsible = bool(dedupe_key) and event_type not in NEVER_COLLAPSE and sev != "urgent" and \
            (cat[4] if cat else True)
        # global flood guard (urgent alerts are always accepted)
        if sev != "urgent":
            pending = _x("SELECT COUNT(*) AS c FROM notify_outbox WHERE status IN ('pending','sending')").fetchone()["c"]
            if pending >= cfg.max_pending:
                _COUNTERS["dropped"] += 1
                _dbg("send", f"{event_type} DROPPED: outbox full ({pending})")
                return None
        with _LOCK:
            if collapsible:
                row = _x("SELECT * FROM notify_outbox WHERE dedupe_key=? ORDER BY created_at DESC LIMIT 1",
                         (dedupe_key,)).fetchone()
                if row is not None:
                    ref = row["sent_at"] or row["created_at"]
                    if row["status"] == "pending" and now - row["created_at"] < cfg.dedupe_window_s:
                        _x("UPDATE notify_outbox SET repeat_count=repeat_count+1 WHERE id=?", (row["id"],))
                        _COUNTERS["collapsed"] += 1
                        _dbg("send", f"{event_type} collapsed into {row['id'][:8]} (count+1)")
                        _WAKE.set()
                        return row["id"]
                    if row["status"] in ("sent", "sending") and now - ref < cfg.dedupe_window_s:
                        due = ref + cfg.dedupe_window_s
                        oid = _insert(now, event_type, sev, "[summary] " + title_s, msg_s, link_path, tags,
                                      dedupe_key, due, digest=True)
                        _COUNTERS["queued"] += 1
                        _dbg("send", f"{event_type} -> digest {oid[:8]} due in {due - now:.0f}s")
                        return oid
            oid = _insert(now, event_type, sev, title_s, msg_s, link_path, tags, dedupe_key, now, digest=False)
        _COUNTERS["queued"] += 1
        _dbg("send", f"queued {event_type} sev={sev} id={oid[:8]}")
        _ensure_worker()
        _WAKE.set()
        return oid
    except Exception as exc:  # notification must never break the caller
        _dbg("send", f"FAILED to queue ({type(exc).__name__}): {exc}")
        return None


def _insert(now: float, event_type: str, sev: str, title: str, msg: str, link: Optional[str], tags: str,
            dedupe_key: Optional[str], due: float, digest: bool) -> str:
    oid = uuid.uuid4().hex
    _x("INSERT INTO notify_outbox(id,created_at,event_type,severity,priority,title,message_base,link,tags,"
       "dedupe_key,repeat_count,is_digest,status,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?, 'pending',0,?)",
       (oid, now, event_type, sev, _CFG.priority_map.get(sev, 3), title, msg, link, tags, dedupe_key,
        1 if digest else 0, due))
    return oid


def _warn_if_public_topic() -> None:
    global _WARNED_PUBLIC
    if _WARNED_PUBLIC:
        return
    _WARNED_PUBLIC = True
    if "ntfy.sh" in _CFG.base_url and len(_CFG.topic) < 16 and not _CFG.token:
        _dbg("security", "topic on public ntfy.sh is short and unauthenticated: anyone can read/publish it. "
                         "Payloads contain IDs only; use a long random topic or self-hosted ntfy+token in production.")


def send_event(event_type: str, fields: Optional[Dict[str, Any]] = None, *, severity: Optional[str] = None,
               title: Optional[str] = None, link: Optional[str] = None, dedupe_key: Optional[str] = None) -> Optional[str]:
    """Preferred API: catalogue defaults + whitelisted fields only (no free text can leak)."""
    cat = EVENTS.get(event_type)
    return send(event_type, severity or (cat[0] if cat else "normal"), title or (cat[1] if cat else event_type),
                _compose_fields(fields or {}), link, dedupe_key)


# ---- typed helpers (callers pass raw values; masking is done here) -------------------------------
def login_success(user_id: str, role: str, ip: Optional[str], user_agent: Optional[str]) -> Optional[str]:
    return send_event("login_success", {"user_id": user_id, "role": role, "ip": ip or "",
                                        "ua_family": ua_family(user_agent)})


def login_failed_threshold(user_id: str, count: int, ip: Optional[str]) -> Optional[str]:
    return send_event("login_failed_threshold", {"user_id": user_id, "count": count, "ip": ip or ""},
                      dedupe_key=f"loginfail:{user_id}")


def access_requested(user_id: str, resource: str, request_id: str) -> Optional[str]:
    return send_event("access_requested", {"user_id": user_id, "resource": resource, "request_id": request_id},
                      dedupe_key=f"accessreq:{request_id}")


def access_decided(decision: str, user_id: str, grant_id: str) -> Optional[str]:
    et = {"approved": "access_approved", "rejected": "access_rejected", "expired": "access_expired"}.get(decision, "access_rejected")
    return send_event(et, {"user_id": user_id, "grant_id": grant_id, "decision": decision}, dedupe_key=f"{et}:{grant_id}")


def action_transition(new_status: str, action_id: str, actor: str) -> Optional[str]:
    et = {"in_review": "action_submitted", "submitted": "action_submitted", "approved": "action_approved",
          "rejected": "action_rejected", "executed": "action_executed"}.get(new_status)
    if et is None:
        return None
    return send_event(et, {"action_id": action_id, "user_id": actor, "to_status": new_status})


def chat_confirm_pending(user_id: str, approval_id: str) -> Optional[str]:
    return send_event("chat_confirm_pending", {"user_id": user_id, "object_id": approval_id},
                      dedupe_key=f"chatconfirm:{user_id}")


def chat_repeated_block(user_id: str, count: int) -> Optional[str]:
    return send_event("chat_repeated_block", {"user_id": user_id, "count": count}, dedupe_key=f"chatblock:{user_id}")


def url_blocked(user_id: str, reason_category: str) -> Optional[str]:
    return send_event("url_blocked", {"user_id": user_id, "reason_category": reason_category},
                      dedupe_key=f"urlblock:{user_id}:{reason_category}")


def file_rejected(user_id: str, role: str, reason_category: str, sha256_prefix: str, source_id: str) -> Optional[str]:
    return send_event("file_rejected_malware", {"user_id": user_id, "role": role, "reason_category": reason_category,
                                                "sha256_prefix": sha256_prefix, "source_id": source_id},
                      dedupe_key=f"filerej:{user_id}:{reason_category}")


def export_sensitive(user_id: str, export_id: str) -> Optional[str]:
    return send_event("export_sensitive", {"user_id": user_id, "export_id": export_id})


def high_severity_finding(case_id: str, finding_id: str) -> Optional[str]:
    return send_event("finding_high_severity", {"case_id": case_id, "finding_id": finding_id})


def config_changed(user_id: str, kind: str) -> Optional[str]:
    return send_event("config_change", {"user_id": user_id, "kind": kind})


def audit_chain_invalid(seq: Optional[int] = None) -> Optional[str]:
    return send_event("audit_chain_invalid", {"seq": seq if seq is not None else "unknown"})


# --------------------------------------------------------------------------------------
# delivery
# --------------------------------------------------------------------------------------
def _audit_safe(event_type: str, oid: str, outcome: str, details: Dict[str, Any]) -> None:
    try:
        from backend.common import audit  # type: ignore
        audit.append({
            "event_id": str(uuid.uuid4()), "actor_id": "system", "actor_role": "system", "tenant_id": "system",
            "request_id": f"notify-{oid[:12]}", "event_type": event_type, "object_type": "notification",
            "object_id": oid, "outcome": outcome, "details": details, "ip_masked": None, "user_agent_family": None,
        })
    except Exception as exc:
        _dbg("audit", f"could not audit {event_type} ({type(exc).__name__})")


def _compose_body(row: sqlite3.Row) -> str:
    body = row["message_base"] or ""
    if row["is_digest"]:
        body = "Summary of repeated events in the last window.\n" + body
    if row["repeat_count"] and row["repeat_count"] > 1:
        body += f"\nOccurrences: {row['repeat_count']}"
    return body


def _http_post(url: str, body: bytes, headers: Dict[str, str], timeout: float) -> Tuple[int, Optional[float], str]:
    """-> (status, retry_after_seconds, error). status 0 = transport error."""
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # TLS verification is on by default
            return int(resp.status), None, ""
    except urllib.error.HTTPError as e:
        ra = None
        try:
            ra = float(e.headers.get("Retry-After")) if e.headers and e.headers.get("Retry-After") else None
        except (TypeError, ValueError):
            ra = None
        return int(e.code), ra, f"http {e.code}"
    except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
        return 0, None, type(e).__name__


def _deliver(row: sqlite3.Row) -> None:
    cfg = _CFG
    oid = row["id"]
    url = f"{cfg.base_url}/{urllib.parse.quote(cfg.topic, safe='')}"
    headers = {"Title": row["title"], "Priority": str(row["priority"]), "Tags": row["tags"] or "bell",
               "Content-Type": "text/plain; charset=utf-8"}
    click = _click_url(row["link"])
    if click:
        headers["Click"] = click
    if cfg.token:
        headers["Authorization"] = f"Bearer {cfg.token}"
    body = _compose_body(row).encode("utf-8")
    _dbg("deliver", f"id={oid[:8]} event={row['event_type']} attempt={row['attempts'] + 1}/{cfg.max_attempts} prio={row['priority']}")
    status, retry_after, err = _http_post(url, body, headers, cfg.http_timeout_s)
    now = time.time()
    if 200 <= status < 300:
        _x("UPDATE notify_outbox SET status='sent', sent_at=?, http_status=?, attempts=attempts+1, last_error=NULL WHERE id=?",
           (now, status, oid))
        _COUNTERS["sent"] += 1
        _dbg("deliver", f"id={oid[:8]} SENT http={status}")
        _audit_safe("notification_sent", oid, "success",
                    {"outbox_id": oid, "notify_event": row["event_type"], "attempts": row["attempts"] + 1, "http_status": status})
        return
    attempts = row["attempts"] + 1
    permanent = status in (400, 401, 403, 404, 413, 422)  # configuration problems: retrying will not help
    if permanent or attempts >= cfg.max_attempts:
        _x("UPDATE notify_outbox SET status='dead', attempts=?, http_status=?, last_error=? WHERE id=?",
           (attempts, status, err, oid))
        _COUNTERS["dead"] += 1
        _dbg("deliver", f"id={oid[:8]} DEAD after {attempts} attempts ({err})")
        _audit_safe("notification_failed", oid, "error",
                    {"outbox_id": oid, "notify_event": row["event_type"], "attempts": attempts, "http_status": status, "error": err})
        return
    delay = min(cfg.backoff_max_s, cfg.backoff_base_s * (2 ** (attempts - 1))) * random.uniform(0.8, 1.2)
    if retry_after is not None:
        delay = max(delay, min(retry_after, cfg.backoff_max_s))
    _x("UPDATE notify_outbox SET status='pending', claimed_at=NULL, attempts=?, http_status=?, last_error=?, next_attempt_at=? WHERE id=?",
       (attempts, status, err, now + delay, oid))
    _COUNTERS["retried"] += 1
    _dbg("deliver", f"id={oid[:8]} retry in {delay:.1f}s ({err})")


def drain_once(limit: int = 20) -> int:
    """Deliver due notifications once (also used by tests). Returns the number attempted."""
    now = time.time()
    _x("UPDATE notify_outbox SET status='pending', claimed_at=NULL WHERE status='sending' AND claimed_at < ?",
       (now - _CFG.stale_sending_s,))
    rows = _x("SELECT * FROM notify_outbox WHERE status='pending' AND next_attempt_at<=? "
              "ORDER BY priority DESC, created_at ASC LIMIT ?", (now, limit)).fetchall()
    done = 0
    for row in rows:
        with _LOCK:  # atomic claim (safe with several worker processes sharing the DB)
            cur = _db().execute("UPDATE notify_outbox SET status='sending', claimed_at=? WHERE id=? AND status='pending'",
                                (time.time(), row["id"]))
            if cur.rowcount != 1:
                continue
        try:
            _deliver(row)
        except Exception as exc:
            _dbg("deliver", f"unexpected error ({type(exc).__name__}); rescheduled")
            _x("UPDATE notify_outbox SET status='pending', claimed_at=NULL, next_attempt_at=? WHERE id=?",
               (time.time() + 30, row["id"]))
        done += 1
    return done


def _worker_loop() -> None:
    _dbg("worker", "started")
    while not _STOP.is_set():
        try:
            n = drain_once()
        except Exception as exc:
            _dbg("worker", f"loop error ({type(exc).__name__})")
            n = 0
        if n == 0:
            _WAKE.wait(_CFG.poll_interval_s)
            _WAKE.clear()
    _dbg("worker", "stopped")


def _ensure_worker() -> None:
    global _WORKER
    if not _CFG.autostart:
        return
    with _LOCK:
        if _WORKER is None or not _WORKER.is_alive():
            _STOP.clear()
            _WORKER = threading.Thread(target=_worker_loop, name="notify-worker", daemon=True)
            _WORKER.start()


def start_worker() -> None:
    _ensure_worker()


def flush(timeout: float = 10.0) -> bool:
    """Wait until nothing due is pending (best effort). True when the outbox is drained."""
    end = time.time() + timeout
    while time.time() < end:
        c = _x("SELECT COUNT(*) AS c FROM notify_outbox WHERE status IN ('pending','sending') AND next_attempt_at<=?",
               (time.time(),)).fetchone()["c"]
        if c == 0:
            return True
        _WAKE.set()
        time.sleep(0.05)
    return False


def shutdown() -> None:
    global _WORKER
    _STOP.set()
    _WAKE.set()
    w = _WORKER
    if w is not None and w.is_alive():
        w.join(timeout=3)
    _WORKER = None


def stats() -> Dict[str, Any]:
    """Counters for /metrics."""
    out: Dict[str, Any] = dict(_COUNTERS)
    try:
        for r in _x("SELECT status, COUNT(*) AS c FROM notify_outbox GROUP BY status").fetchall():
            out[f"outbox_{r['status']}"] = r["c"]
    except Exception:
        pass
    return out


def test_connection() -> Tuple[bool, str]:
    """Synchronous one-off publish (bypasses outbox) - used to verify ntfy.sh/<topic> end to end."""
    cfg = _CFG
    url = f"{cfg.base_url}/{urllib.parse.quote(cfg.topic, safe='')}"
    headers = {"Title": "ParseFusion notify test", "Priority": str(cfg.priority_map["low"]), "Tags": "bell",
               "Content-Type": "text/plain; charset=utf-8"}
    if cfg.token:
        headers["Authorization"] = f"Bearer {cfg.token}"
    status, _, err = _http_post(url, b"Test notification from ParseFusion (no data attached).", headers, cfg.http_timeout_s)
    ok = 200 <= status < 300
    msg = f"POST {cfg.base_url}/{cfg.topic} -> {status or err}"
    _dbg("test", msg)
    return ok, msg


atexit.register(lambda: (flush(2.0) if _CFG.enabled and _CONN is not None else None))

if __name__ == "__main__":
    import sys
    if "--test" in sys.argv:
        ok, m = test_connection()
        print("OK" if ok else "FAILED", m)
        qid = send_event("notification_test", {"object_type": "self_test"})
        print("queued", qid, "flushed", flush(15))
        sys.exit(0 if ok else 1)
    print(__doc__)
