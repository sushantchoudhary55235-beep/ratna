/* ============================================================
   RATNAKARA — 3D WATER COLUMN STUDIO (additive feature)

   Micro-scale local inspection of one ocean water column,
   rendered on an ISOLATED Three.js canvas. The Cesium globe
   keeps running untouched underneath this overlay (macro vs
   micro separation from the source architecture).

   Data honesty contract (spec Phases 8/13/15/16/36):
   - Every displayed number originates from the real backend
     model slices or QC-passed Argo observations.
   - NaN / land / outside-footprint pixels stay TRANSPARENT.
   - Requested depth and actual model level are BOTH shown.
   - No variable is shown as real data unless the dataset has it.
   - No fake particles, gradients or invented measurements.

   Exits: close button, Escape key. Full Three.js disposal on
   unmount — reopening never creates duplicate renderers.
============================================================ */

import { useEffect, useMemo, useRef, useState } from "react";
import { createWaterColumnScene } from "../rendering/waterColumn/waterColumnScene";
import {
  VISUAL_MAX_DEPTH,
  clampDepth,
  formatMeters,
} from "../rendering/waterColumn/waterColumnDepth";
import {
  VARIABLES,
  ready,
  snapDepthToModel,
  getSliceCanvas,
  getValueAt,
  getWallCanvas,
  getCurrentVectors,
  getSliceBounds,
  getNearestObservation,
  getChlorophyllStatus,
} from "../services/waterColumnApi";
import { getRealDepthInfo } from "../data/realDataProvider";
import { pickStratificationLevels } from "../rendering/waterColumn/waterColumnDepth";

const QUICK_DEPTHS = [0, 50, 150, 500, 1000, 2000];
const VISUAL_ONLY_DEPTHS = new Set([1000, 2000]);

/* Status color tokens */
const STATUS_COLORS = {
  loading: "#7dd3fc",
  loaded: "#86efac",
  unavailable: "#fbbf24",
  error: "#f87171",
};

export default function OceanWaterColumnStudio({
  open = false,
  onClose,
  latitude = 15,
  longitude = 67.5,
  lightMode = false,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const requestSeqRef = useRef(0);
  const openSeqRef = useRef(0);

  const [variable, setVariable] = useState("temperature");
  const [requestedDepth, setRequestedDepth] = useState(50);
  const [sliceStatus, setSliceStatus] = useState({
    state: "idle",
    message: "",
  });
  const [wallError, setWallError] = useState(null);
  const [telemetry, setTelemetry] = useState({
    value: null,
    unit: null,
    meta: null,
  });
  const [observation, setObservation] = useState(null);
  const [currentInfo, setCurrentInfo] = useState(null);
  const [sliceBounds, setSliceBounds] = useState(null);
  const [webglFailed, setWebglFailed] = useState(false);

  const [showStratification, setShowStratification] = useState(true);
  const [showVectors, setShowVectors] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);

  const isCurrents = variable === "currents";
  const chlorophyllStatus = useMemo(() => getChlorophyllStatus(), []);
  const snapped = useMemo(() => snapDepthToModel(clampDepth(requestedDepth)), [requestedDepth]);
  const depthSnapped = Math.abs(snapped.actual - clampDepth(requestedDepth)) > 0.01;

  /* ------------------------------------------------------------
     SCENE LIFECYCLE — one renderer per open, full disposal on close
  ------------------------------------------------------------ */
  useEffect(() => {
    if (!open) return undefined;
    openSeqRef.current += 1;
    const myOpen = openSeqRef.current;

    let observer = null;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    setWebglFailed(false);
    const controller = createWaterColumnScene(canvas, {
      onDepthPicked: (depth) => setRequestedDepth(depth),
    });
    if (!controller) {
      setWebglFailed(true); /* spec Phase 27: message, never a crash */
      return undefined;
    }
    sceneRef.current = controller;

    const rect = container.getBoundingClientRect();
    controller.resize(rect.width, rect.height);
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        controller.resize(width, height);
      }
    });
    observer.observe(container);

    return () => {
      if (openSeqRef.current !== myOpen) return;
      observer?.disconnect();
      controller.dispose();
      sceneRef.current = null;
    };
  }, [open]);

  /* Escape closes the studio (spec Phase 30) */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /* ------------------------------------------------------------
     WALLS + STRATIFICATION + CURRENT VECTORS (per variable)
  ------------------------------------------------------------ */
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const controller = sceneRef.current;
    if (!controller) return undefined;

    setWallError(null);

    (async () => {
      await ready();

      /* Vertical section across ALL real levels (temperature/salinity). */
      if (!isCurrents) {
        try {
          const wall = await getWallCanvas(variable);
          if (cancelled) return;
          controller.setMaxRealDepth(wall.maxDepth);
          controller.buildWalls(wall.canvas, wall.ticks);
          if (wall.error) setWallError(wall.error);
        } catch (err) {
          if (!cancelled) setWallError(String(err?.message || err));
        }
      } else {
        /* Currents: walls stay structural-only, depth limit still shown. */
        const depthInfo = getRealDepthInfo();
        const maxDepth = depthInfo ? depthInfo.max : 0;
        controller.setMaxRealDepth(maxDepth);
        controller.buildWalls(null, []);
        if (!depthInfo) setWallError("Real model data unavailable.");
      }

      /* Stratification planes from REAL levels (spec Phase 12). */
      const depthInfo = getRealDepthInfo();
      controller.setStratificationLevels(
        depthInfo ? pickStratificationLevels(depthInfo.levels) : []
      );
      controller.setStratificationVisible(showStratification);

      /* Real U/V vectors (currents tab only). */
      if (isCurrents) {
        const result = await getCurrentVectors(requestedDepth);
        if (cancelled) return;
        controller.setCurrentVectors(
          result.vectors.map((v) => ({ ...v, _bounds: result.bounds }))
        );
        controller.setVectorsVisible(showVectors);
        setCurrentInfo({
          count: result.vectors.length,
          depth: result.depth,
          error: result.error,
          bounds: result.bounds,
        });
        setSliceBounds(result.bounds);
      }
    })();

    return () => {
      cancelled = true;
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [open, variable]);

  /* ------------------------------------------------------------
     LASER PLANE + TELEMETRY VALUES (per depth/variable)
  ------------------------------------------------------------ */
  useEffect(() => {
    if (!open) return undefined;
    const seq = ++requestSeqRef.current;
    const controller = sceneRef.current;
    if (!controller) return undefined;

    const actualDepth = snapped.actual;
    controller.setLaserDepth(actualDepth);

    (async () => {
      if (isCurrents) {
        setSliceStatus({
          state: currentInfo?.error ? "unavailable" : currentInfo ? "loaded" : "loading",
          message: currentInfo?.error
            ? currentInfo.error
            : currentInfo
              ? `${currentInfo.count} real U/V vectors at ${formatMeters(currentInfo.depth)} m`
              : "Loading current vectors…",
        });
        return;
      }

      setSliceStatus({
        state: "loading",
        message: `Loading ${variable} slice at ${formatMeters(actualDepth)} m…`,
      });

      try {
        const { canvas, meta } = await getSliceCanvas(variable, requestedDepth);
        if (seq !== requestSeqRef.current) return; /* stale response */
        controller.setLaserTexture(canvas);
        if (canvas) {
          setSliceStatus({
            state: "loaded",
            message: `${variable} data loaded at ${formatMeters(meta.actualDepth)} m`,
          });
        } else {
          setSliceStatus({
            state: "unavailable",
            message: `${variable} data unavailable for this depth/location.`,
          });
        }
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        controller.setLaserTexture(null);
        setSliceStatus({
          state: "error",
          message: `${variable} slice failed: ${String(err?.message || err)}`,
        });
      }

      /* Pin value from the SAME cached grid (no second request). */
      try {
        const { value, meta } = await getValueAt(variable, requestedDepth, latitude, longitude);
        if (seq !== requestSeqRef.current) return;
        setTelemetry({ value, unit: meta?.unit ?? null, meta });
        const bounds = await getSliceBounds(variable, requestedDepth);
        if (seq !== requestSeqRef.current) return;
        setSliceBounds(bounds);
      } catch {
        if (seq === requestSeqRef.current) {
          setTelemetry({ value: null, unit: null, meta: null });
        }
      }
    })();

    return () => {};
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [open, variable, requestedDepth, latitude, longitude]);

  /* ------------------------------------------------------------
     LOCATION PIN — follows the user's globe selection
  ------------------------------------------------------------ */
  useEffect(() => {
    if (!open) return;
    sceneRef.current?.setLocationPin(latitude, longitude, sliceBounds);
  }, [open, latitude, longitude, sliceBounds]);

  /* ------------------------------------------------------------
     ARGO / OBSERVATION COMPARISON (real data only, Phase 16)
  ------------------------------------------------------------ */
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    (async () => {
      if (isCurrents) {
        setObservation(null);
        return;
      }
      setObservation({ state: "loading" });
      try {
        await ready();
        const result = await getNearestObservation(
          latitude,
          longitude,
          snapped.actual,
          variable
        );
        if (!cancelled) {
          setObservation(result.found ? { state: "found", ...result } : { state: "none", reason: result.reason });
        }
      } catch (err) {
        if (!cancelled) {
          setObservation({ state: "none", reason: String(err?.message || err) });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, isCurrents, variable, latitude, longitude, snapped.actual]);

  const panelText = lightMode ? "#163743" : "#e2e8f0";
  const panelMuted = lightMode ? "#63818b" : "#94a3b8";
  const panelBg = lightMode ? "rgba(248, 253, 255, 0.97)" : "rgba(6, 14, 26, 0.96)";
  const panelBorder = lightMode ? "rgba(22, 135, 201, 0.25)" : "rgba(125, 211, 252, 0.22)";
  const accent = lightMode ? "#087e8b" : "#7dd3fc";

  const variableUnit = VARIABLES.find((v) => v.key === variable)?.units ?? "";

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="3D Water Column Studio"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "flex",
        flexDirection: "column",
        background: lightMode
          ? "rgba(227, 242, 248, 0.92)"
          : "radial-gradient(ellipse at 50% 30%, rgba(10, 42, 64, 0.94), rgba(2, 11, 20, 0.98))",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
        color: panelText,
      }}
    >
      {/* ---------- Header ---------- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 18px",
          borderBottom: `1px solid ${panelBorder}`,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.8px" }}>
            🌊 3D WATER COLUMN STUDIO
          </div>
          <div style={{ fontSize: 10, color: panelMuted, marginTop: 2 }}>
            {latitude.toFixed(2)}°N {longitude.toFixed(2)}°E ·{" "}
            {sliceBounds
              ? "inside real model footprint"
              : "outside real model footprint — structural view only"}
            {" · "}isolated Three.js view; Cesium globe untouched
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close 3D Water Column Studio"
          title="Close (Esc)"
          style={{
            background: "transparent",
            border: `1px solid ${panelBorder}`,
            borderRadius: 8,
            color: panelText,
            fontSize: 14,
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          ✕ Close
        </button>
      </div>

      {/* ---------- Body ---------- */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 3D viewport */}
        <div
          ref={containerRef}
          style={{
            flex: 1,
            position: "relative",
            minWidth: 0,
            background:
              "linear-gradient(180deg, rgba(8, 34, 53, 0.65), rgba(3, 12, 22, 0.8))",
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "100%", display: "block" }}
            aria-label="3D water column viewport"
          />
          {webglFailed && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                color: "#f87171",
                textAlign: "center",
                padding: 24,
              }}
            >
              3D Water Column unavailable on this device/browser.
              <br />
              The rest of RATNAKARA keeps working.
            </div>
          )}
          <div
            style={{
              position: "absolute",
              left: 12,
              bottom: 10,
              fontSize: 9,
              color: panelMuted,
              pointerEvents: "none",
            }}
          >
            drag: orbit · wheel: zoom · right-drag: pan · click column: set depth
          </div>
        </div>

        {/* Sidebar */}
        <div
          style={{
            width: 320,
            flexShrink: 0,
            overflowY: "auto",
            borderLeft: `1px solid ${panelBorder}`,
            background: panelBg,
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {/* Variable tabs */}
          <div>
            <div className="panel-section-title" style={{ fontSize: 9, letterSpacing: 1.2, color: panelMuted, marginBottom: 6 }}>
              VARIABLE
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {VARIABLES.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setVariable(v.key)}
                  aria-pressed={variable === v.key}
                  style={{
                    flex: 1,
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "7px 6px",
                    borderRadius: 8,
                    cursor: "pointer",
                    border: `1px solid ${variable === v.key ? accent : panelBorder}`,
                    background: variable === v.key ? "rgba(125, 211, 252, 0.14)" : "transparent",
                    color: variable === v.key ? accent : panelMuted,
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {!chlorophyllStatus.available && (
              <div style={{ fontSize: 9, color: panelMuted, marginTop: 6 }}>
                Chlorophyll: DATA NOT AVAILABLE in the real dataset.
              </div>
            )}
          </div>

          {/* Depth control */}
          <div>
            <div style={{ fontSize: 9, letterSpacing: 1.2, color: panelMuted, marginBottom: 6 }}>
              DEPTH
            </div>
            <input
              type="range"
              min={0}
              max={VISUAL_MAX_DEPTH}
              step={5}
              value={clampDepth(requestedDepth)}
              onChange={(event) => setRequestedDepth(Number(event.target.value))}
              aria-label="Requested depth in meters"
              style={{ width: "100%", accentColor: accent }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 4 }}>
              <span>
                Requested: <strong>{formatMeters(clampDepth(requestedDepth))} m</strong>
              </span>
              <span style={{ color: depthSnapped ? "#fbbf24" : panelMuted }}>
                Model level: <strong>{formatMeters(snapped.actual)} m</strong>
              </span>
            </div>
            {depthSnapped && (
              <div style={{ fontSize: 9, color: "#fbbf24", marginTop: 3 }}>
                Snapped to the nearest available model level.
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
              {QUICK_DEPTHS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setRequestedDepth(d)}
                  title={
                    VISUAL_ONLY_DEPTHS.has(d)
                      ? "Visual navigation depth — real data may not reach this level"
                      : `Request ${d} m (snaps to nearest model level)`
                  }
                  style={{
                    fontSize: 10,
                    padding: "4px 8px",
                    borderRadius: 7,
                    cursor: "pointer",
                    border: `1px solid ${clampDepth(requestedDepth) === d ? accent : panelBorder}`,
                    color: clampDepth(requestedDepth) === d ? accent : panelMuted,
                    background: "transparent",
                  }}
                >
                  {d} m{VISUAL_ONLY_DEPTHS.has(d) ? " ✦" : ""}
                </button>
              ))}
            </div>
          </div>

          {/* Toggles */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button
              type="button"
              onClick={() => {
                const next = !showStratification;
                setShowStratification(next);
                sceneRef.current?.setStratificationVisible(next);
              }}
              aria-pressed={showStratification}
              style={toggleStyle(panelBorder, showStratification ? accent : panelMuted)}
            >
              Stratification
            </button>
            {isCurrents && (
              <button
                type="button"
                onClick={() => {
                  const next = !showVectors;
                  setShowVectors(next);
                  sceneRef.current?.setVectorsVisible(next);
                }}
                aria-pressed={showVectors}
                style={toggleStyle(panelBorder, showVectors ? accent : panelMuted)}
              >
                Current vectors
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const next = !autoRotate;
                setAutoRotate(next);
                sceneRef.current?.setAutoRotate(next);
              }}
              aria-pressed={autoRotate}
              style={toggleStyle(panelBorder, autoRotate ? accent : panelMuted)}
            >
              Auto rotate
            </button>
            <button
              type="button"
              onClick={() => sceneRef.current?.resetCamera()}
              style={toggleStyle(panelBorder, panelText)}
            >
              Reset camera
            </button>
          </div>

          {/* Slice status */}
          <div
            style={{
              fontSize: 10,
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${panelBorder}`,
              color: STATUS_COLORS[sliceStatus.state] ?? panelMuted,
            }}
            role="status"
          >
            {sliceStatus.message || "Idle."}
            {wallError && (
              <div style={{ color: STATUS_COLORS.unavailable, marginTop: 4 }}>
                Side section: {wallError}
              </div>
            )}
          </div>

          {/* Telemetry */}
          <div>
            <div style={{ fontSize: 9, letterSpacing: 1.2, color: panelMuted, marginBottom: 6 }}>
              TELEMETRY
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11 }}>
              <TeleRow label="Location" value={`${latitude.toFixed(2)}°N, ${longitude.toFixed(2)}°E`} muted={panelMuted} />
              <TeleRow
                label="Depth"
                value={`${formatMeters(clampDepth(requestedDepth))} m → ${formatMeters(snapped.actual)} m (model)`}
                muted={panelMuted}
              />
              <TeleRow
                label="Model"
                value={telemetry.meta?.source ?? "—"}
                sub={telemetry.meta?.time ?? null}
                muted={panelMuted}
              />
              <TeleRow
                label="Temperature"
                value={
                  variable === "temperature"
                    ? telemetry.value != null
                      ? `${telemetry.value.toFixed(2)} °C`
                      : "No data at this point/depth"
                    : telemetry.meta
                      ? "Switch to the Temperature tab"
                      : "—"
                }
                muted={panelMuted}
              />
              <TeleRow
                label="Salinity"
                value={
                  variable === "salinity"
                    ? telemetry.value != null
                      ? `${telemetry.value.toFixed(2)} PSU`
                      : "No data at this point/depth"
                    : telemetry.meta
                      ? "Switch to the Salinity tab"
                      : "—"
                }
                muted={panelMuted}
              />
              <TeleRow
                label="Current"
                value={
                  isCurrents
                    ? currentInfo
                      ? currentInfo.error
                        ? "UNAVAILABLE"
                        : `${currentInfo.count} real vectors @ ${formatMeters(currentInfo.depth)} m`
                      : "Loading…"
                    : "Switch to the Currents tab"
                }
                muted={panelMuted}
              />
            </div>
          </div>

          {/* Observation comparison */}
          {!isCurrents && (
            <div>
              <div style={{ fontSize: 9, letterSpacing: 1.2, color: panelMuted, marginBottom: 6 }}>
                OBSERVATION (ARGO)
              </div>
              {observation?.state === "loading" && (
                <div style={cardStyle(panelBorder, panelMuted)}>Searching nearby floats…</div>
              )}
              {observation?.state === "found" && (
                <div style={cardStyle(panelBorder, panelText)}>
                  <div>
                    Argo @ {observation.latitude.toFixed(2)}°N {observation.longitude.toFixed(2)}°E
                  </div>
                  <div style={{ marginTop: 4 }}>
                    {variable === "salinity" ? "Salinity" : "Temperature"}:{" "}
                    <strong>
                      {Number(observation.value).toFixed(2)} {variableUnit}
                    </strong>{" "}
                    at {formatMeters(observation.observationDepth)} dbar
                  </div>
                  <div style={{ color: panelMuted, marginTop: 4, fontSize: 10 }}>
                    Depth separation vs model level: {observation.depthGap} dbar
                  </div>
                </div>
              )}
              {observation?.state === "none" && (
                <div style={cardStyle(panelBorder, panelMuted)}>
                  {observation.reason || "No nearby observation available."}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* Small style helpers (kept local — feature-scoped styling only) */
function toggleStyle(border, color) {
  return {
    fontSize: 10,
    fontWeight: 600,
    padding: "5px 9px",
    borderRadius: 7,
    cursor: "pointer",
    border: `1px solid ${border}`,
    background: "transparent",
    color,
  };
}

function cardStyle(border, color) {
  return {
    fontSize: 10,
    padding: "8px 10px",
    borderRadius: 8,
    border: `1px solid ${border}`,
    color,
  };
}

function TeleRow({ label, value, sub, muted }) {
  return (
    <div>
      <div style={{ color: muted, fontSize: 9, letterSpacing: 0.8 }}>{label.toUpperCase()}</div>
      <div>{value}</div>
      {sub && <div style={{ color: muted, fontSize: 9 }}>{sub}</div>}
    </div>
  );
}
