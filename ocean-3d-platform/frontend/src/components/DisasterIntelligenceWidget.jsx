import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IMD_ENDPOINT_SLUGS,
  IMD_REASON_LABELS,
  fetchImdEndpoint,
} from "../services/imdApi";

/* ============================================================
   DISASTER INTELLIGENCE WIDGET (additive IMD layer)

   Bottom-right compact card, expands on click. Every tab loads
   its data independently through the RATNAKARA IMD proxy — one
   endpoint failing never blocks the others.

   NO fabricated content: each tab renders only fields actually
   present in the (envelope.data) payload. When IMD is
   unavailable the tab shows the honest reason — never demo data.
============================================================ */

const TABS = [
  { id: "cyclone", label: "CYCLONE", items: ["cyclone_track", "cyclone_wind", "cyclone_cou"] },
  { id: "marine", label: "MARINE", items: ["sea_bulletin"] },
  { id: "coastal", label: "COASTAL", items: ["coastal_bulletin"] },
  { id: "ports", label: "PORTS", items: ["port_warning"] },
];

const TAB_ITEMS = {
  cyclone_track: "Cyclone Track",
  cyclone_wind: "Wind Warning",
  cyclone_cou: "Uncertainty Cone",
  sea_bulletin: "Sea Area Bulletin",
  coastal_bulletin: "Coastal Bulletin",
  port_warning: "Port Warning",
};

function useImdDataset(endpointKey, enabled, onLoaded) {
  const [state, setState] = useState({ status: "idle", envelope: null });
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchImdEndpoint(IMD_ENDPOINT_SLUGS[endpointKey])
      .then((envelope) => {
        if (!cancelled) {
          setState({ status: "loaded", envelope });
          onLoadedRef.current?.(endpointKey, envelope);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const envelope = {
            status: "unavailable",
            endpoint: endpointKey,
            reason: "upstream_error",
            detail: String(err?.message || err),
          };
          setState({ status: "loaded", envelope });
          onLoadedRef.current?.(endpointKey, envelope);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpointKey, enabled]);

  /* A missing envelope while enabled means the fetch is still in flight —
     the card renders its LOADING state from this derived value. */
  const loading = enabled && status === "idle";
  return { ...state, status: loading ? "loading" : status };
}

function formatTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(parsed.getUTCDate())}/${pad(parsed.getUTCMonth() + 1)}/${parsed.getUTCFullYear()} ${pad(
    parsed.getUTCHours()
  )}:${pad(parsed.getUTCMinutes())} UTC`;
}

/* Record rendering is intentionally generic: IMD success field names are
   TODO(VERIFY) until real credentials produce a real response, so the card
   lists whatever fields the payload actually contains (§4.2 — no invented
   field references anywhere in the UI). */

/* ------------------------------------------------------------
   Item card: honest states per IMD dataset
------------------------------------------------------------ */

function ImdItemCard({ endpointKey, expanded, onLoaded }) {
  const { status, envelope } = useImdDataset(endpointKey, expanded, onLoaded);
  const [open, setOpen] = useState(false);

  if (status === "idle") {
    return (
      <div style={{ fontSize: 10, color: "#94a3b8", padding: "4px 0" }}>
        {TAB_ITEMS[endpointKey]} — not loaded (widget collapsed)
      </div>
    );
  }
  if (status === "loading" || !envelope) {
    return (
      <div style={{ fontSize: 10, color: "#7dd3fc", padding: "4px 0" }}>
        ● LOADING — {TAB_ITEMS[endpointKey]}…
      </div>
    );
  }

  if (envelope.status === "unavailable") {
    const isNoData = envelope.reason === "no_active_data";
    return (
      <div
        style={{
          padding: "6px 8px",
          borderRadius: 6,
          border: `1px solid ${isNoData ? "rgba(148,163,184,0.25)" : "rgba(248,113,113,0.35)"}`,
          margin: "4px 0",
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 700, color: isNoData ? "#94a3b8" : "#f87171" }}>
          {isNoData ? "NO ACTIVE DATA" : "IMD DATA UNAVAILABLE"}
        </div>
        <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>
          {isNoData
            ? `${TAB_ITEMS[endpointKey]}: nothing active from IMD right now.`
            : `Unable to retrieve the official IMD source. Reason: ${
                IMD_REASON_LABELS[envelope.reason] || envelope.reason
              }`}
        </div>
        {envelope.last_successful_fetch && (
          <div style={{ fontSize: 8, color: "#94a3b8", opacity: 0.8, marginTop: 2 }}>
            Last successful update: {formatTimestamp(envelope.last_successful_fetch)}
          </div>
        )}
      </div>
    );
  }

  /* status === "ok" — render only fields actually present. */
  const data = envelope.data;
  const records = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? [data]
      : [];

  const isEmpty =
    records.length === 0 ||
    records.every((r) => r === null || (typeof r === "object" && Object.keys(r).length === 0));

  return (
    <div style={{ margin: "4px 0" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          background: "rgba(148,163,184,0.08)",
          border: "1px solid rgba(148,163,184,0.18)",
          borderRadius: 6,
          color: "#e2e8f0",
          padding: "6px 8px",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 700, color: "#7ef0b1" }}>
          ● REAL DATA — {TAB_ITEMS[endpointKey]}
        </div>
        <div style={{ fontSize: 8, color: "#94a3b8", marginTop: 2 }}>
          {isEmpty ? "IMD returned no active records" : `${records.length} record(s) from IMD`}
        </div>
      </button>

      {open && !isEmpty && (
        <div style={{ marginTop: 4 }}>
          {records.map((record, i) => (
            <ImdRecordView key={i} record={record} index={i} />
          ))}
        </div>
      )}

      <div style={{ fontSize: 8, color: "#94a3b8", marginTop: 4 }}>
        Source: India Meteorological Department (IMD)
        {envelope.updated_at && ` — Retrieved: ${formatTimestamp(envelope.updated_at)}`}
        {envelope.cache_hit && " (cached)"}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   Generic record renderer — key/value rows for fields the
   response actually contains. No anticipated-but-absent rows.
------------------------------------------------------------ */

function ImdRecordView({ record, index }) {
  const rows = useMemo(() => {
    if (record === null || typeof record !== "object") return [];
    return Object.entries(record).slice(0, 12);
  }, [record]);

  if (rows.length === 0) return null;

  return (
    <div
      style={{
        background: "rgba(10,18,32,0.6)",
        border: "1px solid rgba(148,163,184,0.14)",
        borderRadius: 6,
        padding: "6px 8px",
        marginBottom: 4,
      }}
    >
      {rows.length > 1 && (
        <div style={{ fontSize: 8, color: "#7dd3fc", marginBottom: 3 }}>Record {index + 1}</div>
      )}
      {rows.map(([key, value]) => (
        <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 8.5, color: "#94a3b8" }}>{key}</span>
          <span style={{ fontSize: 8.5, color: "#e2e8f0", textAlign: "right", wordBreak: "break-all" }}>
            {value === null || value === undefined
              ? "—"
              : typeof value === "object"
                ? `[${Array.isArray(value) ? `array ${value.length}` : "object"}]`
                : String(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   Main widget
============================================================ */

export default function DisasterIntelligenceWidget({
  lightMode = false,
  reportOpen = false,
  /* Part 10: horizontal clearance for the depth panel. Derived in App.jsx
     from the panel's MEASURED width (ResizeObserver) + a fixed gap, so the
     widget stays clear of the panel whatever its actual rendered size is.
     0 = panel closed -> widget sits at its normal bottom-right spot. */
  depthPanelOffset = 0,
}) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState("cyclone");

  /* Active-layer count is computed from real tab data state (never a
     hard-coded number). Until a tab loads, it contributes nothing. */
  const [loadedStates, setLoadedStates] = useState({});
  const handleLoaded = useCallback((endpointKey, envelope) => {
    setLoadedStates((prev) => ({ ...prev, [endpointKey]: envelope }));
  }, []);

  const activeLayers = useMemo(
    () =>
      Object.values(loadedStates).filter(
        (envelope) => envelope && envelope.status === "ok"
      ).length,
    [loadedStates]
  );

  if (reportOpen) return null;

  const bg = lightMode ? "rgba(248,253,255,0.96)" : "rgba(10,18,32,0.96)";
  const textColor = lightMode ? "#163743" : "#e2e8f0";
  const mutedColor = lightMode ? "#63818b" : "#94a3b8";
  const borderColor = lightMode ? "rgba(22,135,201,0.20)" : "rgba(148,163,184,0.18)";
  const accentColor = lightMode ? "#087e8b" : "#7dd3fc";

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        /* Part 10: shift LEFT by the depth panel's measured width (+gap)
          whenever the panel is open; animated so it never jumps. */
        right: 16 + depthPanelOffset,
        transition: "right 0.3s ease-out",
        width: expanded ? 320 : 250,
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "70vh",
        overflowY: "auto",
        background: bg,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
        padding: "12px 14px",
        zIndex: 25 /* below the existing WarningCard (z 30) so transient alerts stay visible */,
        fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
        color: textColor,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          color: "inherit",
          textAlign: "left",
          cursor: "pointer",
          padding: 0,
          fontFamily: "inherit",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.6px" }}>
          🚨 DISASTER INTELLIGENCE
        </div>
        {!expanded && (
          <>
            <div style={{ fontSize: 9, color: mutedColor, marginTop: 4 }}>
              IMD • Marine Monitoring
            </div>
            <div style={{ fontSize: 9, color: accentColor, marginTop: 2 }}>
              {activeLayers} Active Information Layer{activeLayers === 1 ? "" : "s"}
            </div>
          </>
        )}
      </button>

      {expanded && (
        <>
          <div style={{ display: "flex", gap: 4, margin: "10px 0 8px", flexWrap: "wrap" }}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flex: "1 1 auto",
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.5px",
                  padding: "5px 6px",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  background: activeTab === tab.id ? accentColor : "transparent",
                  color: activeTab === tab.id ? (lightMode ? "#ffffff" : "#04101e") : mutedColor,
                  border: `1px solid ${activeTab === tab.id ? accentColor : borderColor}`,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {TABS.filter((t) => t.id === activeTab).map((tab) => (
            <div key={tab.id}>
              {tab.items.map((endpointKey) => (
                <ImdItemCard
                  key={endpointKey}
                  endpointKey={endpointKey}
                  expanded={expanded}
                  onLoaded={handleLoaded}
                />
              ))}
            </div>
          ))}

          <div
            style={{
              marginTop: 8,
              paddingTop: 6,
              borderTop: `1px solid ${borderColor}`,
              fontSize: 8,
              color: mutedColor,
            }}
          >
            Official IMD Marine &amp; Disaster Information — RATNAKARA displays it;
            IMD issues it. Retrieved via the RATNAKARA backend proxy.
          </div>
        </>
      )}
    </div>
  );
}
