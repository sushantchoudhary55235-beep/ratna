"""Tests for the IMD Marine & Disaster Intelligence proxy.

Upstream HTTP calls are mocked with httpx.MockTransport. Fixtures marked
"captured" come from real unauthenticated probes of api.imd.gov.in
(2026-09-24); success-payload fixtures are structural shapes only and are
clearly marked — no invented IMD field names are asserted.
"""

from __future__ import annotations

import pytest
from httpx import HTTPStatusError, Request, Response

from app.services import imd_service
from app.services.imd_service import (
    IMD_ENDPOINTS,
    ImdAuthError,
    ImdRateLimitedError,
    ImdTimeoutError,
    ImdUpstreamError,
    _cache,
    _classify_status,
    _fetch_upstream,
    _last_good_fetch,
)

# ---------------------------------------------------------------------------
# Fixtures captured from the live API (unauthenticated probe)
# ---------------------------------------------------------------------------

CAPTURED_401_BODY = '{"error": "API key missing"}'  # real body, all 6 endpoints
CAPTURED_401_KEY_HEADER_BODY = (
    '{"error": "Authorization header missing or invalid"}'  # real body w/ key header
)


def _install_transport(monkeypatch, handler) -> None:
    """Route all service HTTP traffic through a mock transport."""
    import httpx

    real_client = httpx.Client

    def client_factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(imd_service.httpx, "Client", client_factory)


@pytest.fixture(autouse=True)
def _clean_state():
    _cache._store.clear()
    _last_good_fetch.clear()
    yield
    _cache._store.clear()
    _last_good_fetch.clear()


@pytest.fixture()
def no_credentials(monkeypatch):
    monkeypatch.setattr(imd_service, "IMD_API_KEY", "")
    monkeypatch.setattr(imd_service, "IMD_API_TOKEN", "")


@pytest.fixture()
def with_credentials(monkeypatch):
    monkeypatch.setattr(imd_service, "IMD_API_KEY", "test-key")
    monkeypatch.setattr(imd_service, "IMD_API_TOKEN", "")


# ---------------------------------------------------------------------------
# Classification (status -> typed error) using captured bodies
# ---------------------------------------------------------------------------


class TestStatusClassification:
    def test_401_maps_to_auth_error(self):
        err = _classify_status(401, CAPTURED_401_BODY, "cyclone_track")
        assert isinstance(err, ImdAuthError)
        assert err.reason == "authentication_required"
        assert "API key missing" in err.detail

    def test_403_maps_to_auth_error(self):
        err = _classify_status(403, "Forbidden", "cyclone_wind")
        assert isinstance(err, ImdAuthError)

    def test_429_maps_to_rate_limited(self):
        err = _classify_status(429, "", "sea_bulletin")
        assert isinstance(err, ImdRateLimitedError)
        assert err.reason == "rate_limited"

    def test_500_maps_to_upstream_error(self):
        err = _classify_status(500, "", "port_warning")
        assert isinstance(err, ImdUpstreamError)
        assert err.reason == "upstream_error"

    def test_404_maps_to_invalid_response(self):
        err = _classify_status(404, "Not Found", "coastal_bulletin")
        assert err.reason == "invalid_response"


# ---------------------------------------------------------------------------
# Fetch layer (mocked transport)
# ---------------------------------------------------------------------------


class TestFetchUpstream:
    def test_401_raises_auth_error(self, monkeypatch, no_credentials):
        def handler(request):
            return Response(401, json={"error": "API key missing"})

        _install_transport(monkeypatch, handler)
        with pytest.raises(ImdAuthError):
            _fetch_upstream("/api/v1/cyclone_track", None, "cyclone_track")

    def test_success_json_returned(self, monkeypatch, with_credentials):
        """Structural fixture (marked): envelope object with a data array.

        TODO(VERIFY): real success field names — asserted here is only the
        passthrough contract, not any IMD field name.
        """
        def handler(request):
            assert request.headers.get("apikey") == "test-key"
            return Response(200, json={"data": []})

        _install_transport(monkeypatch, handler)
        payload = _fetch_upstream("/api/v1/cyclone_track", None, "cyclone_track")
        assert payload == {"data": []}

    def test_non_json_200_raises_invalid_response(self, monkeypatch, with_credentials):
        def handler(request):
            return Response(200, text="<html>not json</html>")

        _install_transport(monkeypatch, handler)
        with pytest.raises(imd_service.ImdInvalidResponseError):
            _fetch_upstream("/api/v1/cyclone_wind", None, "cyclone_wind")

    def test_timeout_maps_to_timeout_error(self, monkeypatch, with_credentials):
        import httpx

        def handler(request):
            raise httpx.ConnectTimeout("timed out")

        _install_transport(monkeypatch, handler)
        with pytest.raises(ImdTimeoutError):
            _fetch_upstream("/api/v1/cyclone_track", None, "cyclone_track")

    def test_5xx_retries_then_raises_upstream(self, monkeypatch, with_credentials):
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return Response(503, text="service unavailable")

        _install_transport(monkeypatch, handler)
        with pytest.raises(ImdUpstreamError):
            _fetch_upstream("/api/v1/cyclone_track", None, "cyclone_track")
        assert calls["n"] == imd_service.IMD_MAX_RETRIES + 1

    def test_401_does_not_retry(self, monkeypatch, no_credentials):
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return Response(401, json={"error": "API key missing"})

        _install_transport(monkeypatch, handler)
        with pytest.raises(ImdAuthError):
            _fetch_upstream("/api/v1/cyclone_track", None, "cyclone_track")
        assert calls["n"] == 1  # auth failures must not hammer upstream


# ---------------------------------------------------------------------------
# Service envelope + caching behaviour
# ---------------------------------------------------------------------------


class TestGetImdData:
    def test_unknown_endpoint_raises(self, with_credentials):
        with pytest.raises(KeyError):
            imd_service.get_imd_data("not_a_real_endpoint")

    def test_unavailable_envelope_on_401(self, monkeypatch, no_credentials):
        def handler(request):
            return Response(401, json={"error": "API key missing"})

        _install_transport(monkeypatch, handler)
        result = imd_service.get_imd_data("cyclone_track")
        assert result.status == "unavailable"
        assert result.reason == "authentication_required"
        assert result.last_successful_fetch is None
        assert "API key missing" in result.detail

    def test_success_envelope_shape(self, monkeypatch, with_credentials):
        def handler(request):
            return Response(200, json={"data": [{"id": "x"}]})

        _install_transport(monkeypatch, handler)
        result = imd_service.get_imd_data("cyclone_track")
        assert result.status == "ok"
        assert result.source == "IMD"
        assert result.endpoint == "cyclone_track"
        assert result.cache_hit is False
        assert result.data == {"data": [{"id": "x"}]}
        assert result.fetched_at.endswith("Z")

    def test_cache_hit_within_ttl(self, monkeypatch, with_credentials):
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return Response(200, json={"data": []})

        _install_transport(monkeypatch, handler)
        imd_service.get_imd_data("cyclone_track")
        second = imd_service.get_imd_data("cyclone_track")
        assert calls["n"] == 1
        assert second.cache_hit is True

    def test_ttl_expiry_refetches(self, monkeypatch, with_credentials):
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return Response(200, json={"data": []})

        _install_transport(monkeypatch, handler)
        imd_service.get_imd_data("cyclone_track")
        # Age out the entry by rewinding its stored timestamp.
        key = next(iter(_cache._store))
        stored_at, wrapped = _cache._store[key]
        _cache._store[key] = (
            stored_at - (imd_service._IMD_TTLS["cyclone_track"] + 1),
            wrapped,
        )
        imd_service.get_imd_data("cyclone_track")
        assert calls["n"] == 2

    def test_force_refresh_bypasses_cache(self, monkeypatch, with_credentials):
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return Response(200, json={"data": []})

        _install_transport(monkeypatch, handler)
        imd_service.get_imd_data("cyclone_track")
        imd_service.get_imd_data("cyclone_track", force_refresh=True)
        assert calls["n"] == 2

    def test_force_refresh_is_rate_gated(self, monkeypatch, with_credentials):
        """A second forced call inside the gate window must not hit upstream."""
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return Response(200, json={"data": []})

        _install_transport(monkeypatch, handler)
        imd_service.get_imd_data("cyclone_track", force_refresh=True)
        imd_service.get_imd_data("cyclone_track", force_refresh=True)
        assert calls["n"] == 1

    def test_seabulletin_id_in_cache_key(self, monkeypatch, with_credentials):
        paths = []

        def handler(request):
            paths.append(str(request.url))
            return Response(200, json={"data": []})

        _install_transport(monkeypatch, handler)
        imd_service.get_imd_data("sea_bulletin")
        imd_service.get_imd_data("sea_bulletin", extra_params={"id": "109"})
        assert any("id=108" in p for p in paths)
        assert any("id=109" in p for p in paths)

    def test_stale_on_error_is_labelled(self, monkeypatch, with_credentials):
        """After a good fetch, an upstream failure serves stale data within
        2x TTL — the envelope still carries a real fetched_at timestamp."""
        mode = {"fail": False}

        def handler(request):
            if mode["fail"]:
                return Response(503, text="down")
            return Response(200, json={"data": [{"ok": True}]})

        _install_transport(monkeypatch, handler)
        imd_service.get_imd_data("cyclone_track")
        mode["fail"] = True
        result = imd_service.get_imd_data("cyclone_track", force_refresh=True)
        assert result.status == "ok"  # stale-but-real, timestamped
        assert result.cache_hit is True

    def test_status_aggregates_all_six(self, monkeypatch, no_credentials):
        def handler(request):
            return Response(401, json={"error": "API key missing"})

        _install_transport(monkeypatch, handler)
        status = imd_service.get_imd_status()
        assert set(status) == set(IMD_ENDPOINTS)
        assert all(info["status"] == "unavailable" for info in status.values())


# ---------------------------------------------------------------------------
# Router-level contract
# ---------------------------------------------------------------------------


class TestImdRouter:
    @pytest.fixture()
    def client(self):
        from fastapi.testclient import TestClient

        from app.main import app

        return TestClient(app)

    def test_all_six_endpoints_exist(self, client, monkeypatch, no_credentials):
        def handler(request):
            return Response(401, json={"error": "API key missing"})

        _install_transport(monkeypatch, handler)
        for path, endpoint in [
            ("/api/v1/imd/cyclone-track", "cyclone_track"),
            ("/api/v1/imd/cyclone-wind", "cyclone_wind"),
            ("/api/v1/imd/cyclone-cou", "cyclone_cou"),
            ("/api/v1/imd/sea-bulletin", "sea_bulletin"),
            ("/api/v1/imd/coastal-bulletin", "coastal_bulletin"),
            ("/api/v1/imd/port-warning", "port_warning"),
        ]:
            resp = client.get(path)
            assert resp.status_code == 200, path
            body = resp.json()
            assert body["status"] == "unavailable", path
            assert body["reason"] == "authentication_required", path
            assert body["source"] == "IMD"
            assert body["endpoint"] == endpoint

    def test_status_endpoint_aggregates(self, client, monkeypatch, no_credentials):
        def handler(request):
            return Response(401, json={"error": "API key missing"})

        _install_transport(monkeypatch, handler)
        resp = client.get("/api/v1/imd/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["source"] == "IMD"
        assert body["active_layers"] == 0
        assert set(body["endpoints"]) == set(IMD_ENDPOINTS)

    def test_seabulletin_query_passthrough(self, client, monkeypatch, with_credentials):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            return Response(200, json={"data": []})

        _install_transport(monkeypatch, handler)
        resp = client.get("/api/v1/imd/sea-bulletin", params={"id": "105"})
        assert resp.status_code == 200
        assert "id=105" in seen["url"]
