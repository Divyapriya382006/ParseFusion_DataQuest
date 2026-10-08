"""Platform endpoints the frontend needs before any agent is called.

    GET /config         app configuration (limits, formats, modes, bands ...)
    GET /auth/me        the current user and their capabilities
    GET /health/agents  which agents are mounted

Values come from the backend itself wherever it already defines them (agent 01's accepted file types and size/page
limits, agent 20's export formats and scopes, common.auth for the user). Everything else is read from
backend/platform_config.json, or from the file named by PARSEFUSION_PLATFORM_CONFIG.
"""
from __future__ import annotations

import importlib
import json
import os
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

router = APIRouter()

_CONFIG_FILE = Path(os.getenv("PARSEFUSION_PLATFORM_CONFIG") or Path(__file__).with_name("platform_config.json"))

# Filled in by backend.main after the agent routers are mounted.
AGENT_STATUS: dict[str, Any] = {"mounted": [], "failed": {}}


def _envelope(data: Any) -> dict:
    return {"ok": True, "data": data, "error": None, "request_id": uuid.uuid4().hex}


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"ok": False, "data": None, "error": {"code": code, "message": message}, "request_id": uuid.uuid4().hex},
    )


def _agent(name: str):
    try:
        return importlib.import_module(f"backend.agents.{name}")
    except Exception:
        return None


def _label(token: str) -> str:
    return token.replace("_", " ").replace("-", " ").strip().title()


def _file_settings() -> dict:
    with open(_CONFIG_FILE, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _limits() -> dict:
    support = _agent("_support")
    validation = _agent("01_file_validation")
    if support is None or validation is None:
        raise RuntimeError("agent 01 is not available, so upload limits are unknown")
    max_bytes = support.limit(("max_file_size_bytes", "max_file_size_mb", "maxFileSizeBytes"), "max_file_size_bytes")
    max_pages = support.limit(("max_pages", "maxPages"), "max_pages")
    exts = sorted(getattr(validation, "EXT_TO_MIMES", {}) or {})
    return {
        "max_file_mb": round(max_bytes / (1024 * 1024), 2),
        "max_pages": int(max_pages),
        "accepted_types": [f".{e}" for e in exts],
    }


def _export_options() -> tuple[list, list]:
    export = _agent("20_export")
    if export is None:
        return [], []
    ec = _agent("e_common")
    scopes = list(getattr(export, "DEFAULT_SCOPES", []) or [])
    formats = list(getattr(export, "DEFAULT_FORMATS", []) or [])
    if ec is not None and hasattr(ec, "cfg"):
        scopes = list(ec.cfg("exports.scopes", scopes) or scopes)
        formats = list(ec.cfg("exports.formats", formats) or formats)
    return (
        [{"id": f, "label": f.upper() if len(f) <= 4 else _label(f)} for f in formats],
        [{"id": s, "label": _label(s)} for s in scopes],
    )


@router.get("/config")
def get_config():
    try:
        settings = _file_settings()
        limits = _limits()
    except Exception as exc:
        return _error(500, "CONFIG_UNAVAILABLE", str(exc))
    output_formats, export_scopes = _export_options()
    data = {
        "poll_interval_ms": int(settings.get("poll_interval_ms", 2000)),
        "auth": settings.get("auth") or {"mode": "none"},
        "processing_modes": settings.get("processing_modes") or [],
        "output_formats": output_formats,
        "export_scopes": export_scopes,
        "action_types": settings.get("action_types") or [],
        "limits": limits,
        "confidence_bands": settings.get("confidence_bands") or [],
        "severity_levels": settings.get("severity_levels") or [],
        "feature_flags": settings.get("feature_flags") or {},
        "ui": settings.get("ui") or {},
        "pipeline_stages": [{"id": n, "label": f"{n[:2]} {_label(n[3:])}"} for n in AGENT_STATUS["mounted"]],
    }
    if settings.get("realtime_url"):
        data["realtime_url"] = settings["realtime_url"]
    return _envelope(data)


@router.get("/auth/me")
def auth_me():
    try:
        from backend.common import auth  # type: ignore
        user = auth.current_user()
    except Exception as exc:
        return _error(401, "UNAUTHENTICATED", f"Not authenticated: {exc}")
    if not isinstance(user, dict) or not user.get("user_id"):
        return _error(401, "UNAUTHENTICATED", "Not authenticated")
    profile = {
        "user_id": str(user["user_id"]),
        "display_name": str(user.get("display_name") or user.get("name") or user["user_id"]),
        "role": str(user.get("role") or ""),
        "capabilities": [str(c) for c in (user.get("capabilities") or [])],
        "demo_role_switch_enabled": True,
    }
    if user.get("tenant_id"):
        profile["tenant_id"] = str(user["tenant_id"])
    return _envelope(profile)


@router.post("/auth/demo-role")
def switch_demo_role(body: dict = Body(...)):
    role = body.get("role")
    if role not in ("admin", "viewer"):
        return _error(400, "INVALID_INPUT", "role must be admin or viewer")
    try:
        from backend.common import auth
        user = auth.switch_demo_role(role)
    except Exception as exc:
        return _error(500, "ROLE_SWITCH_FAILED", f"Could not switch demo role: {exc}")
    return _envelope({
        "user_id": str(user["user_id"]),
        "display_name": str(user.get("display_name") or user.get("name") or user["user_id"]),
        "role": str(user["role"]),
        "capabilities": [str(c) for c in user.get("capabilities") or []],
        "demo_role_switch_enabled": True,
    })


@router.get("/health/agents")
def health_agents():
    agents = [{"id": n, "name": f"{n[:2]}. {_label(n[3:])}", "status": "healthy"} for n in AGENT_STATUS["mounted"]]
    agents += [
        {"id": n, "name": f"{n[:2]}. {_label(n[3:])}", "status": "offline", "reason": reason}
        for n, reason in sorted(AGENT_STATUS["failed"].items())
    ]
    try:
        from backend import pipeline_api
        ocr = {k: v for k, v in pipeline_api.ocr_info().items() if not k.startswith("_")}
    except Exception as exc:  # pragma: no cover
        ocr = {"available": False, "reason": str(exc)}
    for a in agents:
        if a["id"].startswith("04_"):
            a["engine"] = ocr.get("engine")
            a["engine_version"] = ocr.get("version")
            if not ocr.get("available"):
                a["status"] = "degraded"
                a["reason"] = ocr.get("reason")
    return _envelope({"agents": agents, "ocr": ocr})
