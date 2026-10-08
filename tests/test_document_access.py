import importlib

import pytest

from backend import pipeline_api
from backend.common import auth

A23 = importlib.import_module("backend.agents.23_access_control")


class FakeStore:
    def __init__(self):
        self.values = {}

    def get(self, kind, identity):
        return self.values.get((kind, identity))

    def put(self, kind, identity, value):
        self.values[(kind, identity)] = value

    def delete(self, kind, identity):
        self.values.pop((kind, identity), None)

    def list_by_kind(self, kind):
        return [(identity, value) for (stored_kind, identity), value in self.values.items() if stored_kind == kind]


@pytest.fixture
def access_setup(monkeypatch):
    store = FakeStore()
    store.put("source_meta", "source-1", {
        "source_id": "source-1", "tenant_id": "tenant-1", "status": "accepted",
        "sanitized_filename": "board-report.pdf", "detected_mime": "application/pdf",
    })
    store.put("source_meta", "source-other-tenant", {
        "source_id": "source-other-tenant", "tenant_id": "tenant-2", "status": "accepted",
        "sanitized_filename": "private.pdf",
    })
    notifications = []
    monkeypatch.setattr(A23, "_document_store", lambda: store)
    monkeypatch.setattr(A23.ec, "audit", lambda *args, **kwargs: {"seq": 1})
    monkeypatch.setattr(A23.ec, "notify_send", lambda event, **kwargs: notifications.append((event, kwargs)))
    return store, notifications


def test_viewer_requests_document_and_admin_approval_grants_only_that_viewer(access_setup, monkeypatch):
    store, notifications = access_setup
    viewer = {"user_id": "reader-1", "role": "viewer", "tenant_id": "tenant-1", "capabilities": []}
    admin = {"user_id": "admin-1", "role": "admin", "tenant_id": "tenant-1", "capabilities": []}
    monkeypatch.setattr(pipeline_api, "_user", lambda: viewer)

    assert A23.op_document_sources(viewer)["documents"][0]["has_access"] is False
    request = A23.op_document_request(
        A23.DocumentRequestIn(source_id="source-1", reason="Review this report"), viewer
    )
    assert request["status"] == "pending"
    assert pipeline_api._document_access_error("source-1").status_code == 403
    with pytest.raises(A23.ec.AgentError, match="already pending"):
        A23.op_document_request(
            A23.DocumentRequestIn(source_id="source-1", reason="Need this report"), viewer
        )
    assert len(A23.op_document_requests({"user_id": "reader-2", "role": "viewer", "tenant_id": "tenant-1"})["requests"]) == 0
    assert len(A23.op_document_requests(admin)["requests"]) == 1

    decided = A23.op_document_decision(
        A23.DocumentDecisionIn(request_id=request["request_id"], decision="approve"), admin
    )
    assert decided["status"] == "approved"
    assert A23._document_access(viewer, "source-1") is True
    assert A23._document_access({"user_id": "reader-2", "role": "viewer", "tenant_id": "tenant-1"}, "source-1") is False
    assert A23.op_document_sources(viewer)["documents"][0]["has_access"] is True
    assert [event for event, _ in notifications] == ["document_access_requested", "document_access_approved"]
    assert store.get(A23._DOCUMENT_GRANT_KIND, "tenant-1:reader-1:source-1")["source_id"] == "source-1"


def test_document_request_rejection_and_non_admin_decision(access_setup):
    _, notifications = access_setup
    viewer = {"user_id": "reader-1", "role": "viewer", "tenant_id": "tenant-1", "capabilities": []}
    outsider = {"user_id": "reader-2", "role": "viewer", "tenant_id": "tenant-1", "capabilities": []}
    request = A23.op_document_request(
        A23.DocumentRequestIn(source_id="source-1", reason="Need to inspect it"), viewer
    )
    with pytest.raises(A23.ec.AgentError, match="Admin only"):
        A23.op_document_decision(
            A23.DocumentDecisionIn(request_id=request["request_id"], decision="approve"), outsider
        )
    rejected = A23.op_document_decision(
        A23.DocumentDecisionIn(request_id=request["request_id"], decision="reject", notes="Not in scope"),
        {"user_id": "admin-1", "role": "admin", "tenant_id": "tenant-1", "capabilities": []},
    )
    assert rejected["status"] == "rejected"
    assert A23._document_access(viewer, "source-1") is False
    assert notifications[-1][0] == "document_access_rejected"


def test_failed_decision_audit_rolls_back_grant_and_status(access_setup, monkeypatch):
    store, _ = access_setup
    viewer = {"user_id": "reader-1", "role": "viewer", "tenant_id": "tenant-1", "capabilities": []}
    admin = {"user_id": "admin-1", "role": "admin", "tenant_id": "tenant-1", "capabilities": []}
    request = A23.op_document_request(
        A23.DocumentRequestIn(source_id="source-1", reason="Need to inspect it"), viewer
    )
    monkeypatch.setattr(A23.ec, "audit", lambda *args, **kwargs: (_ for _ in ()).throw(A23.ec.AgentError("ENGINE_FAILED", "audit unavailable")))

    with pytest.raises(A23.ec.AgentError, match="audit unavailable"):
        A23.op_document_decision(
            A23.DocumentDecisionIn(request_id=request["request_id"], decision="approve"), admin
        )

    assert store.get(A23._DOCUMENT_REQUEST_KIND, request["request_id"])["status"] == "pending"
    assert A23._document_access(viewer, "source-1") is False


def test_viewer_catalog_hides_documents_from_other_tenants(access_setup):
    _, _ = access_setup
    viewer = {"user_id": "reader-1", "role": "viewer", "tenant_id": "tenant-1", "capabilities": []}
    assert [d["source_id"] for d in A23.op_document_sources(viewer)["documents"]] == ["source-1"]


def test_admin_can_make_document_public_and_private_for_tenant_viewers(access_setup):
    store, notifications = access_setup
    admin = {"user_id": "admin-1", "role": "admin", "tenant_id": "tenant-1", "capabilities": []}
    viewer = {"user_id": "reader-1", "role": "viewer", "tenant_id": "tenant-1", "capabilities": []}
    another_viewer = {"user_id": "reader-2", "role": "viewer", "tenant_id": "tenant-1", "capabilities": []}
    other_tenant_viewer = {"user_id": "reader-3", "role": "viewer", "tenant_id": "tenant-2", "capabilities": []}

    assert A23._document_access(viewer, "source-1") is False
    result = A23.op_document_visibility(
        A23.DocumentVisibilityIn(source_id="source-1", visibility="public"), admin
    )
    assert result["visibility"] == "public"
    assert A23._document_access(viewer, "source-1") is True
    assert A23._document_access(another_viewer, "source-1") is True
    assert A23._document_access(other_tenant_viewer, "source-1") is False
    assert A23.op_document_sources(viewer)["documents"][0]["visibility"] == "public"

    A23.op_document_visibility(
        A23.DocumentVisibilityIn(source_id="source-1", visibility="private"), admin
    )
    assert A23._document_access(viewer, "source-1") is False
    assert A23._document_access(another_viewer, "source-1") is False
    assert A23.op_document_sources(viewer)["documents"][0]["visibility"] == "private"
    assert [event for event, _ in notifications] == [
        "document_visibility_changed", "document_visibility_changed",
    ]
    assert store.get(A23._DOCUMENT_VISIBILITY_KIND, "tenant-1:source-1")["visibility"] == "private"


def test_only_admin_can_change_visibility_and_audit_failure_rolls_back(access_setup, monkeypatch):
    store, _ = access_setup
    viewer = {"user_id": "reader-1", "role": "viewer", "tenant_id": "tenant-1", "capabilities": []}
    admin = {"user_id": "admin-1", "role": "admin", "tenant_id": "tenant-1", "capabilities": []}
    visibility = A23.DocumentVisibilityIn(source_id="source-1", visibility="public")

    with pytest.raises(A23.ec.AgentError, match="Admin only"):
        A23.op_document_visibility(visibility, viewer)

    monkeypatch.setattr(A23.ec, "audit", lambda *args, **kwargs: (_ for _ in ()).throw(A23.ec.AgentError("ENGINE_FAILED", "audit unavailable")))
    with pytest.raises(A23.ec.AgentError, match="audit unavailable"):
        A23.op_document_visibility(visibility, admin)
    assert store.get(A23._DOCUMENT_VISIBILITY_KIND, "tenant-1:source-1") is None
    assert A23._document_access(viewer, "source-1") is False


def test_local_demo_auth_exposes_separate_admin_and_viewer_capabilities(monkeypatch):
    monkeypatch.setenv("PARSEFUSION_DEMO_ROLE", "viewer")
    monkeypatch.setenv("PARSEFUSION_DEMO_USER_ID", "reader-1")
    viewer = auth.current_user()
    assert viewer["role"] == "viewer"
    assert viewer["user_id"] == "reader-1"
    assert "documents:request" in viewer["capabilities"]
    assert "*" not in viewer["capabilities"]

    monkeypatch.setenv("PARSEFUSION_DEMO_ROLE", "admin")
    assert auth.current_user()["role"] == "admin"


def test_demo_role_switch_keeps_a_stable_viewer_identity(monkeypatch):
    monkeypatch.setenv("PARSEFUSION_DEMO_ROLE", "admin")
    monkeypatch.delenv("PARSEFUSION_DEMO_USER_ID", raising=False)

    viewer = auth.switch_demo_role("viewer")
    assert viewer["role"] == "viewer"
    viewer["user_id"] = "reader-1"
    monkeypatch.setenv("PARSEFUSION_DEMO_USER_ID", "reader-1")
    admin = auth.switch_demo_role("admin")
    assert admin["user_id"] == "system"
    viewer = auth.switch_demo_role("viewer")
    assert viewer["user_id"] == "reader-1"


def test_demo_role_switch_rejects_unknown_roles():
    with pytest.raises(ValueError, match="role must be admin or viewer"):
        auth.switch_demo_role("owner")
