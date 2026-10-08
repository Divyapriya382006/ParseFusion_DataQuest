from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Blobs written by this module: MAGIC + 12-byte nonce + AES-256-GCM ciphertext (tag included).
_MAGIC = b"PFv1"


def _load_key() -> bytes:
    """Key from PARSEFUSION_DATA_KEY (base64 or hex of 32 bytes). Otherwise a key is generated once and kept in
    <data dir>/data.key next to the persistent store, so stored files can still be decrypted after a restart.
    Memory-only stores (tests) use a per-process key."""
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
    from backend.common import store
    if getattr(store, "_DB", None) is None:
        return AESGCM.generate_key(bit_length=256)
    path = store.DATA_DIR / "data.key"
    if path.exists():
        key = base64.b64decode(path.read_bytes().strip())
        if len(key) == 32:
            return key
    key = AESGCM.generate_key(bit_length=256)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(base64.b64encode(key))
    os.replace(tmp, path)
    return key


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


# ------------------------------------------------------------------------------ signatures (exports, approvals)
def _key_file(name: str, make: Any) -> bytes:
    """Secret material kept next to the persistent store; per-process when the store is memory-only."""
    from backend.common import store
    if getattr(store, "_DB", None) is None:
        return make()
    path = store.DATA_DIR / name
    if path.exists():
        return base64.b64decode(path.read_bytes().strip())
    data = make()
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(base64.b64encode(data))
    os.replace(tmp, path)
    return data


_SIGNING_KEY = Ed25519PrivateKey.from_private_bytes(_key_file(
    "signing.key",
    lambda: Ed25519PrivateKey.generate().private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                                       serialization.NoEncryption())))
_PUBLIC_RAW = _SIGNING_KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
KID = "ed25519:" + hashlib.sha256(_PUBLIC_RAW).hexdigest()[:16]
_HMAC_KEY = os.getenv("URL_SIGNING_KEY", "").encode("utf-8") or _key_file("url.key", lambda: os.urandom(32))


def sign(payload: bytes) -> dict:
    """Ed25519 signature of payload -> {kid, algorithm, value (base64), public_key (base64)}."""
    return {"kid": KID, "algorithm": "Ed25519",
            "value": base64.b64encode(_SIGNING_KEY.sign(bytes(payload))).decode("ascii"),
            "public_key": base64.b64encode(_PUBLIC_RAW).decode("ascii")}


def verify(payload: bytes, sig: dict) -> bool:
    if not isinstance(sig, dict) or sig.get("algorithm") != "Ed25519" or sig.get("kid") != KID:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(_PUBLIC_RAW).verify(base64.b64decode(sig["value"]), bytes(payload))
        return True
    except (InvalidSignature, ValueError, KeyError):
        return False


def hmac_sign(message: bytes) -> str:
    return hmac.new(_HMAC_KEY, bytes(message), hashlib.sha256).hexdigest()


def hmac_verify(message: bytes, sig: str) -> bool:
    return hmac.compare_digest(hmac_sign(message), sig or "")