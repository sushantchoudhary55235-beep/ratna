// RATNAKARA — REAL DATA PROVIDER (backend-backed, demo fallback).
//
// Bridges the globe to the FastAPI backend (services/modelApi.js).
// Same normalized record shapes as src/data/demoData.js, so App.jsx
// layers render identically whichever source is active:
//
//   Backend reachable  -> REAL Copernicus Marine model data
//                         (data/sample/arabian_sea_model.nc)
//   Backend unreachable-> demo provider (DEMO_MODE_ACTIVE), unchanged
//
// The active source is probed once via /api/v1/model-capabilities and
// exposed through subscribeDataSource()/getDataSourceState() so the UI
// can label the data honestly (REAL vs DEMO).

import {
  demoTimeLabel,
  demoTemperatureIndex,
  demoSalinityIndex,
  demoOceanName,
  DEMO_DATASET_BOX,
  demoInsideBox,
  paintRealFieldTexture,
} from "./demoData";
import {
  fetchModelCapabilities,
  fetchModelField,
} from "../services/modelApi";

const r2 = (x) => Math.round(x * 100) / 100;

/* ============================================================
   SOURCE STATE (real vs demo)
============================================================ */

const state = {
  status: "probing", // probing | real | demo
  capabilities: null, // { source, variables, depths_m, timestamps, time_steps }
  lastError: null,
};

const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      /* a broken subscriber must never break the pipeline */
    }
  }
}

export function subscribeDataSource(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDataSourceState() {
  return state;
}

export function isRealMode() {
  return state.status === "real";
}

let probePromise = null;

/** Probe the backend once; every caller shares the same promise. */
export function ensureProbed() {
  if (!probePromise) {
    probePromise = (async () => {
      emit();
      try {
        state.capabilities = await fetchModelCapabilities();
        state.status = "real";
        state.lastError = null;
      } catch (err) {
        state.status = "demo";
        state.lastError = String(err?.message || err);
        /* A failed probe must not latch forever: clear the memoized
           promise so the NEXT ensureProbed() call retries the backend.
           Otherwise a single cold-start failure (backend not up yet,
           dev-server restart, network hiccup) permanently strands the
           app in demo mode with an unknown depth axis. */
        probePromise = null;
      }
      emit();
      return state.status;
    })();
  }
  return probePromise;
}

/* ============================================================
   DEPTH HANDLING (honest — levels come from /model-capabilities)
============================================================ */

/**
 * Real model depth bounds, or null while in demo mode.
 *
 * Levels are canonicalized to the backend's reported depth precision
 * (2 decimals — model_processor.py returns `round(depth, 2)`): the
 * NetCDF axis stores full float32 values like 155.85069274902344, so
 * snapping to the RAW axis made the slice cache key (full precision)
 * and the backend's response `depth` (155.85) disagree. That mismatch
 * made every gridCache lookup miss and the 3D slicer report
 * "Depth data unavailable" for otherwise valid levels.
 */
export function getRealDepthInfo() {
  if (state.status !== "real" || !state.capabilities?.depths_m?.length) {
    return null;
  }
  const levels = [...state.capabilities.depths_m]
    .map((level) => Number(Number(level).toFixed(2)))
    .sort((a, b) => a - b);
  return { min: levels[0], max: levels[levels.length - 1], levels };
}

/**
 * Snap a requested depth to the nearest REAL model level. Returns the
 * effective depth and whether it differed from the request, so the UI
 * never displays a depth the model does not actually have.
 */
export function snapDepthToModel(depth) {
  const info = getRealDepthInfo();
  if (!info) return { depth, clamped: false, actual: depth };
  let nearest = info.levels[0];
  for (const level of info.levels) {
    if (Math.abs(level - depth) < Math.abs(nearest - depth)) nearest = level;
  }
  return {
    depth: nearest,
    clamped: Math.abs(nearest - depth) > 0.01,
    actual: nearest,
  };
}

/* ============================================================
   GRID CACHE — one backend slice per (variable, depth)
============================================================ */

const gridCache = new Map();
const MAX_POINTS = 10000; // backend hard cap

async function getRealSlice(variable, depth) {
  const key = `${variable}:${depth}`;
  if (gridCache.has(key)) return gridCache.get(key);

  const response = await fetchModelField(variable, depth, {
    maxPoints: MAX_POINTS,
  });

  /* Keep the requested depth alongside the actual model level the
     backend selected, so the UI can disclose both (§17). Backend
     statistics are computed server-side over the FULL-resolution
     slice before downsampling — the downsampled `points` payload
     cannot reproduce them client-side. depthIndex/depthCount are
     positions on the real model depth axis (null when unavailable). */
  const entry = {
    points: response.points,
    grid: gridFromPoints(response.points),
    meta: {
      requestedDepth: depth,
      actualDepth: response.depth,
      unit: response.unit,
      source: response.source,
      time: response.time,
      count: response.points.length,
      depthIndex: response.depth_index ?? null,
      depthCount: response.depth_count ?? null,
      requestedDepthM: response.requested_depth_m ?? depth,
      /* Backend statistics are snake_case; normalize once here so the
         panel consumes a stable camelCase contract. */
      statistics: response.statistics
        ? {
            min: response.statistics.min ?? null,
            max: response.statistics.max ?? null,
            mean: response.statistics.mean ?? null,
            validCount: response.statistics.valid_count ?? null,
            missingCount: response.statistics.missing_count ?? null,
          }
        : null,
    },
  };
  gridCache.set(key, entry);
  return entry;
}

/* Rebuild a uniform-step raster from the backend's downsampled lattice.
   Grid bounds are derived from the actual point coordinates so the
   painter can feather against the REAL dataset footprint (45–99.9°E
   / −30–25°N) instead of the demo window. */
function gridFromPoints(points) {
  const latSet = new Map();
  const lonSet = new Map();
  for (const p of points) {
    latSet.set(p.latitude, true);
    lonSet.set(p.longitude, true);
  }
  const lats = [...latSet.keys()].sort((a, b) => a - b);
  const lons = [...lonSet.keys()].sort((a, b) => a - b);
  const rows = lats.length;
  const cols = lons.length;
  if (rows < 2 || cols < 2) return null;

  const minLat = lats[0];
  const minLon = lons[0];
  const step = Math.max(
    (lats[rows - 1] - minLat) / (rows - 1),
    (lons[cols - 1] - minLon) / (cols - 1)
  );

  const values = new Float32Array(rows * cols).fill(NaN);
  for (const p of points) {
    const i = Math.round((p.latitude - minLat) / step);
    const j = Math.round((p.longitude - minLon) / step);
    if (i >= 0 && i < rows && j >= 0 && j < cols) {
      values[i * cols + j] = p.value;
    }
  }
  return {
    minLat,
    minLon,
    step,
    cols,
    rows,
    values,
    maxLat: lats[rows - 1],
    maxLon: lons[cols - 1],
  };
}

/* Nearest grid point within ~2° — null when outside the real footprint. */
function nearestPoint(entry, lat, lon) {
  let best = null;
  let bestD2 = Infinity;
  for (const p of entry.points) {
    const d2 = (p.latitude - lat) ** 2 + (p.longitude - lon) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return bestD2 <= 4 ? best : null;
}

function realTimestampLabel(entry, epochMs) {
  /* Backend timestamps are naive UTC ("2026-06-23T00:00:00"); parse
     them AS UTC so the label matches the model file's timestep. */
  const raw = entry.meta.time;
  const withZone = /[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`;
  const parsed = Date.parse(withZone);
  return demoTimeLabel(Number.isFinite(parsed) ? parsed : epochMs);
}

/* ============================================================
   TEMPERATURE
============================================================ */

/** Field texture for the temperature imagery layer (real data). */
export async function getRealTemperatureTexture(depth) {
  const snapped = snapDepthToModel(depth);
  const entry = await getRealSlice("temperature", snapped.depth);
  if (!entry.grid) {
    /* No valid ocean cells in this slice — surface it instead of
       painting an empty field (§24). */
    throw new Error(
      `No valid temperature grid for depth ${entry.meta.actualDepth} m`
    );
  }
  const texture = paintRealFieldTexture(
    `temperature:${entry.meta.actualDepth}`,
    entry.grid
  );
  if (!texture) {
    throw new Error(
      `Temperature texture painting failed for depth ${entry.meta.actualDepth} m`
    );
  }
  return { texture, meta: entry.meta, snapped };
}

/**
 * Real slice metadata + statistics for the Depth panel — served from the
 * SAME cached slice the texture painter consumes (one fetch per depth,
 * globe and panel can never disagree). No second API request is made.
 *
 * Returns { actualDepth, requestedDepth, depthIndex, depthCount, unit,
 * source, time, statistics } or throws when the slice is unavailable —
 * real-mode errors must clear the layer, never substitute demo data.
 */
export async function getRealTemperatureSliceInfo(depth) {
  const snapped = snapDepthToModel(depth);
  const entry = await getRealSlice("temperature", snapped.depth);
  return {
    actualDepth: entry.meta.actualDepth,
    requestedDepth: entry.meta.requestedDepthM,
    depthIndex: entry.meta.depthIndex,
    depthCount: entry.meta.depthCount,
    unit: entry.meta.unit,
    source: entry.meta.source,
    time: entry.meta.time,
    statistics: entry.meta.statistics,
  };
}

/** Click record for the temperature info box (real data). */
export async function getRealTemperaturePointAt(lat, lon, depth, epochMs) {
  const snapped = snapDepthToModel(depth);
  const entry = await getRealSlice("temperature", snapped.depth);
  const point = nearestPoint(entry, lat, lon);
  if (!point) return null;

  const value = point.value;
  return {
    kind: "temperature",
    title: "SEA SURFACE TEMPERATURE",
    latitude: r2(lat),
    longitude: r2(lon),
    value: r2(value),
    unit: entry.meta.unit,
    valueLabel: `${r2(value)} ${entry.meta.unit}`,
    depth: entry.meta.actualDepth,
    depthLabel: `${r2(entry.meta.actualDepth)} m`,
    indexLabel: demoTemperatureIndex(value),
    oceanLabel: demoOceanName(lat, lon),
    timestampLabel: realTimestampLabel(entry, epochMs),
  };
}

/* ============================================================
   SALINITY
============================================================ */

/* The real lattice is much denser than the demo scatter; a
   deterministic stride keeps the globe readable. */
const SALINITY_STRIDE = 6;

export async function getRealSalinityPoints(depth) {
  const snapped = snapDepthToModel(depth);
  const entry = await getRealSlice("salinity", snapped.depth);
  return entry.points
    .filter((_, index) => index % SALINITY_STRIDE === 0)
    .map((p) => ({
      latitude: r2(p.latitude),
      longitude: r2(p.longitude),
      value: r2(p.value),
      depth: entry.meta.actualDepth,
      indexLabel: demoSalinityIndex(p.value),
      oceanLabel: demoOceanName(p.latitude, p.longitude),
    }));
}

/** Click record for the salinity info box (real data). */
export async function getRealSalinityPointAt(lat, lon, depth, epochMs) {
  const snapped = snapDepthToModel(depth);
  const entry = await getRealSlice("salinity", snapped.depth);
  const point = nearestPoint(entry, lat, lon);
  if (!point) return null;

  const value = point.value;
  return {
    kind: "salinity",
    title: "SALINITY",
    latitude: r2(lat),
    longitude: r2(lon),
    value: r2(value),
    unit: entry.meta.unit,
    valueLabel: `${r2(value)} ${entry.meta.unit}`,
    depth: entry.meta.actualDepth,
    depthLabel: `${r2(entry.meta.actualDepth)} m`,
    indexLabel: demoSalinityIndex(value),
    oceanLabel: demoOceanName(lat, lon),
    timestampLabel: realTimestampLabel(entry, epochMs),
  };
}

/* ============================================================
   SALINITY — continuous field (Part 8: shared depth architecture)

   Same pipeline as temperature: backend slice -> land-masked
   equirectangular texture -> Cesium imagery layer, and the SAME
   cached entry feeds the depth panel (one fetch per depth).
============================================================ */

/** Field texture for the salinity imagery layer (real data). */
export async function getRealSalinityTexture(depth) {
  const snapped = snapDepthToModel(depth);
  const entry = await getRealSlice("salinity", snapped.depth);
  if (!entry.grid) {
    throw new Error(
      `No valid salinity grid for depth ${entry.meta.actualDepth} m`
    );
  }
  const texture = paintRealFieldTexture(
    `salinity:${entry.meta.actualDepth}`,
    entry.grid,
    "salinity"
  );
  if (!texture) {
    throw new Error(
      `Salinity texture painting failed for depth ${entry.meta.actualDepth} m`
    );
  }
  return { texture, meta: entry.meta, snapped };
}

/**
 * Real salinity slice metadata + statistics for the shared depth panel —
 * served from the SAME cached slice as the texture (one fetch per depth).
 * Same contract as getRealTemperatureSliceInfo.
 */
export async function getRealSalinitySliceInfo(depth) {
  const snapped = snapDepthToModel(depth);
  const entry = await getRealSlice("salinity", snapped.depth);
  return {
    actualDepth: entry.meta.actualDepth,
    requestedDepth: entry.meta.requestedDepthM,
    depthIndex: entry.meta.depthIndex,
    depthCount: entry.meta.depthCount,
    unit: entry.meta.unit,
    source: entry.meta.source,
    time: entry.meta.time,
    statistics: entry.meta.statistics,
  };
}

/* ============================================================
   CHLOROPHYLL (Part 8.3 — honest availability check)

   The local model dataset (arabian_sea_model.nc) provides thetao,
   so, uo, vo and zos ONLY — there is no chlorophyll variable, so
   NO real-data chlorophyll pipeline can exist against this file.
   This check reads /model-capabilities dynamically: if a future
   dataset adds a chlorophyll variable, real mode lights up without
   any code change. Until then the globe keeps the clearly-labeled
   demo chlorophyll layer (Part 9.2 allows labeled demo fallback).
============================================================ */

export function getChlorophyllRealAvailability() {
  const variables = state.capabilities?.variables ?? null;
  if (state.status === "real" && variables) {
    const key = Object.keys(variables).find((name) =>
      name.toLowerCase().includes("chlorophyll")
    );
    if (key) {
      return { available: true, variable: key, unit: variables[key] };
    }
  }
  return {
    available: false,
    reason:
      "Chlorophyll is not present in the local model dataset (real variables: temperature, salinity, currents, sea surface height).",
  };
}

/* ============================================================
   CURRENTS (merged U/V vectors, demo record shape)
============================================================ */

const currentsCache = new Map();

export async function getRealCurrentVectors(depth) {
  const snapped = snapDepthToModel(depth);
  const key = `currents:${snapped.depth}`;
  if (currentsCache.has(key)) return currentsCache.get(key);

  const [uEntry, vEntry] = await Promise.all([
    getRealSlice("u_current", snapped.depth),
    getRealSlice("v_current", snapped.depth),
  ]);

  const vIndex = new Map();
  for (const p of vEntry.points) {
    vIndex.set(`${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`, p.value);
  }

  const vectors = [];
  for (const p of uEntry.points) {
    const v = vIndex.get(`${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`);
    if (v === undefined) continue;
    const u = p.value;
    const speed = Math.sqrt(u * u + v * v);
    vectors.push({
      latitude: r2(p.latitude),
      longitude: r2(p.longitude),
      u: r2(u),
      v: r2(v),
      speed: r2(speed),
      direction: Math.atan2(v, u),
      depth: uEntry.meta.actualDepth,
    });
  }

  currentsCache.set(key, vectors);
  return vectors;
}

/* ============================================================
   FOOTPRINT HELPERS (shared with the demo provider's box)
============================================================ */

export { DEMO_DATASET_BOX, demoInsideBox };

/* ============================================================
   WATER COLUMN STUDIO ACCESS (additive export — no behavior change)

   Exposes the cached grid raster for one (variable, snapped depth)
   so the 3D Water Column Studio can map the location pin, current
   vectors and point values onto the SAME slice the globe uses —
   one fetch per depth, zero duplicated caching.
============================================================ */

export function getRealSliceGrid(variable, depth) {
  const entry = gridCache.get(`${variable}:${depth}`);
  return entry ? entry.grid : null;
}
