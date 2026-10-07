from __future__ import annotations

from enum import Enum
from typing import Any, Optional


class ErrorCode(str, Enum):
    VALIDATION = "validation_error"
    AUTH = "auth_error"
    SECURITY = "security_error"
    NOT_FOUND = "not_found"
    INTERNAL = "internal_error"
    EXTERNAL = "external_error"


class AgentError(Exception):
    def __init__(self, code: str | ErrorCode, message: str, details: Optional[dict[str, Any]] = None):
        self.code = str(code)
        self.message = message
        self.details = details or {}
        super().__init__(message)

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"
