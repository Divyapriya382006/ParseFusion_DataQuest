"""ParseFusion API entrypoint.

Run from the project root:
    python -m uvicorn backend.main:app --reload --port 8000

Mounts the router of every agent module in backend/agents (files named NN_*.py). An agent that fails to import
is skipped and reported at GET /health, so one broken agent does not stop the others from serving.
"""
from __future__ import annotations

import importlib
import logging
import os
import re
import traceback
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

log = logging.getLogger("parsefusion")

app = FastAPI(title="ParseFusion API")

_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MOUNTED: list[str] = []
FAILED: dict[str, str] = {}

_agents_dir = Path(__file__).resolve().parent / "agents"
for path in sorted(_agents_dir.glob("[0-9][0-9]_*.py")):
    name = path.stem
    try:
        mod = importlib.import_module(f"backend.agents.{name}")
        router = getattr(mod, "router", None)
        if router is None:
            FAILED[name] = "module has no `router`"
            continue
        app.include_router(router)
        if hasattr(mod, "install"):
            mod.install(app)
        MOUNTED.append(name)
    except Exception as exc:  # keep serving the agents that do work
        FAILED[name] = f"{type(exc).__name__}: {exc}"
        log.warning("agent %s not mounted:\n%s", name, traceback.format_exc())


from backend import platform_api  # noqa: E402
# pipeline_api serves /batches (and runs the agents), /jobs, /sources, /cases, /actions and /metrics.
# It replaces the in-memory stub in backend/batches.py, which only recorded batches and never processed them.
from backend import pipeline_api  # noqa: E402

platform_api.AGENT_STATUS["mounted"] = MOUNTED
platform_api.AGENT_STATUS["failed"] = FAILED
app.include_router(platform_api.router)
app.include_router(pipeline_api.router)


@app.get("/health")
def health():
    return {"ok": True, "data": {"mounted": MOUNTED, "failed": FAILED}, "error": None, "request_id": None}