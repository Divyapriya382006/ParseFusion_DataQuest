"""Key/value store used by every agent: store.put(kind, id, obj) / store.get(kind, id).

Values live in memory for speed and are written through to a SQLite file, so uploads, pages, batches and cases
survive a backend restart (including uvicorn --reload).

    PARSEFUSION_DATA_DIR   folder for the database (default: <project>/.pf_data)
    PARSEFUSION_STORE      "sqlite" (default) or "memory" (nothing written to disk)

Under pytest the store is memory-only unless PARSEFUSION_STORE says otherwise. Delete the data folder to start
from an empty store.
"""
from __future__ import annotations

import logging
import os
import pickle
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any, Iterator

log = logging.getLogger("parsefusion.store")

_STORE: dict[tuple[str, str], Any] = {}
_LOCK = threading.RLock()

_MODE = os.getenv("PARSEFUSION_STORE") or ("memory" if "pytest" in sys.modules else "sqlite")
DATA_DIR = Path(os.getenv("PARSEFUSION_DATA_DIR") or Path(__file__).resolve().parents[2] / ".pf_data")
_DB: sqlite3.Connection | None = None


def _open() -> None:
    global _DB
    if _MODE != "sqlite":
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _DB = sqlite3.connect(str(DATA_DIR / "store.db"), check_same_thread=False, isolation_level=None)
    _DB.execute("PRAGMA journal_mode=WAL")
    _DB.execute("PRAGMA synchronous=NORMAL")
    _DB.execute("CREATE TABLE IF NOT EXISTS kv (kind TEXT NOT NULL, id TEXT NOT NULL, value BLOB NOT NULL, "
                "PRIMARY KEY (kind, id))")
    loaded = 0
    for kind, ident, blob in _DB.execute("SELECT kind, id, value FROM kv"):
        try:
            _STORE[(kind, ident)] = pickle.loads(blob)
            loaded += 1
        except Exception:
            log.warning("store: could not load %s/%s, skipped", kind, ident)
    log.info("store: %d objects loaded from %s", loaded, DATA_DIR / "store.db")


def _write(kind: str, identity: str, value: Any) -> None:
    if _DB is None:
        return
    try:
        blob = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:
        log.warning("store: %s/%s is not serialisable; kept in memory only", kind, identity)
        return
    _DB.execute("INSERT OR REPLACE INTO kv (kind, id, value) VALUES (?, ?, ?)", (kind, identity, blob))


def put(kind: str, identity: str, value: Any) -> None:
    with _LOCK:
        _STORE[(kind, identity)] = value
        _write(kind, identity, value)


def get(kind: str, identity: str) -> Any:
    return _STORE.get((kind, identity))


def delete(kind: str, identity: str) -> None:
    with _LOCK:
        _STORE.pop((kind, identity), None)
        if _DB is not None:
            _DB.execute("DELETE FROM kv WHERE kind = ? AND id = ?", (kind, identity))


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
    put("original", source_id, data)


def list_by_kind(kind: str) -> Iterator[tuple[str, Any]]:
    with _LOCK:
        items = [(key, value) for (k, key), value in _STORE.items() if k == kind]
    yield from items


_open()