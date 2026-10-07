from __future__ import annotations

from typing import Any

_AUDIT: list[dict[str, Any]] = []


def append(event: dict[str, Any]) -> str:
    event = dict(event)
    event.setdefault("event_id", f"evt_{len(_AUDIT)}")
    _AUDIT.append(event)
    return event["event_id"]


def query() -> list[dict[str, Any]]:
    return list(_AUDIT)
