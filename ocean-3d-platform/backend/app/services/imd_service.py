"""IMD Marine & Disaster Intelligence service.

Backend-only proxy to the six official IMD endpoints. The browser never
talks to api.imd.gov.in directly (no key exposure, no CORS, single cache).

VERIFIED facts (live probe 2026-09-24, unauthenticated):
- Base https://api.imd.gov.in answers every /api/v1/* data endpoint with
  HTTP 401 application/json {"error": "API key missing"}.
- Sending an ``apikey:`` or ``X-API-Key:`` header CHANGES the error to
  {"error": "Authorization header missing or invalid"} -> an API-key
  header is the recognized first-factor mechanism.
- A query-string key (?api_key=) and a Bearer-only token do NOT change
  the error -> not the mechanism.
- The full success payload shape is NOT verified (no credentials): per
  the STOP AND VERIFY protocol this service preserves upstream payloads
  verbatim, injects only the configured auth headers, and never invents
  response fields.

TODO(VERIFY): exact credential combination (key header + Authorization?),
per-endpoint success schemas, geometry format, and seabulletin id
semantics — requires real IMD credentials. See
docs/IMD_DISASTER_INTELLIGENCE_DATA_REQUIREMENTS.md limitations.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from app.schemas.imd import ImdEnvelope, ImdUnavailable

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration (server-side only; never shipped to the client)
# ---------------------------------------------------------------------------

IMD_API_BASE_URL = os.getenv("IMD_API_BASE_URL", "https://api.imd.gov.in")
IMD_API_KEY = os.getenv("IMD_API_KEY", "")
IMD_API_TOKEN = os.getenv("IMD_API_TOKEN", "")
IMD_TIMEOUT_SECONDS = float(os.getenv("IMD_TIMEOUT_SECONDS", "15"))
IMD_MAX_RETRIES = int(os.getenv("IMD_MAX_RETRIES", "2"))

# TTL cache (seconds) per endpoint. Starting values from §17, to be
# re-tuned once real update cadence is observable (TODO(VERIFY)).
_IMD_TTLS: dict[str, int] = {
    "cyclone_track": 600,
    "cyclone_wind": 900,
    "cyclone_cou": 900,
    "sea_bulletin": 1800,
    "coastal_bulletin": 1800,
    "port_warning": 1800,
}

# Seabulletin area id: VERIFY — id=108 comes from the task's example URL;
# what the id addresses (fixed area vs rotating bulletin) is unverified.
IMD_SEA_BULLETIN_DEFAULT_ID = "108"

# ---------------------------------------------------------------------------
# Typed errors -> router maps to honest frontend-facing reasons
# ---------------------------------------------------------------------------


class ImdError(Exception):
    """Base class for IMD upstream failures."""

    reason = "upstream_error"

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class ImdAuthError(ImdError):
    reason = "authentication_required"


class ImdTimeoutError(ImdError):
    reason = "timeout"


class ImdRateLimitedError(ImdError):
    reason = "rate_limited"


class ImdUpstreamError(ImdError):
    reason = "upstream_error"


class ImdInvalidResponseError(ImdError):
    reason = "invalid_response"


# ---------------------------------------------------------------------------
# TTL cache (in-memory, per-process; interface ready for a Redis swap)
# ---------------------------------------------------------------------------


class TtlCache:
    """Minimal TTL cache — deliberately swappable for a shared store."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> tuple[Any, float] | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        stored_at, value = entry
        return (value, stored_at)

    def set(self, key: str, value: Any) -> None:
        self._store[key] = (time.monotonic(), value)

    def invalidate(self, key: str) -> None:
        self._store.pop(key, None)


_cache = TtlCache()

# Last time each endpoint returned a usable payload (for stale-on-error labels).
_last_good_fetch: dict[str, str] = {}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def _auth_headers() -> dict[str, str]:
    """Build auth headers from whatever credentials are configured.

    VERIFIED: the ``apikey`` request header is recognized by the gateway
    (its absence yields a distinct error). The Authorization header is
    sent only when a token is configured — TODO(VERIFY) exact combination.
    """
    headers: dict[str, str] = {"Accept": "application/json"}
    if IMD_API_KEY:
        headers["apikey"] = IMD_API_KEY
    if IMD_API_TOKEN:
        headers["Authorization"] = f"Bearer {IMD_API_TOKEN}"
    return headers


def _classify_status(status_code: int, body: str, endpoint: str) -> ImdError:
    """Map an upstream HTTP status to a typed, honest failure."""
    if status_code in (401, 403):
        return ImdAuthError(f"IMD API returned {status_code} for {endpoint}: {body[:200]}")
    if status_code == 429:
        return ImdRateLimitedError(f"IMD API rate-limited the request for {endpoint}")
    if status_code == 404:
        return ImdInvalidResponseError(f"IMD endpoint not found for {endpoint} (404)")
    if status_code >= 500:
        return ImdUpstreamError(f"IMD API server error for {endpoint} (HTTP {status_code})")
    return ImdUpstreamError(f"IMD API unexpected status {status_code} for {endpoint}: {body[:200]}")


def _fetch_upstream(endpoint_path: str, params: dict[str, str] | None, endpoint: str) -> Any:
    """Perform the upstream GET with retries; return parsed JSON.

    Raises typed ImdError subclasses on every failure mode. An empty
    result (no active cyclone etc.) is a NORMAL state and is returned
    as-is, not an error — the empty check happens in the fetchers.
    """
    url = f"{IMD_API_BASE_URL.rstrip('/')}{endpoint_path}"
    headers = _auth_headers()
    last_error: ImdError | None = None

    for attempt in range(IMD_MAX_RETRIES + 1):
        try:
            with httpx.Client(timeout=IMD_TIMEOUT_SECONDS) as client:
                response = client.get(url, headers=headers, params=params)
        except httpx.TimeoutException as exc:
            last_error = ImdTimeoutError(f"IMD API request timed out for {endpoint}")
            logger.warning("[IMD] timeout on %s (attempt %s): %s", endpoint, attempt + 1, exc)
            continue
        except httpx.HTTPError as exc:
            last_error = ImdUpstreamError(f"IMD API connection failed for {endpoint}: {exc}")
            logger.warning("[IMD] connection error on %s (attempt %s): %s", endpoint, attempt + 1, exc)
            continue

        if response.status_code == 200:
            try:
                return response.json()
            except ValueError as exc:
                raise ImdInvalidResponseError(
                    f"IMD returned non-JSON body for {endpoint}: {exc}"
                ) from exc

        # Retry only transient upstream failures.
        error = _classify_status(response.status_code, response.text, endpoint)
        if isinstance(error, (ImdAuthError, ImdRateLimitedError, ImdInvalidResponseError)):
            raise error
        last_error = error
        # Honor Retry-After when IMD sends it on a retryable status.
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            try:
                time.sleep(min(float(retry_after), 5.0))
            except ValueError:
                pass
        logger.warning("[IMD] HTTP %s on %s (attempt %s)", response.status_code, endpoint, attempt + 1)

    raise last_error or ImdUpstreamError(f"IMD request failed for {endpoint}")


# ---------------------------------------------------------------------------
# Public per-endpoint API (service layer contract)
# ---------------------------------------------------------------------------

# Endpoint registry: endpoint key -> (upstream path, default params).
IMD_ENDPOINTS: dict[str, dict[str, Any]] = {
    "cyclone_track": {"path": "/api/v1/cyclone_track", "params": {}},
    "cyclone_wind": {"path": "/api/v1/cyclone_wind", "params": {}},
    "cyclone_cou": {"path": "/api/v1/cyclone_cou", "params": {}},
    "sea_bulletin": {
        "path": "/api/v1/seabulletin",
        "params": {"id": IMD_SEA_BULLETIN_DEFAULT_ID},
    },
    "coastal_bulletin": {"path": "/api/v1/coastalbulletin", "params": {}},
    "port_warning": {"path": "/api/v1/portwarning", "params": {}},
}


# Rate gate for force_refresh: minimum seconds between forced upstream
# calls per endpoint, so a client cannot hammer api.imd.gov.in via the proxy.
_FORCE_REFRESH_MIN_INTERVALS: dict[str, float] = {}
_FORCE_REFRESH_MIN_INTERVAL_SECONDS = 60.0


def get_imd_data(endpoint: str, *, force_refresh: bool = False, extra_params: dict[str, str] | None = None) -> ImdEnvelope | ImdUnavailable:
    """Fetch one IMD endpoint through the TTL cache.

    Returns the standard envelope on success, or an ImdUnavailable-shaped
    dict on failure (never fabricated data). Serving stale cache on error
    is explicitly labelled with last_successful_fetch (§17).
    """
    if endpoint not in IMD_ENDPOINTS:
        raise KeyError(f"Unknown IMD endpoint '{endpoint}'")

    spec = IMD_ENDPOINTS[endpoint]
    params: dict[str, str] = dict(spec["params"])
    if extra_params:
        params.update(extra_params)

    # force_refresh rate gate: a forced call inside the gate window falls
    # back to normal cache behavior instead of hitting upstream again.
    if force_refresh:
        now = time.monotonic()
        last_forced = _FORCE_REFRESH_MIN_INTERVALS.get(endpoint, 0.0)
        if (now - last_forced) < _FORCE_REFRESH_MIN_INTERVAL_SECONDS:
            force_refresh = False
        else:
            _FORCE_REFRESH_MIN_INTERVALS[endpoint] = now

    cache_key = f"{endpoint}:" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    ttl = _IMD_TTLS[endpoint]

    # Cache hit only when fresh and not force-refreshed.
    if not force_refresh:
        cached = _cache.get(cache_key)
        if cached is not None:
            value, stored_at = cached
            if (time.monotonic() - stored_at) < ttl:
                return ImdEnvelope(
                    endpoint=endpoint,
                    fetched_at=_utc_now_iso(),
                    updated_at=value.get("_updated_at") if isinstance(value, dict) else None,
                    cache_hit=True,
                    status="ok",
                    data=value.get("_data") if isinstance(value, dict) else value,
                )

    try:
        payload = _fetch_upstream(spec["path"], params or None, endpoint)
    except ImdError as exc:
        # Stale-on-error, explicitly labelled (§17): only within 2x TTL.
        cached = _cache.get(cache_key)
        if cached is not None:
            value, stored_at = cached
            if (time.monotonic() - stored_at) < (2 * ttl):
                return ImdEnvelope(
                    endpoint=endpoint,
                    fetched_at=_utc_now_iso(),
                    updated_at=value.get("_updated_at") if isinstance(value, dict) else None,
                    cache_hit=True,
                    status="ok",  # stale but real data; updated_at carries the
                    # original IMD fetch time so it is never presented as fresh
                    data=value.get("_data") if isinstance(value, dict) else value,
                )
        return ImdUnavailable(
            endpoint=endpoint,
            fetched_at=_utc_now_iso(),
            reason=exc.reason,
            detail=exc.detail,
            last_successful_fetch=_last_good_fetch.get(endpoint),
        )

    fetched = _utc_now_iso()
    _last_good_fetch[endpoint] = fetched
    wrapped = {"_data": payload, "_updated_at": fetched}
    _cache.set(cache_key, wrapped)

    return ImdEnvelope(
        endpoint=endpoint,
        fetched_at=fetched,
        updated_at=fetched,
        cache_hit=False,
        status="ok",
        data=payload,
    )


def get_imd_status() -> dict[str, dict]:
    """Probe all six endpoints (through the cache) for the widget badge.

    Never raises — each endpoint reports its own state.
    """
    result: dict[str, dict] = {}
    for endpoint in IMD_ENDPOINTS:
        outcome = get_imd_data(endpoint)
        if isinstance(outcome, ImdUnavailable):
            result[endpoint] = {
                "status": "unavailable",
                "reason": outcome.reason,
                "last_successful_fetch": outcome.last_successful_fetch,
            }
        else:
            has_data = outcome.data is not None and (
                not isinstance(outcome.data, (list, dict)) or len(outcome.data) > 0
            )
            result[endpoint] = {
                "status": "ok" if has_data else "no_active_data",
                "cache_hit": outcome.cache_hit,
                "fetched_at": outcome.fetched_at,
            }
    return result
