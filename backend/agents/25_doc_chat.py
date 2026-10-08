"""Agent 25 - Document chat (Groq).

POST /agents/doc-chat       {question, source_ids?: [..], history?: [{role, content}]}
GET  /agents/doc-chat/status   -> whether a Groq key is configured and whether Groq answers (a real 1-token ping)

Answers questions about parsed documents. Retrieval is local (keyword scoring over parsed blocks: text, table cells,
OCR text, and the digitised description of every bar chart), the top passages are sent to Groq with their source and
page, and the answer must cite them. Nothing is invented by this module: if Groq is unreachable or no key is set, the
caller gets the real reason plus the retrieved passages (extractive mode), never an empty reply.

Config (environment): GROQ_API_KEY (required), GROQ_MODEL (default qwen/qwen3.8-27b), GROQ_BASE_URL,
GROQ_TIMEOUT_S (default 30), DOC_CHAT_TOP_K (default 8).
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body

AGENT = "25-doc-chat"
router = APIRouter()

_STOP = set("a an the of in on at to for from by with and or is are was were be been it this that these those what which who whom how much many "
            "does do did can could should would about as into than then there their its has have had not no yes".split())


def _cfg() -> Dict[str, Any]:
    return {"key": os.getenv("GROQ_API_KEY", "").strip(),
            "model": os.getenv("GROQ_MODEL", "qwen/qwen3.8-27b"),
            "base": os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/"),
            "timeout": float(os.getenv("GROQ_TIMEOUT_S", "30")),
            "top_k": int(os.getenv("DOC_CHAT_TOP_K", "8"))}


def _words(text: str) -> List[str]:
    return [w for w in re.findall(r"[a-z0-9][a-z0-9.%$-]*", (text or "").lower()) if w not in _STOP]


def _passages(source_ids: Optional[List[str]]) -> List[dict]:
    from backend import pipeline_api as pl
    out: List[dict] = []
    with pl._LOCK:
        ids = [s for s in (source_ids or list(pl._SOURCES.keys())) if s in pl._SOURCES]
    for sid in ids:
        meta = pl._meta(sid) or {}
        name = meta.get("sanitized_filename") or meta.get("filename") or sid[:8]
        for pno, page in sorted((pl._SOURCES[sid].get("pages") or {}).items(), key=lambda kv: int(kv[0])):
            for b in page.get("blocks", []):
                texts = []
                if b.get("raw_text"):
                    texts.append(b["raw_text"])
                if b.get("cells"):
                    rows: Dict[Any, List[str]] = {}
                    for c in b["cells"]:
                        rows.setdefault(c.get("row"), []).append(str(c.get("raw_text") or ""))
                    texts.append("\n".join(" | ".join(v) for _, v in sorted(rows.items(), key=lambda kv: (kv[0] is None, kv[0]))))
                for t in texts:
                    if t.strip():
                        out.append({"source_id": sid, "filename": name, "page": int(pno), "type": b.get("type"), "text": t.strip()})
    return out


def _retrieve(question: str, passages: List[dict], k: int) -> List[dict]:
    q = set(_words(question))
    if not q:
        return passages[:k]
    scored = []
    for p in passages:
        w = _words(p["text"])
        if not w:
            continue
        hits = sum(1 for t in w if t in q)
        bonus = 1.5 if p["type"] in ("chart", "table") else 1.0   # data blocks answer numeric questions
        scored.append((hits / (len(w) ** 0.5) * bonus, p))
    scored.sort(key=lambda t: -t[0])
    seen, out = set(), []
    for s, p in scored:
        if s > 0 and (p["source_id"], p["text"]) not in seen:
            seen.add((p["source_id"], p["text"])); out.append(p)
        if len(out) >= k:
            break
    return out


def _groq(messages: List[dict], cfg: Dict[str, Any], max_tokens: int = 2048) -> str:
    body = json.dumps({"model": cfg["model"], "messages": messages, "temperature": 0.6, "top_p": 0.95,
                       "max_completion_tokens": max_tokens}).encode()
    req = urllib.request.Request(cfg["base"] + "/chat/completions", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {cfg['key']}", "Content-Type": "application/json",
                                          "User-Agent": "ParseFusion/1.0"})
    with urllib.request.urlopen(req, timeout=cfg["timeout"]) as r:
        data = json.loads(r.read().decode())
    text = data["choices"][0]["message"].get("content") or ""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()   # reasoning models may inline their thinking


def _explain(exc: Exception) -> Dict[str, str]:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            detail = json.loads(exc.read().decode()).get("error", {}).get("message", "")
        except Exception:
            detail = ""
        code = {401: "GROQ_KEY_REJECTED", 403: "GROQ_FORBIDDEN", 404: "GROQ_MODEL_NOT_FOUND", 429: "GROQ_RATE_LIMITED"}.get(exc.code, "GROQ_HTTP_ERROR")
        return {"code": code, "message": f"Groq returned HTTP {exc.code}. {detail}".strip()}
    if isinstance(exc, (urllib.error.URLError, TimeoutError, OSError)):
        return {"code": "GROQ_UNREACHABLE", "message": f"Could not reach Groq: {getattr(exc, 'reason', exc)}"}
    return {"code": "GROQ_BAD_RESPONSE", "message": f"Unexpected Groq response: {type(exc).__name__}"}


@router.get("/agents/doc-chat/status")
def status():
    from backend.pipeline_api import _ok
    cfg = _cfg()
    out = {"configured": bool(cfg["key"]), "model": cfg["model"], "reachable": None, "error": None}
    if cfg["key"]:
        try:
            _groq([{"role": "user", "content": "ping"}], cfg, max_tokens=1)
            out["reachable"] = True
        except Exception as exc:
            out["reachable"], out["error"] = False, _explain(exc)
    else:
        out["error"] = {"code": "GROQ_KEY_MISSING", "message": "Set the GROQ_API_KEY environment variable and restart the backend."}
    return _ok(out)


@router.post("/agents/doc-chat")
def chat(payload: dict = Body(...)):
    from backend.pipeline_api import _err, _ok
    question = str(payload.get("question") or "").strip()
    if not question:
        return _err(400, "INVALID_INPUT", "question is required")
    cfg = _cfg()
    passages = _retrieve(question, _passages(payload.get("source_ids")), cfg["top_k"])
    sources = [{"source_id": p["source_id"], "filename": p["filename"], "page": p["page"], "type": p["type"], "text": p["text"][:600]} for p in passages]
    if not passages:
        return _ok({"answer": "I could not find anything about that in the parsed documents.", "mode": "none", "sources": [], "error": None})
    result: Dict[str, Any] = {"mode": "extractive", "sources": sources, "error": None}
    if cfg["key"]:
        context = "\n\n".join(f"[{i + 1}] {p['filename']}, page {p['page']} ({p['type']}):\n{p['text'][:1500]}" for i, p in enumerate(passages))
        msgs = [{"role": "system", "content": "You answer questions using ONLY the numbered passages from parsed documents. Cite passages like [1]. "
                 "Quote numbers exactly as written. Bar-chart passages contain values read from the chart. If the passages do not contain the "
                 "answer, say so plainly."}]
        for h in (payload.get("history") or [])[-6:]:
            if h.get("role") in ("user", "assistant") and h.get("content"):
                msgs.append({"role": h["role"], "content": str(h["content"])[:2000]})
        msgs.append({"role": "user", "content": f"Passages:\n{context}\n\nQuestion: {question}"})
        try:
            result.update(answer=_groq(msgs, cfg), mode="groq", model=cfg["model"])
            return _ok(result)
        except Exception as exc:
            result["error"] = _explain(exc)
    else:
        result["error"] = {"code": "GROQ_KEY_MISSING", "message": "GROQ_API_KEY is not set, so no AI answer was generated."}
    result["answer"] = "Most relevant passages (no AI answer: " + result["error"]["message"] + ")"
    return _ok(result)
