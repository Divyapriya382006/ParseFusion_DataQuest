from __future__ import annotations

from enum import Enum
from typing import Any, Optional


class ErrorCode(str, Enum):
    # Error codes of the API contract (docs/CONTRACT.md)
    INVALID_INPUT = "INVALID_INPUT"
    UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"
    TOO_LARGE = "TOO_LARGE"
    PASSWORD_REQUIRED = "PASSWORD_REQUIRED"
    CORRUPT_FILE = "CORRUPT_FILE"
    MALWARE_SUSPECTED = "MALWARE_SUSPECTED"
    FORBIDDEN = "FORBIDDEN"
    NOT_FOUND = "NOT_FOUND"
    CONFLICT = "CONFLICT"
    TIMEOUT = "TIMEOUT"
    ENGINE_FAILED = "ENGINE_FAILED"
    RATE_LIMITED = "RATE_LIMITED"
    # Older generic codes, kept for existing callers
    VALIDATION = "validation_error"
    AUTH = "auth_error"
    SECURITY = "security_error"
    INTERNAL = "internal_error"
    EXTERNAL = "external_error"


class AgentError(Exception):
    def __init__(self, code: str | ErrorCode, message: str, details: Optional[dict[str, Any]] = None):
        # str() of an Enum member is "ErrorCode.X"; keep the bare code so callers can compare and map it.
        self.code = code.value if isinstance(code, Enum) else str(code)
        self.message = message
        self.details = details or {}
        super().__init__(message)

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"