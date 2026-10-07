from __future__ import annotations

from typing import Any, Iterator

_STORE: dict[tuple[str, str], Any] = {}


def put(kind: str, identity: str, value: Any) -> None:
    _STORE[(kind, identity)] = value


def get(kind: str, identity: str) -> Any:
    return _STORE.get((kind, identity))


def delete(kind: str, identity: str) -> None:
    _STORE.pop((kind, identity), None)


def get_file(source_id: str) -> bytes | None:
    """Plaintext original. Agent 01 stores it encrypted with aad "<tenant_id>:<source_id>"."""
    blob = _STORE.get(("original", source_id))
    if blob is None:
        return None
    meta = _STORE.get(("source_meta", source_id)) or {}
    tenant = meta.get("tenant_id", "")
    from backend.common import crypto
    return crypto.decrypt(blob, f"{tenant}:{source_id}".encode("utf-8"))


def set_file(source_id: str, data: bytes) -> None:
    _STORE[("original", source_id)] = data


def list_by_kind(kind: str) -> Iterator[tuple[str, Any]]:
    for (k, key), value in _STORE.items():
        if k == kind:
            yield key, value