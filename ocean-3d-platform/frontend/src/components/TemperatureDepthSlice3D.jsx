/* ============================================================
   RATNAKARA — 3D DEPTH SLICE VIEWER · TEMPERATURE (additive)

   Compact 3D panel for the Temperature variable ONLY:
   a transparent water-column box with a horizontal laser plane
   slicing it at the selected depth, textured with the REAL
   temperature slice the Cesium globe layer is built from.

   Strict reuse contract (scope lock):
   - depth levels: /api/v1/model-capabilities via the shared
     ensureProbed() probe in data/realDataProvider.js — never
     hard-coded, never a second probe.
   - depth snapping: snapDepthToModel() from the shared module.
   - slice fetching: getSliceCanvas("temperature", depth) from
     services/waterColumnApi.js — it consumes the SAME slice
     cache (gridCache) and derived-texture cache as the globe,
     so no second fetch and no second cache.
   - NaN / land / outside-footprint pixels stay TRANSPARENT
     (paintSliceCanvas), so no fake data can appear here.
   - stale-request protection: generation counter — when the
     slider moves fast, only the latest depth wins.

   Owns a private WebGLRenderer on its own <canvas> — the
   Cesium globe context is never touched (same isolation rule
   as OceanWaterColumnStudio). Every GPU resource is disposed
   on unmount.
============================================================ */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  snapDepthToModel,
  getRealDepthInfo,
  ensureProbed,
} from "../data/realDataProvider";
import { getSliceCanvas } from "../services/waterColumnApi";

/* Height (local Three.js units) mapped to the REAL model depth
   range (min → max from capabilities), per spec — NOT 0–2000 m. */
const SLICE_VIEW_H = 14;
const SLICE_VIEW_W = 10;
const SLICE_VIEW_L = 10;

/* Cold-start probe retry: if the backend is briefly unreachable when
   this panel mounts (dev server restart, uvicorn still loading the
   NetCDF), keep the "Loading model depth levels…" state and retry the
   SHARED probe instead of latching "depth axis unknown" forever.
   realDataProvider.ensureProbed() clears its memoized promise on every
   failure, so each delay here is a genuine fresh backend attempt. */
const AXIS_PROBE_DELAY_MS = 1500;
const AXIS_PROBE_RETRIES = 20;

/* ------------------------------------------------------------
   REAL-RANGE depth → Y mapping (spec signature).
   Surface of the real range → +H/2, deepest level → -H/2.
   Local to this panel: the shared depthToY() maps the 0–2000 m
   VISUAL range and would compress the real 0.49–541.09 m data
   into the top quarter of the box.
------------------------------------------------------------ */
function realRangeDepthToY(depthMeters, minDepth, maxDepth) {
  const span = maxDepth - minDepth;
  if (!Number.isFinite(span) || span <= 0) return SLICE_VIEW_H / 2;
  const fraction =
    Math.min(Math.max(depthMeters - minDepth, 0), span) / span;
  return SLICE_VIEW_H / 2 - fraction * SLICE_VIEW_H;
}

function formatMeters(value) {
  const d = Number(value);
  if (!Number.isFinite(d)) return "—";
  return String(Math.round(d * 100) / 100);
}

/* ~4 intermediate REAL level labels between the shallowest and
   deepest levels (spec: never fabricate round numbers). */
function pickMarkerDepths(levels, count = 4) {
  if (!Array.isArray(levels) || levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  if (sorted.length <= count + 2) return sorted;
  const picked = [];
  for (let i = 1; i <= count; i++) {
    picked.push(sorted[Math.round((i * (sorted.length - 1)) / (count + 1))]);
  }
  return [...new Set(picked)];
}

export default function TemperatureDepthSlice3D({
  requestedDepth,
  onRequestedDepthChange,
  lightMode = false,
  /* Current region label from the app's EXISTING navigation state
     (activeLocationKey in App.jsx). Optional — the Model Information
     section hides this row when not provided; no second region state. */
  region = null,
  /* panelOpen is still passed by App.jsx but no longer read: the panel
     owns its own fixed right-side lane regardless of the Layers panel. */
  onClose,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);      /* { renderer, scene, camera, laserMesh, resize, dispose } */
  const genRef = useRef(0);           /* stale-request generation counter */

  const [range, setRange] = useState(null);       /* { min, max, levels } — REAL axis */
  const [axisState, setAxisState] = useState("loading"); /* loading | ready | unavailable */
  const [sliceMeta, setSliceMeta] = useState(null); /* backend slice metadata */
  const [sliceState, setSliceState] = useState("idle"); /* idle | loading | ready | error */
  const [sliceError, setSliceError] = useState(null);
  const [webglFailed, setWebglFailed] = useState(false);

  /* Snap the requested depth to the nearest REAL model level. */
  const snap = useMemo(
    () => (range ? snapDepthToModel(requestedDepth) : null),
    [range, requestedDepth]
  );
  const actualDepth = snap ? snap.actual : null;
  const levelIndex = sliceMeta?.depthIndex ?? null;
  const levelCount = sliceMeta?.depthCount ?? (range ? range.levels.length : null);

  /* ------------------------------------------------------------
     REAL depth axis — one shared capabilities probe, no hard-code
  ------------------------------------------------------------ */
  useEffect(() => {
    let cancelled = false;
    let timerId = null;
    /* Shared app-wide probe — one retry loop per mount, always through
       the shared ensureProbed() (no second probe, no hard-coded depths). */
    const probe = async (attempt) => {
      await ensureProbed();
      if (cancelled) return;
      const info = getRealDepthInfo();
      if (info) {
        setRange({ min: info.min, max: info.max, levels: info.levels });
        setAxisState("ready");
        return;
      }
      /* Probe still failing (backend cold start / transient network).
         Keep the LOADING state while retrying; only a genuinely
         exhausted probe becomes "unavailable" (PART G). */
      if (attempt < AXIS_PROBE_RETRIES) {
        timerId = setTimeout(() => probe(attempt + 1), AXIS_PROBE_DELAY_MS);
        return;
      }
      setAxisState("unavailable");
    };
    probe(0);
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  /* ------------------------------------------------------------
     SCENE LIFECYCLE — private renderer, full disposal on unmount
  ------------------------------------------------------------ */
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (err) {
      console.error("TemperatureDepthSlice3D: WebGL init failed:", err);
      /* Async so the effect body never sets state synchronously
         (react-hooks/set-state-in-effect). */
      queueMicrotask(() => setWebglFailed(true));
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(13.5, 9.5, 17.5);
    camera.lookAt(0, 0, 0);

    const disposables = [];
    const track = (resource) => {
      disposables.push(resource);
      return resource;
    };

    /* Water-column volume: transparent box + wireframe boundary. */
    const volumeGeo = track(new THREE.BoxGeometry(SLICE_VIEW_W, SLICE_VIEW_H, SLICE_VIEW_L));
    const volumeMat = track(
      new THREE.MeshBasicMaterial({
        color: 0x0a3a52,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    const volume = new THREE.Mesh(volumeGeo, volumeMat);
    scene.add(volume);

    const edgesMat = track(
      new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.55 })
    );
    scene.add(new THREE.LineSegments(track(new THREE.EdgesGeometry(volumeGeo)), edgesMat));

    /* Surface + deep reference planes of the REAL range. */
    const capMat = track(
      new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    for (const y of [SLICE_VIEW_H / 2, -SLICE_VIEW_H / 2]) {
      const cap = new THREE.Mesh(track(new THREE.PlaneGeometry(SLICE_VIEW_W, SLICE_VIEW_L)), capMat);
      cap.rotation.x = -Math.PI / 2;
      cap.position.y = y;
      scene.add(cap);
    }

    /* Laser plane — textured with the REAL temperature slice. */
    const laserMat = track(
      new THREE.MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    const laserMesh = new THREE.Mesh(
      track(new THREE.PlaneGeometry(SLICE_VIEW_W * 0.99, SLICE_VIEW_L * 0.99)),
      laserMat
    );
    laserMesh.rotation.x = -Math.PI / 2;
    scene.add(laserMesh);

    const frameMat = track(
      new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.75 })
    );
    const frame = new THREE.LineSegments(
      track(new THREE.EdgesGeometry(track(new THREE.PlaneGeometry(SLICE_VIEW_W * 0.99, SLICE_VIEW_L * 0.99)))),
      frameMat
    );
    frame.rotation.x = -Math.PI / 2;
    scene.add(frame);
    /* Keep simple auto-rotation so the 3D structure is readable
       without user input; drag-to-orbit is out of scope here. */
    let animationId = 0;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      scene.rotation.y += 0.0022;
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    sceneRef.current = { renderer, scene, camera, laserMesh, resize };

    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationId);
      if (laserMesh.material.map) laserMesh.material.map.dispose();
      for (const resource of disposables) resource.dispose?.();
      disposables.length = 0;
      renderer.dispose();
      sceneRef.current = null;
    };
  }, []);

  /* ------------------------------------------------------------
     SLICE FETCH + LASER PLANE UPDATE (per snapped depth)
     Generation counter: rapid slider movement — only the latest
     request may paint the plane.
  ------------------------------------------------------------ */
  useEffect(() => {
    if (!range || actualDepth == null) return undefined;
    const controller = sceneRef.current;
    if (!controller) return undefined;

    /* Position first: the plane must move even before data lands. */
    controller.laserMesh.position.y = realRangeDepthToY(actualDepth, range.min, range.max);

    const gen = ++genRef.current;
    setSliceState("loading");
    setSliceError(null);

    (async () => {
      try {
        /* Shared cache path: snaps internally too and reuses the
           globe's slice cache — 155.85 m fetched once is never
           requested again. */
        const { canvas, meta } = await getSliceCanvas("temperature", actualDepth);
        if (gen !== genRef.current) return; /* stale — discard */

        if (canvas && controller.laserMesh) {
          const mat = controller.laserMesh.material;
          if (mat.map) mat.map.dispose();
          const texture = new THREE.CanvasTexture(canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          mat.map = texture;
          mat.color.set(0xffffff);
          mat.opacity = 0.92;
          mat.needsUpdate = true;
          setSliceMeta(meta ?? null);
          setSliceState("ready");
        } else {
          setSliceMeta(meta ?? null);
          setSliceState("error");
          setSliceError("Depth data unavailable for this level.");
        }
      } catch (err) {
        if (gen !== genRef.current) return; /* stale — discard */
        if (controller.laserMesh) {
          const mat = controller.laserMesh.material;
          if (mat.map) {
            mat.map.dispose();
            mat.map = null;
          }
          mat.color.set(0x67e8f9);
          mat.opacity = 0.22;
          mat.needsUpdate = true;
        }
        setSliceState("error");
        setSliceError(String(err?.message || err));
      }
    })();

    return () => {};
  }, [range, actualDepth]);

  /* Depth axis labels: shallowest + selected (highlighted) +
     deepest + ~4 intermediate REAL levels. */
  const markerDepths = useMemo(() => {
    if (!range) return [];
    const set = new Set(
      [range.min, range.max, ...pickMarkerDepths(range.levels)]
    );
    if (actualDepth != null) set.add(actualDepth);
    return [...set].sort((a, b) => a - b);
  }, [range, actualDepth]);

  const textColor = lightMode ? "#163743" : "#e2e8f0";
  const mutedColor = lightMode ? "#63818b" : "#94a3b8";
  const bg = lightMode ? "rgba(248, 253, 255, 0.96)" : "rgba(10, 18, 32, 0.96)";
  const borderColor = lightMode
    ? "rgba(22, 135, 201, 0.20)"
    : "rgba(148, 163, 184, 0.18)";
  const accentColor = lightMode ? "#087e8b" : "#7dd3fc";
  const errorColor = lightMode ? "#a02020" : "#f87171";
  const warnColor = lightMode ? "#8a5a00" : "#fbbf24";

  /* Slider spans the REAL range (min → max of the model axis). */
  const sliderMin = range ? Math.round(range.min) : 0;
  const sliderMax = range ? Math.round(range.max) : 1;

  /* ------------------------------------------------------------
     SLICE STATISTICS / DATA COVERAGE / MODEL INFORMATION
     All values are REAL: statistics arrive on sliceMeta.statistics
     (computed SERVER-SIDE over the full-resolution slice before
     downsampling — see realDataProvider.getRealSlice), so NaN and
     land cells are already excluded there and no Math.min(...arr)
     spread is ever used. The same min/max drives the laser-plane
     colors and the legend, so panel numbers and visuals can never
     disagree. Depth range comes from the shared capabilities probe
     (REAL model levels — never hard-coded). Timestamp comes from
     the slice's own time dimension. Rows are hidden entirely when
     the underlying value is unavailable — nothing is fabricated.
  ------------------------------------------------------------ */
  const stats = sliceMeta?.statistics ?? null;
  const statUnit = sliceMeta?.unit ?? "°C";

  const formatTempValue = (value) =>
    Number.isFinite(value) ? `${formatMeters(value)} ${statUnit}` : null;

  /* Backend timestamps are naive UTC ("2026-06-23T00:00:00");
     parse AS UTC and render an explicit UTC label. */
  const timeLabel = useMemo(() => {
    const raw = sliceMeta?.time;
    if (!raw) return null;
    const withZone = /[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`;
    const parsed = Date.parse(withZone);
    if (!Number.isFinite(parsed)) return null;
    return new Date(parsed).toISOString().replace("T", " ").replace(".000Z", " UTC");
  }, [sliceMeta?.time]);

  /* Coverage: valid cells vs missing cells of the full-resolution
     slice (both from the backend). Null when not provided. */
  const coveragePct =
    stats &&
    Number.isFinite(stats.validCount) &&
    Number.isFinite(stats.missingCount) &&
    stats.validCount + stats.missingCount > 0
      ? (100 * stats.validCount) / (stats.validCount + stats.missingCount)
      : null;

  const renderRows = (rows) =>
    rows.map(([label, value]) => (
      <div key={label} style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: mutedColor, fontSize: 9, letterSpacing: "1px" }}>
          {label.toUpperCase()}
        </span>
        <span style={{ fontWeight: 600 }}>{value}</span>
      </div>
    ));

  /* SLICE METADATA — unchanged fields, exact existing behavior. */
  const metadataRows = [
    ["Variable", "Temperature"],
    ["Requested depth", requestedDepth != null ? `${formatMeters(requestedDepth)} m` : "—"],
    ["Actual depth", actualDepth != null ? `${formatMeters(actualDepth)} m` : "—"],
    [
      "Model level",
      levelIndex != null && levelCount
        ? `${levelIndex} / ${levelCount}`
        : levelCount
          ? `— / ${levelCount}`
          : "—",
    ],
    ["Source", sliceMeta?.source ?? "—"],
    ["Units", sliceMeta?.unit ?? "°C"],
  ];

  /* SLICE STATISTICS — real per-depth stats; hidden when absent. */
  const statRows = [];
  if (Number.isFinite(stats?.min)) statRows.push(["Min", formatTempValue(stats.min)]);
  if (Number.isFinite(stats?.max)) statRows.push(["Max", formatTempValue(stats.max)]);
  if (Number.isFinite(stats?.mean)) statRows.push(["Mean", formatTempValue(stats.mean)]);

  /* DATA COVERAGE — hidden when the backend provides no counts. */
  const coverageRows = [];
  if (Number.isFinite(stats?.validCount)) {
    coverageRows.push(["Valid cells", String(Math.round(stats.validCount))]);
  }
  if (Number.isFinite(coveragePct)) {
    coverageRows.push(["Valid coverage", `${coveragePct.toFixed(1)}%`]);
  }

  /* MODEL INFORMATION — depth range (real axis), dataset time
     (real time dimension), region (existing app state). */
  const modelInfoRows = [];
  if (range) {
    modelInfoRows.push([
      "Depth range",
      `${formatMeters(range.min)} – ${formatMeters(range.max)} m`,
    ]);
  }
  if (timeLabel) modelInfoRows.push(["Data time", timeLabel]);
  if (region) modelInfoRows.push(["Region", region]);

  return (
    <div
      style={{
        position: "fixed",
        /* RIGHT-side lane (Part J): the Layers panel and the
           Ask-the-Ocean overlay own the left lane; the top-right lane
           only hosts transient popups (WarningCard, bottom-right),
           which this panel's bottom clearance leaves visible. */
        right: 16,
        top: 76,
        width: 264, /* matches the app's dashboard lane width (see
                       AskTheOceanPanel) so both AI surfaces read as
                       siblings of the LAYERS panel */
        /* Bottom clearance keeps the bottom-right corner free for the
           fixed WarningCard (bottom 24 + up to ~200px tall, z 30) and
           the bottom-center DataLayerFilter. */
        maxHeight: "calc(100vh - 300px)",
        overflowY: "auto",
        zIndex: 55,
        background: bg,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
        padding: "12px 14px",
        fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
        color: textColor,
      }}
    >
      {/* ---------- Header ---------- */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.6px" }}>
          🌊 TEMPERATURE — 3D DEPTH SLICE
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close 3D depth slice viewer"
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

      {/* ---------- 3D viewport: box + laser plane + markers ---------- */}
      <div
        ref={containerRef}
        style={{
          position: "relative",
          height: 300,
          borderRadius: 8,
          overflow: "hidden",
          background:
            "linear-gradient(180deg, rgba(8, 34, 53, 0.65), rgba(3, 12, 22, 0.8))",
          border: `1px solid ${borderColor}`,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block" }}
          aria-label="3D temperature depth slice viewport"
        />

        {/* Left-edge depth labels from the REAL model axis only. */}
        {range && (
          <div
            style={{
              position: "absolute",
              left: 4,
              top: 0,
              bottom: 0,
              width: 56,
              pointerEvents: "none",
            }}
          >
            {markerDepths.map((depth) => {
              const percent =
                ((depth - range.min) / (range.max - range.min)) * 100;
              const isSelected = actualDepth != null && Math.abs(depth - actualDepth) < 0.01;
              const isExtreme =
                Math.abs(depth - range.min) < 0.01 ||
                Math.abs(depth - range.max) < 0.01;
              return (
                <span
                  key={depth}
                  style={{
                    position: "absolute",
                    top: `${Math.min(100, Math.max(0, percent))}%`,
                    transform: "translateY(-50%)",
                    fontSize: 8.5,
                    fontWeight: isSelected ? 800 : 500,
                    color: isSelected ? accentColor : mutedColor,
                    background: "rgba(3, 12, 22, 0.55)",
                    padding: "0 3px",
                    borderRadius: 3,
                    whiteSpace: "nowrap",
                    ...(isExtreme && !isSelected ? { textDecoration: "underline dotted" } : {}),
                  }}
                >
                  {isExtreme ? `${formatMeters(depth)} m` : formatMeters(depth)}
                </span>
              );
            })}
          </div>
        )}

        {/* Loading / error overlay — panel-local, never blocks the app. */}
        {sliceState === "loading" && (
          <div
            style={{
              position: "absolute",
              right: 8,
              top: 8,
              fontSize: 9.5,
              color: accentColor,
              background: "rgba(3, 12, 22, 0.7)",
              padding: "3px 7px",
              borderRadius: 6,
              border: `1px solid ${borderColor}`,
            }}
            role="status"
          >
            Loading {actualDepth != null ? `${formatMeters(actualDepth)} m` : ""}…
          </div>
        )}
        {sliceState === "error" && (
          <div
            style={{
              position: "absolute",
              right: 8,
              top: 8,
              fontSize: 9.5,
              color: errorColor,
              background: "rgba(3, 12, 22, 0.7)",
              padding: "3px 7px",
              borderRadius: 6,
              border: `1px solid ${borderColor}`,
            }}
            role="alert"
          >
            {sliceError || "Depth data unavailable"}
          </div>
        )}
        {axisState !== "ready" && !webglFailed && (
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              fontSize: 10,
              color: warnColor,
              background: "rgba(3, 12, 22, 0.75)",
              padding: "5px 9px",
              borderRadius: 6,
              border: `1px solid ${borderColor}`,
              textAlign: "center",
            }}
            role="status"
          >
            {axisState === "loading"
              ? "Loading model depth levels…"
              : (
                <>
                  Real model data unavailable —
                  <br />
                  depth axis unknown.
                </>
              )}
          </div>
        )}
        {webglFailed && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: errorColor,
              textAlign: "center",
              padding: 16,
            }}
          >
            3D view unavailable on this device — the rest of RATNAKARA keeps working.
          </div>
        )}

        {/* SURFACE / DEEP captions at the real-range extremes. */}
        {range && (
          <>
            <span
              style={{
                position: "absolute",
                right: 8,
                top: 6,
                fontSize: 8.5,
                color: mutedColor,
                pointerEvents: "none",
              }}
            >
              SURFACE ──── {formatMeters(range.min)} m
            </span>
            <span
              style={{
                position: "absolute",
                right: 8,
                bottom: 6,
                fontSize: 8.5,
                color: mutedColor,
                pointerEvents: "none",
              }}
            >
              DEEP ──── {formatMeters(range.max)} m
            </span>
          </>
        )}
      </div>

      {/* ---------- Depth slider (same depth state as the app) ---------- */}
      <div style={{ marginTop: 10 }}>
        <input
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={1}
          value={
            requestedDepth != null && Number.isFinite(requestedDepth)
              ? Math.min(Math.max(Math.round(requestedDepth), sliderMin), sliderMax)
              : sliderMin
          }
          onChange={(event) => onRequestedDepthChange?.(Number(event.target.value))}
          aria-label="Requested depth in meters"
          disabled={!range}
          style={{ width: "100%", accentColor: accentColor }}
        />
        {snap?.clamped && (
          <div style={{ fontSize: 9, color: warnColor, marginTop: 2 }}>
            Snapped to the nearest available model level.
          </div>
        )}
      </div>

      {/* ---------- Metadata footer (real values only) ---------- */}
      <div style={{ marginTop: 8, fontSize: 10.5, lineHeight: 1.8 }}>
        <div style={{ fontSize: 9, letterSpacing: "1px", color: mutedColor }}>
          SLICE METADATA
        </div>
        {renderRows(metadataRows)}

        {statRows.length > 0 && (
          <>
            <div style={{ fontSize: 9, letterSpacing: "1px", color: mutedColor, marginTop: 6 }}>
              SLICE STATISTICS
            </div>
            {renderRows(statRows)}
          </>
        )}

        {coverageRows.length > 0 && (
          <>
            <div style={{ fontSize: 9, letterSpacing: "1px", color: mutedColor, marginTop: 6 }}>
              DATA COVERAGE
            </div>
            {renderRows(coverageRows)}
          </>
        )}

        {modelInfoRows.length > 0 && (
          <>
            <div style={{ fontSize: 9, letterSpacing: "1px", color: mutedColor, marginTop: 6 }}>
              MODEL INFORMATION
            </div>
            {renderRows(modelInfoRows)}
          </>
        )}

        <div style={{ fontSize: 8, color: mutedColor, marginTop: 4, opacity: 0.85 }}>
          Real model data · land/NaN pixels transparent · same slice cache as the globe.
        </div>
      </div>
    </div>
  );
}
