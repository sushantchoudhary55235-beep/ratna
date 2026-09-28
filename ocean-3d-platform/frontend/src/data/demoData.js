import { isOcean } from "./landMask";

/* ============================================================
   RATNAKARA — DEMO DATA PROVIDER (frontend-only)

   Single source of DEMO ocean data for the visualization
   variables. Every layer consumes data through this provider
   using the SAME normalized shape the real backend model-field
   API returns:

     { latitude, longitude, value, depth, timestamp }   scalars
     { latitude, longitude, u, v, speed, direction }    vectors

   DATA SOURCE        -> this file (demo)  -> later: REST/NetCDF backend
   NORMALIZED RECORDS -> the exports below (shape-stable)
   VISUALIZATION      -> App.jsx / Cesium globe layers

   Replacing the demo with real data means swapping the getter
   implementations for API calls that return the same shapes —
   no rendering component changes required.

   All generation is DETERMINISTIC (seeded hash, no Math.random)
   so re-toggling a layer never produces different values and
   cached textures keep frame cost near zero between timesteps.

   PLAYBACK TIME:
     Model time starts at DEMO_START_EPOCH and advances in
     DEMO_TIMESTEP_MS (6-hour) steps. Every field function takes
     a timestep index `t`; play/pause only moves the clock.
============================================================ */

export const DEMO_MODE_ACTIVE = true;

/* 14 Sep 2026 06:00 UTC — demo model reference time. */
export const DEMO_START_EPOCH = Date.UTC(2026, 8, 14, 6, 0, 0);

/* One model timestep = 6 hours. */
export const DEMO_TIMESTEP_MS = 6 * 60 * 60 * 1000;

/* How the playback bar advances model time while playing
   (real milliseconds per 6-hour step). */
export const DEMO_STEP_INTERVAL_MS = 5000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (x) => Math.round(x * 100) / 100;

/* ------------------------------------------------------------
   TIME HELPERS
------------------------------------------------------------ */

/* Map a wall-clock epoch (ms) to demo model time. */
export function demoTimeToStep(epochMs) {
  const epoch = Number.isFinite(epochMs) ? epochMs : DEMO_START_EPOCH;
  const elapsed = epoch - DEMO_START_EPOCH;
  const stepIndex = Math.floor(elapsed / DEMO_TIMESTEP_MS);
  return {
    stepIndex,
    fraction: (elapsed - stepIndex * DEMO_TIMESTEP_MS) / DEMO_TIMESTEP_MS,
    stepTime: DEMO_START_EPOCH + stepIndex * DEMO_TIMESTEP_MS,
  };
}

const DEMO_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/* "14 Sep 2026 06:00 UTC" formatting used by info boxes. */
export function demoTimeLabel(epochMs) {
  const d = new Date(Number.isFinite(epochMs) ? epochMs : DEMO_START_EPOCH);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${DEMO_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/* Deterministic per-location noise in [0, 1). */
function hash01(lat, lon) {
  const s = Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/* Demo dataset window — Arabian Sea / Bay of Bengal / Indian
   Ocean, matching the region buttons' application bounds. */
const DEMO_BOX = {
  minLat: -28,
  maxLat: 26,
  minLon: 48,
  maxLon: 98,
};

function insideDemoBox(lat, lon) {
  return (
    lat >= DEMO_BOX.minLat &&
    lat <= DEMO_BOX.maxLat &&
    lon >= DEMO_BOX.minLon &&
    lon <= DEMO_BOX.maxLon
  );
}

/* Region naming for info boxes. */
export function demoOceanName(lat, lon) {
  if (lat > 3 && lon < 76) return "Arabian Sea";
  if (lat > 3 && lon >= 76) return "Bay of Bengal";
  return "Indian Ocean";
}

/* Index levels (visual/linguistic, derived from the value). */
export function demoTemperatureIndex(value) {
  if (value >= 31) return "High";
  if (value >= 29) return "Medium";
  return "Normal";
}

export function demoSalinityIndex(value) {
  if (value >= 35) return "High";
  if (value >= 33) return "Medium";
  return "Low";
}

export function demoChlorophyllIndex(value) {
  if (value >= 2) return "High";
  if (value >= 0.5) return "Medium";
  return "Low";
}

/* ============================================================
   FIELD FUNCTIONS (value at a location, optional timestep)
============================================================ */

/*
  Physically-shaped demo SST: warm equatorial pool, cooling
  poleward, Somali/Oman coastal upwelling dips, gentle
  deterministic texture. The timestep adds a slow seasonal
  warm/cool wobble plus a monsoon-modulated Somali dip.
*/
function demoSurfaceTemperature(lat, lon, t = 0) {
  let value = 29.6 - 0.34 * Math.abs(lat + 6);

  value +=
    0.8 *
    Math.exp(-(((lat - 13) ** 2) / 90 + ((lon - 88) ** 2) / 90));

  value -=
    3.2 *
    Math.exp(-(((lat - 9) ** 2) / 14 + ((lon - 52) ** 2) / 14));

  value -=
    2.2 *
    Math.exp(-(((lat - 19) ** 2) / 10 + ((lon - 58.5) ** 2) / 10));

  value += (hash01(lat, lon) - 0.5) * 0.3;

  /* Playback time: seasonal wobble + travelling warm phase. */
  value += 0.55 * Math.sin((2 * Math.PI * t) / 140);
  value += 0.3 * Math.sin((2 * Math.PI * t) / 56 + lon * 0.02);

  /* Stronger Somali upwelling during the monsoon phase. */
  value -=
    1.1 *
    Math.max(0, Math.sin((2 * Math.PI * t) / 140)) *
    Math.exp(-(((lat - 9) ** 2) / 30 + ((lon - 52) ** 2) / 40));

  return clamp(value, 16, 34);
}

function demoTemperatureAtDepth(lat, lon, depth, t = 0) {
  const surface = demoSurfaceTemperature(lat, lon, t);
  /* Simple thermocline decay — demo depth semantics. */
  return surface - 15 * (1 - Math.exp(-depth / 420));
}

function demoSalinityAt(lat, lon, t = 0) {
  /* High-evaporation Arabian Sea core vs low-salinity
     Bay of Bengal (Ganges plume) and open Indian Ocean. */
  const asCore = Math.exp(
    -(((lat - 14) ** 2) / 60 + ((lon - 64) ** 2) / 90)
  );
  const bobBroad = Math.exp(
    -(((lat - 15) ** 2) / 40 + ((lon - 86) ** 2) / 60)
  );
  const bobPlume = Math.exp(
    -(((lat - 20.5) ** 2) / 12 + ((lon - 89.5) ** 2) / 18)
  );

  let s =
    34.9 +
    1.3 * asCore -
    1.1 * bobBroad -
    1.8 * bobPlume;

  s += (hash01(lat * 1.7, lon * 2.3) - 0.5) * 0.24;

  /* Playback time: slow haline drift. */
  s += 0.18 * Math.sin((2 * Math.PI * t) / 112);

  return clamp(s, 31, 37);
}

/*
  Southwest-monsoon-style circulation (June, matching the
  model timestep): Somali Current, Monsoon Current jet east
  of Socotra, inflow into the Bay of Bengal, East/West India
  Coastal Currents, westward South Equatorial Current.
*/
function demoUVAt(lat, lon, t = 0) {
  let u = 0;
  let v = 0;

  const somali = Math.exp(
    -(((lat - 6) ** 2) / 30 + ((lon - 50) ** 2) / 40)
  );
  u += 0.85 * somali;
  v += 0.55 * somali;

  const jet = Math.exp(
    -(((lat - 8) ** 2) / 26 + ((lon - 72) ** 2) / 260)
  );
  u += 0.65 * jet;
  v += 0.12 * jet;

  const bobInflow = Math.exp(
    -(((lat - 10) ** 2) / 20 + ((lon - 90) ** 2) / 70)
  );
  u += 0.45 * bobInflow;
  v += 0.30 * bobInflow;

  const eicc = Math.exp(
    -(((lat - 16) ** 2) / 18 + ((lon - 87.5) ** 2) / 6)
  );
  u -= 0.15 * eicc;
  v -= 0.5 * eicc;

  const wicc = Math.exp(
    -(((lat - 15) ** 2) / 25 + ((lon - 71.5) ** 2) / 5)
  );
  u += 0.25 * wicc;
  v += 0.45 * wicc;

  const sec = Math.exp(-(((lat + 13) ** 2) / 40));
  u -= 0.55 * sec;

  u += 0.1 * Math.sin(lat * 0.5 + lon * 0.35) *
    Math.cos(lon * 0.28 - lat * 0.18);
  v += 0.08 * Math.cos(lat * 0.4 + lon * 0.22);

  /* Playback time: gentle basin-wide strengthening/weakening. */
  const wobble = 0.85 + 0.3 * Math.sin((2 * Math.PI * t) / 84 + lon * 0.01);

  return {
    u: clamp(u * wobble, -1.2, 1.2),
    v: clamp(v * wobble, -1.0, 1.0),
  };
}

/* ============================================================
   CHLOROPHYLL DEMO FIELD
============================================================ */

/*
  Chlorophyll concentrates near coasts (upwelling + runoff).
  A coarse coastal-proximity lattice is sampled once from the
  shared land mask, then bilinearly read during painting.
*/
const COAST_LATTICE_STEP = 1;

let coastLattice = null;

function getCoastProximity(lat, lon) {
  if (!coastLattice) {
    coastLattice = new Map();

    for (let lat0 = DEMO_BOX.minLat; lat0 <= DEMO_BOX.maxLat; lat0 += COAST_LATTICE_STEP) {
      for (let lon0 = DEMO_BOX.minLon; lon0 <= DEMO_BOX.maxLon; lon0 += COAST_LATTICE_STEP) {
        let score = 0;

        for (const radius of [1.5, 3.5]) {
          let hits = 0;
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            const sampleLat = lat0 + Math.sin(a) * radius;
            const sampleLon = lon0 + Math.cos(a) * radius;
            if (!isOcean(sampleLat, sampleLon)) hits++;
          }
          score +=
            (hits / 8) * (radius === 1.5 ? 1 : 0.45);
        }

        coastLattice.set(`${lat0},${lon0}`, score);
      }
    }
  }

  const lat0 = Math.floor(lat / COAST_LATTICE_STEP) * COAST_LATTICE_STEP;
  const lon0 = Math.floor(lon / COAST_LATTICE_STEP) * COAST_LATTICE_STEP;

  const s00 = coastLattice.get(`${lat0},${lon0}`) ?? 0;
  const s10 = coastLattice.get(`${lat0 + COAST_LATTICE_STEP},${lon0}`) ?? 0;
  const s01 = coastLattice.get(`${lat0},${lon0 + COAST_LATTICE_STEP}`) ?? 0;
  const s11 =
    coastLattice.get(
      `${lat0 + COAST_LATTICE_STEP},${lon0 + COAST_LATTICE_STEP}`
    ) ?? 0;

  const fx = (lat - lat0) / COAST_LATTICE_STEP;
  const fy = (lon - lon0) / COAST_LATTICE_STEP;

  return (
    s00 * (1 - fx) * (1 - fy) +
    s10 * fx * (1 - fy) +
    s01 * (1 - fx) * fy +
    s11 * fx * fy
  );
}

function demoChlorophyllAt(lat, lon, t = 0) {
  let c = 0.14;

  c += 2.6 * getCoastProximity(lat, lon);

  /* Ganges/Brahmaputra plume and Somali upwelling peaks. */
  c +=
    1.6 *
    Math.exp(-(((lat - 21) ** 2) / 22 + ((lon - 89.5) ** 2) / 22));
  c +=
    0.9 *
    Math.exp(-(((lat - 7) ** 2) / 20 + ((lon - 51) ** 2) / 20));
  c +=
    0.35 *
    Math.exp(-(((lat - 11) ** 2) / 60 + ((lon - 75) ** 2) / 60));

  c += (hash01(lat * 3.1, lon * 4.7) - 0.5) * 0.06;

  /* Playback time: bloom pulses travelling westward. */
  c *= 1 + 0.25 * Math.sin((2 * Math.PI * t) / 84 + lon * 0.015);

  return clamp(c, 0.04, 9);
}

/* ============================================================
   PALETTES
============================================================ */

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/* Temperature ramp — matches the existing TemperatureLegend. */
const TEMPERATURE_COLOR_STOPS = [
  { value: 4, color: hexToRgb("#0b3d91") },
  { value: 12, color: hexToRgb("#00bcd4") },
  { value: 18, color: hexToRgb("#fdd835") },
  { value: 24, color: hexToRgb("#ff9800") },
  { value: 28, color: hexToRgb("#f44336") },
  { value: 34, color: hexToRgb("#880e4f") },
];

/* Salinity ramp (PSU) — kept for reference/info coloring;
   the salinity layer renders as light particles, not a field. */
const SALINITY_COLOR_STOPS = [
  { value: 31, color: hexToRgb("#4a5fb0") },
  { value: 33, color: hexToRgb("#3f8fb8") },
  { value: 34.5, color: hexToRgb("#2fb8a0") },
  { value: 35.5, color: hexToRgb("#58c96b") },
  { value: 36.5, color: hexToRgb("#a2d94e") },
  { value: 37, color: hexToRgb("#e8e15a") },
];

/* Chlorophyll ramp (mg/m³, log-style oceanographic product). */
const CHLOROPHYLL_COLOR_STOPS = [
  { value: 0.05, color: hexToRgb("#0b3d4d") },
  { value: 0.3, color: hexToRgb("#0e6b6b") },
  { value: 0.8, color: hexToRgb("#2e9e5b") },
  { value: 2.0, color: hexToRgb("#8fd14f") },
  { value: 5.0, color: hexToRgb("#d9e021") },
  { value: 9.0, color: hexToRgb("#f0f921") },
];

const PALETTES = {
  temperature: TEMPERATURE_COLOR_STOPS,
  salinity: SALINITY_COLOR_STOPS,
  chlorophyll: CHLOROPHYLL_COLOR_STOPS,
};

/* Linear interpolation across a palette's stops -> [r,g,b] 0-255. */
function paletteRgb(kind, value) {
  const stops = PALETTES[kind];
  const v = clamp(value, stops[0].value, stops[stops.length - 1].value);

  for (let i = 0; i < stops.length - 1; i++) {
    const lower = stops[i];
    const upper = stops[i + 1];
    if (v <= upper.value) {
      /* Smoothstep between stops: removes the subtle kinks a
         piecewise-linear ramp leaves at each stop, so the field
         reads as one continuous scientific gradient. */
      const raw = (v - lower.value) / (upper.value - lower.value);
      const f = raw * raw * (3 - 2 * raw);
      return [
        Math.round(lower.color[0] + (upper.color[0] - lower.color[0]) * f),
        Math.round(lower.color[1] + (upper.color[1] - lower.color[1]) * f),
        Math.round(lower.color[2] + (upper.color[2] - lower.color[2]) * f),
      ];
    }
  }

  return stops[stops.length - 1].color;
}

/* CSS color for a value — used by scatter-point layers. */
export function demoValueToCss(kind, value) {
  const [r, g, b] = paletteRgb(kind, value);
  return `rgb(${r}, ${g}, ${b})`;
}

/* ============================================================
   VALUE GRIDS (regular 0.5° grid, per kind/depth/timestep)
============================================================ */

const GRID_STEP_DEG = 0.5;

const GRID_SOURCES = {
  temperature: {
    valueAt: (lat, lon, depth, t) => demoTemperatureAtDepth(lat, lon, depth, t),
  },
  salinity: {
    valueAt: (lat, lon, depth, t) => demoSalinityAt(lat, lon, t),
  },
  chlorophyll: {
    valueAt: (lat, lon, depth, t) => demoChlorophyllAt(lat, lon, t),
  },
};

const gridCache = new Map();

/*
  Returns { minLat, minLon, step, cols, rows, values: Float32Array }.
  values[i * cols + j] is the value at
  (minLat + i * step, minLon + j * step).
*/
export function getDemoGrid(kind, depth = 0, t = 0) {
  const key = `${kind}:${depth}:${t}`;
  if (gridCache.has(key)) {
    return gridCache.get(key);
  }

  const source = GRID_SOURCES[kind];
  const cols = Math.round((DEMO_BOX.maxLon - DEMO_BOX.minLon) / GRID_STEP_DEG) + 1;
  const rows = Math.round((DEMO_BOX.maxLat - DEMO_BOX.minLat) / GRID_STEP_DEG) + 1;
  const values = new Float32Array(cols * rows);

  for (let i = 0; i < rows; i++) {
    const lat = DEMO_BOX.minLat + i * GRID_STEP_DEG;
    for (let j = 0; j < cols; j++) {
      const lon = DEMO_BOX.minLon + j * GRID_STEP_DEG;
      values[i * cols + j] = source.valueAt(lat, lon, depth, t);
    }
  }

  const grid = {
    minLat: DEMO_BOX.minLat,
    minLon: DEMO_BOX.minLon,
    step: GRID_STEP_DEG,
    cols,
    rows,
    values,
  };

  gridCache.set(key, grid);
  return grid;
}

/*
  Statistics of one demo grid (min/max/mean/valid/missing) over finite
  values only — same NaN-honest contract as the backend slice statistics.
  Pure read over the cached grid; no fetching, no fabrication.
*/
export function demoGridStats(kind, depth = 0, t = 0) {
  const grid = getDemoGrid(kind, depth, t);
  if (!grid) return null;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let valid = 0;
  const values = grid.values;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    valid += 1;
  }
  if (valid === 0) return null;

  return {
    min,
    max,
    mean: sum / valid,
    validCount: valid,
    missingCount: values.length - valid,
  };
}

/* Bilinear read from a value grid. */
function sampleGrid(grid, lat, lon) {
  const fx = (lon - grid.minLon) / grid.step;
  const fy = (lat - grid.minLat) / grid.step;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);

  if (x0 < 0 || y0 < 0 || x0 >= grid.cols - 1 || y0 >= grid.rows - 1) {
    return null;
  }

  /* Cosine-weighted bilinear: interpolates smoothly across cell
     edges, so the raster never shows the underlying 0.5° lattice
     as faint grid rows/stepping (spec: no visible sampling rows). */
  const w = (0.5 - 0.5 * Math.cos(Math.min(Math.max(fx - x0, 0), 1) * Math.PI));
  const z = (0.5 - 0.5 * Math.cos(Math.min(Math.max(fy - y0, 0), 1) * Math.PI));
  const tx = w;
  const ty = z;

  const v00 = grid.values[y0 * grid.cols + x0];
  const v10 = grid.values[y0 * grid.cols + x0 + 1];
  const v01 = grid.values[(y0 + 1) * grid.cols + x0];
  const v11 = grid.values[(y0 + 1) * grid.cols + x0 + 1];

  return (
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty
  );
}

/* ============================================================
   CONTINUOUS FIELD TEXTURES
   (Temperature / Chlorophyll continuous color fields)
============================================================ */

/* 2048×1024 keeps India-regional zooms crisp while repaint cost
   stays bounded by the cached land/outside raster. */
const FIELD_TEXTURE_WIDTH = 2048;
const FIELD_TEXTURE_HEIGHT = 1024;

/*
  Coastal land dilation: the polygon mask is coarse (1–2° vertex
  spacing), so its straight edges can misclassify coastal land
  (deltas, bays, beach gradients) as ocean. Fields are painted
  only where a pixel is ocean AND at least this far from any
  land pixel, so temperature/chlorophyll color never covers
  Indian or any other plains/coastal land. Purely a paint-time
  buffer — the shared isOcean() used for observations, currents
  and info boxes is untouched.
*/
const FIELD_LAND_BUFFER_DEG = 0.5;
const FIELD_EDGE_FEATHER_DEG = 6;
const FIELD_MAX_ALPHA = 170;

/* One-time land/outside raster per texture size so per-timestep
   repaints only run the (cheap) value + palette math. */
let fieldLandMask = null;

function getFieldLandMask(width, height) {
  if (fieldLandMask && fieldLandMask.width === width && fieldLandMask.height === height) {
    return fieldLandMask.data;
  }

  const data = new Uint8Array(width * height);

  /* Pass 1 — classify per pixel. */
  for (let y = 0; y < height; y++) {
    const latitude = -90 + (y / (height - 1)) * 180;

    for (let x = 0; x < width; x++) {
      let longitude = (x / (width - 1)) * 360 - 180;
      if (longitude > 180) longitude -= 360;

      const index = y * width + x;

      if (!insideDemoBox(latitude, longitude)) {
        data[index] = 2; /* outside dataset footprint */
      } else if (!isOcean(latitude, longitude)) {
        data[index] = 1; /* land */
      }
    }
  }

  /* Pass 2 — dilate land into ocean by FIELD_LAND_BUFFER_DEG
     (separable min-filter: horizontal sweep, then vertical),
     so coarse polygon edges can never leak color onto land. */
  const radius = Math.max(
    1,
    Math.round((FIELD_LAND_BUFFER_DEG * width) / 360)
  );
  const horizontal = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;

    for (let x = 0; x < width; x++) {
      if (data[row + x] === 1) {
        const from = Math.max(0, x - radius);
        const to = Math.min(width - 1, x + radius);
        for (let k = from; k <= to; k++) horizontal[row + k] = 1;
      }
    }
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (horizontal[y * width + x] === 1) {
        const from = Math.max(0, y - radius);
        const to = Math.min(height - 1, y + radius);
        for (let k = from; k <= to; k++) {
          const index = k * width + x;
          if (data[index] === 0) data[index] = 1;
        }
      }
    }
  }

  fieldLandMask = { width, height, data };
  return data;
}

const fieldTextureCache = new Map();
const FIELD_TEXTURE_CACHE_MAX = 12;

/*
  Returns { canvas, url, width, height } for one field frame.
  `url` is a data: URL the Cesium imagery layer consumes.
  Cached per (kind, depth, timestep); the cache is small and
  FIFO-evicted so depth slider use cannot grow it unbounded.
*/
export function getDemoFieldTexture(kind, depth = 0, t = 0) {
  const key = `${kind}:${depth}:${t}`;
  if (fieldTextureCache.has(key)) {
    return fieldTextureCache.get(key);
  }

  const width = FIELD_TEXTURE_WIDTH;
  const height = FIELD_TEXTURE_HEIGHT;
  const grid = getDemoGrid(kind, depth, t);
  const mask = getFieldLandMask(width, height);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  const pixels = image.data;

  for (let y = 0; y < height; y++) {
    const latitude = -90 + (y / (height - 1)) * 180;

    for (let x = 0; x < width; x++) {
      let longitude = (x / (width - 1)) * 360 - 180;
      if (longitude > 180) longitude -= 360;

      const index = y * width + x;
      const maskValue = mask[index];

      /* Outside footprint or land -> fully transparent. */
      if (maskValue !== 0) continue;

      const value = sampleGrid(grid, latitude, longitude);
      if (value === null || value === undefined) continue;

      /* Feathered dataset edge. */
      const edge = Math.min(
        DEMO_BOX.maxLat - latitude,
        latitude - DEMO_BOX.minLat,
        DEMO_BOX.maxLon - longitude,
        longitude - DEMO_BOX.minLon
      );

      const feather =
        edge >= FIELD_EDGE_FEATHER_DEG
          ? 1
          : edge / FIELD_EDGE_FEATHER_DEG;
      if (feather < 0.02) continue;

      const [r, g, b] = paletteRgb(kind, value);

      const pixelIndex = index * 4;
      pixels[pixelIndex] = r;
      pixels[pixelIndex + 1] = g;
      pixels[pixelIndex + 2] = b;
      pixels[pixelIndex + 3] = Math.round(FIELD_MAX_ALPHA * feather);
    }
  }

  context.putImageData(image, 0, 0);

  const texture = {
    canvas,
    url: canvas.toDataURL("image/png"),
    width,
    height,
  };

  fieldTextureCache.set(key, texture);
  if (fieldTextureCache.size > FIELD_TEXTURE_CACHE_MAX) {
    const oldest = fieldTextureCache.keys().next().value;
    fieldTextureCache.delete(oldest);
  }

  return texture;
}

/* ============================================================
   SCALAR POINT PROVIDERS (normalized record shape)
============================================================ */

const demoTemperatureCache = new Map();

/* Regular 1-degree grid over the demo box, ocean-only.
   Same record shape as the model-field API points. */
export function getDemoTemperaturePoints(depth = 0, t = 0) {
  const key = `${depth}:${t}`;
  if (demoTemperatureCache.has(key)) {
    return demoTemperatureCache.get(key);
  }

  const points = [];
  for (let lat = DEMO_BOX.minLat; lat <= DEMO_BOX.maxLat; lat += 1) {
    for (let lon = DEMO_BOX.minLon; lon <= DEMO_BOX.maxLon; lon += 1) {
      if (!isOcean(lat, lon)) continue;
      points.push({
        latitude: r2(lat),
        longitude: r2(lon),
        value: r2(demoTemperatureAtDepth(lat, lon, depth, t)),
        depth,
      });
    }
  }

  demoTemperatureCache.set(key, points);
  return points;
}

/* Point lookup for the temperature click info box. */
export function getDemoTemperaturePointAt(lat, lon, depth = 0, t = 0, epochMs = null) {
  if (!insideDemoBox(lat, lon) || !isOcean(lat, lon)) {
    return null;
  }

  const value = demoTemperatureAtDepth(lat, lon, depth, t);

  return {
    kind: "temperature",
    title: "SEA SURFACE TEMPERATURE",
    latitude: r2(lat),
    longitude: r2(lon),
    value: r2(value),
    unit: "°C",
    valueLabel: `${r2(value)} °C`,
    depth,
    depthLabel: depth > 0 ? `${depth} m` : "Surface (0–10 m)",
    indexLabel: demoTemperatureIndex(value),
    oceanLabel: demoOceanName(lat, lon),
    timestampLabel: demoTimeLabel(epochMs ?? DEMO_START_EPOCH + t * DEMO_TIMESTEP_MS),
  };
}

const demoSalinityCache = new Map();

/* Scattered ocean observation points with a natural, clustered
   distribution: a coarse jittered lattice provides broad coverage,
   then seeded cluster centers (Argo-style deployment pockets) add
   dense local groups. No straight rows or rectangular pattern. */
export function getDemoSalinityPoints(depth = 0, t = 0) {
  const key = `${depth}:${t}`;
  if (demoSalinityCache.has(key)) {
    return demoSalinityCache.get(key);
  }

  const points = [];

  const pushPoint = (lat, lon) => {
    const value = demoSalinityAt(lat, lon, t);
    points.push({
      latitude: r2(lat),
      longitude: r2(lon),
      value: r2(value),
      depth,
      indexLabel: demoSalinityIndex(value),
      oceanLabel: demoOceanName(lat, lon),
    });
  };

  /* Background coverage: sparse lattice with wide, uneven jitter
     so nothing reads as a row or column. */
  for (let lat = -26; lat <= 24; lat += 2.6) {
    for (let lon = 50; lon <= 96; lon += 2.6) {
      const jLat = lat + (hash01(lat * 1.31, lon * 0.73) - 0.5) * 2.2;
      const jLon = lon + (hash01(lon * 2.17, lat * 0.53) - 0.5) * 2.2;

      if (!isOcean(jLat, jLon)) continue;
      /* Skip ~30% of candidates so density varies across the basin. */
      if (hash01(jLat * 4.7, jLon * 3.9) < 0.3) continue;

      pushPoint(jLat, jLon);
    }
  }

  /* Cluster pockets: 16 deterministic centers over ocean; each
     scatters 5-10 nearby observations with anisotropic spread. */
  const CLUSTER_COUNT = 16;
  for (let c = 0; c < CLUSTER_COUNT; c += 1) {
    let center = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const cl = -24 + hash01(c * 7.7 + attempt * 1.9, c * 3.1) * 46;
      const co = 52 + hash01(c * 2.3 + attempt * 2.7, c * 9.4) * 42;
      if (isOcean(cl, co)) {
        center = { cl, co };
        break;
      }
    }
    if (!center) continue;

    const count = 5 + Math.floor(hash01(center.cl * 11.3, center.co * 7.9) * 6);
    for (let k = 0; k < count; k += 1) {
      const dLat = (hash01(c * 5.1 + k * 1.7, k * 8.3) - 0.5) * 3.4;
      const dLon = (hash01(c * 6.7 + k * 2.9, k * 4.1) - 0.5) * 4.2;
      const jLat = center.cl + dLat;
      const jLon = center.co + dLon;

      if (!isOcean(jLat, jLon)) continue;
      pushPoint(jLat, jLon);
    }
  }

  demoSalinityCache.set(key, points);
  return points;
}

/* Point lookup for the salinity click info box. */
export function getDemoSalinityPointAt(lat, lon, depth = 0, t = 0, epochMs = null) {
  if (!insideDemoBox(lat, lon) || !isOcean(lat, lon)) {
    return null;
  }

  const value = demoSalinityAt(lat, lon, t);

  return {
    kind: "salinity",
    title: "SALINITY",
    latitude: r2(lat),
    longitude: r2(lon),
    value: r2(value),
    unit: "PSU",
    valueLabel: `${r2(value)} PSU`,
    depth,
    depthLabel: depth > 0 ? `${depth} m` : "Surface (0–10 m)",
    indexLabel: demoSalinityIndex(value),
    oceanLabel: demoOceanName(lat, lon),
    timestampLabel: demoTimeLabel(epochMs ?? DEMO_START_EPOCH + t * DEMO_TIMESTEP_MS),
  };
}

/* Point lookup for the chlorophyll click info box. */
export function getDemoChlorophyllPointAt(lat, lon, t = 0, epochMs = null) {
  if (!insideDemoBox(lat, lon) || !isOcean(lat, lon)) {
    return null;
  }

  const value = demoChlorophyllAt(lat, lon, t);

  return {
    kind: "chlorophyll",
    title: "CHLOROPHYLL",
    latitude: r2(lat),
    longitude: r2(lon),
    value: r2(value),
    unit: "mg/m³",
    valueLabel: `${r2(value)} mg/m³`,
    depth: 0,
    depthLabel: "Surface (0–10 m)",
    indexLabel: demoChlorophyllIndex(value),
    oceanLabel: demoOceanName(lat, lon),
    timestampLabel: demoTimeLabel(epochMs ?? DEMO_START_EPOCH + t * DEMO_TIMESTEP_MS),
  };
}

/* ============================================================
   CURRENT VECTOR PROVIDER (2-degree grid, merged U/V shape)
============================================================ */

const demoCurrentsCache = new Map();

/* 2-degree vector grid, ocean-only. Same merged shape the
   App currents effect builds from the U/V model fields. */
export function getDemoCurrentVectors(depth = 0, t = 0) {
  const key = `${depth}:${t}`;
  if (demoCurrentsCache.has(key)) {
    return demoCurrentsCache.get(key);
  }

  /* Deeper demo slices move slower (no data invented — the
     decay is part of the demo field definition). */
  const depthScale = Math.exp(-depth / 350);

  const vectors = [];
  for (let lat = DEMO_BOX.minLat; lat <= DEMO_BOX.maxLat; lat += 2) {
    for (let lon = DEMO_BOX.minLon; lon <= DEMO_BOX.maxLon; lon += 2) {
      if (!isOcean(lat, lon)) continue;

      const { u, v } = demoUVAt(lat, lon, t);
      const su = u * depthScale;
      const sv = v * depthScale;
      const speed = Math.sqrt(su * su + sv * sv);

      vectors.push({
        latitude: r2(lat),
        longitude: r2(lon),
        u: r2(su),
        v: r2(sv),
        speed: r2(speed),
        direction: Math.atan2(sv, su),
        depth,
      });
    }
  }

  demoCurrentsCache.set(key, vectors);
  return vectors;
}

/* ============================================================
   CANONICAL DATA ADAPTERS (§5/§8)

   The renderer-facing surface: one function per variable,
   each taking (lat, lon, time) with time as a wall-clock
   epoch in milliseconds. Demo math is mapped onto the demo
   model timeline internally.

   To connect real data later, replace ONLY these four bodies
   (e.g. bilinear sampling of a fetched NetCDF/xarray JSON
   grid). The rendering layers keep calling the same names.
============================================================ */

export function getTemperature(lat, lon, time = null, depth = 0) {
  const t = demoTimeToStep(time ?? DEMO_START_EPOCH).stepIndex;
  return demoTemperatureAtDepth(lat, lon, depth, t);
}

export function getSalinity(lat, lon, time = null) {
  const t = demoTimeToStep(time ?? DEMO_START_EPOCH).stepIndex;
  return demoSalinityAt(lat, lon, t);
}

export function getCurrent(lat, lon, time = null, depth = 0) {
  const t = demoTimeToStep(time ?? DEMO_START_EPOCH).stepIndex;
  const { u, v } = demoUVAt(lat, lon, t);
  const depthScale = Math.exp(-depth / 350);
  const su = u * depthScale;
  const sv = v * depthScale;
  const speed = Math.sqrt(su * su + sv * sv);
  return {
    u: su,
    v: sv,
    speed,
    direction: Math.atan2(sv, su),
  };
}

export function getChlorophyll(lat, lon, time = null) {
  const t = demoTimeToStep(time ?? DEMO_START_EPOCH).stepIndex;
  return demoChlorophyllAt(lat, lon, t);
}

/* ============================================================
   REPORT ANALYSIS ADAPTERS (additive)

   The report view consumes the SAME demo model as the globe —
   no second dataset. All series are built by replaying the
   existing demo field functions across the demo timeline, so
   report values, globe values and downloads share one source
   of truth. Replacing the demo model with real data later
   (NetCDF -> xarray -> API) automatically feeds the report.
============================================================ */

/* Demo timeline length: 84 six-hour steps from the demo epoch. */
const REPORT_SERIES_STEPS = 84;

export const REPORT_LAST_STEP_EPOCH =
  DEMO_START_EPOCH + (REPORT_SERIES_STEPS - 1) * DEMO_TIMESTEP_MS;

/* Fixed ocean reference point for report statistics (central
   Arabian Sea). Used whenever the requested camera location is
   not usable (over land / outside the demo footprint). */
export const REPORT_CENTER = { latitude: 14.5, longitude: 65.5 };

export function getReportCenter(requested) {
  if (
    requested &&
    insideDemoBox(requested.lat, requested.lon) &&
    isOcean(requested.lat, requested.lon)
  ) {
    return { latitude: requested.lat, longitude: requested.lon };
  }
  return {
    latitude: REPORT_CENTER.latitude,
    longitude: REPORT_CENTER.longitude,
  };
}

/* Equirectangular degree distance — good enough to rank the
   nearest demo observations for the report tables. */
function reportDistance(aLat, aLon, bLat, bLon) {
  const dLat = aLat - bLat;
  const dLon = (aLon - bLon) * Math.cos((aLat * Math.PI) / 180);
  return dLat * dLat + dLon * dLon;
}

/* Shared per-variable time-series builder: replays the demo
   field across the 84-step demo timeline at one location. */
function reportSeries(sampleAt) {
  const series = [];
  for (let t = 0; t < REPORT_SERIES_STEPS; t++) {
    series.push({
      time: DEMO_START_EPOCH + t * DEMO_TIMESTEP_MS,
      value: sampleAt(t),
    });
  }
  return series;
}

function reportStats(series) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (const point of series) {
    if (point.value < min) min = point.value;
    if (point.value > max) max = point.value;
    sum += point.value;
  }

  const mean = sum / series.length;
  const delta = series[series.length - 1].value - series[0].value;

  return {
    min: r2(min),
    max: r2(max),
    mean: r2(mean),
    trend: delta >= 0 ? `+${r2(delta)}` : r2(delta),
  };
}

/* -------- Temperature -------- */

export function getReportTemperatureAnalysis(latitude, longitude, depth = 0) {
  const step = 0;
  const current = demoTemperatureAtDepth(latitude, longitude, depth, step);
  const series = reportSeries(
    (t) => demoTemperatureAtDepth(latitude, longitude, depth, t)
  );

  const profile = [];
  for (let d = 0; d <= 2000; d += 100) {
    profile.push({
      depth: d,
      value: r2(demoTemperatureAtDepth(latitude, longitude, d, step)),
    });
  }

  return {
    current,
    ...reportStats(series),
    series,
    profile,
    observationCount: getDemoTemperaturePoints(depth, step).length,
    unit: "°C",
  };
}

/* -------- Salinity -------- */

export function getReportSalinityAnalysis(latitude, longitude) {
  const step = 0;
  const current = demoSalinityAt(latitude, longitude, step);
  const series = reportSeries((t) => demoSalinityAt(latitude, longitude, t));

  const points = getDemoSalinityPoints(0, step)
    .map((p) => ({
      ...p,
      distance: reportDistance(p.latitude, p.longitude, latitude, longitude),
    }))
    .sort((a, b) => a.distance - b.distance);

  return {
    current,
    ...reportStats(series),
    series,
    observations: points.slice(0, 8),
    observationCount: points.length,
    unit: "PSU",
  };
}

/* -------- Currents -------- */

export function getReportCurrentAnalysis(latitude, longitude, depth = 0) {
  const step = 0;
  const depthScale = Math.exp(-depth / 350);
  const at = (t) => {
    const { u, v } = demoUVAt(latitude, longitude, t);
    return {
      u: r2(u * depthScale),
      v: r2(v * depthScale),
      speed: r2(Math.sqrt((u * depthScale) ** 2 + (v * depthScale) ** 2)),
      direction: Math.atan2(v * depthScale, u * depthScale),
    };
  };

  const current = at(step);
  const series = reportSeries(at);

  const speeds = series.map((p) => p.value.speed);
  const uComponents = series.map((p) => p.value.u);
  const vComponents = series.map((p) => p.value.v);

  return {
    current,
    min: r2(Math.min(...speeds)),
    max: r2(Math.max(...speeds)),
    mean: r2(speeds.reduce((s, x) => s + x, 0) / speeds.length),
    uMin: r2(Math.min(...uComponents)),
    uMax: r2(Math.max(...uComponents)),
    uMean: r2(uComponents.reduce((s, x) => s + x, 0) / uComponents.length),
    vMin: r2(Math.min(...vComponents)),
    vMax: r2(Math.max(...vComponents)),
    vMean: r2(vComponents.reduce((s, x) => s + x, 0) / vComponents.length),
    series,
    observationCount: getDemoCurrentVectors(depth, step).length,
    unit: "m/s",
  };
}

/* -------- Chlorophyll-a -------- */

export function getReportChlorophyllAnalysis(latitude, longitude) {
  const step = 0;
  const current = demoChlorophyllAt(latitude, longitude, step);
  const series = reportSeries((t) => demoChlorophyllAt(latitude, longitude, t));

  return {
    current,
    ...reportStats(series),
    series,
    observationCount: null, /* continuous demo field — no point count */
    unit: "mg/m³",
  };
}

/* -------- Coastal / in-situ observation table (DEMO) -------- */

const REPORT_COASTAL_STATIONS = [
  { station: "Mumbai-01", latitude: 19.076, longitude: 72.877 },
  { station: "Mumbai-02", latitude: 18.922, longitude: 72.834 },
  { station: "Kochi-01", latitude: 9.931, longitude: 76.267 },
  { station: "Kochi-02", latitude: 10.026, longitude: 76.308 },
  { station: "Chennai-01", latitude: 13.082, longitude: 80.275 },
  { station: "Chennai-02", latitude: 12.989, longitude: 80.25 },
  { station: "Mormugao-01", latitude: 15.4, longitude: 73.8 },
  { station: "Mangaluru-01", latitude: 12.87, longitude: 74.84 },
  { station: "Visakhapatnam-01", latitude: 17.686, longitude: 83.218 },
  { station: "Paradip-01", latitude: 20.316, longitude: 86.609 },
  { station: "Tuticorin-01", latitude: 8.764, longitude: 78.134 },
  { station: "Port Blair-01", latitude: 11.623, longitude: 92.726 },
  { station: "Kavaratti-01", latitude: 10.57, longitude: 72.64 },
  { station: "Minicoy-01", latitude: 8.28, longitude: 73.05 },
];

export function getReportCoastalObservations(epochMs) {
  const step = demoTimeToStep(epochMs ?? DEMO_START_EPOCH).stepIndex;

  return REPORT_COASTAL_STATIONS.map((station) => {
    const temperature = r2(
      demoTemperatureAtDepth(station.latitude, station.longitude, 0, step)
    );
    const salinity = r2(demoSalinityAt(station.latitude, station.longitude, step));
    const chlorophyll = r2(demoChlorophyllAt(station.latitude, station.longitude, step));

    return [
      {
        station: station.station,
        variable: "Temperature",
        value: temperature,
        unit: "°C",
        latitude: station.latitude,
        longitude: station.longitude,
        depth: "0 m",
        source: "Demo model",
        quality: "Demo",
      },
      {
        station: station.station,
        variable: "Salinity",
        value: salinity,
        unit: "PSU",
        latitude: station.latitude,
        longitude: station.longitude,
        depth: "0 m",
        source: "Demo model",
        quality: "Demo",
      },
      {
        station: station.station,
        variable: "Chlorophyll-a",
        value: chlorophyll,
        unit: "mg/m³",
        latitude: station.latitude,
        longitude: station.longitude,
        depth: "0 m",
        source: "Demo model",
        quality: "Demo",
      },
    ];
  }).flat();
}

/* -------- Recent observations (chronological) -------- */

export function getReportRecentObservations(latitude, longitude) {
  const rows = [];

  for (let t = 0; t < 12; t++) {
    const epoch = DEMO_START_EPOCH + t * DEMO_TIMESTEP_MS;
    const region = demoOceanName(latitude, longitude);

    rows.push(
      {
        time: demoTimeLabel(epoch),
        region,
        variable: "Temperature",
        value: `${r2(demoTemperatureAtDepth(latitude, longitude, 0, t))} °C`,
        source: "Demo model",
        latitude,
        longitude,
      },
      {
        time: demoTimeLabel(epoch),
        region,
        variable: "Salinity",
        value: `${r2(demoSalinityAt(latitude, longitude, t))} PSU`,
        source: "Demo model",
        latitude,
        longitude,
      },
      {
        time: demoTimeLabel(epoch),
        region,
        variable: "Chlorophyll-a",
        value: `${r2(demoChlorophyllAt(latitude, longitude, t))} mg/m³`,
        source: "Demo model",
        latitude,
        longitude,
      }
    );
  }

  return rows;
}

/* -------- Metadata (honest demo provenance) -------- */

export function getReportMetadata() {
  return {
    source: "RATNAKARA DEMO DATA",
    dataset: "Ratnakara Demo Dataset (synthetic)",
    processing: "Demo / interpolated",
    spatialResolution: "Demo (0.5° model field)",
    temporalResolution: `Demo (6-hour steps, ${REPORT_SERIES_STEPS}-step cycle)`,
    depthLevels: "0–2000 m (temperature/current demo decay)",
    lastUpdated: demoTimeLabel(REPORT_LAST_STEP_EPOCH),
    quality: "Demo — not scientifically validated",
  };
}

/* ============================================================
   REAL-BACKEND BRIDGE (additive — demo functions above are
   untouched). Lets src/data/realDataProvider.js reuse the same
   field-painting pipeline for real model grids so the globe's
   look stays identical whichever source is active.
============================================================ */

/** Shared palette/value machinery (private above). */
export { paletteRgb as demoPaletteRgb, clamp as demoClamp };

/** Dataset footprint helpers for the real provider. */
export { DEMO_BOX as DEMO_DATASET_BOX, insideDemoBox as demoInsideBox };

/**
 * Paint a real model grid into the SAME equirectangular field texture
 * the demo layers use (2048×1024, land-masked, feathered edges), and
 * cache it under the provider's own key namespace.
 *
 * @param {string} cacheKey  provider namespaced cache key
 * @param {object} grid      real grid from the backend:
 *        { minLat, minLon, step, cols, rows, values: Float32Array }
 * @param {string} [kind]    palette key: "temperature" | "salinity" |
 *        "chlorophyll". Defaults to "temperature" for backward
 *        compatibility with existing callers.
 * @returns {{ url: string, width: number, height: number }} texture
 */
export function paintRealFieldTexture(cacheKey, grid, kind = "temperature") {
  const key = `real:${cacheKey}`;
  if (fieldTextureCache.has(key)) {
    return fieldTextureCache.get(key);
  }

  /* Degenerate backend slice (too few valid cells for a raster):
     return null so the caller can surface the error instead of
     painting an empty/misleading field. */
  if (!grid || grid.cols < 2 || grid.rows < 2 || !grid.values) {
    return null;
  }

  /* Targeted fix (§27): never create a zero-sized canvas/texture.
     Dimensions here are constants, but the guard documents the
     Cesium "Expected width to be greater than 0" failure mode
     instead of letting it surface from inside the imagery provider. */
  const width = FIELD_TEXTURE_WIDTH;
  const height = FIELD_TEXTURE_HEIGHT;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  /* Feather against the REAL model footprint, not the demo window:
     the Copernicus subset spans 45–99.9°E / −30–25°N, so clamping
     the edge fade to the demo box would hard-clip the southern
     Indian Ocean and eastern Bay of Bengal rows the model actually
     contains. */
  const box = {
    minLat: grid.minLat,
    maxLat: grid.minLat + (grid.rows - 1) * grid.step,
    minLon: grid.minLon,
    maxLon: grid.minLon + (grid.cols - 1) * grid.step,
  };

  /* Land mask for the REAL grid footprint (targeted fix):
     previously this reused getFieldLandMask, which classifies every
     pixel outside the DEMO window (48–98°E / −28–26°N) as "outside
     footprint" — silently dropping the model's western Arabian Sea
     rows (45–48°E) and painting the wrong feather band. The mask is
     now computed from the actual grid bounds: land still comes from
     the shared polygon mask (dilated), everything inside the REAL
     footprint that is ocean is paintable, and NaN cells stay
     transparent below. */
  const mask = getRealFieldLandMask(width, height, box);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  const pixels = image.data;

  for (let y = 0; y < height; y++) {
    const latitude = -90 + (y / (height - 1)) * 180;

    for (let x = 0; x < width; x++) {
      let longitude = (x / (width - 1)) * 360 - 180;
      if (longitude > 180) longitude -= 360;

      const index = y * width + x;
      if (mask[index] !== 0) continue; /* land / outside footprint */

      const value = sampleRealGrid(grid, latitude, longitude);
      if (value === null || value === undefined) continue;

      const edge = Math.min(
        box.maxLat - latitude,
        latitude - box.minLat,
        box.maxLon - longitude,
        longitude - box.minLon
      );

      const feather =
        edge >= FIELD_EDGE_FEATHER_DEG
          ? 1
          : edge / FIELD_EDGE_FEATHER_DEG;
      if (feather < 0.02) continue;

      const [r, g, b] = paletteRgb(kind, value);
      const pixelIndex = index * 4;
      pixels[pixelIndex] = r;
      pixels[pixelIndex + 1] = g;
      pixels[pixelIndex + 2] = b;
      pixels[pixelIndex + 3] = Math.round(FIELD_MAX_ALPHA * feather);
    }
  }

  context.putImageData(image, 0, 0);

  const texture = {
    canvas,
    url: canvas.toDataURL("image/png"),
    width,
    height,
  };

  fieldTextureCache.set(key, texture);
  if (fieldTextureCache.size > FIELD_TEXTURE_CACHE_MAX + 4) {
    const oldest = fieldTextureCache.keys().next().value;
    fieldTextureCache.delete(oldest);
  }

  return texture;
}

/* Cosine bilinear over a real grid (same interpolation shape the demo
   uses, minus the 0.5°-lattice assumption).

   Targeted NaN fix: the previous version required ALL FOUR bilinear
   neighbors to be finite and returned null otherwise, which punched
   transparent holes into valid ocean wherever a single land/missing
   (NaN) cell sat next to real water — most visibly along coastlines,
   inland seas and around islands. Now, when some neighbors are NaN,
   the nearest FINITE model cell value is returned instead: the color
   still comes from a real measured ocean value (never 0, mean,
   random or invented interpolation), while fully-NaN areas (land,
   missing data) remain transparent. */
function sampleRealGrid(grid, lat, lon) {
  const fx = (lon - grid.minLon) / grid.step;
  const fy = (lat - grid.minLat) / grid.step;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);

  if (x0 < 0 || y0 < 0 || x0 >= grid.cols - 1 || y0 >= grid.rows - 1) {
    return null;
  }

  const w = 0.5 - 0.5 * Math.cos(Math.min(Math.max(fx - x0, 0), 1) * Math.PI);
  const z = 0.5 - 0.5 * Math.cos(Math.min(Math.max(fy - y0, 0), 1) * Math.PI);

  const v00 = grid.values[y0 * grid.cols + x0];
  const v10 = grid.values[y0 * grid.cols + x0 + 1];
  const v01 = grid.values[(y0 + 1) * grid.cols + x0];
  const v11 = grid.values[(y0 + 1) * grid.cols + x0 + 1];

  if (
    !Number.isFinite(v00) || !Number.isFinite(v10) ||
    !Number.isFinite(v01) || !Number.isFinite(v11)
  ) {
    /* NaN-aware fallback: keep real ocean pixels that border a
       NaN cell by sampling the nearest finite corner. Pixels whose
       corners are ALL NaN still return null -> transparent. */
    return nearestFinite([
      [v00, Math.hypot(fx - x0, fy - y0)],
      [v10, Math.hypot(fx - (x0 + 1), fy - y0)],
      [v01, Math.hypot(fx - x0, fy - (y0 + 1))],
      [v11, Math.hypot(fx - (x0 + 1), fy - (y0 + 1))],
    ]);
  }

  return (
    v00 * (1 - w) * (1 - z) +
    v10 * w * (1 - z) +
    v01 * (1 - w) * z +
    v11 * w * z
  );
}

/* Pick the value of the nearest finite candidate; null when none. */
function nearestFinite(candidates) {
  let bestValue = null;
  let bestDistance = Infinity;
  for (const [value, distance] of candidates) {
    if (Number.isFinite(value) && distance < bestDistance) {
      bestValue = value;
      bestDistance = distance;
    }
  }
  return bestValue;
}

/* One-time land mask over the REAL model footprint (per box).

   Same classification contract as getFieldLandMask, but scoped to
   the actual grid bounds instead of the demo window:
     0 -> inside the real footprint and ocean (paintable)
     1 -> land (polygon mask, dilated by FIELD_LAND_BUFFER_DEG)
     2 -> outside the real model footprint
   Cached per footprint box so depth switching never recomputes it. */
const realFieldLandMaskCache = new Map();

function getRealFieldLandMask(width, height, box) {
  const cacheKey = [
    width,
    height,
    box.minLat,
    box.maxLat,
    box.minLon,
    box.maxLon,
  ].join(":");

  const cached = realFieldLandMaskCache.get(cacheKey);
  if (cached) return cached;

  const data = new Uint8Array(width * height);

  /* Pass 1 — classify per pixel. */
  for (let y = 0; y < height; y++) {
    const latitude = -90 + (y / (height - 1)) * 180;

    for (let x = 0; x < width; x++) {
      let longitude = (x / (width - 1)) * 360 - 180;
      if (longitude > 180) longitude -= 360;

      const index = y * width + x;

      if (
        latitude < box.minLat ||
        latitude > box.maxLat ||
        longitude < box.minLon ||
        longitude > box.maxLon
      ) {
        data[index] = 2; /* outside the REAL model footprint */
      } else if (!isOcean(latitude, longitude)) {
        data[index] = 1; /* land */
      }
    }
  }

  /* Pass 2 — dilate land into ocean by FIELD_LAND_BUFFER_DEG
     (same separable min-filter as getFieldLandMask) so the coarse
     polygon edges can never leak color onto coastal land. */
  const radius = Math.max(
    1,
    Math.round((FIELD_LAND_BUFFER_DEG * width) / 360)
  );
  const horizontal = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;

    for (let x = 0; x < width; x++) {
      if (data[row + x] === 1) {
        const from = Math.max(0, x - radius);
        const to = Math.min(width - 1, x + radius);
        for (let k = from; k <= to; k++) horizontal[row + k] = 1;
      }
    }
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (horizontal[y * width + x] === 1) {
        const from = Math.max(0, y - radius);
        const to = Math.min(height - 1, y + radius);
        for (let k = from; k <= to; k++) {
          const index = k * width + x;
          if (data[index] === 0) data[index] = 1;
        }
      }
    }
  }

  /* Small FIFO so distinct footprints cannot grow the cache
     unbounded (the real dataset has a single fixed footprint in
     practice; this is defensive only). */
  realFieldLandMaskCache.set(cacheKey, data);
  if (realFieldLandMaskCache.size > 4) {
    const oldest = realFieldLandMaskCache.keys().next().value;
    realFieldLandMaskCache.delete(oldest);
  }

  return data;
}
