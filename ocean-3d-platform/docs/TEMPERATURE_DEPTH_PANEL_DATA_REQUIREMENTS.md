# Temperature / Depth Panel — Data Requirements

Status: **Implemented** (backend + frontend). This document records the data
contract the Temperature Depth Visualization panel consumes and the source of
every field, so the contract is not silently broken by future changes.

Panel component: `frontend/src/components/TemperatureDepthPanel.jsx`
Wiring: `frontend/src/App.jsx` (shared slice state; see "Single source of truth")

---

## 1. Data flow (single fetch per depth)

```
Depth Control (slider, App.jsx state `depth`)
  → Central depth state
  → snapDepthToModel(depth)            (realDataProvider.js — nearest real level)
  → getRealTemperatureTexture(depth)   (existing painter path; one cached fetch)
  → getRealTemperatureSliceInfo(depth) (SAME cached slice — cache hit, no 2nd request)
  → Cesium layer  +  Depth panel  +  Statistics (all consume the same result)
```

The panel never fetches. `paintFieldLayer()` in `App.jsx` installs the Cesium
imagery layer and calls `onSliceLoad({ requestedDepth, info, error })` with the
info extracted from the identical cache entry the texture was painted from.

---

## 2. Required fields and their sources

| Field | Supplied by | Consumed by | UI if unavailable |
|---|---|---|---|
| `requested_depth_m` | `/api/v1/model-field` (`requested_depth_m`) | Panel "Requested" row | `—` |
| `actual_depth_m` | `/api/v1/model-field` (`depth`) | Panel "Model Level" row, marker position | `Loading…` until first slice arrives |
| `depth_index` | `/api/v1/model-field` (`depth_index`, 0-based) | Panel "MODEL LEVEL 24 / 32" | `—` |
| `depth_count` | `/api/v1/model-field` (`depth_count`) — cross-checked against `/api/v1/model-capabilities` `depths_m.length` | Panel "MODEL LEVEL 24 / 32" | index only |
| `variable` | `/api/v1/model-field` (`variable`) | Panel "VARIABLE" | hard labels ("Temperature") |
| `units` | `/api/v1/model-field` (`unit`) | Legend rows | `—` |
| `timestamp` | `/api/v1/model-field` (`time`, naive UTC) | Panel "TIMESTAMP" | `—` |
| `source` | `/api/v1/model-field` (`source`) | Panel "SOURCE" | `—` |
| `min` | `statistics.min` (server-side, full-res slice) | Legend "Min" | stats section shows placeholder |
| `max` | `statistics.max` | Legend "Max" | as above |
| `mean` | `statistics.mean` | Legend "Mean" | as above |
| `valid_count` | `statistics.valid_count` | "Valid: N" row | `—` |
| `missing_count` | `statistics.missing_count` | "Missing / NaN: N" row | `—` |
| depth axis (`depths_m`) | `/api/v1/model-capabilities` | Water-column axis labels, clamping status | "Depth range unavailable" |
| timestep count | `/api/v1/model-capabilities` (`time_steps`) | "1 timestep available — no time animation" | line hidden |

> The example response in the original task (`min: 12.301, max: 25.269, …`,
> `depth_index: 24`) is **illustrative** — all displayed values are computed
> from the real slice at request time. Nothing is hard-coded.

---

## 3. Why statistics are computed server-side

`/api/v1/model-field` returns a **downsampled** point lattice (≤ `max_points`,
default 5000, cap 10000) with NaN/land cells already dropped. Client-side
statistics over `points` could therefore never reproduce full-grid counts such
as `valid_count: 368946`. `app/processing/model_processor.py` now computes
`min/max/mean/valid_count/missing_count` over the **full-resolution** slice
*before* downsampling, from finite values only (`np.isfinite` mask — NaN, land,
and fill values excluded, never `nan_to_num`-ed).

---

## 4. Illustrative response schema

```json
{
  "variable": "temperature",
  "unit": "°C",
  "depth": 155.85,
  "requested_depth_m": 150.0,
  "depth_index": 24,
  "depth_count": 32,
  "time": "2026-06-23T00:00:00",
  "source": "Copernicus Marine",
  "statistics": {
    "min": 12.301,
    "max": 25.269,
    "mean": 17.698,
    "valid_count": 352385,
    "missing_count": 83875
  },
  "points": [{ "latitude": 10.0, "longitude": 70.0, "value": 17.4 }]
}
```

(`depth_index` is the 0-based position on the model's real depth axis;
`depth: 155.85` is the nearest real level to the requested `150.0`.)

---

## 5. Status state machine

`dataSourceStatus` (probing | real | demo) × `sliceStatus`
(idle | loading | ready | error | no-data) → panel badge:

| Condition | Badge |
|---|---|
| backend probe in flight | `● CONNECTING…` |
| slice fetch in flight | `● LOADING 155.85 m SLICE…` |
| real slice ready | `● REAL MODEL DATA` |
| fetch failed (real mode) | `● DATA UNAVAILABLE` + subtle reason |
| slice has no valid cells | `● NO DATA` |
| demo slice ready | `● DEMO DATA` |

In real mode a fetch error **clears the Cesium layer and the panel info**
(`onSliceLoad({ info: null, error })`) — demo data is never substituted.

---

## 6. Depth semantics

- Requested depth = raw slider value (App state `depth`).
- Actual model depth = `snapDepthToModel(requested).depth` — the nearest entry
  of the real `depths_m` array; never a round-number invention.
- If requested > max level (541.09 m), the panel shows
  "Clamped to deepest available model level (541.09 m)" and the deepest level's
  real statistics. No data is ever implied beyond the deepest level.
- Water-column axis labels are sampled from the real `depths_m` array in real
  mode. Generic round-number ticks appear only in demo mode, where they are
  visual axis references, not claimed model levels.
