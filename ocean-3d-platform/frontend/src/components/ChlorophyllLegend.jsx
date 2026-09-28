/* ============================================================
   CHLOROPHYLL LEGEND (Part 13.5)

   The chlorophyll layer previously had no legend. Chlorophyll-a's
   real-world distribution is strongly right-skewed, so the shared
   CHLOROPHYLL_COLOR_STOPS palette in demoData.js follows the
   oceanographic convention of quasi-logarithmic stop spacing
   (0.05 → 0.3 → 0.8 → 2 → 5 → 9 mg/m³): equal visual steps
   represent equal *multiplicative* steps in biomass. That is why
   the temperature ramp is NOT reused (Part 8.3).

   Mirrors TemperatureLegend.jsx (same layout, light/dark colors).
============================================================ */

const CHL_STOPS = [
  { value: "0.05", color: "#0b3d4d" },
  { value: "0.3", color: "#0e6b6b" },
  { value: "0.8", color: "#2e9e5b" },
  { value: "2", color: "#8fd14f" },
  { value: "5", color: "#d9e021" },
  { value: "9", color: "#f0f921" },
];

export default function ChlorophyllLegend({ visible = true, lightMode = false }) {
  if (!visible) return null;

  const mutedColor = lightMode ? "#63818b" : "#94a3b8";
  const bg = lightMode ? "rgba(248, 253, 255, 0.88)" : "rgba(10, 18, 32, 0.88)";
  const borderColor = lightMode
    ? "rgba(22, 135, 201, 0.15)"
    : "rgba(148, 163, 184, 0.12)";

  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: 24,
        right: "auto",
        padding: "10px 14px",
        background: bg,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        boxShadow: "0 4px 14px rgba(0,0,0,0.16)",
        zIndex: 70,
        fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
        minWidth: 200,
      }}
    >
      <div
        style={{
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: "1.2px",
          color: mutedColor,
          marginBottom: 8,
        }}
      >
        CHLOROPHYLL — mg/m³ (log-style scale)
      </div>

      <div
        style={{
          width: "100%",
          height: 8,
          borderRadius: 4,
          background: `linear-gradient(to right, ${CHL_STOPS.map(
            (s) => s.color
          ).join(", ")})`,
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
        {CHL_STOPS.map((s) => (
          <span key={s.value} style={{ whiteSpace: "nowrap" }}>
            {s.value}
          </span>
        ))}
      </div>

      {/* Honest data-source line (Part 9.2): chlorophyll currently has
          no real-data pipeline against the local model dataset. */}
      <div
        style={{
          marginTop: 6,
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: "0.8px",
          color: lightMode ? "#8a5a00" : "#ffd479",
        }}
      >
        DEMO DATA — representative values
      </div>
    </div>
  );
}
