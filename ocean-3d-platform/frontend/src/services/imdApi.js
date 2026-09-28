// RATNAKARA — IMD Marine & Disaster Intelligence client.
//
// Consumes ONLY the RATNAKARA proxy (/api/v1/imd/*). The browser never
// talks to api.imd.gov.in directly — no keys, no CORS, one cache.

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

/**
 * Fetch one IMD dataset through the RATNAKARA proxy.
 *
 * Every response is the standard envelope:
 *   ok:          { source, endpoint, fetched_at, updated_at, cache_hit, status:"ok", data }
 *   unavailable: { source, endpoint, fetched_at, status:"unavailable",
 *                  reason, detail, last_successful_fetch }
 *
 * `status: "unavailable"` is returned as a normal result (NOT a thrown
 * error) so each widget tab can render its honest state independently.
 */
export function fetchImdEndpoint(slug, { forceRefresh = false } = {}) {
  const qs = forceRefresh ? "?force_refresh=true" : "";
  return fetchJson(`${API_BASE}/api/v1/imd/${slug}${qs}`);
}

export const IMD_ENDPOINT_SLUGS = {
  cyclone_track: "cyclone-track",
  cyclone_wind: "cyclone-wind",
  cyclone_cou: "cyclone-cou",
  sea_bulletin: "sea-bulletin",
  coastal_bulletin: "coastal-bulletin",
  port_warning: "port-warning",
};

/** Aggregated availability (widget badge / active layer count). */
export function fetchImdStatus() {
  return fetchJson(`${API_BASE}/api/v1/imd/status`);
}

/** Human phrasing for the backend's reason enum (§18.1). */
export const IMD_REASON_LABELS = {
  authentication_required: "Authentication required",
  timeout: "IMD service timed out",
  rate_limited: "Rate limited by IMD — try again shortly",
  upstream_error: "IMD service error",
  invalid_response: "Invalid response from IMD",
  no_active_data: "No active data",
};
