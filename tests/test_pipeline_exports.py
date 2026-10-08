from __future__ import annotations

from backend import pipeline_api


class FakeSupport:
    class AgentError(Exception):
        def __init__(self, code: str, message: str):
            super().__init__(message)
            self.code = code
            self.message = message

    def __init__(self):
        self.store = {
            ("source_meta", "source-1"): {
                "tenant_id": "tenant-1",
                "status": "accepted",
                "sanitized_filename": "invoice.pdf",
                "detected_mime": "application/pdf",
                "sha256": "abc123",
                "size_bytes": 123,
                "page_count": 1,
            },
        }

    def current_user(self):
        return {
            "user_id": "user-1",
            "tenant_id": "tenant-1",
            "role": "admin",
            "capabilities": ["*"],
        }

    def store_get(self, kind: str, object_id: str):
        return self.store.get((kind, object_id))

    def store_put(self, kind: str, object_id: str, value):
        self.store[(kind, object_id)] = value


class FakeExportAgent:
    class ExportScope:
        def __init__(self, type: str, ids: list[str]):
            self.type = type
            self.ids = ids

    class ExportOptions:
        def __init__(self, include_evidence: bool):
            self.include_evidence = include_evidence

    class ExportIn:
        def __init__(self, scope, format: str, options):
            self.scope = scope
            self.format = format
            self.options = options

    def __init__(self, failing_formats=()):
        self.calls = []
        self.failing_formats = set(failing_formats)

    def run(self, request, user):
        self.calls.append((request, user))
        if request.format in self.failing_formats:
            raise FakeSupport.AgentError("UNSUPPORTED_FORMAT", "No renderer is installed")
        return {
            "export_id": f"export-{request.format}",
            "format": request.format,
            "download_url": f"/agents/export/download/export-{request.format}",
            "content_hash": f"hash-{request.format}",
        }


def _prepare_batch(monkeypatch, formats, failing_formats=()):
    support = FakeSupport()
    exporter = FakeExportAgent(failing_formats)
    monkeypatch.setattr(pipeline_api, "_support", lambda: support)
    monkeypatch.setattr(pipeline_api, "_agent", lambda name: exporter if name == "20_export" else None)
    monkeypatch.setitem(pipeline_api._BATCHES, "batch-1", {
        "batch_id": "batch-1",
        "job_id": "job-1",
        "created_at": "2026-10-08T00:00:00Z",
        "status": "running",
        "source_ids": ["source-1", "source-failed"],
        "output_formats": formats,
        "sources_summary": {"total": 2, "completed": 1, "failed": 1},
    })
    monkeypatch.setitem(pipeline_api._SOURCES, "source-1", {
        "status": "completed",
        "route": "native_text",
        "warnings": [],
        "pages": {
            1: {
                "page_id": "source-1_p1",
                "page_number": 1,
                "blocks": [{"raw_text": "Invoice total: 100"}],
            },
        },
    })
    monkeypatch.setitem(pipeline_api._SOURCES, "source-failed", {"status": "failed"})
    return support, exporter


def test_batch_generates_each_requested_export_for_successful_sources(monkeypatch):
    support, exporter = _prepare_batch(monkeypatch, ["json", "csv", "pdf"])

    pipeline_api._refresh_batch("batch-1")

    batch = pipeline_api._batch_view(pipeline_api._BATCHES["batch-1"])
    assert batch["status"] == "completed"
    assert batch["output_formats"] == ["json", "csv", "pdf"]
    assert [item["format"] for item in batch["exports"]] == ["json", "csv", "pdf"]
    assert batch["export_errors"] == []
    assert all(call[0].scope.type == "batch" for call in exporter.calls)
    assert all(call[0].options.include_evidence for call in exporter.calls)
    assert support.store[("batch", "batch-1")]["sources"][0]["pages"][0]["blocks"][0]["raw_text"] == "Invoice total: 100"


def test_batch_reports_export_failure_without_discarding_successful_formats(monkeypatch):
    _, exporter = _prepare_batch(monkeypatch, ["json", "csv"], failing_formats=["csv"])

    pipeline_api._refresh_batch("batch-1")

    batch = pipeline_api._batch_view(pipeline_api._BATCHES["batch-1"])
    assert [item["format"] for item in batch["exports"]] == ["json"]
    assert batch["export_errors"] == [{
        "format": "csv",
        "code": "UNSUPPORTED_FORMAT",
        "message": "No renderer is installed",
    }]
    assert batch["stage"] == "completed with 1 failed source(s) and export failures"
    assert len(exporter.calls) == 2


def test_batch_source_retry_is_rejected_while_exports_are_generating(monkeypatch):
    monkeypatch.setitem(pipeline_api._BATCHES, "batch-1", {
        "batch_id": "batch-1",
        "job_id": "job-1",
        "source_ids": ["source-1"],
        "stage": "exporting",
    })

    response = pipeline_api.retry_source("batch-1", pipeline_api.RetryIn(source_id="source-1"))

    assert response.status_code == 409
