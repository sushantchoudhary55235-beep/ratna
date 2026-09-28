/* ============================================================
   RATNAKARA — 3D WATER COLUMN STUDIO · DEPTH SYSTEM

   Single source of truth for depth → Three.js Y mapping.

   Two SEPARATE depth concepts are kept apart (spec Phase 5):
     VISUAL RANGE   0 → 2000 m   (what the cube shows)
     REAL LEVELS    from /model-capabilities (e.g. 0.49 → 541.09 m)

   The cube communicates "MODEL DATA AVAILABLE TO <max> m" instead
   of pretending real data exists at the bottom of the visual range.
============================================================ */

/* Column dimensions (spec Phase 4): X = [-5, +5], Z = [-5, +5],
   Y = [+7 surface, -7 deep]. */
export const CUBE_W = 10;
export const CUBE_L = 10;
export const CUBE_H = 14;

/* Visual depth range (meters) mapped onto the cube height. This is a
   NAVIGATION range only — real data requests always snap to actual
   model levels via snapDepthToModel() in realDataProvider.js. */
export const VISUAL_MAX_DEPTH = 2000;

/** Clamp a requested depth into the visual range. */
export function clampDepth(depthMeters) {
  const d = Number(depthMeters);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.min(d, VISUAL_MAX_DEPTH);
}

/**
 * Map a depth in meters to a Three.js Y coordinate.
 * Surface (0 m) → +CUBE_H/2, visual max → -CUBE_H/2.
 */
export function depthToY(depthMeters) {
  const fraction = clampDepth(depthMeters) / VISUAL_MAX_DEPTH;
  return CUBE_H / 2 - fraction * CUBE_H;
}

/** Inverse mapping (used for ruler tick placement). */
export function yToDepth(y) {
  const fraction = (CUBE_H / 2 - y) / CUBE_H;
  return fraction * VISUAL_MAX_DEPTH;
}

/** "541.09" → "541.09", "50" → "50", "47.366666" → "47.37". */
export function formatMeters(depthMeters) {
  const d = Number(depthMeters);
  if (!Number.isFinite(d)) return "—";
  const rounded = Math.round(d * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Choose stratification-plane levels from the REAL model depth axis
 * (spec Phase 12): the nearest actual level to each reference depth
 * (50 / 150 / 500 m) plus the deepest available level. Reference
 * depths are never presented as real levels — the nearest REAL level
 * is used so every plane sits on data that exists.
 *
 * @param {number[]|null} realLevels ascending model depth levels
 * @returns {number[]} sorted, de-duplicated levels (empty without data)
 */
export function pickStratificationLevels(realLevels) {
  if (!Array.isArray(realLevels) || realLevels.length === 0) return [];
  const ascending = [...realLevels].sort((a, b) => a - b);

  const nearestTo = (target) =>
    ascending.reduce(
      (best, level) =>
        Math.abs(level - target) < Math.abs(best - target) ? level : best,
      ascending[0]
    );

  const chosen = new Set([nearestTo(50), nearestTo(150), nearestTo(500)]);
  chosen.add(ascending[ascending.length - 1]); // model limit plane
  return [...chosen].sort((a, b) => a - b);
}
