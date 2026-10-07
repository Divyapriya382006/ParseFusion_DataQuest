from __future__ import annotations

from typing import Any


def run(task: str, prompt: str, *, model: str | None = None, **kwargs: Any) -> dict[str, Any]:
    return {"task": task, "prompt": prompt, "model": model, "ok": True}


def validate_prompt(text: str) -> str:
    return text.strip()


def safe_json(data: Any) -> str:
    import json
    return json.dumps(data, default=str, sort_keys=True)
