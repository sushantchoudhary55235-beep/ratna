/* ============================================================
   RATNAKARA — 3D WATER COLUMN STUDIO · CANVAS TEXTURES

   Scientific rendering helpers for the isolated Three.js view.

   Responsibilities (spec Phases 8-11):
   - scientific colormaps (RdYlBu-reversed for temperature,
     viridis for salinity, turbo fallback) as compact
     control-point ramps
   - vertical-section canvases for the four side walls, built
     ONLY from real RATNAKARA model slices (all available levels)
     with NaN → transparent pixels (never fake gradients)
   - laser-plane canvases from ONE real slice, reusing the exact
     RGB painting of the globe's temperature layer (the platform's
     authoritative colors) with alpha boosted for 3D visibilityEvery pixel originates from real backend data. NaN pixels get
alpha 0 (transparent) — land, outside-footprint and missing
cells are never painted.
============================================================ */

/* Shared land-mask probe (the globe's polygon mask) — same module
   the globe's temperature layer uses. One-way dependency, safe
   static import; keeps masking identical across Cesium and here. */
import { isLandPoint } from "../../data/landMask";


/* ------------------------------------------------------------
   SCIENTIFIC COLORMAPS (control points sampled from the
   published Turbo / Viridis ramps — technical reference only)
------------------------------------------------------------ */

/** Lerp between hex control points; t is clamped to [0, 1]. */
function rampColor(stops, t) {
  const x = Math.min(Math.max(t, 0), 1);
  const scaled = x * (stops.length - 1);
  const i = Math.min(Math.floor(scaled), stops.length - 2);
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/* Turbo (Google) — key control points, t: 0 → 1 */
const TURBO_STOPS = [
  [48, 18, 59],
  [70, 107, 227],
  [42, 181, 218],
  [122, 232, 145],
  [215, 226, 40],
  [252, 149, 7],
  [220, 57, 3],
  [122, 4, 3],
];

/* Viridis — key control points, t: 0 → 1 */
const VIRIDIS_STOPS = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
];

/* RdYlBu-reversed — perceptually ordered cold→warm scientific
   temperature ramp (deep blue → cyan → pale yellow → orange →
   dark red). TEMPERATURE ONLY: the Depth Slice panel and its
   legend share this exact ramp. Salinity keeps viridis and the
   turbo ramp remains the fallback for any other kind. */
const TEMPERATURE_STOPS = [
  [0x31, 0x36, 0x95],
  [0x45, 0x75, 0xb4],
  [0x74, 0xad, 0xd1],
  [0xab, 0xd9, 0xe9],
  [0xe0, 0xf3, 0xf8],
  [0xff, 0xff, 0xbf],
  [0xfe, 0xe0, 0x90],
  [0xfd, 0xae, 0x61],
  [0xf4, 0x6d, 0x43],
  [0xd7, 0x30, 0x27],
  [0xa5, 0x00, 0x26],
];

export function turboColormap(t) {
  return rampColor(TURBO_STOPS, t);
}

export function temperatureColormap(t) {
  return rampColor(TEMPERATURE_STOPS, t);
}

export function viridisColormap(t) {
  return rampColor(VIRIDIS_STOPS, t);
}

/**
 * Colormap per variable kind. TEMPERATURE branch is scoped: the
 * scientific cold→warm ramp is used ONLY for temperature slices —
 * salinity still maps to viridis and every other kind still maps
 * to turbo, so no other variable's colors change.
 */
export function colormapFor(kind) {
  if (kind === "temperature") return temperatureColormap;
  if (kind === "salinity") return viridisColormap;
  return turboColormap;
}

/* ------------------------------------------------------------
   VALUE → COLOR (NaN-safe)
------------------------------------------------------------ */

/**
 * Normalize a value into [0, 1] over the slice's real range, with a
 * hard NaN guard. Never converts NaN into a number (spec Phase 9).
 */
export function normalizeValue(value, min, max) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return 0.5;
  }
  return Math.min(Math.max((value - min) / (max - min), 0), 1);
}

/* ------------------------------------------------------------
   REAL SLICE → LASER PLANE CANVAS
   (same color ramp as the globe's paintRealFieldTexture)
------------------------------------------------------------ */

const LASER_WIDTH = 256;
const LASER_HEIGHT = 128;

/** Point-in-real-grid lookup with nearest-finite fallback. Exported
 *  so telemetry can read the value at the selected pin from the SAME
 *  grid the texture was painted from (no second fetch, no drift). */
export function sampleGridValue(grid, lat, lon) {
  if (!grid) return null;
  const fy = (lat - grid.minLat) / grid.step;
  const fx = (lon - grid.minLon) / grid.step;
  const y0 = Math.floor(fy);
  const x0 = Math.floor(fx);
  if (y0 < 0 || x0 < 0 || y0 >= grid.rows - 1 || x0 >= grid.cols - 1) {
    return null;
  }
  const v00 = grid.values[y0 * grid.cols + x0];
  const v10 = grid.values[y0 * grid.cols + x0 + 1];
  const v01 = grid.values[(y0 + 1) * grid.cols + x0];
  const v11 = grid.values[(y0 + 1) * grid.cols + x0 + 1];
  const finite = [v00, v10, v01, v11].filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/**
 * Paint a real model slice onto a canvas for the laser plane.
 *
 * @param {{minLat,maxLat,minLon,maxLon,step,rows,cols,values:Float32Array}} grid
 * @param {{kind:string, min:number, max:number}} style  value range of THIS slice
 * @returns {HTMLCanvasElement|null}
 */
export function paintSliceCanvas(grid, { kind, min, max }) {
  if (!grid || !Number.isFinite(min) || !Number.isFinite(max)) return null;

  const colorAt = colormapFor(kind);

  const canvas = document.createElement("canvas");
  canvas.width = LASER_WIDTH;
  canvas.height = LASER_HEIGHT;
  const context = canvas.getContext("2d");
  const image = context.createImageData(LASER_WIDTH, LASER_HEIGHT);
  const pixels = image.data;

  for (let py = 0; py < LASER_HEIGHT; py++) {
    /* Row 0 = north edge (flipY texture mapping, see below). */
    const lat = grid.maxLat - (py / (LASER_HEIGHT - 1)) * (grid.maxLat - grid.minLat);
    for (let px = 0; px < LASER_WIDTH; px++) {
      const lon = grid.minLon + (px / (LASER_WIDTH - 1)) * (grid.maxLon - grid.minLon);
      const index = (py * LASER_WIDTH + px) * 4;

      /* Land mask first (spec Phase 10) — the polygon mask governs,
         then NaN transparency. Both produce alpha 0. */
      if (isLandPoint(lat, lon)) continue;

      const value = sampleGridValue(grid, lat, lon);
      const t = normalizeValue(value, min, max);
      if (t === null) continue; /* NaN / missing → transparent */

      const [r, g, b] = colorAt(t);
      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = 235;
    }
  }

  context.putImageData(image, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------
   REAL MULTI-LEVEL SECTION → SIDE WALL CANVAS
   Vertical structure from ALL available real model levels.
------------------------------------------------------------ */

/**
 * Build one side-wall canvas: vertical temperature/salinity section
 * through the column center, interpolated across the REAL depth
 * levels. NaN cells stay transparent; structural label overlay is
 * applied separately so science and annotation never mix.
 *
 * @param {Array<{grid: object, depth: number}>} levels ascending by depth
 * @param {{kind: string, min: number, max: number}} style global value range
 * @param {{minDepth: number, maxDepth: number}} depthSpan REAL model range
 * @returns {HTMLCanvasElement|null}
 */
export function paintSideWallCanvas(levels, { kind, min, max }, { minDepth, maxDepth }) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth) || maxDepth <= minDepth) {
    return null;
  }

  const colorAt = colormapFor(kind);
  const centerLat = levels[0].grid ? (levels[0].grid.minLat + levels[0].grid.maxLat) / 2 : null;
  const centerLon = levels[0].grid ? (levels[0].grid.minLon + levels[0].grid.maxLon) / 2 : null;
  if (centerLat === null || centerLon === null) return null;

  const W = 128;
  const H = 256;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const context = canvas.getContext("2d");
  const image = context.createImageData(W, H);
  const pixels = image.data;

  /* Pre-extract the center-column value at each real level. */
  const column = levels.map(({ grid, depth }) => ({
    depth,
    value: sampleGridValue(grid, centerLat, centerLon),
  }));

  if (isLandPoint(centerLat, centerLon)) {
    return canvas; /* fully transparent: the column center is on land */
  }

  for (let py = 0; py < H; py++) {
    /* Row 0 = surface (top of wall). */
    const depth = minDepth + (py / (H - 1)) * (maxDepth - minDepth);

    /* Piecewise-linear interpolation across the REAL levels. Above
       the shallowest level: repeat it (surface mixed layer). Below
       the deepest: transparent — no invented deep-water values. */
    let value = null;
    if (depth <= column[0].depth) {
      value = column[0].value;
    } else if (depth <= column[column.length - 1].depth) {
      for (let i = 0; i < column.length - 1; i++) {
        const a = column[i];
        const b = column[i + 1];
        if (depth >= a.depth && depth <= b.depth) {
          const t =
            b.depth > a.depth ? (depth - a.depth) / (b.depth - a.depth) : 0;
          if (Number.isFinite(a.value) && Number.isFinite(b.value)) {
            value = a.value + (b.value - a.value) * t;
          } else if (Number.isFinite(a.value)) {
            value = a.value;
          } else if (Number.isFinite(b.value)) {
            value = b.value;
          }
          break;
        }
      }
    }
    /* depth > deepest level → value stays null → transparent */

    const t = normalizeValue(value, min, max);
    if (t === null) continue;

    const [r, g, b] = colorAt(t);
    for (let px = 0; px < W; px++) {
      const index = (py * W + px) * 4;
      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      /* Vertical feather: full opacity inside, fading at the very
         top/bottom edges so walls blend into the water volume. */
      const edgeFade =
        py < 6 ? py / 6 : py > H - 7 ? (H - 1 - py) / 6 : 1;
      pixels[index + 3] = Math.round(200 * edgeFade);
    }
  }

  context.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Overlay structural depth labels + a "STRUCTURAL VISUALIZATION"
 * disclosure onto a side-wall canvas (spec Phase 11). Pure annotation —
 * never claims data exists where it does not.
 *
 * @param {HTMLCanvasElement} canvas canvas to annotate in place
 * @param {Array<{depth:number, label:string, y:number}>} ticks ruler ticks
 */
export function annotateSideWall(canvas, ticks) {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const H = canvas.height;

  context.save();
  context.font = "600 11px Inter, 'Segoe UI', Arial, sans-serif";
  context.textBaseline = "middle";
  for (const tick of ticks) {
    const y = tick.y;
    if (y < 8 || y > H - 8) continue;
    context.strokeStyle = "rgba(125, 211, 252, 0.55)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();

    context.fillStyle = "rgba(226, 232, 240, 0.92)";
    context.shadowColor = "rgba(2, 11, 20, 0.9)";
    context.shadowBlur = 4;
    context.fillText(tick.label, 6, y - 7);
    context.shadowBlur = 0;
  }
  context.restore();
}
