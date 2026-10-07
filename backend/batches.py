"""Batch orchestration stub.

Provides the /batches endpoints the frontend needs to submit accepted sources
for pipeline processing and track progress.  Currently in-memory only.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

router = APIRouter()

# --------------- models
class CreateBatchInput(BaseModel):
    source_ids: List[str] = Field(min_length=1)
    mode: str = "standard"
    output_formats: List[str] = []
    case_id: Optional[str] = None
    instructions: Optional[str] = None
    options: Optional[Dict[str, Any]] = None


class SourceStatus(BaseModel):
    source_id: str
    status: str = "queued"  # queued | processing | completed | failed
    progress: float = 0.0
    error: Optional[str] = None


class BatchSummary(BaseModel):
    batch_id: str
    job_id: str
    status: str  # queued | processing | completed | failed
    mode: str
    output_formats: List[str]
    case_id: Optional[str] = None
    sources: List[SourceStatus] = []
    created_at: float
    updated_at: float
    progress: float = 0.0


# --------------- in-memory store
_BATCHES: Dict[str, dict] = {}


def _envelope(data: Any) -> dict:
    return {"ok": True, "data": data, "error": None, "request_id": uuid.uuid4().hex}


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"ok": False, "data": None, "error": {"code": code, "message": message},
                 "request_id": uuid.uuid4().hex},
    )


@router.post("/batches")
def create_batch(body: CreateBatchInput):
    now = time.time()
    batch_id = uuid.uuid4().hex[:16]
    job_id = uuid.uuid4().hex[:16]
    sources = [SourceStatus(source_id=sid).model_dump() for sid in body.source_ids]
    batch = {
        "batch_id": batch_id,
        "job_id": job_id,
        "status": "queued",
        "mode": body.mode,
        "output_formats": body.output_formats,
        "case_id": body.case_id,
        "sources": sources,
        "created_at": now,
        "updated_at": now,
        "progress": 0.0,
    }
    _BATCHES[batch_id] = batch
    return _envelope({"batch_id": batch_id, "job_id": job_id, "status": "queued"})


@router.get("/batches")
def list_batches():
    batches = sorted(_BATCHES.values(), key=lambda b: b["created_at"], reverse=True)
    return _envelope({"batches": batches})


@router.get("/batches/{batch_id}")
def get_batch(batch_id: str):
    b = _BATCHES.get(batch_id)
    if b is None:
        return _error(404, "NOT_FOUND", "Batch not found")
    return _envelope(b)


@router.post("/batches/{batch_id}/retry")
def retry_batch_source(batch_id: str, body: dict):
    b = _BATCHES.get(batch_id)
    if b is None:
        return _error(404, "NOT_FOUND", "Batch not found")
    job_id = uuid.uuid4().hex[:16]
    return _envelope({"job_id": job_id})
