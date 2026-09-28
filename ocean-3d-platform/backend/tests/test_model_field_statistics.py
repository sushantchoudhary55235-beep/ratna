"""Tests for slice statistics + depth metadata on /api/v1/model-field.

Verifies the depth panel's data contract: statistics are computed from
the FULL-resolution slice (before downsampling, NaN/land excluded), and
requested vs actual depth are both reported.
"""

from __future__ import annotations

from datetime import datetime

import numpy as np
import pytest

from app.processing.model_processor import process_model_field

from test_model_field import client, get_field, synthetic_env  # noqa: F401


class TestSliceStatistics:
    def test_statistics_present_with_all_fields(self, client, synthetic_env):
        body = get_field(client).json()
        stats = body["statistics"]
        assert set(stats) == {"min", "max", "mean", "valid_count", "missing_count"}
        assert stats["min"] == 27.5
        assert stats["max"] == 27.5
        assert stats["mean"] == 27.5

    def test_statistics_exclude_nan_land_cells(self, client, synthetic_env):
        """The synthetic grid has exactly one NaN cell (16 total -> 15 valid)."""
        body = get_field(client).json()
        stats = body["statistics"]
        assert stats["valid_count"] == 15
        assert stats["missing_count"] == 1

    def test_statistics_full_grid_not_downsampled(self, client, synthetic_env):
        """Points are capped by max_points, but statistics are not."""
        body = get_field(client, max_points=100).json()
        assert body["statistics"]["valid_count"] == 15

    def test_statistics_vary_by_depth(self, client, synthetic_env):
        """Different depth levels genuinely hold different data."""
        ds5 = get_field(client, depth=5.0).json()
        ds100 = get_field(client, depth=100.0).json()
        assert ds5["depth_index"] != ds100["depth_index"]

    def test_requested_depth_reported_alongside_actual(self, client, synthetic_env):
        """Requesting 10 m resolves to level 5.0 but both are disclosed."""
        body = get_field(client, depth=10.0).json()
        assert body["requested_depth_m"] == 10.0
        assert body["depth"] == 5.0

    def test_depth_index_and_count(self, client, synthetic_env):
        body = get_field(client, depth=5.0).json()
        assert body["depth_index"] == 0
        assert body["depth_count"] == 2

    def test_stats_unit_consistent_with_response(self, client, synthetic_env):
        body = get_field(client).json()
        assert body["unit"] == "°C"
        assert 0 < body["statistics"]["min"] <= body["statistics"]["mean"] <= body["statistics"]["max"]


class TestSliceStatisticsUnit:
    def test_processor_direct_statistics(self, synthetic_env):
        result = process_model_field(
            variable="temperature",
            depth=5.0,
            time=datetime(2026, 6, 23),
            path=synthetic_env,
        )
        assert result["statistics"]["valid_count"] == 15
        assert result["statistics"]["missing_count"] == 1
        assert result["requested_depth_m"] == 5.0
        assert result["depth_index"] == 0
        assert result["depth_count"] == 2


class TestSliceStatisticsRealData:
    """Smoke tests against the real CMEMS file (skipped when absent)."""

    def _skip_if_missing(self):
        from app.processing.model_processor import model_dataset_path

        if not model_dataset_path().is_file():
            pytest.skip("Real model dataset not available on this machine")

    def test_real_surface_statistics(self, client):
        self._skip_if_missing()
        body = get_field(client, depth=0.0).json()
        stats = body["statistics"]
        # Sanity envelope for real ocean temperature — never hard-coded into UI.
        assert 0 < stats["min"] <= stats["mean"] <= stats["max"] < 45
        assert stats["valid_count"] > stats["missing_count"]

    def test_real_deep_statistics_vary(self, client):
        self._skip_if_missing()
        surface = get_field(client, depth=0.0).json()["statistics"]
        deep = get_field(client, depth=500.0).json()["statistics"]
        assert deep["mean"] < surface["mean"]

    def test_real_depth_count_is_32(self, client):
        self._skip_if_missing()
        body = get_field(client, depth=0.0).json()
        assert body["depth_count"] == 32
        assert 0 <= body["depth_index"] < 32
