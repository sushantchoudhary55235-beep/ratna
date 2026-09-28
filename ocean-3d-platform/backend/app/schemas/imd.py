"""Pydantic schemas for the IMD Marine & Disaster Intelligence proxy.

Every model mirrors fields VERIFIED in real IMD API responses or marks
unverified facts explicitly (see docs/IMD_DISASTER_INTELLIGENCE_DATA_REQUIREMENTS.md).
The upstream payloads are preserved verbatim inside ``raw`` — RATNAKARA
never discards official fields it does not currently render.
"""

from typing import Any

from pydantic import BaseModel, Field

# Verified against live api.imd.gov.in responses (HTTP 401 probe, 2026-09-24):
# every endpoint answers application/json {"error": "..."} when unauthenticated.
# The SUCCESS payload shapes are NOT yet verified (no credentials) — data
# fields below are therefore intentionally permissive containers, NOT guesses
# at field names.


class ImdEnvelope(BaseModel):
    """Standard RATNAKARA envelope for all /api/v1/imd/* responses."""

    source: str = "IMD"
    endpoint: str
    fetched_at: str
    updated_at: str | None = None
    cache_hit: bool = False
    status: str = "ok"  # ok | unavailable
    data: Any = None  # verified upstream payload (verbatim where possible)


class ImdUnavailable(BaseModel):
    """Honest failure envelope — never substituted with fabricated data."""

    source: str = "IMD"
    endpoint: str
    fetched_at: str
    status: str = "unavailable"
    reason: str  # authentication_required | timeout | rate_limited | upstream_error | invalid_response
    detail: str
    last_successful_fetch: str | None = None


class ImdStatusResponse(BaseModel):
    """Aggregated status for the Disaster Intelligence widget badge."""

    source: str = "IMD"
    fetched_at: str
    endpoints: dict[str, dict]
    active_layers: int = 0
