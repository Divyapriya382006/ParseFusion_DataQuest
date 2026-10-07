from __future__ import annotations

from typing import Any


def current_user() -> dict[str, Any]:
    return {"user_id": "system", "role": "admin", "capabilities": ["*"], "tenant_id": "tenant-1"}


def require_capability(capability: str) -> None:
    return None
