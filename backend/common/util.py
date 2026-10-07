from __future__ import annotations

import hashlib
import json
from typing import Any


def make_page_id(source_id: str, page_number: int) -> str:
    token = hashlib.sha256(f"{source_id}:{page_number}".encode("utf-8")).hexdigest()[:16]
    return f"p_{token}"


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
