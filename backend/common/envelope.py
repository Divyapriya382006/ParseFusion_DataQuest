from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class WarningItem:
    code: str
    message: str
    details: Optional[dict[str, Any]] = None


class ApiError(Exception):
    def __init__(self, message: str, code: str = "api_error", details: Optional[dict[str, Any]] = None):
        self.message = message
        self.code = code
        self.details = details or {}
        super().__init__(message)


@dataclass
class Timer:
    started: float

    def elapsed_ms(self) -> float:
        import time
        return (time.time() - self.started) * 1000.0


def ok(payload: Any) -> dict[str, Any]:
    return {"ok": True, "payload": payload}


def fail(message: str, code: str = "error", details: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message, "details": details or {}}}
