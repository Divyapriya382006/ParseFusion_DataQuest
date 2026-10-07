from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class CheckResult:
    name: str
    status: str
    detail: str


@dataclass
class TableBlock:
    cells: list[Any] = field(default_factory=list)


@dataclass
class WarningItem:
    code: str
    message: str
    details: dict[str, Any] | None = None
