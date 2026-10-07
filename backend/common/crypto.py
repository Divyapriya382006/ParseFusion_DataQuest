from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Blobs written by this module: MAGIC + 12-byte nonce + AES-256-GCM ciphertext (tag included).
_MAGIC = b"PFv1"


def _load_key() -> bytes:
    """Key from PARSEFUSION_DATA_KEY (base64 or hex of 32 bytes). Without it a random key is made per process,
    which matches the in-memory store: nothing encrypted outlives the process that encrypted it."""
    raw = os.getenv("PARSEFUSION_DATA_KEY", "").strip()
    if raw:
        for decode in (base64.b64decode, bytes.fromhex):
            try:
                key = decode(raw)
            except Exception:
                continue
            if len(key) == 32:
                return key
        raise RuntimeError("PARSEFUSION_DATA_KEY must be 32 bytes, base64 or hex encoded")
    return AESGCM.generate_key(bit_length=256)


_KEY = _load_key()


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def encrypt(data: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(12)
    return _MAGIC + nonce + AESGCM(_KEY).encrypt(nonce, bytes(data), aad)


def decrypt(data: bytes, aad: bytes) -> bytes:
    data = bytes(data)
    if data.startswith(_MAGIC):
        nonce, ct = data[len(_MAGIC):len(_MAGIC) + 12], data[len(_MAGIC) + 12:]
        return AESGCM(_KEY).decrypt(nonce, ct, aad)
    # Blobs written by the earlier placeholder format: b"enc:" + data + b"|" + aad.
    suffix = b"|" + aad
    if data.startswith(b"enc:") and data.endswith(suffix):
        return data[4:-len(suffix)]
    return data


def sign_url(url: str, secret: str | bytes = "") -> str:
    key = secret.encode("utf-8") if isinstance(secret, str) else secret
    mac = hmac.new(key, url.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{url}?sig={mac}"