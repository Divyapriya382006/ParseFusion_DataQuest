from __future__ import annotations

from typing import Any, Callable


def agent(*args: Any, **kwargs: Any) -> Callable[[Callable], Callable]:
    def decorator(fn: Callable) -> Callable:
        return fn
    return decorator
