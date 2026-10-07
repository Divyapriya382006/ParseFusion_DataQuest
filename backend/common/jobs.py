from __future__ import annotations

from typing import Any

_JOBS: dict[str, Any] = {}


def submit(name: str, payload: Any | None = None) -> str:
    job_id = f"job_{len(_JOBS)}"
    _JOBS[job_id] = {"name": name, "payload": payload}
    return job_id


def get(job_id: str) -> Any:
    return _JOBS.get(job_id)
