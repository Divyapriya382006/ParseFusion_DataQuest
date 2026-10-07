from __future__ import annotations

from typing import Any, Iterable


class TextItem:
    def __init__(self, text: str, **attrs: Any):
        self.text = text
        self.__dict__.update(attrs)


def collapse_ws(value: str) -> str:
    return " ".join((value or "").split())


def join_lines(items: Iterable[str]) -> str:
    return "\n".join(str(x) for x in items)


def iou(a: set[Any], b: set[Any]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b) if (a or b) else 0.0


def mean_confidence(values: Iterable[float]) -> float:
    vals = [float(v) for v in values]
    return sum(vals) / len(vals) if vals else 0.0


def assign_items(items: list[Any], **kwargs: Any) -> list[Any]:
    for item in items:
        for key, value in kwargs.items():
            setattr(item, key, value)
    return items
