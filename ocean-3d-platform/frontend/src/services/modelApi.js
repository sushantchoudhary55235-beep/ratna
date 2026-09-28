// RATNAKARA — FastAPI backend access layer.
//
// Thin fetch wrapper for the existing backend endpoints. Runs
// same-origin in dev thanks to the Vite proxy (vite.config.ts);
// an explicit base URL can be forced with VITE_API_BASE_URL.

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch {
      /* non-JSON error body — keep the HTTP status message */
    }
    throw new Error(detail);
  }
  return res.json();
}

/* The single model timestep available in data/sample/arabian_sea_model.nc.
   The backend selects the nearest timestep anyway, so any time inside the
   dataset window resolves to it. */
export const MODEL_TIME = "2026-06-23T00:00:00";

export async function fetchHealth() {
  return fetchJson(`${API_BASE}/health`);
}

export async function fetchModelCapabilities() {
  return fetchJson(`${API_BASE}/api/v1/model-capabilities`);
}

/**
 * Fetch one 2-D model field slice.
 *
 * @param {string} variable  temperature | salinity | u_current | v_current
 * @param {number} depth     requested depth in meters (backend picks nearest)
 * @param {object} [opts]    { maxPoints }
 * @returns {Promise<{variable: string, unit: string, depth: number,
 *   time: string, source: string,
 *   points: Array<{latitude: number, longitude: number, value: number}>}>}
 */
export function fetchModelField(variable, depth, opts = {}) {
  const qs = new URLSearchParams({
    variable,
    depth: String(depth),
    time: MODEL_TIME,
  });
  if (opts.maxPoints !== undefined) {
    qs.set("max_points", String(opts.maxPoints));
  }
  return fetchJson(`${API_BASE}/api/v1/model-field?${qs.toString()}`);
}
