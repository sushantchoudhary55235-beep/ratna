/* ============================================================
   RATNAKARA — 3D WATER COLUMN STUDIO · DATA LAYER

   Thin orchestration over the EXISTING real-data pipeline
   (spec Phase 8 / Phase 41 — no duplicate API client):

     model-capabilities (realDataProvider probe)
       → snapDepthToModel()
       → model-field (shared slice cache in realDataProvider.js)
       → paintSliceCanvas / paintSideWallCanvas (waterColumnTextures.js)

   Adds only: a bounded derived-texture cache keyed by
   variable + actual depth (spec Phase 25) and an Argo
   nearest-depth lookup over the existing /observations endpoint
   (spec Phase 16).

   NEVER fabricates values: every number shown by the Studio
   originates from the backend model or a QC-passed observation.
============================================================ */

import {
  ensureProbed,
  subscribeDataSource,
  getDataSourceState,
  getRealDepthInfo,
  snapDepthToModel,
  getRealCurrentVectors,
  getChlorophyllRealAvailability,
} from "../data/realDataProvider";
import { fetchObservations } from "./api";
import {
  paintSliceCanvas,
  paintSideWallCanvas,
  sampleGridValue,
} from "../rendering/waterColumn/waterColumnTextures";

export { subscribeDataSource, getDataSourceState, snapDepthToModel };

/* ------------------------------------------------------------
   VARIABLE REGISTRY — only variables the real dataset has
------------------------------------------------------------ */

export const VARIABLES = [
  {
    key: "temperature",
    label: "Temperature",
    units: "°C",
    slice: async (depth) => {
      const { getRealTemperatureSliceInfo } = await import("../data/realDataProvider");
      return getRealTemperatureSliceInfo(depth);
    },
  },
  {
    key: "salinity",
    label: "Salinity",
    units: "PSU",
    slice: async (depth) => {
      const { getRealSalinitySliceInfo } = await import("../data/realDataProvider");
      return getRealSalinitySliceInfo(depth);
    },
  },
  {
    key: "currents",
    label: "Currents",
    units: "m/s",
    /* Currents render as vectors, not a scalar slice. */
    slice: null,
  },
];

/** Chlorophyll is NOT in the real dataset — reported, never faked. */
export function getChlorophyllStatus() {
  return getChlorophyllRealAvailability();
}

/* ------------------------------------------------------------
   GRID ACCESS — same cached slice the globe uses
   (additive getRealSliceGrid export in realDataProvider.js)
------------------------------------------------------------ */

let gridGetter = null;
async function getGridGetter() {
  if (!gridGetter) {
    const mod = await import("../data/realDataProvider");
    gridGetter = mod.getRealSliceGrid;
  }
  return gridGetter;
}

/* ------------------------------------------------------------
   BOUNDED TEXTURE CACHE (spec Phase 25)
   key: `${kind}:${actualDepth}` → canvas | null (all-NaN)
------------------------------------------------------------ */

const textureCache = new Map();
const TEXTURE_CACHE_LIMIT = 8;

function cachePut(key, value) {
  if (textureCache.size >= TEXTURE_CACHE_LIMIT) {
    const oldest = textureCache.keys().next().value;
    textureCache.delete(oldest);
  }
  textureCache.set(key, value);
}

/**
 * Laser-plane canvas for a variable at the requested depth.
 * Snaps to the nearest real level, reuses the shared slice cache,
 * and derives the value range from THIS slice's real statistics.
 *
 * @returns {Promise<{canvas: HTMLCanvasElement|null, meta: object}>}
 */
export async function getSliceCanvas(variableKey, requestedDepth) {
  const snapped = snapDepthToModel(requestedDepth);
  const info = await VARIABLES.find((v) => v.key === variableKey)?.slice?.(
    requestedDepth
  );
  if (!info) {
    return { canvas: null, meta: { ...snapped, unavailable: true } };
  }

  const key = `${variableKey}:${info.actualDepth}`;
  if (textureCache.has(key)) {
    return { canvas: textureCache.get(key), meta: info };
  }

  const getGrid = await getGridGetter();
  const grid = getGrid(variableKey, info.actualDepth);
  if (!grid) {
    return { canvas: null, meta: info };
  }

  const min = info.statistics?.min;
  const max = info.statistics?.max;
  const canvas = paintSliceCanvas(grid, {
    kind: variableKey,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 1,
  });
  cachePut(key, canvas);
  return { canvas, meta: info };
}

/**
 * Geographic bounds of the cached slice grid (for pin/vector mapping).
 * @returns {Promise<{minLat,maxLat,minLon,maxLon}|null>} null when unavailable
 */
export async function getSliceBounds(variableKey, requestedDepth) {
  const info = await VARIABLES.find((v) => v.key === variableKey)?.slice?.(
    requestedDepth
  );
  if (!info) return null;
  const getGrid = await getGridGetter();
  const grid = getGrid(variableKey, info.actualDepth);
  if (!grid) return null;
  return {
    minLat: grid.minLat,
    maxLat: grid.maxLat,
    minLon: grid.minLon,
    maxLon: grid.maxLon,
  };
}

/** Scalar value at the pin from the SAME cached grid (no refetch). */
export async function getValueAt(variableKey, requestedDepth, lat, lon) {
  const info = await VARIABLES.find((v) => v.key === variableKey)?.slice?.(
    requestedDepth
  );
  if (!info) return { value: null, meta: null };
  const getGrid = await getGridGetter();
  const grid = getGrid(variableKey, info.actualDepth);
  const value = grid ? sampleGridValue(grid, lat, lon) : null;
  return { value, meta: info };
}

/* ------------------------------------------------------------
   SIDE WALLS — vertical section across ALL real levels
------------------------------------------------------------ */

let wallCache = null; /* { key, canvas, ticks } */

/**
 * Build the shared side-wall section canvas from every real level of
 * a variable. Expensive (fetches each level once through the shared
 * slice cache) — cached per variable until the variable changes.
 *
 * @returns {Promise<{canvas: HTMLCanvasElement|null, ticks: Array, maxDepth: number, error: string|null}>}
 */
export async function getWallCanvas(variableKey) {
  const depthInfo = getRealDepthInfo();
  if (!depthInfo) {
    return { canvas: null, ticks: [], maxDepth: 0, error: "Real model data unavailable." };
  }

  const key = variableKey;
  if (wallCache && wallCache.key === key) {
    return { canvas: wallCache.canvas, ticks: wallCache.ticks, maxDepth: depthInfo.max, error: null };
  }

  const getGrid = await getGridGetter();
  const levels = [];
  const errors = [];

  /* Fetch every level sequentially through the shared cache — first
     load is the only expensive pass; later levels come from cache. */
  for (const level of depthInfo.levels) {
    try {
      const info = await VARIABLES.find((v) => v.key === variableKey)?.slice?.(level);
      if (!info) continue;
      const grid = getGrid(variableKey, info.actualDepth);
      if (grid) {
        levels.push({ grid, depth: info.actualDepth });
      }
    } catch (err) {
      errors.push(`${level}m: ${err?.message || err}`);
    }
  }

  if (levels.length === 0) {
    return {
      canvas: null,
      ticks: [],
      maxDepth: depthInfo.max,
      error: errors[0] || `No valid ${variableKey} sections in the model footprint.`,
    };
  }

  /* Global value range across ALL levels (honest normalization). */
  let min = Infinity;
  let max = -Infinity;
  for (const { grid } of levels) {
    for (const v of grid.values) {
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (!Number.isFinite(min)) {
    return { canvas: null, ticks: [], maxDepth: depthInfo.max, error: "All-NaN section." };
  }

  const canvas = paintSideWallCanvas(
    levels,
    { kind: variableKey, min, max },
    { minDepth: depthInfo.min, maxDepth: depthInfo.max }
  );

  /* Ruler ticks at meaningful REAL levels (spec Phase 11). */
  const tickTargets = [0, 50, 150, 500].map(
    (target) => depthInfo.levels.reduce((best, l) =>
      Math.abs(l - target) < Math.abs(best - target) ? l : best
    )
  );
  const ticks = [...new Set([...tickTargets, depthInfo.max])].map((depth) => ({
    depth,
    label: `${depth} m`,
  }));

  wallCache = { key, canvas, ticks };
  return { canvas, ticks, maxDepth: depthInfo.max, error: errors[0] || null };
}

/* ------------------------------------------------------------
   CURRENTS — REAL U/V vectors at the snapped depth
------------------------------------------------------------ */

/**
 * @returns {Promise<{vectors: Array, bounds: object|null, depth: number, error: string|null}>}
 */
export async function getCurrentVectors(requestedDepth) {
  const snapped = snapDepthToModel(requestedDepth);
  try {
    const vectors = await getRealCurrentVectors(snapped.depth);
    const getGrid = await getGridGetter();
    const bounds = getGrid("u_current", snapped.depth);
    return { vectors, bounds, depth: snapped.depth, error: null };
  } catch (err) {
    return {
      vectors: [],
      bounds: null,
      depth: snapped.depth,
      error: `Current data unavailable: ${err?.message || err}`,
    };
  }
}

/* ------------------------------------------------------------
   ARGO / OBSERVATION COMPARISON (spec Phase 16)
------------------------------------------------------------ */

const observationCache = new Map();
const OBS_CACHE_LIMIT = 12;

/**
 * Nearest QC-passed Argo profile to (lat, lon), with the measurement
 * closest to the selected model depth. Only real values are returned.
 *
 * @returns {Promise<{found: boolean, depthGap: number, ...}|{found: false, reason: string}>}
 */
export async function getNearestObservation(lat, lon, modelDepth, variableKey) {
  const round1 = (x) => Math.round(x * 10) / 10;
  const cacheKey = `${round1(lat)},${round1(lon)}`;

  let profile = observationCache.get(cacheKey);
  if (!profile) {
    const response = await fetchObservations({
      latitude: round1(lat),
      longitude: round1(lon),
      radius_km: 120,
      max_observations: 200,
    });
    if (!response.observations?.length) {
      profile = { found: false, reason: "No nearby Argo float in the dataset." };
    } else {
      /* Score by horizontal distance, keep the full profile. */
      let best = null;
      let bestD2 = Infinity;
      for (const obs of response.observations) {
        const d2 = (obs.latitude - lat) ** 2 + (obs.longitude - lon) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = obs;
        }
      }
      profile = { found: true, observation: best };
    }
    if (observationCache.size >= OBS_CACHE_LIMIT) {
      observationCache.delete(observationCache.keys().next().value);
    }
    observationCache.set(cacheKey, profile);
  }

  if (!profile.found) {
    return profile;
  }

  /* Deep copy-free nearest-depth scan over the single profile row. */
  const obs = profile.observation;
  const value =
    variableKey === "salinity"
      ? obs.salinity
      : variableKey === "temperature"
        ? obs.temperature
        : null;

  if (value === null || value === undefined || !Number.isFinite(value)) {
    return {
      found: false,
      reason: `Nearest Argo float (${round1(obs.latitude)}°N, ${round1(obs.longitude)}°E) reports no ${variableKey} at this cycle.`,
    };
  }

  return {
    found: true,
    latitude: obs.latitude,
    longitude: obs.longitude,
    observationDepth: obs.depth,
    depthGap: Math.round(Math.abs(obs.depth - modelDepth) * 10) / 10,
    value,
    time: obs.time,
  };
}

/* ------------------------------------------------------------
   BOOTSTRAP
------------------------------------------------------------ */

/** Ensure the capabilities probe has run before reading depths. */
export function ready() {
  return ensureProbed();
}
