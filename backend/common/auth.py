from __future__ import annotations

from typing import Any

# Single local demo user (no login yet). "*" grants everything in the UI; the explicit list is for agents that
# check one named capability (e.g. agents 15/16 require "cases:review"). Keys match src/config/capabilityKeys.ts.
CAPABILITIES = [
    "*",
    "documents:upload", "documents:view", "batch:view", "dashboard:view",
    "cases:review", "cases:decide", "actions:draft", "actions:approve",
    "access:browse", "access:request", "access:admin", "chat:sql",
    "export:create", "export:view", "audit:view", "metrics:view", "system:health", "admin:settings",
]


def current_user() -> dict[str, Any]:
    return {"user_id": "system", "role": "admin", "capabilities": list(CAPABILITIES), "tenant_id": "tenant-1"}


def require_capability(capability: str) -> None:
    return None