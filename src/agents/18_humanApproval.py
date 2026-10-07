"""
Agent 22 - URL Guard + Web Render            POST /agents/url-ingest
Owner: Person D (Case Reasoning & Web)

Purpose
    Decide whether a URL may be fetched, fetch it safely, render it, and register
    the snapshot as a source for the pipeline. Deterministic: NO LLM is used here.

Security layers (in order; every layer fails closed)
    L0  Capability check, free-text hygiene (purpose / authorization_basis).
    L1  URL syntax: scheme allowlist, no userinfo, no backslashes/control chars,
        port allowlist, IDNA normalisation, numeric-host obfuscation rejected.
    L2  Host policy: denylist (wins) -> internal hostnames -> allowlist.
    L3  SSRF: resolve DNS, EVERY returned IP must be globally routable (IPv4-mapped,
        6to4, NAT64 unwrapped; Teredo rejected; extra CIDRs from config). The
        connection is PINNED to the validated IP (Host header + SNI = hostname),
        so DNS rebinding between check and use is impossible.
    L4  Redirects are followed manually, each hop re-runs L1-L3 (+ robots).
    L5  robots.txt honoured (RFC 9309: 4xx = allowed, 5xx/redirect/error = blocked).
    L6  Per-domain rate limit; response / subresource / request-count caps.
    L7  Rendering: Chromium has NO network of its own (host-resolver MAP * ~NOTFOUND).
        Every request is intercepted and served from our pinned, guarded fetcher.
        GET only, no downloads, no service workers, no cookies, no sub-frames,
        no in-page navigation. Login walls -> blocked; we never log in.
    L8  Prompt-injection layer (web text is UNTRUSTED): rule scan of visible text,
        hidden text (display:none, opacity 0, off-screen, comments, alt/aria/title)
        and invisible/bidi characters. Action per config: flag | quarantine | block.
    L9  Sensitive-data layer: PII (email, phone, card+Luhn, Aadhaar+Verhoeff, PAN,
        IBAN+mod97, US SSN) and credentials (private keys, cloud/API keys, JWT,
        password=...). Credentials block by default; PII is tagged / redacted /
        blocked per config. Values are NEVER logged, audited or notified (counts only).
    L10 Evidence is encrypted at rest (AES-GCM via common/crypto, AAD = tenant:object).
        Audit is written BEFORE the source is committed; audit failure = no source.

Confidence for each DOM text element (computed, not defaulted)
    confidence = (1 - removed_invisible_chars / original_length)
                 * (cfg.injection_confidence_factor if injection-flagged else 1.0)

Config (read from /config -> "url_guard"; nothing here is hardcoded). Person C must add:
    capability, allowed_schemes, allowed_ports, max_url_length, domain_allowlist,
    domain_denylist, blocked_hostnames, blocked_hostname_suffixes, extra_blocked_cidrs,
    require_authorization_basis, authorization_bases, max_redirects, dns_timeout_s,
    connect_timeout_s, total_timeout_s, settle_timeout_ms, max_response_bytes,
    max_subresource_bytes, max_total_bytes, robots_max_bytes, max_requests,
    allowed_document_types, allowed_subresource_types, allow_third_party_subresources,
    viewport_width, viewport_height, max_page_height, max_text_elements,
    max_aux_strings, rate_limit_per_domain, rate_limit_window_s, user_agent,
    injection_action, injection_flag_threshold, injection_block_score,
    injection_confidence_factor, secret_action, pii_action, screenshot_url_ttl_s,
    admin_link_template, max_free_text_chars.

Assumed shared interfaces (adapt ONLY in default_deps(), nowhere else)
    common.config.get(name)->dict, common.auth.current_user()->{user_id, role,
    capabilities, tenant_id}, common.audit.append(event)->{event_id,...},
    common.notify.send(...), common.crypto.{encrypt, canonical_json, sha256_hex,
    signed_url}, common.store.put(kind,id,obj), common.jobs.submit(name,payload),
    common.errors.AgentError(code,message,details?).

Known limits
    * Text hidden only by colour-matching the background or by overflow clipping is
      not detected as hidden (the screenshot is the ground truth).
    * Rate-limit state is in-process (per worker). Use a shared store for multi-worker.
    * Domain key for rate limiting = last two labels (no public-suffix list).
    * Third-party subresources are blocked unless config allows them.
"""
from __future__ import annotations

import asyncio
import inspect
import ipaddress
import re
import socket
import struct
import threading
import time
import unicodedata
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Literal, Optional
from urllib import robotparser
from urllib.parse import urljoin, urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict

try:  # shared error type from Person C's common package
    from backend.common.errors import AgentError  # type: ignore
except ImportError:  # pragma: no cover - only for isolated unit tests
    class AgentError(Exception):
        def __init__(self, code: str, message: str, details: Optional[dict] = None):
            super().__init__(message)
            self.code, self.message, self.details = code, message, details


# --------------------------------------------------------------------------- #
# Models (contract: In {url, purpose?, authorization_basis?}                   #
#   Out {status, reason?, robots_checked, source_id?, snapshot?, error?})      #
# --------------------------------------------------------------------------- #
class UrlIngestInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str
    purpose: Optional[str] = None
    authorization_basis: Optional[str] = None


class ErrorInfo(BaseModel):
    code: str
    message: str
    details: Optional[dict] = None


class Snapshot(BaseModel):
    screenshot_url: str
    fetched_at: str


class UrlIngestOutput(BaseModel):
    status: Literal["allowed", "blocked", "failed"]
    reason: Optional[str] = None
    robots_checked: bool
    source_id: Optional[str] = None
    snapshot: Optional[Snapshot] = None
    error: Optional[ErrorInfo] = None


class UrlGuardConfig(BaseModel):
    """Every field is required: a missing key means fail closed (ENGINE_FAILED)."""
    model_config = ConfigDict(extra="ignore")
    capability: str
    allowed_schemes: list[str]
    allowed_ports: list[int]
    max_url_length: int
    domain_allowlist: list[str]
    domain_denylist: list[str]
    blocked_hostnames: list[str]
    blocked_hostname_suffixes: list[str]
    extra_blocked_cidrs: list[str]
    require_authorization_basis: bool
    authorization_bases: list[str]
    max_redirects: int
    dns_timeout_s: float
    connect_timeout_s: float
    total_timeout_s: float
    settle_timeout_ms: int
    max_response_bytes: int
    max_subresource_bytes: int
    max_total_bytes: int
    robots_max_bytes: int
    max_requests: int
    allowed_document_types: list[str]
    allowed_subresource_types: list[str]
    allow_third_party_subresources: bool
    viewport_width: int
    viewport_height: int
    max_page_height: int
    max_text_elements: int
    max_aux_strings: int
    rate_limit_per_domain: int
    rate_limit_window_s: int
    user_agent: str
    injection_action: Literal["flag", "quarantine", "block"]
    injection_flag_threshold: float
    injection_block_score: float
    injection_confidence_factor: float
    secret_action: Literal["block", "redact"]
    pii_action: Literal["tag", "redact", "block"]
    screenshot_url_ttl_s: int
    admin_link_template: str
    max_free_text_chars: int


# --------------------------------------------------------------------------- #
# Internal types                                                               #
# --------------------------------------------------------------------------- #
class Blocked(Exception):
    def __init__(self, code: str, hop: int = 0, **info: Any):
        super().__init__(code)
        self.code, self.hop, self.info = code, hop, info


@dataclass(frozen=True)
class Target:
    url: str
    scheme: str
    host: str
    port: int
    ip: str
    request_target: str


@dataclass
class HttpResult:
    status: int
    headers: dict
    body: bytes


@dataclass
class GuardedFetch:
    target: Target
    res: HttpResult
    hops: int
    robots_checked: bool


@dataclass
class RenderResult:
    png: bytes
    page_width: int
    page_height: int
    elements: list
    hidden: list = field(default_factory=list)
    aux: list = field(default_factory=list)
    has_password_field: bool = False
    blocked_requests: int = 0
    total_elements: int = 0
    dropped_below_fold: int = 0


@dataclass
class Deps:
    cfg: Callable[[], dict]
    user: Callable[[], dict]
    audit_append: Callable[[dict], Any]
    notify_send: Callable[..., Any]
    encrypt: Callable[[bytes, bytes], bytes]
    canonical_json: Callable[[Any], Any]
    sha256_hex: Callable[[bytes], str]
    store_put: Callable[[str, str, Any], Any]
    signed_url: Callable[[str, int], str]
    submit_job: Callable[[str, dict], Any]
    resolve: Callable[[str, int, UrlGuardConfig], Awaitable[list]]
    http_get: Callable[[Target, dict, int, UrlGuardConfig], Awaitable[HttpResult]]
    render: Callable[..., Awaitable[RenderResult]]
    now: Callable[[], datetime]
    new_id: Callable[[], str]


@dataclass
class _Ctx:
    url_hash: str
    user: dict
    host: Optional[str] = None
    robots_checked: bool = False


# --------------------------------------------------------------------------- #
# Plain-language reasons (neutral wording, no accusations)                     #
# --------------------------------------------------------------------------- #
REASONS = {
    "SCHEME_NOT_ALLOWED": "Only http and https addresses are accepted.",
    "USERINFO_IN_URL": "Addresses that embed a username or password are not accepted.",
    "PORT_NOT_ALLOWED": "The port in this address is not on the permitted list.",
    "INTERNAL_HOSTNAME": "The host name refers to an internal or local network name.",
    "NUMERIC_HOST_OBFUSCATION": "The host is written as a numeric shorthand address, which is not accepted.",
    "NON_GLOBAL_IP": "The address resolves to a private, loopback, link-local or otherwise non-public network range.",
    "BLOCKED_NETWORK": "The address resolves to a network range that is blocked by policy.",
    "TEREDO_IP": "The address resolves to a tunnelled IPv6 range that is blocked by policy.",
    "DOMAIN_DENYLISTED": "This domain is on the blocked list.",
    "DOMAIN_NOT_ALLOWED": "This domain is not on the permitted list.",
    "AUTHORIZATION_BASIS_REQUIRED": "A valid authorization basis is required for this request.",
    "ROBOTS_DISALLOWED": "The site's robots.txt does not permit automated access to this page.",
    "ROBOTS_UNAVAILABLE": "The site's robots.txt could not be read reliably, so access was not attempted.",
    "RATE_LIMITED": "Too many recent requests to this domain. Please retry later.",
    "TOO_MANY_REDIRECTS": "The address redirected too many times.",
    "LOGIN_REQUIRED": "The page requires a login. No login was attempted.",
    "SENSITIVE_DATA_IN_URL": "The address appears to contain a credential or token.",
    "SENSITIVE_CREDENTIALS_DETECTED": "The page was fetched but not stored because it appears to contain credentials. Manual review recommended.",
    "SENSITIVE_PII_DETECTED": "The page was fetched but not stored because it appears to contain personal data and policy does not allow it. Manual review recommended.",
    "PROMPT_INJECTION_BLOCKED": "The page was fetched but not stored because it contains instruction-like content aimed at automated systems. Manual review recommended.",
}
# Block codes that count as a security signal -> admin ntfy alert (Standard 3).
SECURITY_CODES = {
    "SCHEME_NOT_ALLOWED", "USERINFO_IN_URL", "PORT_NOT_ALLOWED", "INTERNAL_HOSTNAME",
    "NUMERIC_HOST_OBFUSCATION", "NON_GLOBAL_IP", "BLOCKED_NETWORK", "TEREDO_IP",
    "DOMAIN_DENYLISTED", "SENSITIVE_DATA_IN_URL", "SENSITIVE_CREDENTIALS_DETECTED",
    "PROMPT_INJECTION_BLOCKED",
}


# --------------------------------------------------------------------------- #
# L1-L3: URL / host / IP validation                                            #
# --------------------------------------------------------------------------- #
_BAD_URL_CHARS = re.compile(r"[\x00-\x20\x7f\\]")
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _host_in(host: str, patterns: list) -> bool:
    for p in patterns:
        p = p.lower().lstrip(".")
        if p and (host == p or host.endswith("." + p)):
            return True
    return False


def classify_ip(ip_str: str, extra_nets: list) -> Optional[str]:
    """Return a block code, or None if the IP is acceptable."""
    ip = ipaddress.ip_address(ip_str)
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        elif ip.sixtofour:
            ip = ip.sixtofour
        elif ip in _NAT64:
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        elif ip.teredo:
            return "TEREDO_IP"
    if not ip.is_global or ip.is_multicast or ip.is_unspecified:
        return "NON_GLOBAL_IP"
    for net in extra_nets:
        if ip.version == net.version and ip in net:
            return "BLOCKED_NETWORK"
    return None


def _parse(url: str, cfg: UrlGuardConfig) -> tuple:
    if not isinstance(url, str) or not url.strip():
        raise AgentError("INVALID_INPUT", "url is required")
    url = url.strip()
    if len(url) > cfg.max_url_length:
        raise AgentError("INVALID_INPUT", "url is too long")
    if _BAD_URL_CHARS.search(url):
        raise AgentError("INVALID_INPUT", "url contains illegal characters")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise AgentError("INVALID_INPUT", "url is malformed")
    scheme = parts.scheme.lower()
    if scheme not in [s.lower() for s in cfg.allowed_schemes]:
        raise Blocked("SCHEME_NOT_ALLOWED")
    if "@" in parts.netloc:
        raise Blocked("USERINFO_IN_URL")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host or "%" in host:
        raise AgentError("INVALID_INPUT", "url has no valid host")
    if port is None:
        port = 443 if scheme == "https" else 80
    if port not in cfg.allowed_ports:
        raise Blocked("PORT_NOT_ALLOWED", host=host)
    if not _is_ip(host):
        try:
            host = host.encode("idna").decode("ascii").lower()
        except UnicodeError:
            raise AgentError("INVALID_INPUT", "host name is not valid")
    path = parts.path or "/"
    request_target = path + ("?" + parts.query if parts.query else "")
    return scheme, host, port, request_target, parts.query


def _netloc(scheme: str, host: str, port: int) -> str:
    h = f"[{host}]" if ":" in host else host
    default = 443 if scheme == "https" else 80
    return h if port == default else f"{h}:{port}"


def _host_policy(host: str, cfg: UrlGuardConfig) -> None:
    if _host_in(host, cfg.domain_denylist):
        raise Blocked("DOMAIN_DENYLISTED", host=host)
    if not _is_ip(host):
        if "." not in host or host in [h.lower() for h in cfg.blocked_hostnames] \
                or _host_in(host, cfg.blocked_hostname_suffixes):
            raise Blocked("INTERNAL_HOSTNAME", host=host)
        if host.rsplit(".", 1)[-1].isdigit():  # TLDs are never numeric: 127.1, 0x7f.1 ...
            raise Blocked("NUMERIC_HOST_OBFUSCATION", host=host)
    if cfg.domain_allowlist and not _host_in(host, cfg.domain_allowlist):
        raise Blocked("DOMAIN_NOT_ALLOWED", host=host)


def mask_ip(ip: str) -> str:
    if ":" in ip:
        return ip.rsplit(":", 1)[0] + ":x"
    return ip.rsplit(".", 1)[0] + ".x"


async def validate_target(url: str, cfg: UrlGuardConfig, deps: Deps, hop: int = 0) -> Target:
    scheme, host, port, request_target, _ = _parse(url, cfg)
    try:
        _host_policy(host, cfg)
        ips = await deps.resolve(host, port, cfg)
        if not ips:
            raise AgentError("NOT_FOUND", "The host could not be resolved")
        nets = [ipaddress.ip_network(c, strict=False) for c in cfg.extra_blocked_cidrs]
        for ip in sorted(set(ips)):  # ALL records must pass (defeats mixed-record rebinding)
            code = classify_ip(ip, nets)
            if code:
                raise Blocked(code, host=host, ip_masked=mask_ip(ip))
        pinned = next((i for i in sorted(set(ips)) if ":" not in i), sorted(set(ips))[0])
    except Blocked as b:
        b.hop = hop
        b.info.setdefault("host", host)
        raise
    clean = urlunsplit((scheme, _netloc(scheme, host, port), request_target.split("?")[0],
                        request_target.split("?", 1)[1] if "?" in request_target else "", ""))
    return Target(clean, scheme, host, port, pinned, request_target)


# --------------------------------------------------------------------------- #
# Default network implementations (replaced by fakes in tests)                 #
# --------------------------------------------------------------------------- #
async def _system_resolve(host: str, port: int, cfg: UrlGuardConfig) -> list:
    if _is_ip(host):
        return [host]
    loop = asyncio.get_running_loop()
    try:
        infos = await asyncio.wait_for(
            loop.getaddrinfo(host, port, type=socket.SOCK_STREAM), cfg.dns_timeout_s)
    except (socket.gaierror, asyncio.TimeoutError, UnicodeError):
        return []
    return sorted({i[4][0].split("%")[0] for i in infos})


def _host_header(t: Target) -> str:
    return _netloc(t.scheme, t.host, t.port)


async def _httpx_get(target: Target, headers: dict, max_bytes: int, cfg: UrlGuardConfig) -> HttpResult:
    import httpx  # lazy: keeps pure-logic unit tests dependency-light

    ip = f"[{target.ip}]" if ":" in target.ip else target.ip
    url = f"{target.scheme}://{ip}:{target.port}{target.request_target}"
    h = {**headers, "Host": _host_header(target)}
    timeout = httpx.Timeout(cfg.total_timeout_s, connect=cfg.connect_timeout_s)
    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=timeout,
                                     verify=True, trust_env=False) as client:
            async with client.stream("GET", url, headers=h,
                                     extensions={"sni_hostname": target.host}) as r:
                cl = r.headers.get("content-length")
                if cl and cl.isdigit() and int(cl) > max_bytes:
                    raise AgentError("TOO_LARGE", "Response exceeds the size limit")
                buf = bytearray()
                async for chunk in r.aiter_bytes():  # decoded bytes: caps decompression bombs
                    buf.extend(chunk)
                    if len(buf) > max_bytes:
                        raise AgentError("TOO_LARGE", "Response exceeds the size limit")
                return HttpResult(r.status_code, {k.lower(): v for k, v in r.headers.items()}, bytes(buf))
    except AgentError:
        raise
    except httpx.TimeoutException:
        raise AgentError("TIMEOUT", "The remote server timed out")
    except httpx.HTTPError:
        raise AgentError("ENGINE_FAILED", "The remote server could not be reached")


def _doc_headers(cfg: UrlGuardConfig) -> dict:
    return {"User-Agent": cfg.user_agent, "Accept": "text/html,application/xhtml+xml"}


# --------------------------------------------------------------------------- #
# L4-L6: guarded fetch (redirects, robots, caps)                               #
# --------------------------------------------------------------------------- #
async def _check_robots(target: Target, cfg: UrlGuardConfig, deps: Deps, cache: dict) -> None:
    key = (target.scheme, target.host, target.port)
    if key not in cache:
        rt = replace(target, request_target="/robots.txt",
                     url=f"{target.scheme}://{_netloc(target.scheme, target.host, target.port)}/robots.txt")
        try:
            res = await deps.http_get(rt, _doc_headers(cfg), cfg.robots_max_bytes, cfg)
        except Exception:
            raise Blocked("ROBOTS_UNAVAILABLE", host=target.host)
        if res.status == 200:
            rp = robotparser.RobotFileParser()
            rp.parse(res.body.decode("utf-8", errors="replace").splitlines())
            cache[key] = rp
        elif 400 <= res.status < 500:
            cache[key] = None  # RFC 9309: unavailable (4xx) -> no restrictions
        else:
            raise Blocked("ROBOTS_UNAVAILABLE", host=target.host)  # 3xx / 5xx -> conservative
    rp = cache[key]
    if rp is not None and not rp.can_fetch(cfg.user_agent, target.url):
        raise Blocked("ROBOTS_DISALLOWED", host=target.host)


async def fetch_guarded(url: str, cfg: UrlGuardConfig, deps: Deps, *, max_bytes: int,
                        robots: bool, ctx: Optional[_Ctx] = None,
                        robots_cache: Optional[dict] = None) -> GuardedFetch:
    cache = robots_cache if robots_cache is not None else {}
    hops, current, checked = 0, url, False
    while True:
        target = await validate_target(current, cfg, deps, hop=hops)
        if ctx is not None:
            ctx.host = target.host
        if robots:
            try:
                await _check_robots(target, cfg, deps, cache)
            except Blocked as b:
                b.hop = hops
                raise
            checked = True
            if ctx is not None:
                ctx.robots_checked = True
        res = await deps.http_get(target, _doc_headers(cfg), max_bytes, cfg)
        if res.status in (301, 302, 303, 307, 308):
            loc = res.headers.get("location")
            if not loc:
                raise AgentError("ENGINE_FAILED", "Redirect without a destination")
            hops += 1
            if hops > cfg.max_redirects:
                raise Blocked("TOO_MANY_REDIRECTS", hop=hops, host=target.host)
            current = urljoin(target.url, loc)
            continue
        return GuardedFetch(target, res, hops, checked)


# --------------------------------------------------------------------------- #
# L8: prompt-injection scanner                                                 #
# --------------------------------------------------------------------------- #
_INVISIBLE = re.compile("[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]"
                        "|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_text(s: str) -> tuple:
    """NFC-normalise and strip invisible/bidi/control characters. Returns (text, removed_count)."""
    s2 = unicodedata.normalize("NFC", s)
    out = _INVISIBLE.sub("", s2)
    return out, len(s2) - len(out)


def _norm_scan(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)  # folds full-width / compatibility homoglyphs
    s = _INVISIBLE.sub("", s)
    return re.sub(r"\s+", " ", s).casefold()


class InjectionScanner:
    RULES = [
        ("ignore_previous", 0.9, r"\b(ignore|disregard|forget|override|bypass)\b.{0,25}\b(previous|prior|above|earlier|all|your|the|system)\b.{0,25}\b(instructions?|prompts?|rules?|guidelines?|messages?|safety)\b"),
        ("new_instructions", 0.7, r"\b(new|updated|revised) (system )?(instructions?|prompt)\s*:"),
        ("role_reassign", 0.6, r"\byou are (now|no longer)\b|\bact as (an? )?(admin|root|developer|unrestricted|system)\b|\bpretend (to be|you are)\b"),
        ("reveal_prompt", 0.8, r"\b(reveal|print|show|repeat|leak)\b.{0,20}\b(system|hidden|initial|secret) (prompt|instructions?|message)\b"),
        ("system_prompt_ref", 0.4, r"\bsystem prompt\b"),
        ("jailbreak", 0.8, r"\bdo anything now\b|\bdan mode\b|\bjailbreak\b|\bdeveloper mode\b"),
        ("chat_template_token", 0.9, r"<\|(im_start|im_end|system|assistant|user|endoftext)\|>|\[/?inst\]|<<sys>>|</?s>"),
        ("role_marker", 0.5, r"(^|\. )(system|assistant)\s*:"),
        ("exfiltrate", 0.8, r"\b(send|post|upload|forward|exfiltrate|email)\b.{0,50}\b(to|at)\b.{0,10}(https?://|[\w.+-]+@[\w-]+\.)"),
        ("tool_invocation", 0.6, r"\b(call|invoke|execute|run)\b (the )?(tool|function|command|shell|sql|query)\b"),
        ("decision_override", 0.6, r"\b(approve|mark as verified|set (the )?status to|skip (the )?(review|approval))\b"),
        ("encoded_blob", 0.4, r"[a-z0-9+/]{200,}={0,2}"),
    ]
    _COMPILED = [(i, w, re.compile(p, re.S)) for i, w, p in RULES]

    def scan(self, text: str) -> tuple:
        """Return (score in [0,1], sorted rule ids). Score = 1 - prod(1 - weight)."""
        t = _norm_scan(text)
        hit = {i: w for i, w, rx in self._COMPILED if rx.search(t)}
        score = 1.0
        for w in hit.values():
            score *= (1.0 - w)
        return round(1.0 - score, 4), sorted(hit)


# --------------------------------------------------------------------------- #
# L9: sensitive-data detector                                                  #
# --------------------------------------------------------------------------- #
_VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
       [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
       [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]]
_VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
       [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]]


def verhoeff_ok(num: str) -> bool:
    c = 0
    for i, ch in enumerate(reversed(num)):
        c = _VD[c][_VP[i % 8][int(ch)]]
    return c == 0


def luhn_ok(num: str) -> bool:
    s = 0
    for i, ch in enumerate(reversed(num)):
        n = int(ch)
        if i % 2:
            n = n * 2 - 9 if n * 2 > 9 else n * 2
        s += n
    return s % 10 == 0


def iban_ok(s: str) -> bool:
    s = s.replace(" ", "").upper()
    if not 15 <= len(s) <= 34:
        return False
    moved = s[4:] + s[:4]
    return int("".join(str(int(c, 36)) for c in moved)) % 97 == 1


@dataclass(frozen=True)
class SensitiveFinding:
    kind: str
    category: str  # "credential" | "pii"
    start: int
    end: int


class SensitiveDetector:
    _PII = [
        ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), None),
        ("card", re.compile(r"\b(?:\d[ -]?){13,19}\b"),
         lambda m: (lambda d: 13 <= len(d) <= 19 and d[0] in "23456" and luhn_ok(d))(re.sub(r"\D", "", m))),
        ("aadhaar", re.compile(r"\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b"),
         lambda m: verhoeff_ok(re.sub(r"\D", "", m))),
        ("pan", re.compile(r"\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b"), None),
        ("iban", re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b"), iban_ok),
        ("us_ssn", re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b"), None),
        ("phone_in", re.compile(r"(?<![\d])(?:\+91[ -]?|0)?[6-9]\d{9}(?!\d)"), None),
        ("phone_intl", re.compile(r"(?<![\w])\+\d{1,3}[ -]?\d(?:[ -]?\d){7,13}(?!\d)"), None),
    ]
    _CRED = [
        ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
        ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
        ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
        ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
        ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
        ("stripe_key", re.compile(r"\b[sr]k_live_[0-9A-Za-z]{16,}\b")),
        ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
        ("bearer_token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*")),
        ("secret_assignment", re.compile(r"(?i)\b(pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*['\"]?[^\s'\"]{6,}")),
    ]

    def scan(self, text: str) -> list:
        out: list = []
        for kind, rx in self._CRED:
            out += [SensitiveFinding(kind, "credential", m.start(), m.end()) for m in rx.finditer(text)]
        for kind, rx, validator in self._PII:
            for m in rx.finditer(text):
                if validator is None or validator(m.group(0)):
                    out.append(SensitiveFinding(kind, "pii", m.start(), m.end()))
        return sorted(out, key=lambda f: (f.start, f.end, f.kind))

    @staticmethod
    def redact(text: str, findings: list) -> str:
        merged, last = [], -1
        for f in sorted(findings, key=lambda f: (f.start, -f.end)):
            if f.start >= last:
                merged.append(f)
                last = f.end
        for f in reversed(merged):
            text = text[:f.start] + f"[REDACTED:{f.kind}]" + text[f.end:]
        return text


INJECTION = InjectionScanner()
DETECTOR = SensitiveDetector()


# --------------------------------------------------------------------------- #
# L6: per-domain rate limit                                                    #
# --------------------------------------------------------------------------- #
class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_s: int, now: float) -> bool:
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] >= window_s:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


_LIMITER = RateLimiter()


def _rate_key(host: str) -> str:
    return host if _is_ip(host) else ".".join(host.split(".")[-2:])


# --------------------------------------------------------------------------- #
# L7: Playwright renderer (Chromium has no network of its own)                 #
# --------------------------------------------------------------------------- #
_EXTRACT_JS = r"""
(args) => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','TITLE','META','LINK']);
  const sx = window.scrollX, sy = window.scrollY;
  const docW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const visible = [], hidden = [], aux = [];
  const transparent = /rgba?\([^)]*,\s*0(\.0+)?\)$/;
  const hiddenByStyle = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
      if (parseFloat(cs.opacity) === 0 || parseFloat(cs.fontSize) < 1) return true;
      if (e === el && transparent.test(cs.color)) return true;
    }
    return false;
  };
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.COMMENT_NODE) { if (aux.length < args.maxAux) aux.push(n.nodeValue.slice(0, 1000)); continue; }
    const text = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || SKIP.has(el.tagName)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of rects) { x1 = Math.min(x1, r.left + sx); y1 = Math.min(y1, r.top + sy); x2 = Math.max(x2, r.right + sx); y2 = Math.max(y2, r.bottom + sy); }
    const offPage = rects.length === 0 || x2 <= 0 || y2 <= 0 || x1 >= docW;
    if (offPage || hiddenByStyle(el)) { if (hidden.length < args.maxAux) hidden.push(text.slice(0, 1000)); continue; }
    visible.push({text: text, bbox: [Math.floor(x1), Math.floor(y1), Math.ceil(x2), Math.ceil(y2)]});
  }
  for (const el of document.querySelectorAll('[alt],[aria-label],[title],[placeholder]')) {
    for (const a of ['alt', 'aria-label', 'title', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && aux.length < args.maxAux) aux.push(v.slice(0, 1000));
    }
  }
  return {visible, hidden, aux, docW, docH, hasPassword: !!document.querySelector('input[type=password]')};
}
"""


def _png_size(png: bytes) -> tuple:
    return struct.unpack(">II", png[16:24])


async def _playwright_render(target: Target, doc: HttpResult, cfg: UrlGuardConfig, deps: Deps) -> RenderResult:
    from playwright.async_api import async_playwright  # lazy import

    stats = {"requests": 0, "bytes": 0, "blocked": 0}
    main_ctype = doc.headers.get("content-type", "text/html")
    robots_cache: dict = {}
    first_party = _rate_key(target.host)
    allowed_types = set(cfg.allowed_subresource_types)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--host-resolver-rules=MAP * ~NOTFOUND", "--disable-dev-shm-usage", "--disable-gpu"])
        try:
            ctx = await browser.new_context(
                viewport={"width": cfg.viewport_width, "height": cfg.viewport_height},
                java_script_enabled=True, accept_downloads=False, service_workers="block",
                user_agent=cfg.user_agent, ignore_https_errors=False, permissions=[],
                device_scale_factor=1)  # fresh context = no cookies / storage
            page = await ctx.new_page()
            nav_served = {"done": False}

            async def handler(route, request):
                try:
                    if request.method != "GET":
                        stats["blocked"] += 1
                        return await route.abort("blockedbyclient")
                    stats["requests"] += 1
                    if stats["requests"] > cfg.max_requests:
                        stats["blocked"] += 1
                        return await route.abort("blockedbyclient")
                    if request.is_navigation_request():
                        if request.frame == page.main_frame and not nav_served["done"]:
                            nav_served["done"] = True
                            return await route.fulfill(status=200, body=doc.body,
                                                       headers={"content-type": main_ctype})
                        stats["blocked"] += 1  # sub-frames and in-page navigation
                        return await route.abort("blockedbyclient")
                    if request.resource_type not in allowed_types:
                        stats["blocked"] += 1
                        return await route.abort("blockedbyclient")
                    host = (urlsplit(request.url).hostname or "").lower()
                    if not cfg.allow_third_party_subresources and _rate_key(host) != first_party:
                        stats["blocked"] += 1
                        return await route.abort("blockedbyclient")
                    gf = await fetch_guarded(request.url, cfg, deps, max_bytes=cfg.max_subresource_bytes,
                                             robots=False, robots_cache=robots_cache)
                    stats["bytes"] += len(gf.res.body)
                    if stats["bytes"] > cfg.max_total_bytes or gf.res.status >= 400:
                        stats["blocked"] += 1
                        return await route.abort("blockedbyclient")
                    return await route.fulfill(
                        status=gf.res.status, body=gf.res.body,
                        headers={"content-type": gf.res.headers.get("content-type", "application/octet-stream")})
                except Exception:
                    stats["blocked"] += 1
                    try:
                        await route.abort("failed")
                    except Exception:
                        pass

            await page.route("**/*", handler)
            await page.goto(target.url, wait_until="load", timeout=int(cfg.total_timeout_s * 1000))
            try:
                await page.wait_for_load_state("networkidle", timeout=cfg.settle_timeout_ms)
            except Exception:
                pass
            data = await page.evaluate(_EXTRACT_JS, {"maxAux": cfg.max_aux_strings})
            width = max(1, min(int(data["docW"]), cfg.viewport_width))
            height = max(1, min(int(data["docH"]), cfg.max_page_height))
            png = await page.screenshot(full_page=True, type="png", animations="disabled",
                                        clip={"x": 0, "y": 0, "width": width, "height": height})
        finally:
            await browser.close()

    pw_w, pw_h = _png_size(png)
    visible = sorted(data["visible"], key=lambda e: (e["bbox"][1], e["bbox"][0], e["text"]))
    kept = [e for e in visible if e["bbox"][1] < pw_h]
    dropped = len(visible) - len(kept)
    total = len(kept)
    return RenderResult(png=png, page_width=pw_w, page_height=pw_h, elements=kept[:cfg.max_text_elements],
                        hidden=data["hidden"], aux=data["aux"], has_password_field=bool(data["hasPassword"]),
                        blocked_requests=stats["blocked"], total_elements=total, dropped_below_fold=dropped)


# --------------------------------------------------------------------------- #
# Dependency wiring                                                            #
# --------------------------------------------------------------------------- #
def default_deps() -> Deps:
    from backend.common import audit, auth, config, crypto, jobs, notify, store  # type: ignore
    return Deps(
        cfg=lambda: config.get("url_guard"), user=auth.current_user,
        audit_append=audit.append, notify_send=notify.send, encrypt=crypto.encrypt,
        canonical_json=crypto.canonical_json, sha256_hex=crypto.sha256_hex,
        store_put=store.put, signed_url=crypto.signed_url, submit_job=jobs.submit,
        resolve=_system_resolve, http_get=_httpx_get, render=_playwright_render,
        now=lambda: datetime.now(timezone.utc), new_id=lambda: str(uuid.uuid4()))


async def _maybe(v: Any) -> Any:
    return await v if inspect.isawaitable(v) else v


def _load_cfg(deps: Deps) -> UrlGuardConfig:
    try:
        return UrlGuardConfig.model_validate(deps.cfg())
    except Exception:
        raise AgentError("ENGINE_FAILED", "URL guard configuration is missing or invalid")


def _canon(deps: Deps, obj: Any) -> bytes:
    c = deps.canonical_json(obj)
    return c.encode("utf-8") if isinstance(c, str) else c


async def _audit(deps: Deps, event_type: str, outcome: str, object_type: str, object_id: str,
                 details: dict, strict: bool) -> Optional[dict]:
    try:
        res = await _maybe(deps.audit_append({
            "event_type": event_type, "object_type": object_type, "object_id": object_id,
            "outcome": outcome, "details": details}))
        return res if isinstance(res, dict) else {}
    except Exception:
        if strict:
            raise AgentError("ENGINE_FAILED", "Audit write failed; the action was not performed")
        return None


def _clean_free_text(value: Optional[str], cfg: UrlGuardConfig, name: str) -> Optional[str]:
    if value is None:
        return None
    text, _ = clean_text(value.strip())
    if len(text) > cfg.max_free_text_chars:
        raise AgentError("INVALID_INPUT", f"{name} is too long")
    if any(f.category == "credential" for f in DETECTOR.scan(text)):
        raise AgentError("INVALID_INPUT", f"{name} must not contain credentials")
    score, _rules = INJECTION.scan(text)
    if score >= cfg.injection_flag_threshold:
        raise AgentError("INVALID_INPUT", f"{name} contains instruction-like content")
    return text or None


# --------------------------------------------------------------------------- #
# Analysis of rendered content (L8 + L9)                                       #
# --------------------------------------------------------------------------- #
def _valid_bbox(b: Any, w: int, h: int) -> Optional[list]:
    try:
        x1, y1, x2, y2 = [int(v) for v in b]
    except Exception:
        return None
    x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
    return [x1, y1, x2, y2] if x2 > x1 and y2 > y1 else None


def _analyse(rr: RenderResult, cfg: UrlGuardConfig, source_id: str, page_id: str) -> dict:
    elements: list = []
    warnings: list = []
    pii_counts: dict = defaultdict(int)
    cred_counts: dict = defaultdict(int)
    rules_hit: set = set()
    max_score, removed_total, quarantined, redacted, sensitive = 0.0, 0, 0, False, False

    for raw in rr.elements:
        text, removed = clean_text(raw["text"])
        removed_total += removed
        if not text:
            continue
        findings = DETECTOR.scan(text)
        creds = [f for f in findings if f.category == "credential"]
        pii = [f for f in findings if f.category == "pii"]
        if creds:
            if cfg.secret_action == "block":
                raise Blocked("SENSITIVE_CREDENTIALS_DETECTED")
            redacted = sensitive = True
            for f in creds:
                cred_counts[f.kind] += 1
        if pii:
            if cfg.pii_action == "block":
                raise Blocked("SENSITIVE_PII_DETECTED")
            sensitive = True
            for f in pii:
                pii_counts[f.kind] += 1
            if cfg.pii_action == "redact":
                redacted = True
        score, rules = INJECTION.scan(text)
        flagged = score >= cfg.injection_flag_threshold
        if flagged:
            rules_hit |= set(rules)
            max_score = max(max_score, score)
            if cfg.injection_action == "quarantine":
                quarantined += 1
                continue
        to_redact = creds + (pii if cfg.pii_action == "redact" else [])
        if to_redact:
            text = DETECTOR.redact(text, to_redact)
        ratio = removed / max(1, len(raw["text"]))
        bbox = _valid_bbox(raw.get("bbox"), rr.page_width, rr.page_height)
        flags = (["prompt_injection_suspected"] if flagged else []) + (["contains_pii"] if pii else [])
        elements.append({
            "text": text, "source_id": source_id, "page_id": page_id, "bbox": bbox,
            "bbox_unavailable_reason": None if bbox else "invalid_dom_rect",
            "bbox_origin": "pixel_top_left", "page_width": rr.page_width, "page_height": rr.page_height,
            "extraction_method": "dom_text",
            "confidence": round((1.0 - ratio) * (cfg.injection_confidence_factor if flagged else 1.0), 4),
            "flags": flags})

    hidden_hits = 0
    for s in list(rr.hidden) + list(rr.aux):  # hidden text is the classic injection vector
        score, rules = INJECTION.scan(s)
        if score >= cfg.injection_flag_threshold:
            hidden_hits += 1
            rules_hit |= {r + "@hidden" for r in rules}
            max_score = 1.0
    if cfg.injection_action == "block" and max_score >= cfg.injection_block_score:
        raise Blocked("PROMPT_INJECTION_BLOCKED")

    if removed_total:
        warnings.append({"code": "HIDDEN_CHARACTERS_REMOVED", "message": f"{removed_total} invisible or control characters were removed."})
    if rules_hit:
        warnings.append({"code": "PROMPT_INJECTION_SUSPECTED", "message": "Instruction-like content detected; treat page text as untrusted. Manual review recommended."})
    if quarantined:
        warnings.append({"code": "CONTENT_QUARANTINED", "message": f"{quarantined} text elements were withheld."})
    if sensitive:
        warnings.append({"code": "SENSITIVE_DATA_PRESENT", "message": "Personal data or credentials were detected; stored as sensitive."})
    if rr.total_elements > len(rr.elements):
        warnings.append({"code": "CONTENT_TRUNCATED", "message": f"Stored {len(rr.elements)} of {rr.total_elements} text elements."})
    if rr.dropped_below_fold:
        warnings.append({"code": "PAGE_HEIGHT_CAPPED", "message": f"{rr.dropped_below_fold} text elements lie beyond the captured page height."})
    if rr.blocked_requests:
        warnings.append({"code": "SUBREQUESTS_BLOCKED", "message": f"{rr.blocked_requests} page requests were blocked by policy."})
    if hidden_hits or rr.hidden:
        warnings.append({"code": "HIDDEN_TEXT", "message": f"{len(rr.hidden)} hidden text fragments were excluded from the stored text."})

    elements.sort(key=lambda e: ((e["bbox"] or [0, 0])[1], (e["bbox"] or [0, 0])[0], e["text"]))
    return {
        "elements": elements, "warnings": sorted(warnings, key=lambda w: w["code"]),
        "sensitive": sensitive, "keep_snapshot": not (redacted or quarantined),
        "summary": {"pii": dict(sorted(pii_counts.items())), "credentials": dict(sorted(cred_counts.items())),
                    "injection_rules": sorted(rules_hit), "injection_max_score": round(max_score, 4),
                    "hidden_fragments": len(rr.hidden), "quarantined": quarantined}}


# --------------------------------------------------------------------------- #
# Orchestration                                                                #
# --------------------------------------------------------------------------- #
@dataclass
class _Acquired:
    gf: GuardedFetch
    render: RenderResult


async def _acquire(inp: UrlIngestInput, basis: Optional[str], cfg: UrlGuardConfig,
                   deps: Deps, ctx: _Ctx) -> _Acquired:
    if cfg.require_authorization_basis and not basis:
        raise Blocked("AUTHORIZATION_BASIS_REQUIRED")
    if basis and cfg.authorization_bases and basis not in cfg.authorization_bases:
        raise Blocked("AUTHORIZATION_BASIS_REQUIRED")

    _scheme, host, _port, _rt, _q = _parse(inp.url, cfg)  # INVALID_INPUT / syntax blocks first
    ctx.host = host
    if any(f.category == "credential" for f in DETECTOR.scan(inp.url)):
        raise Blocked("SENSITIVE_DATA_IN_URL", host=host)
    if not _LIMITER.allow(_rate_key(host), cfg.rate_limit_per_domain, cfg.rate_limit_window_s, time.monotonic()):
        raise Blocked("RATE_LIMITED", host=host)

    gf = await fetch_guarded(inp.url, cfg, deps, max_bytes=cfg.max_response_bytes, robots=True, ctx=ctx)
    st = gf.res.status
    if st in (401, 403, 407) or "www-authenticate" in gf.res.headers:
        raise Blocked("LOGIN_REQUIRED", hop=gf.hops, host=gf.target.host)
    if st in (404, 410):
        raise AgentError("NOT_FOUND", "The page was not found")
    if st >= 400:
        raise AgentError("ENGINE_FAILED", f"The remote server returned status {st}")
    ctype = gf.res.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype not in [t.lower() for t in cfg.allowed_document_types]:
        raise AgentError("UNSUPPORTED_FORMAT", "Only web pages can be ingested here; upload other files directly")

    rr = await deps.render(gf.target, gf.res, cfg, deps)
    if rr.has_password_field:
        raise Blocked("LOGIN_REQUIRED", hop=gf.hops, host=gf.target.host)
    return _Acquired(gf, rr)


async def _commit(acq: _Acquired, basis: Optional[str], purpose: Optional[str], cfg: UrlGuardConfig,
                  deps: Deps, ctx: _Ctx, inp: UrlIngestInput) -> UrlIngestOutput:
    user = ctx.user
    tenant = user.get("tenant_id")
    if not tenant:
        raise AgentError("ENGINE_FAILED", "Tenant context is unavailable")
    source_id = deps.new_id()
    page_id = deps.sha256_hex(f"{source_id}:1".encode())[:32]
    analysis = _analyse(acq.render, cfg, source_id, page_id)  # may raise Blocked
    fetched_at = deps.now().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    aad = f"{tenant}:{source_id}".encode()
    keep = analysis["keep_snapshot"]
    record = {
        "source_id": source_id,
        "origin": {"type": "url", "url": inp.url.strip()},
        "display_name": (acq.gf.target.host + urlsplit(acq.gf.target.url).path)[:120],
        "sha256": deps.sha256_hex(acq.gf.res.body),
        "sensitivity": "sensitive" if analysis["sensitive"] else "normal",
        "untrusted": True,
        "page": {"page_id": page_id, "page_number": 1, "page_width": acq.render.page_width,
                 "page_height": acq.render.page_height, "bbox_origin": "pixel_top_left", "dpi": 96},
        "fetched_at": fetched_at, "final_host": acq.gf.target.host,
        "text_blob": deps.encrypt(_canon(deps, {"elements": analysis["elements"]}), aad),
        "snapshot_blob": deps.encrypt(acq.render.png, aad) if keep else None,
        "snapshot_omitted": not keep,
        "warnings": analysis["warnings"] + ([] if keep else [{"code": "SNAPSHOT_OMITTED", "message": "Screenshot withheld because content was redacted or quarantined."}]),
        "findings": analysis["summary"], "purpose": purpose, "authorization_basis": basis,
        "registered_by": user.get("user_id")}

    details = {"host": acq.gf.target.host, "url_sha256": ctx.url_hash, "redirect_hops": acq.gf.hops,
               "resolved_ip_masked": mask_ip(acq.gf.target.ip), "robots_checked": acq.gf.robots_checked,
               "sensitivity": record["sensitivity"], "findings": analysis["summary"],
               "elements_stored": len(analysis["elements"]), "snapshot_stored": keep,
               "blocked_subrequests": acq.render.blocked_requests,
               "purpose_sha256": deps.sha256_hex(purpose.encode()) if purpose else None,
               "basis_sha256": deps.sha256_hex(basis.encode()) if basis else None}
    # Fail closed: audit BEFORE the source becomes visible.
    await _audit(deps, "url_allowed", "success", "source", source_id, details, strict=True)
    try:
        await _maybe(deps.store_put("source", source_id, record))
    except Exception:
        await _audit(deps, "url_failed", "error", "source", source_id, {"url_sha256": ctx.url_hash, "stage": "store"}, strict=False)
        raise AgentError("ENGINE_FAILED", "The snapshot could not be stored")
    try:
        await _maybe(deps.submit_job("pipeline.ingest_source", {"source_id": source_id}))
    except Exception:
        await _audit(deps, "url_handoff_failed", "error", "source", source_id, {}, strict=False)

    snap = None
    if keep:
        snap = Snapshot(screenshot_url=deps.signed_url(f"/sources/{source_id}/pages/1/image", cfg.screenshot_url_ttl_s),
                        fetched_at=fetched_at)
    return UrlIngestOutput(status="allowed", robots_checked=ctx.robots_checked, source_id=source_id, snapshot=snap)


async def _blocked(b: Blocked, cfg: UrlGuardConfig, deps: Deps, ctx: _Ctx) -> UrlIngestOutput:
    reason = REASONS.get(b.code, "The request was blocked by policy.")
    if b.hop > 0:
        reason = "A redirect target was blocked. " + reason
    details = {"reason_code": b.code, "redirect_hop": b.hop, "url_sha256": ctx.url_hash,
               **{k: v for k, v in b.info.items() if k in ("host", "ip_masked")}}
    ev = await _audit(deps, "url_blocked", "denied", "url", ctx.url_hash, details, strict=False)
    if b.code in SECURITY_CODES:
        try:
            eid = (ev or {}).get("event_id", "")
            await _maybe(deps.notify_send(
                event_type="url_blocked", severity="high", title="Blocked URL request",
                message=f"Request by user {ctx.user.get('user_id')} (role {ctx.user.get('role')}) was blocked. "
                        f"Reason code: {b.code}. Audit event: {eid}.",
                link=cfg.admin_link_template.format(event_id=eid),
                dedupe_key=f"url_blocked:{ctx.user.get('user_id')}:{b.code}"))
        except Exception:
            pass  # a notification outage must never block the user action
    return UrlIngestOutput(status="blocked", reason=reason, robots_checked=ctx.robots_checked)


async def _failed(code: str, message: str, deps: Deps, ctx: _Ctx) -> UrlIngestOutput:
    await _audit(deps, "url_failed", "error", "url", ctx.url_hash, {"error_code": code, "url_sha256": ctx.url_hash}, strict=False)
    return UrlIngestOutput(status="failed", robots_checked=ctx.robots_checked,
                           error=ErrorInfo(code=code, message=message))


async def arun(inp: UrlIngestInput, deps: Optional[Deps] = None) -> UrlIngestOutput:
    deps = deps or default_deps()
    cfg = _load_cfg(deps)
    user = deps.user()
    ctx = _Ctx(url_hash=deps.sha256_hex(inp.url.encode("utf-8")), user=user)

    if cfg.capability not in (user.get("capabilities") or []):
        await _audit(deps, "url_denied", "denied", "url", ctx.url_hash, {"reason": "missing_capability"}, strict=False)
        raise AgentError("FORBIDDEN", "The caller lacks the capability required for URL ingestion")
    try:
        purpose = _clean_free_text(inp.purpose, cfg, "purpose")
        basis = _clean_free_text(inp.authorization_basis, cfg, "authorization_basis")
        acq = await asyncio.wait_for(_acquire(inp, basis, cfg, deps, ctx), timeout=cfg.total_timeout_s)
        return await _commit(acq, basis, purpose, cfg, deps, ctx, inp)
    except Blocked as b:
        return await _blocked(b, cfg, deps, ctx)
    except asyncio.TimeoutError:
        return await _failed("TIMEOUT", "The page took too long to fetch or render", deps, ctx)
    except AgentError as e:
        if e.code in ("INVALID_INPUT", "FORBIDDEN"):
            await _audit(deps, "url_rejected", "error", "url", ctx.url_hash, {"error_code": e.code}, strict=False)
            raise
        return await _failed(e.code, e.message if hasattr(e, "message") else str(e), deps, ctx)
    except Exception:
        return await _failed("ENGINE_FAILED", "The page could not be processed", deps, ctx)


def run(inp: UrlIngestInput) -> UrlIngestOutput:
    """Sync entry point matching the NN_name.run(input) convention (network I/O is unavoidable here)."""
    return asyncio.run(arun(inp))


# --------------------------------------------------------------------------- #
# Thin router (move to backend/routers/url_guard.py if you prefer)             #
# --------------------------------------------------------------------------- #
def build_router():
    from fastapi import APIRouter  # type: ignore
    from backend.common.envelope import fail, ok  # type: ignore

    router = APIRouter(prefix="/agents", tags=["url-guard"])

    @router.post("/url-ingest")
    async def url_ingest(body: UrlIngestInput):
        try:
            return ok(await arun(body))
        except AgentError as e:
            return fail(e.code, getattr(e, "message", str(e)), getattr(e, "details", None))

    return router