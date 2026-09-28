/* ============================================================
   TEMPERATURE DEPTH SLICE PANEL — real slice data (additive)

   Pure visualization of EXISTING app state: no fetches, no
   slider, no Cesium interaction. Shows where the currently
   rendered temperature slice sits within the model's REAL
   depth range (from /api/v1/model-capabilities) and the REAL
   per-slice statistics (from /api/v1/model-field, computed
   server-side over the full-resolution slice).

   The water-column shading stays a visual cue only — the axis
   labels and the statistics are measured model values.
============================================================ */

/* Fallback axis ticks for DEMO mode only (demo depth slider spans
   0–2000 m). NEVER shown in real mode — real mode labels come from
   the model's actual depths_m array. */
const DEMO_REFERENCE_TICKS = [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000];

/* Existing app temperature colormap (TEMPERATURE_COLOR_STOPS in
   demoData.js / TemperatureLegend stops) — cold → warm. */
const TEMP_GRADIENT =
  "linear-gradient(to right, #0b3d91, #00bcd4, #fdd835, #ff9800, #f44336, #880e4f)";

const fmtDepth = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : null;

/* Requested slider depth: show as the user chose it (no fake precision). */
const fmtRequested = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? String(Math.round(value * 100) / 100)
    : null;

const fmtTemp = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : null;

const fmtCount = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : null;

/* Real depth axis: "24 / 32" — the 0-based depth_index straight from
   the backend (155.85 m = index 24 of 32), never re-derived locally. */
const fmtLevelIndex = (index, count) =>
  typeof index === "number" && Number.isFinite(index) && index >= 0
    ? typeof count === "number" && count > 0
      ? `${index} / ${count}`
      : `${index}`
    : null;

/* "2026-06-23T00:00:00" (naive UTC) -> "23 Jun 2026 • 00:00 UTC" */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtTimestamp(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const withZone = /[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(withZone);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()} • ${pad(
    parsed.getUTCHours()
  )}:${pad(parsed.getUTCMinutes())} UTC`;
}

/* Pick ~5 evenly spaced labels from the REAL depth axis. */
function sampleDepthLabels(levels, count = 5) {
  if (!Array.isArray(levels) || levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  if (sorted.length <= count) return sorted;
  const picked = [];
  for (let i = 0; i < count; i++) {
    picked.push(sorted[Math.round((i * (sorted.length - 1)) / (count - 1))]);
  }
  return [...new Set(picked)];
}

const fmtTick = (value) =>
  typeof value === "number" ? String(Math.round(value * 100) / 100) : "";

export default function TemperatureDepthPanel({
  requestedDepth,
  actualModelDepth,
  modelDepthMin,
  modelDepthMax,
  depthLevels,
  modelLevelIndex,
  modelLevelCount,
  sliceMinTemp,
  sliceMaxTemp,
  sliceMeanTemp,
  sliceValidCount,
  sliceMissingCount,
  sliceUnits,
  sliceTimestamp,
  sliceSource,
  timeStepsAvailable,
  lightMode = false,
  dataSourceStatus = "probing", // probing | real | demo
  sliceStatus = "idle",         // idle | loading | ready | error | no-data
  sliceError = null,
  onClose,
}) {
  const textColor = lightMode ? "#163743" : "#e2e8f0";
  const mutedColor = lightMode ? "#63818b" : "#94a3b8";
  const bg = lightMode ? "rgba(248, 253, 255, 0.96)" : "rgba(10, 18, 32, 0.96)";
  const borderColor = lightMode
    ? "rgba(22, 135, 201, 0.20)"
    : "rgba(148, 163, 184, 0.18)";
  const accentColor = lightMode ? "#087e8b" : "#7dd3fc";
  const errorColor = lightMode ? "#a02020" : "#f87171";

  /* ---------- Data status state machine (Step 9) ---------- */
  let status;
  if (dataSourceStatus === "probing") {
    status = { label: "CONNECTING…", color: mutedColor, reason: null };
  } else if (sliceStatus === "error") {
    status = { label: "DATA UNAVAILABLE", color: errorColor, reason: sliceError };
  } else if (sliceStatus === "loading") {
    const lvl = fmtDepth(actualModelDepth);
    status = {
      label: lvl ? `LOADING ${lvl} m SLICE…` : "LOADING SLICE…",
      color: accentColor,
      reason: null,
    };
  } else if (sliceStatus === "no-data") {
    status = { label: "NO DATA", color: mutedColor, reason: null };
  } else if (sliceStatus === "ready" && dataSourceStatus === "real") {
    status = { label: "REAL MODEL DATA", color: lightMode ? "#0a6b3d" : "#7ef0b1", reason: null };
  } else if (sliceStatus === "ready" && dataSourceStatus === "demo") {
    status = { label: "DEMO DATA", color: lightMode ? "#8a5a00" : "#ffd479", reason: null };
  } else {
    status = { label: "CONNECTING…", color: mutedColor, reason: null };
  }

  /* ---------- Depth column geometry (real range only in real mode) ---------- */
  const hasDepthRange =
    typeof modelDepthMin === "number" &&
    typeof modelDepthMax === "number" &&
    modelDepthMax > modelDepthMin;

  const loading = !fmtDepth(actualModelDepth);

  const markerPercent = !hasDepthRange
    ? 0
    : Math.min(
        100,
        Math.max(
          0,
          ((actualModelDepth - modelDepthMin) / (modelDepthMax - modelDepthMin)) * 100
        )
      );

  /* Axis labels: the REAL depths_m array in real mode; generic ticks in
     demo mode only. Round numbers are visual axis references — never
     presented as measured model levels. */
  const tickDepths =
    Array.isArray(depthLevels) && depthLevels.length > 0 && hasDepthRange
      ? sampleDepthLabels(depthLevels)
      : hasDepthRange
        ? DEMO_REFERENCE_TICKS.filter(
            (d) => d >= modelDepthMin && d <= modelDepthMax
          )
        : [];

  /* Clamping disclosure (Step 3): request beyond the model's deepest level. */
  const clampedToMax =
    hasDepthRange &&
    typeof requestedDepth === "number" &&
    Number.isFinite(requestedDepth) &&
    requestedDepth > modelDepthMax + 0.5;

  /* ---------- Statistics (Step 4 / Step 7) ---------- */
  const hasStats =
    fmtTemp(sliceMinTemp) !== null && fmtTemp(sliceMaxTemp) !== null;
  const unitSuffix = sliceUnits ? ` ${sliceUnits}` : "";

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        top: "50%",
        transform: "translateY(-50%)",
        width: 260,
        maxHeight: "90vh",
        overflowY: "auto",
        zIndex: 50, /* above globe overlays, below the report view (z 60) */
        background: bg,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
        padding: "14px 16px",
        fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
        color: textColor,
      }}
    >
      {/* ---------- Section A — Header ---------- */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.6px" }}>
          🌊 Depth Slice Visualization
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close depth slice panel"
          style={{
            background: "none",
            border: "none",
            color: mutedColor,
            fontSize: 16,
            cursor: "pointer",
            padding: "0 2px",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      {/* ---------- Section B — Water column + slice marker ---------- */}
      {hasDepthRange ? (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            {/* Left: axis labels sampled from the REAL model depth axis */}
            <div
              style={{
                position: "relative",
                width: 34,
                height: 360,
                flexShrink: 0,
              }}
            >
              {tickDepths.map((labelDepth) => {
                const labelPercent =
                  ((labelDepth - modelDepthMin) / (modelDepthMax - modelDepthMin)) * 100;
                return (
                  <span
                    key={labelDepth}
                    style={{
                      position: "absolute",
                      top: `${Math.min(100, Math.max(0, labelPercent))}%`,
                      transform: "translateY(-50%)",
                      fontSize: 9,
                      color: mutedColor,
                      textAlign: "right",
                      width: "100%",
                    }}
                  >
                    {fmtTick(labelDepth)}
                  </span>
                );
              })}
            </div>

            {/* Right: water column with the selected-slice marker */}
            <div style={{ position: "relative", flex: 1 }}>
              <div
                style={{
                  position: "relative",
                  height: 360,
                  width: "100%",
                  borderRadius: 8,
                  border: `1px solid ${borderColor}`,
                  background:
                    "linear-gradient(to bottom, #7dd3fc 0%, #1d6fa5 35%, #0b3d5c 70%, #041e30 100%)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: `${markerPercent}%`,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: lightMode ? "#0b3d5c" : "#ffffff",
                    boxShadow: lightMode
                      ? "0 0 6px rgba(11, 61, 92, 0.5)"
                      : "0 0 8px rgba(255, 255, 255, 0.8)",
                    transition: "top 0.25s ease-out",
                  }}
                />
              </div>
              {!loading && (
                <span
                  style={{
                    position: "absolute",
                    top: `${markerPercent}%`,
                    right: 0,
                    transform: "translateY(-50%)",
                    fontSize: 9,
                    fontWeight: 700,
                    color: accentColor,
                    background: bg,
                    padding: "1px 4px",
                    borderRadius: 4,
                    border: `1px solid ${borderColor}`,
                    transition: "top 0.25s ease-out",
                    whiteSpace: "nowrap",
                  }}
                >
                  {fmtDepth(actualModelDepth)}m
                </span>
              )}
            </div>
          </div>

          <div
            style={{
              fontSize: 9,
              color: mutedColor,
              marginTop: 6,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>Depth Visualization</span>
            <span>depth (m)</span>
          </div>
          <div style={{ fontSize: 8, color: mutedColor, marginTop: 2, opacity: 0.8 }}>
            Column shading is a visual cue — not measured values at each depth.
          </div>
          {clampedToMax && (
            <div
              style={{
                fontSize: 9,
                marginTop: 4,
                padding: "3px 6px",
                borderRadius: 6,
                border: `1px solid ${borderColor}`,
                color: lightMode ? "#8a5a00" : "#ffd479",
              }}
            >
              Clamped to deepest available model level ({fmtDepth(modelDepthMax)} m)
            </div>
          )}
        </>
      ) : (
        <div
          style={{
            height: 120,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: mutedColor,
            border: `1px solid ${borderColor}`,
            borderRadius: 8,
          }}
        >
          Depth range unavailable
        </div>
      )}

      {/* ---------- Section C — Current depth: requested vs actual ---------- */}
      <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.9 }}>
        <div style={{ fontSize: 9, letterSpacing: "1px", color: mutedColor }}>
          CURRENT DEPTH
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: mutedColor, fontSize: 9, letterSpacing: "1px" }}>
            Requested
          </span>
          <span>
            {fmtRequested(requestedDepth) !== null
              ? `${fmtRequested(requestedDepth)} m`
              : "—"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: mutedColor, fontSize: 9, letterSpacing: "1px" }}>
            Model Level
          </span>
          <span style={{ fontWeight: 700, color: accentColor }}>
            {loading ? "Loading…" : `${fmtDepth(actualModelDepth)} m`}
          </span>
        </div>
      </div>

      {/* ---------- Section C2 — Model information block ---------- */}
      <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.9 }}>
        <div style={{ fontSize: 9, letterSpacing: "1px", color: mutedColor }}>
          MODEL INFORMATION
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: mutedColor, fontSize: 9, letterSpacing: "1px" }}>
            MODEL LEVEL
          </span>
          <span style={{ fontWeight: 700 }}>
            {fmtLevelIndex(modelLevelIndex, modelLevelCount) ?? "—"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: mutedColor, fontSize: 9, letterSpacing: "1px" }}>
            DEPTH
          </span>
          <span>{loading ? "—" : `${fmtDepth(actualModelDepth)} m`}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: mutedColor, fontSize: 9, letterSpacing: "1px" }}>
            VARIABLE
          </span>
          <span>Temperature</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: mutedColor, fontSize: 9, letterSpacing: "1px" }}>
            UNITS
          </span>
          <span>{sliceUnits ?? "—"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: mutedColor, fontSize: 9, letterSpacing: "1px" }}>
            TIMESTAMP
          </span>
          <span>{fmtTimestamp(sliceTimestamp) ?? "—"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: mutedColor, fontSize: 9, letterSpacing: "1px" }}>
            SOURCE
          </span>
          <span>{sliceSource ?? "—"}</span>
        </div>
        {typeof timeStepsAvailable === "number" && (
          <div style={{ fontSize: 8, color: mutedColor, marginTop: 2, opacity: 0.8 }}>
            {timeStepsAvailable === 1
              ? "1 timestep available — no time animation"
              : `${timeStepsAvailable} timesteps available`}
          </div>
        )}
      </div>

      {/* ---------- Section D — Temperature legend (current slice only) ---------- */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 9, letterSpacing: "1px", color: mutedColor, marginBottom: 6 }}>
          TEMPERATURE RANGE
        </div>
        {hasStats ? (
          <>
            <div
              style={{
                height: 8,
                borderRadius: 4,
                background: TEMP_GRADIENT,
                marginBottom: 4,
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 9,
                color: mutedColor,
              }}
            >
              <span>
                {fmtTemp(sliceMinTemp)}
                {unitSuffix} (Min)
              </span>
              <span>
                {fmtTemp(sliceMaxTemp)}
                {unitSuffix} (Max)
              </span>
            </div>
            {fmtTemp(sliceMeanTemp) !== null && (
              <div style={{ fontSize: 9, color: mutedColor, marginTop: 4 }}>
                Mean: {fmtTemp(sliceMeanTemp)}
                {unitSuffix}
              </div>
            )}
            {(fmtCount(sliceValidCount) !== null || fmtCount(sliceMissingCount) !== null) && (
              <div style={{ fontSize: 9, color: mutedColor, marginTop: 4 }}>
                Valid: {fmtCount(sliceValidCount) ?? "—"} • Missing / NaN:{" "}
                {fmtCount(sliceMissingCount) ?? "—"}
              </div>
            )}
          </>
        ) : sliceStatus === "error" ? (
          <div style={{ fontSize: 9, color: errorColor }}>
            Slice data unavailable — the temperature layer was cleared.
            {sliceError && (
              <div style={{ fontSize: 8, marginTop: 2, opacity: 0.85 }}>
                {sliceError}
              </div>
            )}
          </div>
        ) : sliceStatus === "loading" ? (
          <div style={{ fontSize: 9, color: mutedColor }}>Loading slice statistics…</div>
        ) : (
          <div style={{ fontSize: 9, color: mutedColor }}>
            {dataSourceStatus === "demo"
              ? "Demo slice statistics unavailable."
              : "Slice statistics unavailable."}
          </div>
        )}
      </div>

      {/* ---------- Section E — Data status ---------- */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 8,
          borderTop: `1px solid ${borderColor}`,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 9,
          letterSpacing: "0.8px",
        }}
      >
        <span style={{ color: status.color }}>●</span>
        <span style={{ color: mutedColor }}>{status.label}</span>
      </div>
      {status.reason && (
        <div style={{ fontSize: 8, color: mutedColor, marginTop: 4, opacity: 0.85 }}>
          {status.reason}
        </div>
      )}
    </div>
  );
}
