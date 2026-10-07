from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

import sqlglot
from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Column, Integer, String, Table, Text, func, insert, select, text, update
from sqlglot import exp
from sqlglot.errors import OptimizeError, ParseError, TokenError
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import traverse_scope

try:
    from . import e_common as ec
except ImportError:  # pragma: no cover
    import e_common as ec

AGENT = "24-chat"

chat_approvals = Table(
    "chat_approvals", ec.APP_META,
    Column("approval_id", String(36), primary_key=True),
    Column("tenant_id", String(64), nullable=False), Column("user_id", String(128), nullable=False),
    Column("sql", Text, nullable=False), Column("sql_hash", String(64), nullable=False), Column("analysis", Text), Column("reason", Text),
    Column("status", String(16), nullable=False),  # pending | approved | rejected | consumed
    Column("created_at", String(32), nullable=False), Column("decided_by", String(128)), Column("decided_at", String(32)), Column("consumed_at", String(32)),
)
chat_questions = Table(
    "chat_questions", ec.APP_META,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String(36), nullable=False, index=True), Column("user_id", String(128), nullable=False),
    Column("tenant_id", String(64), nullable=False), Column("question", Text, nullable=False), Column("created_at", String(32), nullable=False),
)
chat_blocks = Table(
    "chat_blocks", ec.APP_META,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("user_id", String(128), nullable=False, index=True), Column("created_at", String(32), nullable=False),
)

DEFAULT_DENIED_FUNCS = {
    "pg_sleep", "pg_sleep_for", "pg_sleep_until", "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "lo_import", "lo_export", "lo_get",
    "lo_put", "dblink", "dblink_exec", "dblink_connect", "copy", "load_file", "sleep", "benchmark", "set_config", "current_setting", "pg_terminate_backend",
    "pg_cancel_backend", "query_to_xml", "table_to_xml", "txid_current", "pg_advisory_lock", "pg_advisory_xact_lock", "pg_notify", "version",
    "current_user", "session_user", "current_database", "current_schema", "current_schemas", "inet_server_addr", "inet_client_addr", "pg_backend_pid",
    "pg_reload_conf", "readfile", "writefile", "load_extension", "randomblob", "zeroblob", "generate_series", "pg_read_server_files",
}
_FORBIDDEN_NODE_NAMES = ["Insert", "Update", "Delete", "Drop", "Create", "Alter", "Command", "Merge", "TruncateTable", "Set", "Use", "Into", "Lock",
                         "Copy", "Grant", "Revoke", "Transaction", "Commit", "Rollback", "Pragma", "Attach", "Detach", "Describe", "Show", "Kill",
                         "LoadData", "Analyze", "Refresh", "Declare", "Call", "Execute"]
FORBIDDEN_NODES = tuple(getattr(exp, n) for n in _FORBIDDEN_NODE_NAMES if hasattr(exp, n))
_SYSTEM_TABLE_PREFIXES = ("pg_", "sqlite_", "information_schema", "sys", "mysql", "performance_schema")
MAX_SQL_CHARS = 8000


# ---------------------------------------------------------------------------
# policy gate (pure function: unit-testable without a DB or an LLM)
# ---------------------------------------------------------------------------
@dataclass
class GateResult:
    ok: bool
    reason: Optional[str] = None
    sql: Optional[str] = None        # rewritten SQL that is safe to execute
    analysis: dict = field(default_factory=dict)


def _block(reason: str) -> GateResult:
    return GateResult(False, reason)


def gate_sql(sql: str, allowed: dict, *, dialect: str, row_cap: int, all_cols: Optional[dict] = None,
             denied_funcs: Optional[set] = None, allowed_anon: Optional[set] = None, sensitive_fn=None) -> GateResult:
    """allowed = {table: {col: type}} containing ONLY columns unlocked for the caller (lowercase identifiers)."""
    if not sql or not sql.strip():
        return _block("Empty SQL")
    if len(sql) > MAX_SQL_CHARS:
        return _block("SQL is too long")
    denied = {d.lower() for d in (denied_funcs if denied_funcs is not None else DEFAULT_DENIED_FUNCS)}
    anon_ok = {a.lower() for a in (allowed_anon or set())}
    try:
        tokens = sqlglot.Dialect.get_or_raise(dialect).tokenize(sql)
        if any(t.comments for t in tokens):
            return _block("SQL comments are not allowed")
        stmts = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except (ParseError, TokenError) as e:
        return _block(f"SQL could not be parsed: {str(e)[:80]}")
    if len(stmts) != 1:
        return _block("Exactly one SQL statement is allowed")
    stmt = stmts[0]
    if not isinstance(stmt, exp.Select):
        return _block("Only a single SELECT statement is allowed")
    bad = stmt.find(*FORBIDDEN_NODES) if FORBIDDEN_NODES else None
    if bad is not None:
        return _block(f"{type(bad).__name__} operations are not allowed")
    for fn in stmt.find_all(exp.Func):
        name = (fn.name if isinstance(fn, exp.Anonymous) else fn.sql_name()).lower()
        if name in denied:
            return _block(f"Function '{name}' is not allowed")
        if isinstance(fn, exp.Anonymous) and name not in anon_ok:
            return _block(f"Unknown function '{name}' is not allowed")
    cte_names = {c.alias_or_name.lower() for c in stmt.find_all(exp.CTE)}
    allowed_l = {t.lower(): {c.lower(): ty for c, ty in cols.items()} for t, cols in allowed.items()}
    touched_tables: set = set()
    for t in stmt.find_all(exp.Table):
        if not isinstance(t.this, exp.Identifier):
            return _block("Table functions are not allowed")
        if t.args.get("db") or t.args.get("catalog"):
            return _block("Schema-qualified table names are not allowed; use the plain table name")
        name = t.name.lower()
        if name in cte_names:
            continue
        if name.startswith(_SYSTEM_TABLE_PREFIXES):
            return _block("System tables are not allowed")
        if name not in allowed_l:
            return _block(f"Table '{name}' is not available to you")
        touched_tables.add(name)
    try:
        q = qualify(stmt.copy(), schema=allowed_l, dialect=dialect, validate_qualify_columns=True, expand_stars=True)
    except OptimizeError as e:
        locked_hit = _locked_refs(stmt, all_cols, allowed_l) if all_cols else []
        if locked_hit:
            return _block("Column(s) not available to you: " + ", ".join(locked_hit))
        return _block(f"Query references an unknown or locked column ({str(e)[:70]})")
    except Exception as e:  # qualify must never crash the request
        return _block(f"Query could not be validated ({type(e).__name__})")
    # defence in depth on the REWRITTEN tree: every column must resolve to a physical table AND be unlocked
    cols_used: set = set()
    for sc in traverse_scope(q):
        for col in sc.columns:
            src = sc.sources.get(col.table)
            if isinstance(src, exp.Table):
                tn, cn = src.name.lower(), col.name.lower()
                if cn not in allowed_l.get(tn, {}):
                    return _block(f"Column '{tn}.{cn}' is not available to you")
                cols_used.add((tn, cn))
            elif src is None:
                return _block("A column could not be traced to a table")
    for star in q.find_all(exp.Star):
        if not isinstance(star.parent, exp.Count):
            return _block("Wildcards could not be resolved")
    lim = q.args.get("limit")
    cur = None
    if lim is not None and isinstance(lim.expression, exp.Literal) and lim.expression.is_int:
        cur = int(lim.expression.name)
    if cur is None or cur > row_cap:
        q = q.limit(row_cap)
        cur = row_cap
    final_sql = q.sql(dialect=dialect)
    sens = sorted(f"{t}.{c}" for t, c in cols_used if sensitive_fn and sensitive_fn(t, c))
    where = stmt.args.get("where")
    analysis = {"operation": "SELECT", "tables": sorted(touched_tables), "columns": sorted(f"{t}.{c}" for t, c in cols_used),
                "where": where.this.sql(dialect=dialect)[:300] if where is not None else None, "joins": len(list(stmt.find_all(exp.Join))),
                "has_aggregation": stmt.find(exp.AggFunc) is not None, "has_group_by": stmt.args.get("group") is not None,
                "limit": cur, "sensitive_columns": sens, "row_estimate": None}
    return GateResult(True, None, final_sql, analysis)


def _locked_refs(stmt: exp.Expression, all_cols: dict, allowed_l: dict) -> list:
    """Friendly error only: which explicitly named columns exist but are locked."""
    names = {c.name.lower() for c in stmt.find_all(exp.Column)}
    hits = []
    for t, cols in all_cols.items():
        for c in cols:
            if c.lower() in names and c.lower() not in allowed_l.get(t.lower(), {}):
                hits.append(f"{t}.{c}")
    return sorted(set(hits))


# ---------------------------------------------------------------------------
# number verification (answer text)
# ---------------------------------------------------------------------------
_NUM_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _norm_num(s: str) -> str:
    try:
        d = Decimal(s.replace(",", ""))
        return format(d.normalize(), "f")
    except InvalidOperation:
        return s


def numbers_in(s: str) -> set:
    return {_norm_num(m) for m in _NUM_RE.findall(s or "")}


def answer_grounded(answer: str, columns: list, rows: list) -> bool:
    allowed = {str(len(rows)), str(len(columns))}
    for r in rows:
        for v in r:
            allowed |= numbers_in(str(v))
    return numbers_in(answer) <= allowed


def template_answer(columns: list, rows: list, truncated: bool) -> str:
    if not rows:
        return "The query returned no rows."
    if len(rows) == 1 and len(columns) == 1:
        return f"{columns[0]}: {rows[0][0]}"
    return f"The query returned {len(rows)} row(s) with {len(columns)} column(s)." + (" Results were truncated at the row cap." if truncated else "")


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def _t(sql: str):
    return text(sql.replace(":", "\\:"))  # keep ':' in literals from being read as bind parameters


def _jsonable(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        return f"<{len(v)} bytes>"
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


def explain_rows(sql: str) -> Optional[int]:
    eng = ec.data_engine()
    if eng.dialect.name != "postgresql":
        return None
    try:
        with eng.connect() as c:
            c.exec_driver_sql("SET TRANSACTION READ ONLY")
            c.exec_driver_sql("SET LOCAL statement_timeout = 5000")
            plan = c.execute(_t("EXPLAIN (FORMAT JSON) " + sql)).scalar()
        plan = plan if isinstance(plan, list) else ec.jloads(str(plan), [])
        return int(plan[0]["Plan"]["Plan Rows"])
    except Exception as e:
        ec.dbg(AGENT, "explain_failed", err=type(e).__name__)
        return None


def run_query(sql: str, cap: int) -> tuple:
    eng = ec.data_engine()
    timeout = float(ec.cfg("chat.timeout_seconds", 15))
    t0 = time.perf_counter()
    with eng.connect() as c:
        raw = None
        if eng.dialect.name == "postgresql":
            c.exec_driver_sql("SET TRANSACTION READ ONLY")
            c.exec_driver_sql(f"SET LOCAL statement_timeout = {int(timeout * 1000)}")
        elif eng.dialect.name == "sqlite":
            raw = c.connection.driver_connection
            deadline = time.time() + timeout
            raw.set_progress_handler(lambda: 1 if time.time() > deadline else 0, 1000)
        try:
            res = c.execute(_t(sql))
            cols = list(res.keys())
            data = res.fetchmany(cap + 1)
        except Exception as e:
            msg = str(e).lower()
            if "interrupt" in msg or "timeout" in msg or "canceling statement" in msg:
                raise ec.AgentError("TIMEOUT", "The query took too long") from e
            ec.dbg(AGENT, "query_error", err=type(e).__name__)
            raise ec.AgentError("ENGINE_FAILED", "Query execution failed") from e
        finally:
            if raw is not None:
                raw.set_progress_handler(None, 0)
    truncated = len(data) > cap
    rows = [[_jsonable(v) for v in r] for r in data[:cap]]
    ec.dbg(AGENT, "query_ran", rows=len(rows), truncated=truncated, ms=round((time.perf_counter() - t0) * 1000, 1))
    return cols, rows, truncated


# ---------------------------------------------------------------------------
# llm adapters (ONLY through common.llm_guard)
# ---------------------------------------------------------------------------
class SQLProposal(BaseModel):
    sql: Optional[str] = None
    clarification: Optional[str] = None


class AnswerProposal(BaseModel):
    answer: Optional[str] = None


def _llm(task: str, blocks: list, schema: type) -> Optional[Any]:
    from common import llm_guard  # type: ignore
    try:
        res = llm_guard.call(task, blocks, schema)
    except Exception as e:
        ec.dbg(AGENT, "llm_exception", task=task, err=type(e).__name__)
        return None
    if not res or not res.get("ok") or res.get("output") is None:
        ec.dbg(AGENT, "llm_abstained", task=task, rejected=len(res.get("rejected_fields", []) or []) if res else None)
        return None
    out = res["output"]
    try:
        return out if isinstance(out, schema) else schema.model_validate(out)
    except Exception:
        return None


def _schema_text(allowed: dict) -> str:
    return "\n".join(f"TABLE {t} ({', '.join(f'{c} {ty}' for c, ty in cols.items())})" for t, cols in sorted(allowed.items()))


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------
class ChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str
    conversation_id: Optional[str] = None
    scope: Optional[dict] = None
    approval_id: Optional[str] = None


class ApprovalDecisionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approval_id: str
    decision: str  # approve | reject


# ---------------------------------------------------------------------------
# core
# ---------------------------------------------------------------------------
def _hist(conv: str, user: dict) -> list:
    n = int(ec.cfg("chat.history_questions", 5))
    with ec.app_engine().connect() as c:
        rows = c.execute(select(chat_questions.c.user_id, chat_questions.c.question).where(chat_questions.c.conversation_id == conv)
                         .order_by(chat_questions.c.id.desc()).limit(n)).all()
    if any(r.user_id != user["user_id"] for r in rows):
        raise ec.AgentError("FORBIDDEN", "Conversation belongs to another user")
    return [r.question for r in reversed(rows)]


def _record_block(user: dict) -> None:
    thr, win = int(ec.cfg("chat.block_alert_threshold", 3)), int(ec.cfg("chat.block_alert_window_seconds", 600))
    since = ec.iso(ec.now() - timedelta(seconds=win))
    with ec.app_engine().begin() as c:
        c.execute(insert(chat_blocks).values(user_id=user["user_id"], created_at=ec.iso_now()))
        n = c.execute(select(func.count()).select_from(chat_blocks).where(chat_blocks.c.user_id == user["user_id"], chat_blocks.c.created_at >= since)).scalar()
    ec.dbg(AGENT, "block_counted", user=user["user_id"], in_window=n)
    if n >= thr:
        ec.notify_send("chat_repeated_block", message=f"User {user['user_id']} (role {user['role']}) had {n} blocked chat queries in {win // 60} min.",
                       link="/admin/chat-queries", dedupe_key=f"chat_repeated_block:{user['user_id']}")


def _answer(question: str, columns: list, rows: list, truncated: bool) -> str:
    fallback = template_answer(columns, rows, truncated)
    if not rows or not ec.cfg("chat.llm_answer", True):
        return fallback
    sample = [dict(zip(columns, r)) for r in rows[:50]]
    out = _llm("chat_answer", [{"block_id": "rows", "text": ec.jdumps(sample), "untrusted": True},
                               {"block_id": "question", "text": question, "untrusted": True},
                               {"block_id": "rules", "text": "Summarise ONLY the rows. Do not add, compute or infer any number that is not literally in the rows. Return null if unsure."}],
               AnswerProposal)
    if out and out.answer and answer_grounded(out.answer, columns, rows):
        return out.answer.strip()
    ec.dbg(AGENT, "answer_fallback_template", reason="llm_abstained_or_ungrounded")
    return fallback


def _citations(columns: list, rows: list) -> list:
    lineage = [c for c in ec.cfg("chat.lineage_columns", ["block_id", "source_block_id", "evidence_block_id"]) if c in columns]
    if not lineage:
        return []
    idx = [columns.index(c) for c in lineage]
    return [{"row": i, "block_ids": sorted({str(r[j]) for j in idx if r[j] is not None})} for i, r in enumerate(rows) if any(r[j] is not None for j in idx)]


def run(inp: ChatIn, user: dict) -> dict:
    t0 = time.perf_counter()
    q = (inp.question or "").strip()
    if not q or len(q) > int(ec.cfg("chat.max_question_chars", 2000)):
        raise ec.AgentError("INVALID_INPUT", "question is empty or too long")
    conv = inp.conversation_id or str(uuid.uuid4())
    ec.dbg(AGENT, "start", conv=conv, q_chars=len(q), via_approval=bool(inp.approval_id), user=user["user_id"])
    history = _hist(conv, user) if inp.conversation_id else []
    with ec.app_engine().begin() as c:
        c.execute(insert(chat_questions).values(conversation_id=conv, user_id=user["user_id"], tenant_id=user.get("tenant_id", "default"),
                                                question=q, created_at=ec.iso_now()))
    ec.audit("question_asked", "conversation", conv, "success", {"question_sha256": ec.sha256_hex(q), "chars": len(q), "via_approval": bool(inp.approval_id)}, user=user)
    out: dict = {"conversation_id": conv}

    acc = ec.import_agent("23_access_control")
    only = (inp.scope or {}).get("resources") if isinstance(inp.scope, dict) else None
    allowed, all_cols = acc.user_schema(user, only if isinstance(only, list) else None)
    ec.dbg(AGENT, "schema_for_user", tables=len(allowed))
    if not allowed:
        out.update(decision="BLOCK", reason="No data resources are available to you. Request access first.")
        ec.audit("sql_decision", "conversation", conv, "denied", {"decision": "BLOCK", "reason": "no_resources"}, strict=True, user=user)
        return out

    dialect = ec.cfg("chat.dialect", None) or {"postgresql": "postgres"}.get(ec.data_engine().dialect.name, ec.data_engine().dialect.name)
    approval_row = None
    if inp.approval_id:
        with ec.app_engine().connect() as c:
            approval_row = c.execute(select(chat_approvals).where(chat_approvals.c.approval_id == inp.approval_id,
                                                                  chat_approvals.c.tenant_id == user.get("tenant_id", "default"))).first()
        if not approval_row or approval_row.user_id != user["user_id"]:
            raise ec.AgentError("NOT_FOUND", "Approval not found")
        if approval_row.status != "approved":
            raise ec.AgentError("CONFLICT", f"Approval is {approval_row.status}", {"status": approval_row.status})
        proposed_sql = approval_row.sql
        ec.dbg(AGENT, "using_approved_sql", approval_id=inp.approval_id)
    else:
        blocks = [{"block_id": "schema", "text": _schema_text(allowed)},
                  {"block_id": "rules", "text": f"Dialect: {dialect}. Write exactly one read-only SELECT using only the tables and columns in 'schema'. "
                                                f"No comments, no semicolons, no schema prefixes. Return {{\"sql\": null, \"clarification\": \"...\"}} if the question is ambiguous "
                                                f"or cannot be answered from the schema."},
                  {"block_id": "history", "text": "\n".join(history) or "(none)", "untrusted": True},
                  {"block_id": "question", "text": q, "untrusted": True}]
        prop = _llm("nl_to_sql", blocks, SQLProposal)
        if prop is None:
            out.update(decision="BLOCK", reason="Could not generate a grounded query for this question.")
            ec.audit("sql_decision", "conversation", conv, "denied", {"decision": "BLOCK", "reason": "llm_abstained"}, strict=True, user=user)
            return out
        if prop.clarification and not prop.sql:
            out.update(decision="ALLOW", reason="clarification_needed", answer_text=prop.clarification.strip()[:500])
            ec.audit("sql_decision", "conversation", conv, "success", {"decision": "ALLOW", "reason": "clarification_needed"}, strict=True, user=user)
            return out
        proposed_sql = prop.sql or ""
    ec.dbg(AGENT, "sql_proposed", chars=len(proposed_sql))

    gate = gate_sql(proposed_sql, allowed, dialect=dialect, row_cap=int(ec.cfg("chat.row_cap", 1000)), all_cols=all_cols,
                    denied_funcs=set(ec.cfg("chat.denied_functions", [])) | DEFAULT_DENIED_FUNCS,
                    allowed_anon=set(ec.cfg("chat.allowed_anonymous_functions", [])), sensitive_fn=acc.is_sensitive)
    ec.dbg(AGENT, "gate", ok=gate.ok, reason=gate.reason)
    sql_hash = ec.sha256_hex(proposed_sql)
    if not gate.ok:
        out.update(decision="BLOCK", reason=gate.reason)
        ec.audit("sql_decision", "conversation", conv, "denied", {"decision": "BLOCK", "reason": gate.reason, "sql_sha256": sql_hash, "sql": proposed_sql[:1500]},
                 strict=True, user=user)
        _record_block(user)
        return out
    gate.analysis["row_estimate"] = explain_rows(gate.sql)
    est = gate.analysis["row_estimate"]
    out.update(sql=gate.sql, analysis=gate.analysis)

    needs_confirm = None
    if gate.analysis["sensitive_columns"]:
        needs_confirm = "The query reads sensitive columns; admin approval is required."
    elif est is not None and est > int(ec.cfg("chat.confirm_row_threshold", 10000)):
        needs_confirm = f"The query is estimated to scan about {est} rows; admin approval is required."
    if needs_confirm and not approval_row:
        aid = str(uuid.uuid4())
        with ec.app_engine().begin() as c:
            c.execute(insert(chat_approvals).values(approval_id=aid, tenant_id=user.get("tenant_id", "default"), user_id=user["user_id"], sql=gate.sql,
                                                    sql_hash=ec.sha256_hex(gate.sql), analysis=ec.jdumps(gate.analysis), reason=needs_confirm,
                                                    status="pending", created_at=ec.iso_now()))
            ec.audit("sql_decision", "conversation", conv, "success", {"decision": "CONFIRM", "reason": needs_confirm, "approval_id": aid,
                     "sql_sha256": ec.sha256_hex(gate.sql), "sql": gate.sql[:1500]}, strict=True, user=user)
        ec.notify_send("chat_confirm_pending", message=f"Chat query approval {aid} from {user['user_id']} (role {user['role']}) is waiting.", link="/admin/chat-queries")
        out.update(decision="CONFIRM", reason=needs_confirm, approval_id=aid)
        ec.dbg(AGENT, "confirm_created", approval_id=aid)
        return out

    # ALLOW (or approved CONFIRM): audit first, THEN execute (fail-closed)
    ec.audit("sql_decision", "conversation", conv, "success", {"decision": "ALLOW", "approved": bool(approval_row), "sql_sha256": ec.sha256_hex(gate.sql),
             "sql": gate.sql[:1500], "tables": gate.analysis["tables"]}, strict=True, user=user)
    if approval_row:
        with ec.app_engine().begin() as c:
            r = c.execute(update(chat_approvals).where(chat_approvals.c.approval_id == approval_row.approval_id, chat_approvals.c.status == "approved")
                          .values(status="consumed", consumed_at=ec.iso_now()))
            if r.rowcount != 1:
                raise ec.AgentError("CONFLICT", "Approval was already used")
    cap = int(ec.cfg("chat.row_cap", 1000))
    columns, rows, truncated = run_query(gate.sql, cap)
    ec.audit("query_executed", "conversation", conv, "success", {"rows": len(rows), "truncated": truncated, "columns": columns[:50],
             "sql_sha256": ec.sha256_hex(gate.sql)}, strict=False, user=user)
    out.update(decision="ALLOW", columns=columns, rows=rows, answer_text=_answer(q, columns, rows, truncated), citations=_citations(columns, rows))
    ec.dbg(AGENT, "done", rows=len(rows), ms=round((time.perf_counter() - t0) * 1000, 1))
    return out


def decide_approval(inp: ApprovalDecisionIn, user: dict) -> dict:
    ec.dbg(AGENT, "approval_decision_start", approval_id=inp.approval_id, decision=inp.decision, user=user["user_id"])
    if inp.decision not in ("approve", "reject"):
        raise ec.AgentError("INVALID_INPUT", "decision must be approve or reject")
    if not ec.is_admin(user):
        ec.audit("chat_approval_decided", "chat_approval", inp.approval_id, "denied", {"reason": "not admin"}, user=user)
        raise ec.AgentError("FORBIDDEN", "Admin only")
    stamp = ec.iso_now()
    with ec.app_engine().begin() as c:
        r = c.execute(select(chat_approvals).where(chat_approvals.c.approval_id == inp.approval_id,
                                                   chat_approvals.c.tenant_id == user.get("tenant_id", "default")).with_for_update()).first()
        if not r:
            raise ec.AgentError("NOT_FOUND", "Approval not found")
        if r.status != "pending":
            raise ec.AgentError("CONFLICT", f"Approval is already {r.status}")
        if r.user_id == user["user_id"]:
            ec.audit("chat_approval_decided", "chat_approval", inp.approval_id, "denied", {"reason": "self-approval"}, user=user)
            raise ec.AgentError("FORBIDDEN", "You cannot approve your own query")
        status = "approved" if inp.decision == "approve" else "rejected"
        c.execute(update(chat_approvals).where(chat_approvals.c.approval_id == inp.approval_id).values(status=status, decided_by=user["user_id"], decided_at=stamp))
        ec.audit("chat_approval_decided", "chat_approval", inp.approval_id, "success", {"decision": status, "requester": r.user_id, "sql_sha256": r.sql_hash},
                 strict=True, user=user)
    ec.notify_send("chat_confirm_decided", message=f"Chat approval {inp.approval_id} {status} by {user['user_id']}.", link="/admin/chat-queries")
    return {"approval_id": inp.approval_id, "status": status, "decided_by": user["user_id"], "decided_at": stamp}


router = APIRouter()


@router.post("/agents/chat-sql")
def post_chat(request: Request, body: dict = Body(default=None)):
    return ec.handle(request, lambda: run(ChatIn.model_validate(body or {}), ec.current_user()))


@router.post("/agents/chat-sql/approval")
def post_chat_approval(request: Request, body: dict = Body(default=None)):
    return ec.handle(request, lambda: decide_approval(ApprovalDecisionIn.model_validate(body or {}), ec.current_user()))
