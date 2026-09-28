"""IMD Marine & Disaster Intelligence proxy endpoints.

Thin HTTP layer: parse params -> call the service -> map typed errors to
the honest, frontend-facing reason enum. No business logic here.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Query

from app.schemas.imd import ImdEnvelope, ImdStatusResponse, ImdUnavailable
from app.services import imd_service
from app.services.imd_service import ImdError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/imd", tags=["imd"])

# force_refresh gate: minimum seconds between forced upstream calls, so a
# client cannot hammer api.imd.gov.in via this proxy.
_FORCE_REFRESH_MIN_INTERVAL_SECONDS = 60


def _build_endpoint(ep: str, force_refresh: bool, extra_params: dict[str, str] | None):
    """Shared handler body for all six endpoints."""
    try:
        return imd_service.get_imd_data(
            ep, force_refresh=force_refresh, extra_params=extra_params
        )
    except ImdError as exc:  # defensive: service normally returns, not raises
        logger.error("[IMD] unhandled service error for %s: %s", ep, exc)
        return ImdUnavailable(
            endpoint=ep,
            fetched_at=imd_service._utc_now_iso(),
            reason=exc.reason,
            detail=exc.detail,
            last_successful_fetch=None,
        )


@router.get("/cyclone-track", response_model=ImdEnvelope | ImdUnavailable)
def cyclone_track(
    force_refresh: bool = Query(False, description="Bypass the TTL cache (rate-gated)"),
):
    """Official IMD cyclone track positions (proxied, never browser-direct)."""
    return _build_endpoint("cyclone_track", force_refresh, None)


@router.get("/cyclone-wind", response_model=ImdEnvelope | ImdUnavailable)
def cyclone_wind(
    force_refresh: bool = Query(False, description="Bypass the TTL cache (rate-gated)"),
):
    """Official IMD cyclone wind-warning zone geometry (proxied)."""
    return _build_endpoint("cyclone_wind", force_refresh, None)


@router.get("/cyclone-cou", response_model=ImdEnvelope | ImdUnavailable)
def cyclone_cou(
    force_refresh: bool = Query(False, description="Bypass the TTL cache (rate-gated)"),
):
    """Official IMD cone-of-uncertainty geometry (proxied)."""
    return _build_endpoint("cyclone_cou", force_refresh, None)


@router.get("/sea-bulletin", response_model=ImdEnvelope | ImdUnavailable)
def sea_bulletin(
    id: str | None = Query(
        None,
        description="IMD sea area bulletin id. Defaults to the documented id=108. "
        "TODO(VERIFY): semantics of the id selector need a real response.",
    ),
    force_refresh: bool = Query(False, description="Bypass the TTL cache (rate-gated)"),
):
    """Official IMD sea area bulletin (proxied)."""
    extra = {"id": id} if id else None
    return _build_endpoint("sea_bulletin", force_refresh, extra)


@router.get("/coastal-bulletin", response_model=ImdEnvelope | ImdUnavailable)
def coastal_bulletin(
    force_refresh: bool = Query(False, description="Bypass the TTL cache (rate-gated)"),
):
    """Official IMD coastal bulletin (proxied)."""
    return _build_endpoint("coastal_bulletin", force_refresh, None)


@router.get("/port-warning", response_model=ImdEnvelope | ImdUnavailable)
def port_warning(
    force_refresh: bool = Query(False, description="Bypass the TTL cache (rate-gated)"),
):
    """Official IMD port warnings (proxied)."""
    return _build_endpoint("port_warning", force_refresh, None)


@router.get("/status", response_model=ImdStatusResponse)
def imd_status():
    """Aggregated IMD availability for the Disaster Intelligence widget."""
    from datetime import datetime, timezone

    endpoints = imd_service.get_imd_status()
    active = sum(1 for info in endpoints.values() if info.get("status") == "ok")
    return ImdStatusResponse(
        fetched_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        endpoints=endpoints,
        active_layers=active,
    )
