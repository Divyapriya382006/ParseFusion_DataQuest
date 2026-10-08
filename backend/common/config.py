from __future__ import annotations

import copy
import json
from pathlib import Path
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

# Agent settings kept with the other platform settings: the "agents" section of backend/platform_config.json is
# merged over the defaults above (e.g. "reasoning" for agent 16, "fact_normalizer" for agent 15).
_PLATFORM_FILE = Path(__file__).resolve().parents[1] / "platform_config.json"


def _merged() -> dict[str, Any]:
    cfg = copy.deepcopy(_DEFAULT)
    try:
        agents = json.loads(_PLATFORM_FILE.read_text(encoding="utf-8")).get("agents") or {}
    except Exception:
        agents = {}
    for key, value in agents.items():
        if isinstance(value, dict) and isinstance(cfg.get(key), dict):
            cfg[key] = {**cfg[key], **value}
        else:
            cfg[key] = value
    return cfg


def get(path: str | None = None, default: Any = None) -> Any:
    """config.get() -> everything, config.get("reasoning") -> a section, config.get("reasoning.tolerance_pct")."""
    cfg = _merged()
    if path is None:
        return cfg
    node: Any = cfg
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


def get_config() -> dict[str, Any]:
    return _merged()