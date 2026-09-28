/* ============================================================
   TEMPERATURE LEGEND

   Scientific cold→warm gradient bar — the SAME temperatureColormap
   ramp as the Temperature — 3D Depth Slice (see
   rendering/waterColumn/waterColumnTextures.js).

   Labels come from the real slice value range when provided
   (statistics.min/max of the displayed slice); otherwise the
   stable fixed scientific scale. No fabricated values.

   Positioned bottom-right, below the depth-slice lane; does not
   cover controls.
============================================================ */

/* SAME control points as temperatureColormap() in
   rendering/waterColumn/waterColumnTextures.js — keep in sync.
   Scientific cold→warm ramp shared with the 3D Depth Slice:
   one source of truth, no second temperature scale. */
const TEMPERATURE_COLOR_STOPS = [
  "#313695",
  "#4575b4",
  "#74add1",
  "#abd9e9",
  "#e0f3f8",
  "#ffffbf",
  "#fee090",
  "#fdae61",
  "#f46d43",
  "#d73027",
  "#a50026", /* hottest */
];


const SLIDER_LANE_RIGHT = 272; /* depth panel right:16 + width:264 */

/* Stable fallback scale (°C) used only when the current slice's
   real statistics are unavailable — never fabricated per-render. */
const FALLBACK_MIN = -2;
const FALLBACK_MAX = 34;

function formatTemp(value) {
  return `${Math.round(value)}°`;
}

export default function TemperatureLegend({ visible = true, lightMode = false, minValue = null, maxValue = null, raised = false }) {
  if (!visible) return null;

  const mutedColor = lightMode ? "#63818b" : "#94a3b8";
  const bg = lightMode
    ? "rgba(248, 253, 255, 0.88)"
    : "rgba(10, 18, 32, 0.88)";
  const borderColor = lightMode
    ? "rgba(22, 135, 201, 0.15)"
    : "rgba(148, 163, 184, 0.12)";

  /* Real slice range when the current slice provides finite
     statistics; otherwise the stable fixed scientific scale. */
  const useRealRange = Number.isFinite(minValue) && Number.isFinite(maxValue) && maxValue > minValue;
  const rangeMin = useRealRange ? minValue : FALLBACK_MIN;
  const rangeMax = useRealRange ? maxValue : FALLBACK_MAX;
  const tickValues = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    Math.round(rangeMin + f * (rangeMax - rangeMin))
  );
  const ticks = [...new Set(tickValues)];

  return (
    <div
      style={{
        position: "fixed",
        /* BOTTOM-RIGHT: below the Temperature — 3D Depth Slice lane
           (right:16 + 264px wide, zIndex 55). zIndex 40 keeps the
           depth panel on top; bottom-center DataLayerFilter (z 25)
           and the bottom-left CurrentLegend (z 25) are unaffected. */
        bottom: 24,
        right: raised ? 24 : SLIDER_LANE_RIGHT,
        left: "auto",
        padding: "10px 14px",
        background: bg,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        boxShadow: "0 4px 14px rgba(0,0,0,0.16)",
        zIndex: 40,
        fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
        minWidth: 220,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: "1.2px",
            color: mutedColor,
          }}
        >
          TEMPERATURE
        </span>
        <span
          style={{
            fontSize: 7,
            fontWeight: 600,
            letterSpacing: "0.8px",
            color: mutedColor,
          }}
        >
          <span style={{ color: TEMPERATURE_COLOR_STOPS[0] }}>■</span> COLD
          &nbsp;·&nbsp; WARM{" "}
          <span style={{ color: TEMPERATURE_COLOR_STOPS[10] }}>■</span>
        </span>
      </div>

      <div
        style={{
          width: "100%",
          height: 8,
          borderRadius: 4,
          background: `linear-gradient(to right, ${TEMPERATURE_COLOR_STOPS.join(", ")})`,
          marginBottom: 4,
        }}
      />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 8,
          color: mutedColor,
        }}
      >
        {ticks.map((value, index) => (
          <span
            key={`${value}-${index}`}
            style={{
              whiteSpace: "nowrap",
              fontWeight: index === 0 || index === ticks.length - 1 ? 700 : 500,
            }}
          >
            {formatTemp(value)}C
          </span>
        ))}
      </div>
    </div>
  );
}