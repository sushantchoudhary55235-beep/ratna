import { useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import ReportAIAssistant from "./ReportAIAssistant";
import {
  demoOceanName,
  demoTimeLabel,
  getReportCenter,
  getReportTemperatureAnalysis,
  getReportSalinityAnalysis,
  getReportCurrentAnalysis,
  getReportChlorophyllAnalysis,
  getReportCoastalObservations,
  getReportRecentObservations,
  getReportMetadata,
} from "../data/demoData";
import "./ReportAnalysis.css";

/* ============================================================
   REPORT ANALYSIS — isolated research view (additive feature)

   Consumes ONLY the existing demo provider (one source of
   truth with the globe). No Cesium code here; graphs are
   lightweight inline SVG so nothing interferes with rendering.

   Later, when the provider is fed real data (NetCDF -> xarray
   -> API), this view follows automatically: it renders whatever
   the adapters return.
============================================================ */

const TABS = [
  { id: "temperature", label: "TEMPERATURE", accent: "#ff9800" },
  { id: "salinity", label: "SALINITY", accent: "#4dd0e1" },
  { id: "currents", label: "CURRENTS", accent: "#7dd3fc" },
  { id: "chlorophyll", label: "CHLOROPHYLL-a", accent: "#7bd88f" },
  { id: "coastal", label: "COASTAL / IN-SITU", accent: "#f6d88a" },
];

const DEMO_BANNER =
  "DEMO DATA — synthetic demonstration values, not scientific observations";

/* ---------- Inline SVG line graph (no chart dependency) ---------- */

function LineGraph({ series, unit, accent, label }) {
  const [hover, setHover] = useState(null);
  if (!series || series.length < 2) return null;

  const W = 680;
  const H = 230;
  const PAD = { l: 56, r: 16, t: 18, b: 36 };

  const values = series.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }
  const span = max - min;
  min -= span * 0.08;
  max += span * 0.08;

  const x = (i) => PAD.l + (i / (series.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);

  const points = series.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${PAD.l},${H - PAD.b} ${points} ${W - PAD.r},${H - PAD.b}`;

  const fmtTime = (ms) => demoTimeLabel(ms).replace(" UTC", "").replace(" 2026", "");
  const fmtVal = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

  return (
    <div className="report-graph">
      <div className="report-graph-title">{label}</div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(
            ((px - PAD.l) / (W - PAD.l - PAD.r)) * (series.length - 1)
          );
          setHover(Math.max(0, Math.min(series.length - 1, i)));
        }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const v = min + f * (max - min);
          return (
            <g key={f}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(v)}
                y2={y(v)}
                stroke="rgba(148,163,184,0.14)"
                strokeWidth="1"
              />
              <text x={PAD.l - 8} y={y(v) + 3} textAnchor="end" className="report-graph-tick">
                {fmtVal(v)}
              </text>
            </g>
          );
        })}

        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const i = Math.round(f * (series.length - 1));
          return (
            <text key={f} x={x(i)} y={H - PAD.b + 16} textAnchor="middle" className="report-graph-tick">
              {fmtTime(series[i].time)}
            </text>
          );
        })}

        <polygon points={area} fill={accent} opacity="0.08" />
        <polyline points={points} fill="none" stroke={accent} strokeWidth="1.8" />

        {hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke={accent}
              strokeWidth="1"
              opacity="0.4"
            />
            <circle cx={x(hover)} cy={y(series[hover].value)} r="3.4" fill={accent} />
            <text
              x={Math.min(Math.max(x(hover), PAD.l + 40), W - PAD.r - 40)}
              y={PAD.t + 2}
              textAnchor="middle"
              className="report-graph-hover"
            >
              {`${fmtVal(series[hover].value)} ${unit} · ${fmtTime(series[hover].time)}`}
            </text>
          </g>
        )}
      </svg>
      <div className="report-graph-caption">
        {label} — demo model timeline, 6-hour steps · hover for values
      </div>
    </div>
  );
}

/* ---------- Depth-profile graph (temperature demo decay) ---------- */

function DepthGraph({ profile, unit, accent }) {
  if (!profile || profile.length < 2) return null;

  const W = 680;
  const H = 230;
  const PAD = { l: 56, r: 16, t: 18, b: 36 };

  const values = profile.map((p) => p.value);
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const pad = (vMax - vMin) * 0.08 || 0.5;
  const lo = vMin - pad;
  const hi = vMax + pad;

  const x = (v) => PAD.l + ((v - lo) / (hi - lo)) * (W - PAD.l - PAD.r);
  const y = (d) => PAD.t + (d / 2000) * (H - PAD.t - PAD.b);

  const points = profile.map((p) => `${x(p.value).toFixed(1)},${y(p.depth).toFixed(1)}`).join(" ");

  return (
    <div className="report-graph">
      <div className="report-graph-title">TEMPERATURE vs DEPTH</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Temperature vs depth">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const v = lo + f * (hi - lo);
          return (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(2000 * f)} y2={y(2000 * f)} stroke="rgba(148,163,184,0.14)" />
              <text x={PAD.l - 8} y={y(2000 * f) + 3} textAnchor="end" className="report-graph-tick">
                {v.toFixed(1)}
              </text>
            </g>
          );
        })}
        {[0, 500, 1000, 1500, 2000].map((d) => (
          <text key={d} x={W - PAD.r + 4} y={y(d) + 3} className="report-graph-tick">
            {`${d} m`}
          </text>
        ))}
        <polyline points={points} fill="none" stroke={accent} strokeWidth="1.8" />
      </svg>
      <div className="report-graph-caption">Demo temperature decay with depth · surface to 2000 m</div>
    </div>
  );
}

/* ---------- Small building blocks ---------- */

function StatRow({ label, value }) {
  return (
    <div className="report-stat-row">
      <span className="report-stat-label">{label}</span>
      <span className="report-stat-value">{value}</span>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="report-panel">
      <h2 className="report-panel-title">{title}</h2>
      {children}
    </section>
  );
}

/* ============================================================ */

export default function ReportAnalysis({
  onBack,
  cameraLocation,
  playbackEpoch,
  depth = 0,
  lightMode = false,
}) {
  /* Location + snapshot time, resolved against the demo model. */
  const center = useMemo(() => getReportCenter(cameraLocation), [cameraLocation]);

  const snapshot = useMemo(() => {
    if (playbackEpoch) return playbackEpoch;
    return null;
  }, [playbackEpoch]);

  const temp = useMemo(
    () => getReportTemperatureAnalysis(center.latitude, center.longitude, depth),
    [center.latitude, center.longitude, depth]
  );
  const sal = useMemo(
    () => getReportSalinityAnalysis(center.latitude, center.longitude),
    [center.latitude, center.longitude]
  );
  const curr = useMemo(
    () => getReportCurrentAnalysis(center.latitude, center.longitude, depth),
    [center.latitude, center.longitude, depth]
  );
  const chl = useMemo(
    () => getReportChlorophyllAnalysis(center.latitude, center.longitude),
    [center.latitude, center.longitude]
  );
  const coastal = useMemo(() => getReportCoastalObservations(snapshot), [snapshot]);
  const recent = useMemo(
    () => getReportRecentObservations(center.latitude, center.longitude),
    [center.latitude, center.longitude]
  );
  const metadata = useMemo(() => getReportMetadata(), []);

  const [activeTab, setActiveTab] = useState("temperature");
  const [focus, setFocus] = useState(null); /* recent-obs row → hero card */
  const [showAIAssistant, setShowAIAssistant] = useState(false);

  const region = demoOceanName(center.latitude, center.longitude);
  const timeLabel = demoTimeLabel(snapshot ?? temp.series[temp.series.length - 1].time);
  const depthLabel = depth > 0 ? `${depth} m` : "Surface (0–10 m)";

  const accent = TABS.find((t) => t.id === activeTab)?.accent || "#7dd3fc";
  const dark = !lightMode;

  /* ---------- PDF download (demo-labelled research summary) ---------- */

  const handleDownloadPdf = () => {
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    let y = 54;

    const ensure = (h) => {
      if (y + h > H - 48) {
        doc.addPage();
        y = 54;
      }
    };
    const text = (s, size = 10, style = "normal", color = [40, 55, 71], x = 48) => {
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(color[0], color[1], color[2]);
      doc.text(String(s), x, y);
    };
    const heading = (s) => {
      ensure(26);
      y += 10;
      text(s, 12.5, "bold", [7, 94, 108]);
      y += 8;
      doc.setDrawColor(7, 94, 108);
      doc.line(48, y, W - 48, y);
      y += 12;
    };
    const kv = (k, v) => {
      ensure(16);
      text(k, 9.5, "bold", [100, 116, 139]);
      text(v, 9.5, "normal", [40, 55, 71], 190);
      y += 15;
    };

    /* Header */
    doc.setFillColor(2, 11, 20);
    doc.rect(0, 0, W, 86, "F");
    y = 40;
    text("RATNAKARA", 22, "bold", [247, 241, 228]);
    y += 20;
    text("OCEAN REPORT - RATNAKARA DEMONSTRATION REPORT (DEMO DATA)", 9, "normal", [125, 211, 252]);
    y = 112;

    kv("Region", region);
    kv("Location", `${center.latitude.toFixed(2)} N, ${center.longitude.toFixed(2)} E`);
    kv("Date / time", timeLabel);
    kv("Depth", depthLabel);

    heading("Data Summary");
    kv("Temperature", `${temp.current.toFixed(2)} °C`);
    kv("Salinity", `${sal.current.toFixed(2)} PSU`);
    kv("Current", `${curr.current.speed.toFixed(2)} m/s`);
    kv("Chlorophyll-a", `${chl.current.toFixed(2)} mg/m3`);

    heading("Variable Analysis");
    kv("Temperature min / max / mean", `${temp.min} / ${temp.max} / ${temp.mean} °C (trend ${temp.trend})`);
    kv("Salinity min / max / mean", `${sal.min} / ${sal.max} / ${sal.mean} PSU`);
    kv("Current speed min / max / mean", `${curr.min} / ${curr.max} / ${curr.mean} m/s`);
    kv("Current U / V mean", `${curr.uMean} / ${curr.vMean} m/s`);
    kv("Chlorophyll-a min / max / mean", `${chl.min} / ${chl.max} / ${chl.mean} mg/m3`);

    heading("Recent Observations (first 8)");
    for (const r of recent.slice(0, 8)) {
      ensure(15);
      text(`${r.time}`, 8.5, "bold", [100, 116, 139]);
      text(`${r.variable}`, 8.5, "normal", [40, 55, 71], 150);
      text(`${r.value}`, 8.5, "normal", [40, 55, 71], 230);
      text(`${r.source}`, 8.5, "normal", [100, 116, 139], 320);
      y += 13;
    }

    heading("Data Source / Metadata");
    kv("Source", metadata.source);
    kv("Dataset", metadata.dataset);
    kv("Processing", metadata.processing);
    kv("Quality", metadata.quality);

    y += 8;
    ensure(30);
    text(
      "Demonstration output generated from the Ratnakara demo dataset. Not a scientifically validated research report.",
      8,
      "italic",
      [120, 130, 140]
    );

    doc.save("ratnakara-demo-report.pdf");
  };

  /* ---------- CSV download (coastal observation table) ---------- */

  const handleDownloadCsv = () => {
    const rows = [
      ["Station", "Variable", "Value", "Unit", "Latitude", "Longitude", "Depth", "Source", "Quality"],
      ...coastal.map((o) => [
        o.station,
        o.variable,
        o.value,
        o.unit,
        o.latitude,
        o.longitude,
        o.depth,
        o.source,
        o.quality,
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "ratnakara-demo-observations.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ============================================================ */

  return (
    <div className={`report-root ${dark ? "report-dark" : "report-light"}`}>
      {/* ---------------- TOP BAR ---------------- */}
      <header className="report-topbar">
        <button type="button" className="report-back" onClick={onBack}>
          ← BACK TO OCEAN GLOBE
        </button>

        <div className="report-title-block">
          <h1>REPORT ANALYSIS</h1>
          <p>
            {region} · {center.latitude.toFixed(2)}°N {center.longitude.toFixed(2)}°E · {timeLabel}
          </p>
        </div>

        <div className="report-topbar-meta">
          <span className="report-demo-chip">DEMO DATA</span>
        </div>
      </header>

      <main className="report-main">
        {/* ---------------- SECTION 1 — DATA SUMMARY ---------------- */}
        <Panel title="DATA SUMMARY">
          <div className="report-cards">
            {[
              { label: "TEMPERATURE", value: `${focus?.temperature ?? temp.current.toFixed(1)} °C`, accent: "#ff9800", sub: `mean ${temp.mean} °C` },
              { label: "SALINITY", value: `${focus?.salinity ?? sal.current.toFixed(1)} PSU`, accent: "#4dd0e1", sub: `mean ${sal.mean} PSU` },
              { label: "CURRENT", value: `${(focus?.current ?? curr.current.speed).toFixed(2)} m/s`, accent: "#7dd3fc", sub: `mean ${curr.mean} m/s` },
              { label: "CHLOROPHYLL-a", value: `${focus?.chlorophyll ?? chl.current.toFixed(2)} mg/m³`, accent: "#7bd88f", sub: `mean ${chl.mean} mg/m³` },
            ].map((card) => (
              <div key={card.label} className="report-card" style={{ borderColor: `${card.accent}55` }}>
                <div className="report-card-label" style={{ color: card.accent }}>
                  {card.label}
                </div>
                <div className="report-card-value">{card.value}</div>
                <div className="report-card-sub">{card.sub}</div>
              </div>
            ))}
          </div>
          {focus && (
            <div className="report-focus-note">
              Showing values for recent observation at {focus.latitude?.toFixed?.(2)}°N{" "}
              {focus.longitude?.toFixed?.(2)}°E ·{" "}
              <button type="button" className="report-link" onClick={() => setFocus(null)}>
                reset to report center
              </button>
            </div>
          )}
        </Panel>

        {/* ---------------- SECTION 2 — OBSERVATION SUMMARY ---------------- */}
        <Panel title="OBSERVATION SUMMARY">
          <div className="report-summary-grid">
            <StatRow label="Data points" value={temp.observationCount + sal.observationCount + curr.observationCount} />
            <StatRow label="In-situ observations" value={`${coastal.length} (demo stations × 3 variables)`} />
            <StatRow label="Satellite observations" value="Demo model field (not satellite)" />
            <StatRow label="Coverage" value="Arabian Sea · Bay of Bengal · Indian Ocean (demo box 48–98°E, 28°S–26°N)" />
            <StatRow label="Latest update" value={timeLabel} />
            <StatRow label="Depth" value={depthLabel} />
            <StatRow label="Spatial resolution" value={metadata.spatialResolution} />
            <StatRow label="Temporal resolution" value={metadata.temporalResolution} />
          </div>
        </Panel>

        {/* ---------------- SECTION 3 — VARIABLE ANALYSIS ---------------- */}
        <Panel title="VARIABLE ANALYSIS">
          <div className="report-tabs" role="tablist" aria-label="Report variable analysis">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={activeTab === t.id}
                className={`report-tab ${activeTab === t.id ? "active" : ""}`}
                style={activeTab === t.id ? { borderColor: t.accent, color: t.accent } : undefined}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="report-tab-body">
            {activeTab === "temperature" && (
              <>
                <div className="report-stats-2col">
                  <div>
                    <StatRow label="Current value" value={`${temp.current.toFixed(2)} °C`} />
                    <StatRow label="Minimum" value={`${temp.min} °C`} />
                    <StatRow label="Maximum" value={`${temp.max} °C`} />
                    <StatRow label="Mean" value={`${temp.mean} °C`} />
                  </div>
                  <div>
                    <StatRow label="Trend (demo cycle)" value={`${temp.trend} °C`} />
                    <StatRow label="Depth" value={depthLabel} />
                    <StatRow label="Timestamp" value={timeLabel} />
                    <StatRow label="Source" value="RATNAKARA DEMO DATA" />
                  </div>
                </div>
                <LineGraph
                  series={temp.series}
                  unit="°C"
                  accent="#ff9800"
                  label="TEMPERATURE vs TIME"
                />
                <DepthGraph profile={temp.profile} unit="°C" accent="#ff9800" />
              </>
            )}

            {activeTab === "salinity" && (
              <>
                <div className="report-stats-2col">
                  <div>
                    <StatRow label="Current value" value={`${sal.current.toFixed(2)} PSU`} />
                    <StatRow label="Minimum" value={`${sal.min} PSU`} />
                    <StatRow label="Maximum" value={`${sal.max} PSU`} />
                    <StatRow label="Mean" value={`${sal.mean} PSU`} />
                  </div>
                  <div>
                    <StatRow label="Observation count" value={sal.observationCount} />
                    <StatRow label="Depth" value={depthLabel} />
                    <StatRow label="Timestamp" value={timeLabel} />
                    <StatRow label="Source" value="RATNAKARA DEMO DATA" />
                  </div>
                </div>
                <LineGraph
                  series={sal.series}
                  unit="PSU"
                  accent="#4dd0e1"
                  label="SALINITY vs TIME"
                />
                <div className="report-subtable">
                  <div className="report-subtable-title">NEAREST SALINITY OBSERVATIONS (demo)</div>
                  <table>
                    <thead>
                      <tr>
                        <th>Ocean / Region</th>
                        <th>Latitude</th>
                        <th>Longitude</th>
                        <th>Value</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sal.observations.map((o, i) => (
                        <tr key={i}>
                          <td>{o.oceanLabel}</td>
                          <td>{o.latitude.toFixed(2)}°</td>
                          <td>{o.longitude.toFixed(2)}°</td>
                          <td>{o.value.toFixed(2)} PSU</td>
                          <td>{timeLabel}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {activeTab === "currents" && (
              <>
                <div className="report-stats-2col">
                  <div>
                    <StatRow label="Speed" value={`${curr.current.speed.toFixed(2)} m/s`} />
                    <StatRow
                      label="Direction"
                      value={`${((curr.current.direction * 180) / Math.PI).toFixed(0)}° (from east, math convention)`}
                    />
                    <StatRow label="U component" value={`${curr.current.u.toFixed(2)} m/s`} />
                    <StatRow label="V component" value={`${curr.current.v.toFixed(2)} m/s`} />
                  </div>
                  <div>
                    <StatRow label="Speed min / max / mean" value={`${curr.min} / ${curr.max} / ${curr.mean} m/s`} />
                    <StatRow label="U mean" value={`${curr.uMean} m/s`} />
                    <StatRow label="V mean" value={`${curr.vMean} m/s`} />
                    <StatRow label="Depth / Timestamp / Source" value={`${depthLabel} · ${timeLabel} · Demo`} />
                  </div>
                </div>
                <LineGraph
                  series={curr.series.map((p) => ({ time: p.time, value: p.value.speed }))}
                  unit="m/s"
                  accent="#7dd3fc"
                  label="CURRENT SPEED vs TIME"
                />
                <div className="report-uvgap" />
                <LineGraph
                  series={curr.series.map((p) => ({ time: p.time, value: p.value.u }))}
                  unit="m/s"
                  accent="#bfefff"
                  label="U COMPONENT (east-west) vs TIME"
                />
              </>
            )}

            {activeTab === "chlorophyll" && (
              <>
                <div className="report-stats-2col">
                  <div>
                    <StatRow label="Current value" value={`${chl.current.toFixed(2)} mg/m³`} />
                    <StatRow label="Minimum" value={`${chl.min} mg/m³`} />
                    <StatRow label="Maximum" value={`${chl.max} mg/m³`} />
                    <StatRow label="Mean" value={`${chl.mean} mg/m³`} />
                  </div>
                  <div>
                    <StatRow label="Trend (demo cycle)" value={`${chl.trend} mg/m³`} />
                    <StatRow label="Observation type" value="Demo model field (not satellite)" />
                    <StatRow label="Timestamp" value={timeLabel} />
                    <StatRow label="Source" value="RATNAKARA DEMO DATA" />
                  </div>
                </div>
                <LineGraph
                  series={chl.series}
                  unit="mg/m³"
                  accent="#7bd88f"
                  label="CHLOROPHYLL-a vs TIME"
                />
              </>
            )}

            {activeTab === "coastal" && (
              <div className="report-subtable report-subtable--wide">
                <div className="report-subtable-title">
                  COASTAL / IN-SITU OBSERVATIONS (DEMO — structure ready for real stations)
                </div>
                <div className="report-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Station</th>
                        <th>Variable</th>
                        <th>Value</th>
                        <th>Unit</th>
                        <th>Latitude</th>
                        <th>Longitude</th>
                        <th>Depth</th>
                        <th>Time</th>
                        <th>Source</th>
                        <th>Quality</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coastal.map((o, i) => (
                        <tr key={i}>
                          <td>{o.station}</td>
                          <td>{o.variable}</td>
                          <td>{typeof o.value === "number" ? o.value.toFixed(2) : o.value}</td>
                          <td>{o.unit}</td>
                          <td>{o.latitude.toFixed(3)}</td>
                          <td>{o.longitude.toFixed(3)}</td>
                          <td>{o.depth}</td>
                          <td>{timeLabel}</td>
                          <td>{o.source}</td>
                          <td>{o.quality}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </Panel>

        {/* ---------------- RECENT OBSERVATIONS ---------------- */}
        <Panel title="RECENT OBSERVATIONS">
          <div className="report-table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Region</th>
                  <th>Variable</th>
                  <th>Value</th>
                  <th>Source</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i}>
                    <td>{r.time}</td>
                    <td>{r.region}</td>
                    <td>{r.variable}</td>
                    <td>{r.value}</td>
                    <td>{r.source}</td>
                    <td>
                      <button
                        type="button"
                        className="report-link"
                        onClick={() =>
                          setFocus({
                            temperature: r.variable === "Temperature" ? parseFloat(r.value) : undefined,
                            salinity: r.variable === "Salinity" ? parseFloat(r.value) : undefined,
                            chlorophyll: r.variable === "Chlorophyll-a" ? parseFloat(r.value) : undefined,
                            current: undefined,
                            latitude: r.latitude,
                            longitude: r.longitude,
                          })
                        }
                      >
                        Highlight
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="report-focus-note">
            Full in-globe focus ("VIEW ON GLOBE") is intentionally not wired to the camera system in this
            version — it will use the existing location flight mechanism in a later pass.
          </div>
        </Panel>

        {/* ---------------- METADATA ---------------- */}
        <Panel title="DATA SOURCE / METADATA">
          <div className="report-summary-grid">
            <StatRow label="Source" value={metadata.source} />
            <StatRow label="Dataset" value={metadata.dataset} />
            <StatRow label="Processing" value={metadata.processing} />
            <StatRow label="Spatial resolution" value={metadata.spatialResolution} />
            <StatRow label="Temporal resolution" value={metadata.temporalResolution} />
            <StatRow label="Depth" value={metadata.depthLevels} />
            <StatRow label="Last updated" value={metadata.lastUpdated} />
            <StatRow label="Quality" value={metadata.quality} />
          </div>
          <div className="report-demo-banner">{DEMO_BANNER}</div>
        </Panel>

        {/* ---------------- DOWNLOADS ---------------- */}
        <div className="report-download-row">
          <button type="button" className="report-download-btn" onClick={handleDownloadPdf}>
            ⬇ DOWNLOAD REPORT (PDF — Research Summary)
          </button>
          <button type="button" className="report-download-btn report-download-btn--ghost" onClick={handleDownloadCsv}>
            ⬇ CSV — Observations
          </button>
          <button
            type="button"
            className="report-download-btn"
            onClick={() => setShowAIAssistant(true)}
          >
            🤖 AI Assistant
          </button>
        </div>

        {/* ---------------- AI ASSISTANT (additive) ---------------- */}
        {showAIAssistant && (
          <ReportAIAssistant
            report={{
              title: "RATNAKARA Ocean Report",
              region,
              location: `${center.latitude.toFixed(2)}°N ${center.longitude.toFixed(2)}°E`,
              analysisDate: timeLabel,
              depthLabel,
              dataSource: metadata.source,
              temp,
              sal,
              curr,
              chl,
              center,
            }}
            lightMode={lightMode}
            onClose={() => setShowAIAssistant(false)}
          />
        )}

        <div className="report-footer-note">
          RATNAKARA DEMONSTRATION REPORT — generated from the demo dataset shown on the globe. Not a
          scientifically validated research product.
        </div>
      </main>
    </div>
  );
}
