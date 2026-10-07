from __future__ import annotations

from typing import Any


class UpstreamReader:
    def __init__(self, data: Any | None = None):
        self.data = data

    def read(self, *args: Any, **kwargs: Any) -> Any:
        return self.data


def default_reader(*args: Any, **kwargs: Any) -> UpstreamReader:
    return UpstreamReader()
