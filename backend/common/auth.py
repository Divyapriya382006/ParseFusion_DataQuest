from __future__ import annotations

import os
from typing import Any

# This is a local-development identity switch, not authentication. Deployments must use a real auth provider.
ADMIN_CAPABILITIES = [
    "*",
    "documents:upload", "documents:view", "batch:view", "dashboard:view",
    "cases:review", "cases:decide", "actions:draft", "actions:approve",
    "access:browse", "access:request", "access:admin", "chat:sql",
    "export:create", "export:view", "audit:view", "metrics:view", "system:health", "admin:settings",
]

VIEWER_CAPABILITIES = ["access:browse", "access:request", "documents:request"]


def current_user() -> dict[str, Any]:
    role = os.getenv("PARSEFUSION_DEMO_ROLE", "admin").strip().lower()
    if role not in ("admin", "viewer"):
        raise ValueError("PARSEFUSION_DEMO_ROLE must be admin or viewer")
    default_user = "system" if role == "admin" else "viewer"
    capabilities = ADMIN_CAPABILITIES if role == "admin" else VIEWER_CAPABILITIES
    return {
        "user_id": os.getenv("PARSEFUSION_DEMO_USER_ID", default_user),
        "role": role,
        "capabilities": list(capabilities),
        "tenant_id": os.getenv("PARSEFUSION_DEMO_TENANT_ID", "tenant-1"),
    }


def switch_demo_role(role: str) -> dict[str, Any]:
    if role not in ("admin", "viewer"):
        raise ValueError("role must be admin or viewer")
    current_role = os.getenv("PARSEFUSION_DEMO_ROLE", "admin").strip().lower()
    if current_role == "viewer":
        viewer_id = os.getenv("PARSEFUSION_DEMO_USER_ID", "viewer")
        os.environ["PARSEFUSION_DEMO_VIEWER_USER_ID"] = viewer_id
    os.environ["PARSEFUSION_DEMO_ROLE"] = role
    if role == "admin":
        os.environ["PARSEFUSION_DEMO_USER_ID"] = "system"
    else:
        os.environ["PARSEFUSION_DEMO_USER_ID"] = os.getenv("PARSEFUSION_DEMO_VIEWER_USER_ID", "viewer")
    return current_user()


def require_capability(capability: str) -> None:
    return None