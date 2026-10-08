import json

from backend import pipeline_api


class FakeStore:
    def __init__(self):
        self.items = {}

    def put(self, kind, source_id, value):
        self.items[(kind, source_id)] = value

    def get(self, kind, source_id):
        return self.items.get((kind, source_id))


def test_url_dom_is_registered_as_a_parsed_pipeline_source(monkeypatch):
    store = FakeStore()
    published = []
    monkeypatch.setattr(pipeline_api, "_store", lambda: store)
    monkeypatch.setattr(pipeline_api, "_publish_source", lambda *args: published.append(args))
    monkeypatch.setattr(pipeline_api, "_save_source", lambda _source_id: None)
    monkeypatch.setattr(pipeline_api, "_SOURCES", {})
    record = {
        "source_id": "web-1",
        "tenant_id": "tenant-1",
        "text_blob": b"encrypted",
        "page": {"page_id": "page-1", "page_width": 800, "page_height": 600},
        "origin": {"type": "url", "url": "https://example.test/report"},
        "display_name": "example.test_report",
        "fetched_at": "2026-10-08T00:00:00Z",
        "links": [{"text": "Annual report", "url": "https://example.test/annual-report"}],
    }
    payload = json.dumps({"elements": [
        {"text": "Revenue 100", "bbox": [10, 20, 100, 40], "confidence": 0.92},
        {"text": "  ", "bbox": [0, 0, 0, 0], "confidence": 1},
    ]}).encode()

    pipeline_api.register_url_source(record, "tenant-1", lambda _blob, _aad: payload)

    page = store.get("url_page", "web-1")
    assert page["blocks"][0]["raw_text"] == "Revenue 100"
    assert page["blocks"][0]["extraction_method"] == "web_dom"
    assert page["blocks"][0]["location"]["bbox"] == [10, 20, 100, 40]
    assert page["links"] == record["links"]
    assert store.get("source_meta", "web-1")["url_ingested"] is True
    assert pipeline_api._SOURCES["web-1"]["status"] == "completed"
    assert published


def test_batch_source_reuses_registered_url_dom_without_file_router(monkeypatch):
    page = {"page_number": 1, "blocks": [{"raw_text": "Extracted DOM text"}], "warnings": []}
    store = FakeStore()
    store.put("url_page", "web-2", page)
    published = []

    class FakeAgentError(Exception):
        def __init__(self, code, message):
            super().__init__(message)
            self.code, self.message = code, message

    monkeypatch.setattr(pipeline_api, "_support", lambda: type("Support", (), {"AgentError": FakeAgentError})())
    monkeypatch.setattr(pipeline_api, "_meta", lambda _sid: {"status": "accepted", "url_ingested": True})
    monkeypatch.setattr(pipeline_api, "_store", lambda: store)
    monkeypatch.setattr(pipeline_api, "_set_source", lambda _sid, **kwargs: captured.update(kwargs))
    monkeypatch.setattr(pipeline_api, "_refresh_batch", lambda _bid: None)
    monkeypatch.setattr(pipeline_api, "_publish_source", lambda *args: published.append(args))
    captured = {}

    pipeline_api._run_source("batch-1", "web-2")

    assert captured["status"] == "completed"
    assert captured["route"] == "web_dom"
    assert captured["pages"] == {1: page}
    assert published
