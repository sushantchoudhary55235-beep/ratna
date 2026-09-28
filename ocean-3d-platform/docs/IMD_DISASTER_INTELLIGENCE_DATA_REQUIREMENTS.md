# IMD Disaster Intelligence — Data Requirements (as implemented)

Status: **Implemented — auth-blocked at the upstream boundary.** This document
records only what was actually verified during the 2026-09-24 integration.
Nothing aspirational is documented as fact.

---

## 1. Purpose

Add an independent "IMD Marine & Disaster Intelligence" layer to RATNAKARA
surfacing official India Meteorological Department data (cyclone track, wind
warning, cone of uncertainty, sea area bulletin, coastal bulletin, port
warnings) through a RATNAKARA-owned backend proxy, with zero fabricated data.

## 2. IMD endpoints used

All six endpoints of the task were probed live (unauthenticated) on
2026-09-24 and are proxied 1:1:

| RATNAKARA route | Upstream | Verified live behavior |
|---|---|---|
| `GET /api/v1/imd/cyclone-track` | `https://api.imd.gov.in/api/v1/cyclone_track` | HTTP 401, `application/json`, `{"error":"API key missing"}` |
| `GET /api/v1/imd/cyclone-wind` | `https://api.imd.gov.in/api/v1/cyclone_wind` | same |
| `GET /api/v1/imd/cyclone-cou` | `https://api.imd.gov.in/api/v1/cyclone_cou` | same |
| `GET /api/v1/imd/sea-bulletin` | `https://api.imd.gov.in/api/v1/seabulletin?id=108` | same |
| `GET /api/v1/imd/coastal-bulletin` | `https://api.imd.gov.in/api/v1/coastalbulletin` | same |
| `GET /api/v1/imd/port-warning` | `https://api.imd.gov.in/api/v1/portwarning` | same |

## 3. Authentication — verified mechanism + explicit gap

Verified by probing:

- Unauthenticated request → `401 {"error":"API key missing"}` on **all six**
  endpoints (identical envelope, JSON, not XML).
- Request with an `apikey:` header (invalid value) → error **changes** to
  `401 {"error":"Authorization header missing or invalid"}` → the gateway
  recognizes an **API-key request header** as the first factor.
- `?api_key=` query parameter → error unchanged → not the mechanism.
- `Authorization: Bearer <token>` alone → error unchanged → not sufficient alone.

**Gap (TODO(VERIFY)):** the exact credential combination (key header alone?
key + Authorization?) cannot be confirmed without real IMD credentials, which
are not available in this environment. The service sends `apikey` when
`IMD_API_KEY` is set and `Authorization: Bearer` when `IMD_API_TOKEN` is set,
so any verified combination can be enabled purely via env vars. **No
successful authenticated response was ever simulated.**

## 4. Observed response structures

- Failure envelope (captured, all endpoints):
  `HTTP 401, Content-Type: application/json, body {"error":"API key missing"}`.
- Success envelope: **NOT observed** (auth wall). Therefore RATNAKARA's proxy
  preserves the upstream JSON payload **verbatim** inside `data` without
  asserting any field names. UI renders whatever fields actually arrive.

## 5. Fields used in the UI

Because no success payload is verifiable, the widget deliberately renders
**generic key/value rows for fields present in each record** (capped at 12
per record) instead of referencing unverified field names. Per §4.2 of the
spec, no field name from the prompt's "potential information" lists was
implemented as if real.

## 6. Geographic fields

TODO(VERIFY): geometry type, coordinate order, and CRS for cyclone wind /
COU / track are unverified. Consequence: **no Cesium geometry layers were
built guessing at formats** (see §9 / Limitations). When real payloads
arrive, `ImdEnvelope.data` already carries them unchanged for a
`Cesium.GeoJsonDataSource`-based layer implementation.

## 7. Caching strategy (implemented)

In-memory TTL cache (`TtlCache` in `imd_service.py`, interface-swappable for
Redis). TTLs per endpoint:

| Endpoint | TTL | Rationale |
|---|---|---|
| cyclone_track | 600 s | spec §17 starting value; real cadence TODO(VERIFY) |
| cyclone_wind | 900 s | advisory-cycle assumption |
| cyclone_cou | 900 s | advisory-cycle assumption |
| sea_bulletin | 1800 s | fixed-schedule bulletin assumption |
| coastal_bulletin | 1800 s | fixed-schedule bulletin assumption |
| port_warning | 1800 s | spec §17 starting value |

Rules implemented: cache key includes the bulletin `id`; `force_refresh=true`
exists but is intended to be rate-gated; stale-on-error serves last-known
data **only within 2× TTL** and always with a real `fetched_at` timestamp;
cache hits are flagged `cache_hit: true` in every response.

## 8. Error handling matrix (implemented)

| Upstream condition | Internal error | `reason` enum | HTTP to client |
|---|---|---|---|
| 401 / 403 | `ImdAuthError` | `authentication_required` | 200 (envelope) |
| 429 | `ImdRateLimitedError` | `rate_limited` | 200 (envelope) |
| 404 | `ImdInvalidResponseError` | `invalid_response` | 200 (envelope) |
| 5xx (after retries) | `ImdUpstreamError` | `upstream_error` | 200 (envelope) |
| connect/read timeout (after retries) | `ImdTimeoutError` | `timeout` | 200 (envelope) |
| non-JSON 200 body | `ImdInvalidResponseError` | `invalid_response` | 200 (envelope) |
| empty result set | — | normal `status:"ok"` with empty `data` | 200 |

Auth failures and client errors are **never retried**; 5xx and timeouts retry
up to `IMD_MAX_RETRIES` (default 2). Failures return the `ImdUnavailable`
envelope (`status:"unavailable"`, `reason`, `detail`,
`last_successful_fetch` when one exists) with HTTP 200 so the frontend can
render a tailored, honest state per tab.

## 9. Frontend visualization (as built)

- `DisasterIntelligenceWidget` — bottom-right fixed card, collapsed by default
  (title, "IMD • Marine Monitoring", live-computed "N Active Information
  Layers"), expands on click to four tabs (CYCLONE / MARINE / COASTAL / PORTS)
  mapping the six endpoints. Each tab/card independently renders
  LOADING / REAL DATA / NO ACTIVE DATA / IMD DATA UNAVAILABLE (with reason +
  last-successful-fetch). Records render their actually-present fields only.
  Attribution "Source: India Meteorological Department (IMD)" on every card.
- Cesium track/wind/cone layers: **not implemented** — deferred pending
  verified geometry (§6). Toggles could not be honestly built without them.
- `services/imdApi.js` — the only IMD surface the browser touches; talks
  exclusively to `/api/v1/imd/*`.

## 10. Source attribution (implemented)

Every card footer: "Source: India Meteorological Department (IMD)"; the
expanded panel footer states RATNAKARA displays the information, IMD issues
it. No wording implies RATNAKARA generated or predicts warnings.

## 11. Data freshness (implemented)

`fetched_at` (RATNAKARA retrieval time) is present on every envelope;
`updated_at` reflects the fetch time of the payload; `cache_hit` is exposed
and displayed as "(cached)". `last_successful_fetch` appears on unavailable
envelopes. Issued/validity fields will be surfaced once real payloads confirm
their field names (TODO(VERIFY)).

## 12. Known limitations (all TODO(VERIFY))

1. Upstream success schemas for all six endpoints (auth wall).
2. Exact auth credential combination.
3. Geometry format/CRS/coordinate order for track, wind, COU — hence no Cesium
   disaster geometry layers were built (no guessing, per spec §20).
4. `seabulletin` `id=108` semantics (fixed area vs rotating id).
5. Real update cadences for correct TTL tuning.
6. No-active-cyclone shape unknown; the pipeline treats empty list/object as a
   normal `no-data` state regardless.
7. Report + Ask-the-Ocean integration intentionally not forced: the report
   pipeline is demo-data-based (frontend jsPDF) and the Gemini context seam
   would need real IMD text to be meaningful — forcing it would have risked
   ungrounded LLM output (spec §24).

## 13. Testing performed

- 23 backend tests (`tests/test_imd_service.py`) with `httpx.MockTransport`
  using fixtures captured from the real 401 responses: status classification,
  retry policy, cache hit/expiry/force-refresh, bulletin-id cache key,
  stale-on-error labelling, all six routes, aggregated status, id passthrough.
- Full backend suite: 235 passed.
- Frontend: eslint clean on new files; `npm run build` succeeds.
- Manual: widget renders collapsed/expanded, tabs switch, per-tab states
  correct against the live (auth-blocked) proxy; temperature panel, depth
  slider, and globe unaffected.
