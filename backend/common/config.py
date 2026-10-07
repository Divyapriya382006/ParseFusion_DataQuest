from __future__ import annotations

from typing import Any

_DEFAULT = {
    "case_linker": {},
    "fact_normalizer": {},
    "reasoning": {},
    "router": {
        "min_text_chars": 40,
        "scanned_image_ratio": 0.5,
        "blank_image_ratio": 0.1,
        "mixed_image_ratio": 0.25,
        "osd_enabled": False,
        "osd_dpi": 72,
        "osd_workers": 2,
    },
}


def get(path: str | None = None, default: Any = None) -> Any:
    if path is None:
        return dict(_DEFAULT)
    if path in _DEFAULT:
        return _DEFAULT[path]
    return default


def get_config() -> dict[str, Any]:
    return dict(_DEFAULT)
