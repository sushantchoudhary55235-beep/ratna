import {
  useCallback,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

import "./App.css";

import {
  DEMO_MODE_ACTIVE,
  DEMO_STEP_INTERVAL_MS,
  DEMO_START_EPOCH,
  DEMO_TIMESTEP_MS,
  demoTimeLabel,
  demoTimeToStep,
  getDemoChlorophyllPointAt,
  getDemoCurrentVectors,
  getDemoFieldTexture,
  getDemoSalinityPointAt,
  getDemoSalinityPoints,
  getDemoTemperaturePointAt,
} from "./data/demoData";

import { PinpointMarker, WarningCard } from "./components/CoastalWarning";
import { isOcean } from "./data/landMask";
import DataLayerFilter from "./components/DataLayerFilter";
import TemperatureLegend from "./components/TemperatureLegend";
import CurrentLegend from "./components/CurrentLegend";
import LocationLabel from "./components/LocationLabel";

/*
  IMPORTANT:
  Currents is lazy-loaded so a problem inside
  RatnakaraCurrents.jsx cannot prevent the
  main globe from rendering.
*/
const RatnakaraCurrents = lazy(
  () => import("./components/RatnakaraCurrents")
);

/*
  Report Analysis (additive feature): isolated full-screen view,
  lazy-loaded so the globe bundle is unaffected.
*/
const ReportAnalysis = lazy(
  () => import("./components/ReportAnalysis")
);

/* Water Column Studio: lazy so the Three.js scene and its
   dependencies never enter the main bundle (globe-first load). */
const OceanWaterColumnStudio = lazy(
  () => import("./components/OceanWaterColumnStudio")
);

/* 3D Depth Slice viewer (Temperature only): lazy, isolated
   Three.js panel sharing the app's single depth state. */
/* Real slice info for the Temperature legend (real min/max labels).
   Same shared slice cache as the globe + depth panel — no extra fetch. */
import { getRealTemperatureSliceInfo } from "./data/realDataProvider";

const TemperatureDepthSlice3D = lazy(
  () => import("./components/TemperatureDepthSlice3D")
);

import AskTheOceanPanel from "./components/AskTheOceanPanel";


/* ============================================================
   CAMERA LOCATIONS
============================================================ */

const LOCATIONS = {
  ARABIAN_SEA: {
    lat: 15,
    lon: 67.5,
    distance: 4.6,
  },

  BAY_OF_BENGAL: {
    lat: 15,
    lon: 89,
    distance: 4.6,
  },

  INDIAN_OCEAN: {
    lat: -7.5,
    lon: 90,
    distance: 5.2,
  },
};


/* Coastal pinpoint locations.  The existing PinpointMarker animation is reused. */
const COASTAL_LINE_LOCATIONS = {
  MUMBAI_COAST: { lat: 19.076, lon: 72.8777, distance: 3.0 },
  KOCHI_COAST: { lat: 9.9312, lon: 76.2673, distance: 3.0 },
  CHENNAI_COAST: { lat: 13.0827, lon: 80.2707, distance: 3.0 },
};

/*
  FULL-GLOBE OVERVIEW ALTITUDE.

  Cesium's default FOV is the HORIZONTAL field of view on wide
  canvases, so the vertical FOV shrinks as the window gets wider —
  a fixed altitude crops the sphere top/bottom ("only 3/4 of the
  globe visible"). This computes the altitude at which the whole
  sphere fits the viewport vertically (88% fill, comfortable
  margin) from the actual canvas aspect ratio.
*/
/* Deterministic per-location hash in [0,1) — shared by the currents
   and salinity renderers so neither shows a regular lattice. */
function hash01(lat, lon) {
  const s = Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/* Ocean-clip tolerance for the current streamlines (degrees).
   The shared polygon mask is coarse near coasts; particles spawned
   or advected within this band of land are dropped, so no trail
   ever crosses India, Africa, Sri Lanka or island coastlines. */
const CURRENT_COAST_BUFFER_DEG = 0.45;

function isOceanForCurrents(lat, lon) {
  return (
    isOcean(lat, lon) &&
    isOcean(lat + CURRENT_COAST_BUFFER_DEG, lon) &&
    isOcean(lat - CURRENT_COAST_BUFFER_DEG, lon) &&
    isOcean(lat, lon + CURRENT_COAST_BUFFER_DEG) &&
    isOcean(lat, lon - CURRENT_COAST_BUFFER_DEG)
  );
}

function computeFullGlobeHeight(viewer) {
  const canvas = viewer?.canvas;
  const width = canvas?.clientWidth || window.innerWidth || 1280;
  const height = canvas?.clientHeight || window.innerHeight || 720;
  const aspect = width / Math.max(height, 1);

  const fov = viewer?.camera?.frustum?.fov || Math.PI / 3;
  const fovy = aspect >= 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspect) : fov;

  const EARTH_RADIUS = 6371000;
  /* 0.80 fill: the whole sphere fits with a comfortable margin on
     all sides instead of touching/cropping at the viewport edges. */
  const halfFov = Math.min((fovy / 2) * 0.8, Math.PI / 2.2);
  return Math.max(EARTH_RADIUS / Math.sin(halfFov) - EARTH_RADIUS, 8000000);
}


/* ============================================================
   SEARCHABLE HAZARDS
============================================================ */

const SEARCHABLE_HAZARDS = [
  {
    name: "Tsunami Warning",
    icon: "⚠️",
    description: "Active tsunami alerts",
  },

  {
    name: "Earthquakes",
    icon: "◈",
    description: "Recent seismic activity",
  },

  {
    name: "Cyclones",
    icon: "🌀",
    description: "Tropical cyclone tracking",
  },

  {
    name: "Storm Surge",
    icon: "🌊",
    description: "Coastal surge risk",
  },
];


/* ============================================================
   TEMPERATURE SYSTEM
============================================================ */


/*
  Thermal thresholds.

  NORMAL  < 29°C  -> GREEN
  MEDIUM 29-31°C  -> GREEN -> YELLOW -> RED
  HIGH   >= 31°C  -> RED

  These values can later be replaced by backend values.
*/

const NORMAL_TEMPERATURE_LIMIT = 29;

const HIGH_TEMPERATURE_LIMIT = 31;/* ============================================================
   DATA-PROVIDER BOUNDARY (§9/§15)

   App.jsx never computes ocean values itself. Every layer reads
   normalized records from src/data/demoData.js:

     getDemoFieldTexture(kind, depth, t) -> continuous color field
     getDemo<Var>PointAt(lat, lon, t)     -> info-box records
     getDemoCurrentVectors(depth, t)      -> 2° U/V grid

   DEMO_MODE_ACTIVE switches the effects below between the demo
   provider and a future fetchModelField() pipeline returning
   the SAME shapes. Swapping the source never touches rendering.
============================================================ */


/* ============================================================
   CESIUM OCEAN GLOBE

   Runtime globe is now fully CesiumJS. The existing React UI,
   camera-location state, depth state, layer state, coastal
   pinpoint state, and warning state remain unchanged.
============================================================ */

function CesiumOceanGlobe({
  activeLayer,
  depth,
  lightMode,
  visibleLayers,
  activeWarning,
  coastalPinpoint,
  activeLocation,
  cameraState,
  playbackEpoch,
  reportOpen,
  onDataInfo,
  onCameraMove,
  onAnimationComplete,
}) {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const animationRef = useRef(null);
  const flightGenRef = useRef(0);
  const flightSafetyRef = useRef(null);
  const currentLinesRef = useRef(null);
  const dataPointsRef = useRef(null);
  const salinityRecordsRef = useRef(null);
  const lastInteractionRef = useRef(0);
  /* One-way latch: once the user interacts OR a location flight is
     triggered, the idle auto-spin never resumes for the session. */
  const autoSpinDisabledRef = useRef(false);
  const prevReportOpenRef = useRef(false);
  const warningEntityRef = useRef(null);
  const pinPrimitivesRef = useRef(null);
  const satelliteLayerRef = useRef(null);
  const fieldLayerRef = useRef(null);
  const fieldUrlRef = useRef(null);
  const currentParticlesRef = useRef(null);
  const currentSeedsRef = useRef(null);
  const currentTrailLinesRef = useRef(null);

  /*
    Continuous-field layers (Temperature / Chlorophyll) paint a
    shared equirectangular canvas into an imagery layer. One
    canvas, one putImageData, one toDataURL per (kind, depth,
    timestep) — cached by the provider so playback repaints are
    just a provider lookup + layer URL swap.
  */
  const paintFieldLayer = (kind, depth, t) => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    const texture = getDemoFieldTexture(kind, depth, t);
    if (!texture) return;

    if (fieldLayerRef.current) {
      viewer.imageryLayers.remove(fieldLayerRef.current, true);
      fieldLayerRef.current = null;
      fieldUrlRef.current = null;
    }

    try {
      const layer = viewer.imageryLayers.addImageryProvider(
        new Cesium.SingleTileImageryProvider({
          url: texture.url,
          tileWidth: texture.width,
          tileHeight: texture.height,
        })
      );
      layer.alpha = 0.72;
      fieldLayerRef.current = layer;
      fieldUrlRef.current = texture.url;
    } catch (error) {
      console.warn(`[RATNAKARA] ${kind} field layer failed; hiding overlay.`, error);
    }
  };

  const clearFieldLayer = () => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    if (fieldLayerRef.current) {
      viewer.imageryLayers.remove(fieldLayerRef.current, true);
      fieldLayerRef.current = null;
      fieldUrlRef.current = null;
    }
  };



  const flyToLocation = (location) => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !location) return;

    /* Location selection (ocean buttons, coastal pins) stops the
       idle spin permanently — the globe stays stationary on
       arrival and never auto-rotates again (§4/§8). */
    autoSpinDisabledRef.current = true;

    /* Flight generation: only the LATEST flight may touch camera
       state, so a canceled predecessor can never fight the new
       flight (§12: new flight safely replaces the old one). */
    const gen = ++flightGenRef.current;
    if (flightSafetyRef.current) clearTimeout(flightSafetyRef.current);
    viewer.camera.cancelFlight();

    /* distance >= 20 marks the full-globe overview: fit the ENTIRE
       sphere to the viewport instead of a fixed altitude. */
    const height =
      Number(location.distance) >= 20
        ? computeFullGlobeHeight(viewer)
        : Number(location.distance)
          ? Math.max(900000, Number(location.distance) * 700000)
          : 2600000;

    const finish = () => {
      if (flightSafetyRef.current) {
        clearTimeout(flightSafetyRef.current);
        flightSafetyRef.current = null;
      }
      if (flightGenRef.current === gen) onAnimationComplete?.();
    };

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(Number(location.lon), Number(location.lat), height),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        /* Straight-down view: the target ocean sits centered and the
           post-flight orientation is the natural interactive one. */
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration: 1.6,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: finish,
      cancel: finish,
    });

    /* Safety net: even if Cesium never fires complete/cancel, the
       app returns to interactive state (never stuck). */
    flightSafetyRef.current = setTimeout(finish, 2400);
  };

  /* ============================================================
     CESIUM VIEWER

     Cesium ion is optional at runtime:
     - Token present  -> ion imagery (asset 3813, free
       Earth-at-night asset usable without a subscription) and
       Cesium World Terrain.
     - Token missing / ion failing -> ArcGIS World Imagery tiles
       over an OSM base, and ArcGIS World Elevation terrain.
     - Everything failing -> plain Cesium ellipsoid globe.

     A bad imagery layer is removed at runtime; it can never
     take the globe down. Terrain failure only falls back to
     the ellipsoid. No token value is ever rendered to the DOM.
  ============================================================ */
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return undefined;

    let destroyed = false;
    let satelliteErrorListener = null;

    const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: false,
      baseLayerPicker: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      vrButton: false,
      shouldAnimate: true,
      shadows: false,
      terrainShadows: Cesium.ShadowMode.DISABLED,
      msaaSamples: 4,
    });

    viewerRef.current = viewer;

    /* Dev/testing hook: lets the acceptance harness read the live camera.
       Harmless in production, cleared on unmount. */
    if (typeof window !== "undefined") window.__RATNAKARA_VIEWER__ = viewer;

    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.showGroundAtmosphere = true;
    viewer.scene.globe.depthTestAgainstTerrain = true;

    /* Clearer regional zoom without weighting the initial load (§6).
       2.0 = fast, crisp world view. Over India the globe refines
       harder before displaying, so close-ups resolve sharp tiles.
       Tile cache bias keeps recent India tiles resident while the
       user pans/zooms around the region. */
    viewer.scene.globe.maximumScreenSpaceError = 2.0;
    viewer.scene.globe.tileCacheSize = 1000;

    viewer.scene.highDynamicRange = false;
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(
      lightMode ? "#bfe9f7" : "#020b14"
    );

    /* Regional zoom constraints (§2). The controller defaults
       (1 m .. infinity) let the camera collide with terrain and
       stall mid-way to India; these bounds keep zoom useful. */
    const controller = viewer.scene.screenSpaceCameraController;
    controller.minimumZoomDistance = 70000;   /* 70 km — closest useful regional view */
    controller.maximumZoomDistance = 30000000; /* 30,000 km — full-globe overview always fits */
    controller.enableCollisionDetection = true;

    /* Initial view: the ENTIRE sphere visible, centered, with a
       comfortable margin — altitude fitted to this viewport. */
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(82, 10, computeFullGlobeHeight(viewer)),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
    });

    /* Reliable no-token base map UNDERNEATH satellite imagery. Esri
       World Base Map is a clean satellite-style map — OSM's labeled
       street tiles are what made the globe read as an "index map". */
    try {
      const basemap = new Cesium.UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        credit: "Esri World Imagery",
        maximumLevel: 19,
        enablePickFeatures: false,
      });
      viewer.imageryLayers.addImageryProvider(basemap);
    } catch (error) {
      console.warn("[RATNAKARA] Base map unavailable; keeping Cesium ellipsoid.", error);
    }

    /* Real satellite imagery. If its image decoding fails, remove only
       this layer; the globe and base map remain alive. */
    const removeBrokenSatelliteLayer = (error) => {
      console.warn("[RATNAKARA] Satellite imagery tile failed; using base map.", error);
      if (satelliteLayerRef.current && !viewer.isDestroyed()) {
        viewer.imageryLayers.remove(satelliteLayerRef.current, true);
        satelliteLayerRef.current = null;
        viewer.scene.requestRender();
      }
    };

    const installSatelliteErrorGuard = (provider, layer) => {
      satelliteLayerRef.current = layer;
      satelliteErrorListener = (error) => removeBrokenSatelliteLayer(error);
      provider.errorEvent.addEventListener(satelliteErrorListener);
    };

    /* Country/place labels over the satellite imagery (normal map
       names, no reference-map look). Added directly ABOVE the
       satellite layer so it stacks correctly. */
    const addReferenceLabels = () => {
      if (destroyed || viewer.isDestroyed()) return;
      try {
        viewer.imageryLayers.addImageryProvider(
          new Cesium.UrlTemplateImageryProvider({
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
            credit: "Esri Reference Labels",
            maximumLevel: 19,
            enablePickFeatures: false,
          })
        );
      } catch (error) {
        console.warn("[RATNAKARA] Reference labels unavailable.", error);
      }
    };

    const addSatelliteFromIon = () =>
      Cesium.IonImageryProvider.fromAssetId(3813)
        .then((provider) => {
          if (destroyed || viewer.isDestroyed()) return;
          const layer = viewer.imageryLayers.addImageryProvider(provider);
          installSatelliteErrorGuard(provider, layer);
          addReferenceLabels();
        });

    const addSatelliteFromArcGIS = () => {
      if (destroyed || viewer.isDestroyed()) return;
      try {
        const satellite = new Cesium.UrlTemplateImageryProvider({
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          credit: "Esri World Imagery",
          maximumLevel: 19,
          enablePickFeatures: false,
        });
        const layer = viewer.imageryLayers.addImageryProvider(satellite);
        installSatelliteErrorGuard(satellite, layer);
        addReferenceLabels();
      } catch (error) {
        console.warn("[RATNAKARA] Satellite imagery unavailable; using base map.", error);
      }
    };

    if (ionToken) {
      /* Cesium ion reads its default token from Ion.defaultAccessToken;
         the token value is never printed or shown in the UI. */
      Cesium.Ion.defaultAccessToken = ionToken;

      addSatelliteFromIon().catch((error) => {
        console.warn("[RATNAKARA] Cesium ion imagery unavailable; using fallback tiles.", error);
        addSatelliteFromArcGIS();
      });

      /* Real elevation terrain. Failure is non-fatal: the globe
         falls back to Cesium's ellipsoid. */
      Cesium.createWorldTerrainAsync()
        .then((terrainProvider) => {
          if (!destroyed && !viewer.isDestroyed()) viewer.terrainProvider = terrainProvider;
        })
        .catch((error) => {
          console.warn("[RATNAKARA] Cesium World Terrain unavailable; using ellipsoid.", error);
        });
    } else {
      addSatelliteFromArcGIS();

      Promise.resolve()
        .then(() => Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
          "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer"
        ))
        .then((terrainProvider) => {
          if (!destroyed && !viewer.isDestroyed()) viewer.terrainProvider = terrainProvider;
        })
        .catch((error) => {
          console.warn("[RATNAKARA] Terrain unavailable; using ellipsoid.", error);
        });
    }

    return () => {
      destroyed = true;
      satelliteErrorListener = null;
      satelliteLayerRef.current = null;
      if (!viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
      if (typeof window !== "undefined") window.__RATNAKARA_VIEWER__ = undefined;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(
      lightMode ? "#bfe9f7" : "#020b14"
    );
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(
      lightMode ? "#78c9d9" : "#123d4f"
    );
    viewer.scene.requestRender();
  }, [lightMode]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const controller = viewer.scene.screenSpaceCameraController;
    /* Camera input is NEVER disabled: zoom/rotate/pan must keep
       working during location flights and data animations. User
       input during a flight is handled by cancelFlight in the
       interaction handlers below instead of disabling controls. */
    controller.enableRotate = true;
    controller.enableZoom = true;
    controller.enableTranslate = true;
    controller.enableTilt = true;
    controller.enableLook = true;
  }, [cameraState]);

  /* ============================================================
     CAMERA AUTHORITY — idle rotation + interaction handover

     ONE system owns automatic camera behavior:
       - Idle (no input for IDLE_ROTATION_DELAY_MS, camera state
         'idle', report closed): slow museum-style spin via
         camera.rotate in preRender.
       - ANY user input (drag/wheel) marks activity and stops the
         spin immediately; it resumes after the idle delay.
       - Input during a camera flight cancels the flight; the
         flight's cancel callback restores 'idle' + controls.
       - Report open: no background rotation; on close a single
         requestRender nudges the canvas back cleanly.
  ============================================================ */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return undefined;

    const canvas = viewer.canvas;
    const IDLE_ROTATION_DELAY_MS = 5000;
    const ROTATION_RATE = 0.015; /* rad/s — slow display-globe spin */

    const markActivity = () => {
      lastInteractionRef.current = performance.now();
      /* Manual camera control takes permanent precedence (§8): the
         idle spin must not restart after this. */
      autoSpinDisabledRef.current = true;
    };

    const onPointerDown = (event) => {
      markActivity();
      /* A click/drag during a flight hands control back to the
         user immediately (§13): cancelFlight triggers the flight's
         cancel callback -> cameraState 'idle' -> controls on. */
      if (cameraState !== "idle" && !viewer.isDestroyed()) {
        viewer.camera.cancelFlight();
      }
    };
    const onPointerMove = (event) => {
      if (event.buttons > 0) markActivity();
    };
    const onWheel = (event) => {
      markActivity();
      if (cameraState !== "idle" && !viewer.isDestroyed()) {
        viewer.camera.cancelFlight();
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", markActivity);
    canvas.addEventListener("wheel", onWheel, { passive: true });

    let lastFrame = performance.now();
    const spin = () => {
      if (viewerRef.current == null || viewer.isDestroyed()) return;
      const now = performance.now();
      const delta = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;

      const inactive = now - lastInteractionRef.current > IDLE_ROTATION_DELAY_MS;
      if (autoSpinDisabledRef.current) return;
      if (inactive && cameraState === "idle" && !reportOpen) {
        viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -ROTATION_RATE * delta);
      }
    };
    viewer.scene.preRender.addEventListener(spin);

    /* Report just closed (transition only): nudge one clean render
       so the returning canvas has no stale frame artifacts (§19). */
    if (prevReportOpenRef.current === true && reportOpen === false) {
      viewer.scene.requestRender();
    }
    prevReportOpenRef.current = reportOpen;

    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.preRender.removeEventListener(spin);
      }
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", markActivity);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [cameraState, reportOpen]);

  useEffect(() => {
    if (activeLocation) flyToLocation(activeLocation);
  }, [activeLocation]);

  /* Selecting a data layer (temperature/salinity/currents/...) also
     hands camera control to the user permanently (§8): no idle spin
     resume after layer switches. */
  useEffect(() => {
    if (activeLayer) {
      autoSpinDisabledRef.current = true;
    }
  }, [activeLayer]);

  /* Existing pinpoint/warning behavior preserved. */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (warningEntityRef.current) {
      viewer.entities.remove(warningEntityRef.current);
      warningEntityRef.current = null;
    }

    /* Pinpoint primitives (glow / ring / beacon) live outside the
       entity so they must be removed here too. */
    if (pinPrimitivesRef.current && !viewer.isDestroyed()) {
      const { pointPrims, beaconPrims } = pinPrimitivesRef.current;
      viewer.scene.primitives.remove(pointPrims);
      viewer.scene.primitives.remove(beaconPrims);
    }
    pinPrimitivesRef.current = null;

    const point = activeWarning || coastalPinpoint;
    if (!point) return;

    /* Normalize case so "HIGH"/"MEDIUM" from CoastalWarning.jsx map
       correctly (matches PinpointMarker's severity colors). */
    const severity = String(activeWarning?.severity || "high").toLowerCase();
    const color = severity === "high" || severity === "critical"
      ? Cesium.Color.RED
      : Cesium.Color.ORANGE;

    const entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 3500),
      point: {
        pixelSize: 13,
        color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      ellipse: {
        semiMajorAxis: 22000,
        semiMinorAxis: 22000,
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.08)),
        outline: true,
        outlineColor: color.withAlpha(0.75),
        height: 3500,
      },
    });

    warningEntityRef.current = entity;

    /* ========================================================
       CESIUM PINPOINT RENDERING — the PinpointMarker component
       (components/CoastalWarning.jsx) animates a Three.js pin
       (glow sphere + expanding ring + beacon) that never mounted
       in this Cesium-only runtime, so no pin icon appeared on the
       globe. The SAME animation is attached here as persistent
       Cesium primitives at the same coordinates: identical colors
       (severity-driven), identical pulse/ring timing formulas and
       sizes. disableDepthTestDistance = INFINITY keeps the pin
       visible through zoom/rotate/flight, attached to the surface.
    ========================================================= */
    const position = Cesium.Cartesian3.fromDegrees(
      point.longitude,
      point.latitude,
      3500
    );

    const pointPrims = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection()
    );

    const glow = pointPrims.add({
      position,
      pixelSize: 14,
      color: color.withAlpha(0.6),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });

    const ring = pointPrims.add({
      position,
      pixelSize: 14,
      color: color.withAlpha(0.5),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });

    const beaconPrims = viewer.scene.primitives.add(
      new Cesium.PolylineCollection()
    );
    const beacon = beaconPrims.add({
      positions: [
        Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 0),
        Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 60000),
      ],
      width: 2,
      material: Cesium.Material.fromType("Color", {
        color: color.withAlpha(0.5),
      }),
    });

    pinPrimitivesRef.current = { pointPrims, beaconPrims, glow, ring, beacon, baseColor: color };

    viewer.scene.requestRender();

    return () => {
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.entities.remove(entity);
        if (pinPrimitivesRef.current) {
          const { pointPrims, beaconPrims } = pinPrimitivesRef.current;
          viewerRef.current.scene.primitives.remove(pointPrims);
          viewerRef.current.scene.primitives.remove(beaconPrims);
        }
        pinPrimitivesRef.current = null;
      }
    };
  }, [activeWarning, coastalPinpoint]);

  /* ============================================================
     CONTINUOUS DATA FIELDS — Temperature / Chlorophyll (§8/§13)

     The demo provider paints one land-masked equirectangular
     canvas per (kind, depth, timestep). It is added as an
     imagery layer so it drapes on the globe exactly like a
     real satellite product, with the Sentinel imagery kept
     underneath (land pixels stay transparent).
  ============================================================ */

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const kind =
      activeLayer === "Temperature" && visibleLayers.temperature
        ? "temperature"
        : activeLayer === "Chlorophyll"
          ? "chlorophyll"
          : null;

    if (!kind) {
      if (fieldLayerRef.current) {
        viewer.imageryLayers.remove(fieldLayerRef.current, true);
        fieldLayerRef.current = null;
        fieldUrlRef.current = null;
        viewer.scene.requestRender();
      }
      return;
    }

    const t = demoTimeToStep(playbackEpoch).stepIndex;
    paintFieldLayer(kind, kind === "chlorophyll" ? 0 : depth, t);
    viewer.scene.requestRender();
  }, [activeLayer, depth, visibleLayers.temperature, playbackEpoch]);

  /* ============================================================
     SALINITY — scattered observation points (§10)

     Jittered lattice from the provider (no straight-line
     pattern). Each point carries its normalized record and
     opens the info box on click.
  ============================================================ */

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (dataPointsRef.current) {
      viewer.scene.primitives.remove(dataPointsRef.current);
      dataPointsRef.current = null;
    }

    if (activeLayer !== "Salinity" || !visibleLayers.salinity) {
      salinityRecordsRef.current = null;
      if (onDataInfo) onDataInfo(null);
      viewer.scene.requestRender();
      return;
    }

    const t = demoTimeToStep(playbackEpoch).stepIndex;
    const points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());

    /* White/light irregular particles (§2): jittered lattice from
       the provider, size/opacity gently modulated by value so
       concentration reads as density — never a color heatmap. */
    const records = [];

    for (const record of getDemoSalinityPoints(depth, t)) {
      const intensity = Cesium.Math.clamp((record.value - 31) / 6, 0, 1);
      const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, 4200);

      points.add({
        position,
        pixelSize: 5.5 + intensity * 4.5,
        color: Cesium.Color.fromCssColorString("#f4fbff").withAlpha(0.55 + intensity * 0.4),
        outlineColor: Cesium.Color.fromCssColorString("#bdefff").withAlpha(0.35),
        outlineWidth: 1,
        disableDepthTestDistance: 200000,
        id: { ratnakaraData: record },
      });

      /* Parallel (record, position) list so the click handler can
         project positions to screen space for a small hit-region
         fallback — the visible particles stay exactly as they are. */
      records.push({ record, position });
    }

    salinityRecordsRef.current = records;
    dataPointsRef.current = points;
    viewer.scene.requestRender();

    return () => {
      if (viewerRef.current && !viewerRef.current.isDestroyed() && dataPointsRef.current === points) {
        viewerRef.current.scene.primitives.remove(points);
        dataPointsRef.current = null;
      }
      salinityRecordsRef.current = null;
    };
  }, [activeLayer, depth, visibleLayers.salinity, playbackEpoch]);

  /* Click-to-inspect (§10/§11): salinity points pick directly;
     temperature / chlorophyll sample the active continuous
     field at the clicked globe position. */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !onDataInfo) return undefined;

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);

    const HIT_REGION_PX = 14; /* invisible pick tolerance around a particle */

    handler.setInputAction((movement) => {
      /* 1 — Direct pick, drilling past any overlaying primitives so
         an observation is found even when something renders over it. */
      let picked = null;
      try {
        /* 14px tolerance matches the screen-space fallback below so
           synthetic/edge clicks reliably hit the small particles. */
        const hits = viewer.scene.drillPick(movement.position, 4, 14, 14);
        picked = hits.find((h) => Cesium.defined(h) && h.id?.ratnakaraData) || null;
      } catch {
        picked = null;
      }
      if (!picked) {
        const single = viewer.scene.pick(movement.position);
        if (Cesium.defined(single) && single.id?.ratnakaraData) picked = single;
      }

      if (picked) {
        const record = picked.id.ratnakaraData;
        const t = demoTimeToStep(playbackEpoch).stepIndex;
        onDataInfo(
          getDemoSalinityPointAt(record.latitude, record.longitude, depth, t, playbackEpoch)
        );
        return;
      }

      /* 2 — Screen-space hit-region fallback: project each salinity
         observation to window coordinates and accept the nearest one
         within HIT_REGION_PX. Purely hit detection — the visible
         particles are unchanged. Horizon test keeps far-side points
         (hidden behind the globe) from matching near the limb. */
      if (activeLayer === "Salinity" && salinityRecordsRef.current?.length) {
        const cartesian = viewer.camera.pickEllipsoid(
          movement.position,
          viewer.scene.globe.ellipsoid
        );
        if (!cartesian) {
          onDataInfo(null);
          return;
        }

        const cameraPos = viewer.camera.positionWC;
        const windowPos = new Cesium.Cartesian2();
        const sub = new Cesium.Cartesian3();
        let best = null;
        let bestDist = HIT_REGION_PX * HIT_REGION_PX;

        for (const item of salinityRecordsRef.current) {
          /* Hidden-behind-globe test: dot(P − C, P) >= 0 → beyond horizon. */
          Cesium.Cartesian3.subtract(item.position, cameraPos, sub);
          if (Cesium.Cartesian3.dot(sub, item.position) >= 0) continue;

          const win = Cesium.SceneTransforms.worldToWindowCoordinates(
            viewer.scene,
            item.position,
            windowPos
          );
          if (!win) continue;

          const dx = win.x - movement.position.x;
          const dy = win.y - movement.position.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDist) {
            bestDist = distSq;
            best = item;
          }
        }

        if (best) {
          const t = demoTimeToStep(playbackEpoch).stepIndex;
          onDataInfo(
            getDemoSalinityPointAt(
              best.record.latitude,
              best.record.longitude,
              depth,
              t,
              playbackEpoch
            )
          );
        }
        return;
      }

      if (activeLayer !== "Temperature" && activeLayer !== "Chlorophyll") return;

      const cartesian = viewer.camera.pickEllipsoid(
        movement.position,
        viewer.scene.globe.ellipsoid
      );
      if (!cartesian) {
        onDataInfo(null);
        return;
      }

      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const t = demoTimeToStep(playbackEpoch).stepIndex;

      const info =
        activeLayer === "Temperature"
          ? getDemoTemperaturePointAt(lat, lon, depth, t, playbackEpoch)
          : getDemoChlorophyllPointAt(lat, lon, t, playbackEpoch);

      onDataInfo(info);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    return () => handler.destroy();
  }, [activeLayer, depth, playbackEpoch, onDataInfo]);

  /* Camera lat/lon readout for the playback bar (§7). */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !onCameraMove) return undefined;

    let lastUpdate = 0;
    const listener = () => {
      const now = performance.now();
      if (now - lastUpdate < 300) return;
      lastUpdate = now;
      const carto = viewer.camera.positionCartographic;
      if (!carto) return;
      onCameraMove({
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
      });
    };

    viewer.scene.preRender.addEventListener(listener);
    /* Guard against the StrictMode mount/unmount cycle: the
       viewer-creation cleanup may already have destroyed the
       viewer when this cleanup runs. */
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.preRender.removeEventListener(listener);
      }
    };
  }, [onCameraMove]);

  /* ============================================================
     CURRENTS — flowing particle trails (§12)

     A persistent particle pool is advected EVERY FRAME through
     the provider's U/V field (nearest-cell bilinear velocity).
     Each particle leaves a long, curved, fading trail on the
     globe: hundreds of continuous wave-like streamlines that
     follow the real vector field. Particles spawn ONLY in ocean
     (shared land mask + coast buffer), pause on contact with
     land, and respawn elsewhere — trails never cross land.
     Speed drives both motion rate and trail brightness.
  ============================================================ */

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (currentLinesRef.current) {
      viewer.scene.primitives.remove(currentLinesRef.current);
      currentLinesRef.current = null;
    }

    if (activeLayer !== "Currents" || !visibleLayers.current) {
      if (onDataInfo) onDataInfo(null);
      viewer.scene.requestRender();
      return;
    }

    const t = demoTimeToStep(playbackEpoch).stepIndex;
    const vectors = getDemoCurrentVectors(depth, t);

    /* Bilinear velocity lookup over the provider's 2° vector grid.
       Sparse land cells carry (0,0) so advection naturally bends
       around coastlines instead of skipping across them. */
    const CELL = 2;
    const cellMap = new Map();
    for (const vector of vectors) {
      cellMap.set(`${vector.latitude},${vector.longitude}`, vector);
    }
    for (let lat = -30; lat <= 28; lat += CELL) {
      for (let lon = 46; lon <= 100; lon += CELL) {
        const key = `${lat},${lon}`;
        if (!cellMap.has(key)) {
          cellMap.set(key, { latitude: lat, longitude: lon, u: 0, v: 0, speed: 0 });
        }
      }
    }

    const fieldAt = (lat, lon) => {
      const gx = lon / CELL;
      const gy = lat / CELL;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const lon0 = x0 * CELL;
      const lat0 = y0 * CELL;
      const v00 = cellMap.get(`${lat0},${lon0}`);
      const v10 = cellMap.get(`${lat0},${lon0 + CELL}`);
      const v01 = cellMap.get(`${lat0 + CELL},${lon0}`);
      const v11 = cellMap.get(`${lat0 + CELL},${lon0 + CELL}`);
      if (!v00 || !v10 || !v01 || !v11) return null;

      const tx = gx - x0;
      const ty = gy - y0;
      const u =
        v00.u * (1 - tx) * (1 - ty) +
        v10.u * tx * (1 - ty) +
        v01.u * (1 - tx) * ty +
        v11.u * tx * ty;
      const v =
        v00.v * (1 - tx) * (1 - ty) +
        v10.v * tx * (1 - ty) +
        v01.v * (1 - tx) * ty +
        v11.v * tx * ty;
      return { u, v };
    };

    const speedAt = (lat, lon) => {
      const f = fieldAt(lat, lon);
      if (!f) return 0;
      return Math.sqrt(f.u * f.u + f.v * f.v);
    };

    /* ------- Ocean-clip seed sampling (mask-aware placement) ------- */

    const TRAIL_COUNT = 620;
    const seeds = [];

    /* Deterministic hash stream: every call walks the SAME sequence
       of candidate points, so initial fill and respawns never exhaust
       a global attempt budget (respawns must always find a spot). */
    let spawnCounter = 0;
    const spawnCurrentParticle = () => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        spawnCounter += 1;
        const h1 = hash01(spawnCounter * 0.731, spawnCounter * 1.317);
        const h2 = hash01(spawnCounter * 2.113, spawnCounter * 0.559);
        const lat = -30 + h1 * 56;
        const lon = 46 + h2 * 54;

        if (!isOceanForCurrents(lat, lon)) continue;
        const speed = speedAt(lat, lon);
        if (speed < 0.05) continue;

        return {
          lat,
          lon,
          trail: [],
          life: 0,
          offset: hash01(lon * 7.13, lat * 5.77),
          speed,
          paused: 0,
        };
      }
      return null;
    };

    for (let i = 0; i < TRAIL_COUNT; i += 1) {
      const seed = spawnCurrentParticle();
      if (seed) seeds.push(seed);
    }

    /* ------- Trail polylines (persistent, updated in place) ------- */

    const lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    const TRAIL_LIFE_FRAMES = 130;
    const TIME_SCALE = 0.36; /* u/v magnitude -> degrees/frame */
    const TRAIL_HEIGHT = 4500;
    const TRAIL_MAX_POINTS = 130;

    const trailLines = [];
    const scratchColor = new Cesium.Color();

    for (const seed of seeds) {
      const speedNorm = Math.min(1, seed.speed / 0.9);
      const line = lines.add({
        positions: [],
        width: 1.1 + speedNorm * 0.9,
        material: Cesium.Material.fromType("Color", {
          color: Cesium.Color.fromCssColorString("#bdf3ff").withAlpha(0.85),
        }),
      });
      trailLines.push(line);

      /* Pre-charge a short starter trail (field-sized steps, ~0.3°
         apart) so particles never read as lone dots during the
         first seconds. */
      let sLat = seed.lat;
      let sLon = seed.lon;
      for (let k = 0; k < 6; k += 1) {
        seed.trail.push(Cesium.Cartesian3.fromDegrees(sLon, sLat, TRAIL_HEIGHT));
        const f = fieldAt(sLat, sLon);
        if (!f) break;
        sLat += f.v * TIME_SCALE * 2.2;
        sLon += f.u * TIME_SCALE * 2.2;
        if (!isOceanForCurrents(sLat, sLon)) break;
      }
      line.positions = seed.trail;
    }

    currentLinesRef.current = lines;
    currentSeedsRef.current = seeds;
    currentTrailLinesRef.current = trailLines;

    let frameIndex = 0;
    let lastFrameMs = performance.now();

    const tick = () => {
      const allSeeds = currentSeedsRef.current;
      const allLines = currentTrailLinesRef.current;
      if (!allSeeds || !allLines || viewer.isDestroyed()) return;

      const nowMs = performance.now();
      const dt = Math.min((nowMs - lastFrameMs) / 16.667, 3);
      lastFrameMs = nowMs;

      /* Background-tab throttle: Cesium's clock keeps ticking while
         requestAnimationFrame is suspended, so without this guard
         particles teleport or stall after tab switches. */
      if (typeof document !== "undefined" && document.hidden) {
        frameIndex = (frameIndex + 1) % 4;
        if (frameIndex !== 0) return;
      }

      let fieldTouched = false;

      for (let i = 0; i < allSeeds.length; i += 1) {
        const seed = allSeeds[i];

        /* Fields refresh each timestep; re-sample speed so trails
           brighten/dim with the live field. */
        const speed = speedAt(seed.lat, seed.lon);
        seed.speed = speed;
        const speedNorm = Math.min(1, speed / 0.9);

        /* Wait out land contact — the trail freezes and the particle
           resumes flowing when the field carries it clear again. */
        if (seed.paused > 0) {
          seed.paused -= dt;
        } else if (speed >= 0.02) {
          const f = fieldAt(seed.lat, seed.lon);
          if (f) {
            const nextLat = seed.lat + f.v * TIME_SCALE * dt;
            const nextLon = seed.lon + f.u * TIME_SCALE * dt;

            if (nextLat < -34 || nextLat > 30 || nextLon < 42 || nextLon > 104) {
              seed.life = TRAIL_LIFE_FRAMES;
            } else if (!isOcean(nextLat, nextLon)) {
              seed.paused = 12;
            } else {
              seed.lat = nextLat;
              seed.lon = nextLon;
              seed.trail.push(
                Cesium.Cartesian3.fromDegrees(seed.lon, seed.lat, TRAIL_HEIGHT)
              );
            }
          }
        }

        seed.life += dt;
        let fadedOut = false;
        if (seed.life >= TRAIL_LIFE_FRAMES) {
          if (seed.trail.length > 2) {
            const cut = Math.max(1, Math.floor(seed.trail.length * 0.06 * dt));
            seed.trail.splice(0, cut);
          } else {
            fadedOut = true;
          }
        } else if (seed.trail.length > TRAIL_MAX_POINTS) {
          seed.trail.splice(0, seed.trail.length - TRAIL_MAX_POINTS);
        }

        if (fadedOut) {
          const fresh = spawnCurrentParticle();
          if (fresh) {
            allSeeds[i] = fresh;
            allLines[i].positions = [];
          } else {
            allSeeds[i].life = 0;
            allSeeds[i].trail.length = 0;
          }
          continue;
        }

        fieldTouched = true;

        /* Advection steps are <0.5°, so chords between consecutive
           points read as smooth curves on the globe. Positions are
           assigned every frame (PolylineCollection rebuilds from
           its array); alpha is quantized so the Color material only
           re-uploads when the speed band actually changes. */
        const line = allLines[i];
        if (line) {
          line.positions = seed.trail;
          const alpha = Math.min(0.85, 0.3 + 0.55 * speedNorm);
          const quantized = Math.round(alpha * 8) / 8;
          if (seed.alphaBand !== quantized) {
            seed.alphaBand = quantized;
            Cesium.Color.fromCssColorString("#e9fcff", scratchColor);
            scratchColor.alpha = quantized;
            line.material.uniforms.color = scratchColor;
          }
        }
      }

      /* Only force a render when particle geometry actually moved —
         keeps the idle spin's requestRender cadence authoritative
         and avoids a redundant second render pass per frame. */
      if (fieldTouched) viewer.scene.requestRender();
    };

    const removeListener = viewer.clock.onTick.addEventListener(tick);

    return () => {
      removeListener();
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.scene.primitives.remove(lines);
      }
      if (currentLinesRef.current === lines) currentLinesRef.current = null;
      currentParticlesRef.current = null;
      currentSeedsRef.current = null;
      currentTrailLinesRef.current = null;
    };
  }, [activeLayer, depth, visibleLayers.current, playbackEpoch]);

  /* Existing red pinpoint pulse preserved. */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !warningEntityRef.current) return;

    const entity = warningEntityRef.current;
    const prims = pinPrimitivesRef.current;
    const start = performance.now();
    const listener = () => {
      if (!viewerRef.current || viewerRef.current.isDestroyed()) return;
      const t = (performance.now() - start) / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 4.0);
      if (entity.point) entity.point.pixelSize = 11 + pulse * 7;
      if (entity.ellipse) {
        entity.ellipse.semiMajorAxis = 18000 + pulse * 13000;
        entity.ellipse.semiMinorAxis = 18000 + pulse * 13000;
      }
      /* PinpointMarker animation (components/CoastalWarning.jsx) —
         same formulas, applied to the Cesium primitives. */
      if (prims && prims.glow) {
        const glowPulse = 1 + Math.sin(t * 2.5) * 0.15;
        prims.glow.pixelSize = 14 * glowPulse;
        prims.glow.color = prims.baseColor.withAlpha(0.55 + Math.sin(t * 2.5) * 0.15);
      }
      if (prims && prims.ring) {
        const ringPhase = (t * 0.8) % 1;
        prims.ring.pixelSize = 14 * (1 + ringPhase * 3.5);
        prims.ring.color = prims.baseColor.withAlpha((1 - ringPhase) * 0.5);
      }
      if (prims && prims.beacon && prims.beacon.material) {
        const beaconAlpha = 0.5 + Math.sin(t * 3.0) * 0.2;
        prims.beacon.material.uniforms.color = prims.baseColor.withAlpha(beaconAlpha);
      }
    };
    viewer.scene.preRender.addEventListener(listener);
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.preRender.removeEventListener(listener);
      }
    };
  }, [activeWarning, coastalPinpoint]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 0,
        overflow: "hidden",
        background: lightMode ? "#bfe9f7" : "#020b14",
      }}
    />
  );
}


/* ============================================================
   MAIN APPLICATION
============================================================ */

function App() {
  const [
    selectedLocation,
    setSelectedLocation,
  ] = useState(null);


  /* No data layer auto-activates on load (§8/§14): the user
     must explicitly select Temperature / Salinity / etc. */
  const [
    activeLayer,
    setActiveLayer,
  ] = useState(
    null
  );


  const [
    depth,
    setDepth,
  ] = useState(0);


  const [
    panelOpen,
    setPanelOpen,
  ] = useState(false);


  const [
    filterQuery,
    setFilterQuery,
  ] = useState("");


  const [
    lightMode,
    setLightMode,
  ] = useState(false);


  /* ==========================================================
     DATA PLAYBACK (§7/§15)

     Model time starts at the demo epoch and advances one
     6-hour timestep per DEMO_STEP_INTERVAL_MS while playing.
     Paused = frozen data state. All field math lives in the
     demo provider; a real backend later supplies the same
     normalized records per timestep.
  ========================================================== */

  const [playbackEpoch, setPlaybackEpoch] = useState(DEMO_START_EPOCH);
  const [playing, setPlaying] = useState(false);

  /* Report Analysis view (additive): null globe impact — the
     overlay simply mounts on top; the Cesium viewer keeps its
     state underneath. */
  const [reportOpen, setReportOpen] = useState(false);

  /* Ask the Ocean chat overlay (additive): a fixed panel over the
     globe; opening/closing it never touches the Cesium viewer or
     its layers. Hidden while the report view is open. */
  const [askOceanOpen, setAskOceanOpen] = useState(false);

  /* 3D Water Column Studio overlay (additive): isolated Three.js
     canvas on top of the globe; opening/closing never touches the
     Cesium viewer or its layers. */
  const [waterColumnOpen, setWaterColumnOpen] = useState(false);

  /* 3D Depth Slice viewer (Temperature only, additive): a compact
     side panel sharing the SAME `depth` state that drives the
     Cesium temperature layer — the two can never diverge. */
  const [tempSlice3DOpen, setTempSlice3DOpen] = useState(false);

  useEffect(() => {
    if (!playing || !DEMO_MODE_ACTIVE) return undefined;

    const timer = setInterval(() => {
      setPlaybackEpoch((prev) => prev + DEMO_TIMESTEP_MS);
    }, DEMO_STEP_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [playing]);

  const handleTogglePlayback = useCallback(() => {
    setPlaying((value) => !value);
  }, []);

  /* Camera readout for the playback bar (throttled in the globe). */
  const [cameraReadout, setCameraReadout] = useState({ lat: 10, lon: 82 });

  const handleCameraMove = useCallback((readout) => {
    setCameraReadout(readout);
  }, []);

  /* Data info box — temperature / salinity / chlorophyll records. */
  const [dataInfo, setDataInfo] = useState(null);

  const handleDataInfo = useCallback((info) => {
    setDataInfo(info);
  }, []);


  /* ==========================================================
     LAYER VISIBILITY
  ========================================================== */

  const [visibleLayers, setVisibleLayers] = useState({
    current: true,
    temperature: true,
    salinity: true,
    warnings: true,
  });

  const handleToggleLayer = (layerId) => {
    setVisibleLayers((prev) => ({
      ...prev,
      [layerId]: !prev[layerId],
    }));
  };


  /* ==========================================================
     COASTAL WARNINGS
  ========================================================== */

  const [activeWarning, setActiveWarning] = useState(null);

  const handleSelectWarning = (advisory) => {
    /* Always responsive — see goToLocation note (§12/§13). */
    setActiveWarning(advisory);
    setSelectedLocation({
      lat: advisory.latitude,
      lon: advisory.longitude,
    });
    setCameraState('locationAnimating');
  };

  const handleCloseWarning = () => {
    setActiveWarning(null);
  };


  /* ==========================================================
     CAMERA STATE MACHINE

     States: idle | locationAnimating | dataAnimating
  ========================================================== */

  const [cameraState, setCameraState] = useState('idle');
  const [activeLocationKey, setActiveLocationKey] = useState(null);

  /* REGION — derived read-only from the EXISTING navigation state
     (no second region state; region switching untouched). */
  const regionLabel = useMemo(() => {
    if (activeLocationKey === "ARABIAN_SEA") return "Arabian Sea";
    if (activeLocationKey === "BAY_OF_BENGAL") return "Bay of Bengal";
    if (activeLocationKey === "INDIAN_OCEAN") return "Indian Ocean";
    return null;
  }, [activeLocationKey]);

  /* Real temperature slice value range for the legend labels —
     fires only while the Temperature layer is active; the shared
     slice cache makes this free once the globe has the depth. */
  const [legendTempRange, setLegendTempRange] = useState(null);
  useEffect(() => {
    if (activeLayer !== "Temperature" || !visibleLayers.temperature) {
      return;
    }
    let cancelled = false;
    getRealTemperatureSliceInfo(depth)
      .then((info) => {
        if (!cancelled && info?.statistics) {
          setLegendTempRange({
            min: info.statistics.min,
            max: info.statistics.max,
          });
        }
      })
      .catch(() => {
        /* Real-mode failure: keep the last real range (or the fixed
           fallback inside the legend) — never substitute demo data. */
      });
    return () => {
      cancelled = true;
    };
  }, [activeLayer, visibleLayers.temperature, depth]);
  const [coastalLinesOpen, setCoastalLinesOpen] = useState(false);
  const [coastalPinpoint, setCoastalPinpoint] = useState(null);
  const layerAnimationTimerRef = useRef(null);


  const normalizedFilter =
    filterQuery
      .trim()
      .toLowerCase();


  const matchingHazards =
    normalizedFilter
      ? SEARCHABLE_HAZARDS.filter(
          (hazard) =>
            hazard.name
              .toLowerCase()
              .includes(
                normalizedFilter
              ) ||
            hazard.description
              .toLowerCase()
              .includes(
                normalizedFilter
              )
        )
      : [];


  /* ==========================================================
     LOCATION NAVIGATION (with toggle)

     First click: animate to ocean.
     Second click on same button: return to default.
     Different button: smoothly transition.
  ========================================================== */

  /* Full-globe overview return target. distance >= 20 tells
     flyToLocation to fit the ENTIRE sphere to the viewport. */
  const DEFAULT_CAMERA = { lat: 10, lon: 82, distance: 21 };

  const clearLayerAnimationTimer = () => {
    if (layerAnimationTimerRef.current) {
      clearTimeout(layerAnimationTimerRef.current);
      layerAnimationTimerRef.current = null;
    }
  };

  const handleLayerSelect = (layerName) => {
    if (cameraState !== 'idle') return;

    clearLayerAnimationTimer();

    /* Only one variable visualization is active at a time (§14);
       switching variables clears any open info box. */
    setDataInfo(null);

    if (activeLayer === layerName) {
      setActiveLayer(null);
      return;
    }

    /* Selecting a layer always makes that layer visible.
       This keeps the panel trigger independent from the
       optional DataLayerFilter visibility state. */
    if (layerName === "Temperature") {
      setVisibleLayers((prev) => ({ ...prev, temperature: true }));
    } else if (layerName === "Currents") {
      setVisibleLayers((prev) => ({ ...prev, current: true }));
    } else if (layerName === "Salinity") {
      setVisibleLayers((prev) => ({ ...prev, salinity: true }));
    }

    setCoastalPinpoint(null);
    setActiveLayer(layerName);
    setCameraState('dataAnimating');

    layerAnimationTimerRef.current = setTimeout(() => {
      layerAnimationTimerRef.current = null;
      setCameraState('idle');
    }, 900);
  };

  const goToLocation = (location, locationKey) => {
    /* No idle-state guard here (§12/§13): a new selection must
       ALWAYS respond — flyToLocation safely cancels any active
       flight and the safety timer guarantees recovery. */

    clearLayerAnimationTimer();

    /* Do NOT clear coastalPinpoint here — goToCoastalLocation sets it
       just before calling this, and an unconditional null-write here
       races that set (last-write-wins), so the pin never rendered. */

    if (activeLocationKey === locationKey) {
      setSelectedLocation({ ...DEFAULT_CAMERA });
      setActiveLocationKey(null);
      setCameraState('locationAnimating');
    } else {
      setSelectedLocation({
        lat: location.lat,
        lon: location.lon,
        ...(location.distance ? { distance: location.distance } : {}),
      });
      setActiveLocationKey(locationKey);
      setCameraState('locationAnimating');
    }
  };

  const goToCoastalLocation = (location, locationKey) => {
    /* Always responsive — see goToLocation note (§12/§13). */

    clearLayerAnimationTimer();

    if (activeLocationKey === locationKey && coastalPinpoint?.key === locationKey) {
      setCoastalPinpoint(null);
      goToLocation(location, locationKey);
      return;
    }

    setActiveLayer('Coastal Lines');
    setCoastalPinpoint({
      key: locationKey,
      latitude: location.lat,
      longitude: location.lon,
    });
    goToLocation(location, locationKey);
  };

  /* ==========================================================
     CURRENTS NAVIGATION
  ========================================================== */

  const goToCurrents = () => {
    handleLayerSelect("Currents");
  };


  /* ==========================================================
     CAMERA ANIMATION COMPLETE CALLBACK
  ========================================================== */

  const handleCameraAnimationComplete = () => {
    clearLayerAnimationTimer();
    setCameraState('idle');
  };

  useEffect(() => {
    return () => clearLayerAnimationTimer();
  }, []);


  /* ==========================================================
     INLINE THEME STYLES
  ========================================================== */

  const techButtonStyle = {
    border:
      lightMode
        ? "1px solid rgba(22,135,201,0.55)"
        : "1px solid rgba(36,154,255,0.90)",

    boxShadow:
      lightMode
        ? "0 0 8px rgba(22,135,201,0.12)"
        : "0 0 10px rgba(0,145,255,0.32)",

    color:
      lightMode
        ? undefined
        : "#ffffff",

    background:
      lightMode
        ? undefined
        : "rgba(4,20,35,0.72)",
  };


  return (
    <div
      className={
        lightMode
          ? "app light-mode"
          : "app dark-mode"
      }
      style={{
        position: "relative",
        width: "100%",
        height: "100vh",
        overflow: "hidden",
      }}
    >

      {/* ======================================================
          HEADER
      ====================================================== */}

      <header
        className="header"
        style={{
          position: "relative",
          zIndex: 20,
        }}
      >

        <div className="brand-row">

          {/* Circular logo/avatar space (existing .dash-logo styling). */}
          <div className="dash-logo" aria-hidden="true"></div>

          <div className="brand">

            <h1>
              RATNAKARA
            </h1>

            <p>
              Ocean Intelligence Platform
            </p>

          </div>

        </div>


        <nav
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >

          <button
            style={
              activeLocationKey === 'ARABIAN_SEA'
                ? { ...techButtonStyle, background: lightMode ? '#dff2f4' : 'rgba(255,255,255,0.95)', color: lightMode ? undefined : '#000' }
                : techButtonStyle
            }
            onClick={() =>
              goToLocation(LOCATIONS.ARABIAN_SEA, 'ARABIAN_SEA')
            }
          >
            Arabian Sea
          </button>


          <button
            style={
              activeLocationKey === 'BAY_OF_BENGAL'
                ? { ...techButtonStyle, background: lightMode ? '#dff2f4' : 'rgba(255,255,255,0.95)', color: lightMode ? undefined : '#000' }
                : techButtonStyle
            }
            onClick={() =>
              goToLocation(LOCATIONS.BAY_OF_BENGAL, 'BAY_OF_BENGAL')
            }
          >
            Bay of Bengal
          </button>


          <button
            style={
              activeLocationKey === 'INDIAN_OCEAN'
                ? { ...techButtonStyle, background: lightMode ? '#dff2f4' : 'rgba(255,255,255,0.95)', color: lightMode ? undefined : '#000' }
                : techButtonStyle
            }
            onClick={() =>
              goToLocation(LOCATIONS.INDIAN_OCEAN, 'INDIAN_OCEAN')
            }
          >
            Indian Ocean
          </button>

        </nav>


        <div
          className="theme-switch-wrap"
          style={{
            marginLeft: "8px",
          }}
        >

          <button
            type="button"
            className={
              lightMode
                ? "theme-switch light"
                : "theme-switch"
            }
            onClick={() =>
              setLightMode(
                (value) => !value
              )
            }
            aria-label={
              lightMode
                ? "Switch to dark mode"
                : "Switch to light mode"
            }
            title={
              lightMode
                ? "Switch to dark mode"
                : "Switch to light mode"
            }
            style={{
              width: "22px",
              height: "22px",
              minWidth: "22px",
              minHeight: "22px",
              padding: 0,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >

            <span
              className={
                lightMode
                  ? "theme-switch-dot light-dot"
                  : "theme-switch-dot dark-dot"
              }
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                display: "block",
              }}
            />

          </button>

        </div>

      </header>


      {/* ======================================================
          OCEAN VIEW
      ====================================================== */}

      <main
        className="ocean-view"
        style={{
          position: "relative",
          width: "100%",
          height: "calc(100vh - 0px)",
          minHeight: 0,
          overflow: "hidden",
        }}
      >

        {/* ====================================================
            PANEL TOGGLE
        ==================================================== */}

        <button
          className={
            panelOpen
              ? "panel-toggle open"
              : "panel-toggle"
          }

          onClick={() =>
            setPanelOpen(
              !panelOpen
            )
          }

          aria-label="Toggle ocean layers"

          style={{
            position: "absolute",
            zIndex: 15,

            border:
              lightMode
                ? "1px solid rgba(22,135,201,0.55)"
                : "1px solid rgba(35,154,255,0.90)",

            boxShadow:
              lightMode
                ? "0 0 7px rgba(22,135,201,0.12)"
                : "0 0 11px rgba(0,145,255,0.32)",
          }}
        >

          <span></span>
          <span></span>
          <span></span>

        </button>


        {/* ====================================================
            OCEAN PANEL
        ==================================================== */}

        <div
          className={
            panelOpen
              ? "ocean-panel visible"
              : "ocean-panel"
          }

          style={{
            zIndex: 14,
          }}
        >

          <div className="panel-header">

            <div>

              <span className="panel-dot"></span>

              <span>
                LAYERS
              </span>

            </div>

          </div>


          <div className="panel-search">

            🔍

            <input
              type="search"
              value={filterQuery}
              placeholder="Filter layers..."
              aria-label="Filter layers"

              onChange={(event) =>
                setFilterQuery(
                  event.target.value
                )
              }
            />

          </div>


          <div className="panel-section-title">
            OCEAN VARIABLES
          </div>


          {/* ==================================================
              TEMPERATURE
          ================================================== */}

          <button
            className={
              activeLayer ===
              "Temperature"
                ? "layer-button selected"
                : "layer-button"
            }

            onClick={() => {
              /* 3D Depth Slice viewer (Temperature only): toggle
                 alongside the layer selection — additive to the
                 existing handler below. */
              if (activeLayer === "Temperature") {
                setTempSlice3DOpen(false);
              } else {
                setTempSlice3DOpen(true);
              }
              handleLayerSelect(
                "Temperature"
              );
            }}
          >

            <span className="layer-icon">
              🌡
            </span>

            <span>

              <strong>
                Temperature
              </strong>

              <small>
                Sea surface temperature
              </small>

            </span>

          </button>


          {/* ==================================================
              SALINITY
          ================================================== */}

          <button
            className={
              activeLayer ===
              "Salinity"
                ? "layer-button selected"
                : "layer-button"
            }

            onClick={() =>
              handleLayerSelect(
                "Salinity"
              )
            }
          >

            <span className="layer-icon">
              💧
            </span>

            <span>

              <strong>
                Salinity
              </strong>

              <small>
                Ocean salinity
              </small>

            </span>

          </button>


          {/* ==================================================
              CURRENTS
          ================================================== */}

          <button
            className={
              activeLayer ===
              "Currents"
                ? "layer-button selected"
                : "layer-button"
            }

            onClick={
              goToCurrents
            }
          >

            <span className="layer-icon">
              🌊
            </span>

            <span>

              <strong>
                Currents
              </strong>

              <small>
                Ocean circulation
              </small>

            </span>

          </button>


          {/* ==================================================
              CHLOROPHYLL
          ================================================== */}

          <button
            className={
              activeLayer ===
              "Chlorophyll"
                ? "layer-button selected"
                : "layer-button"
            }

            onClick={() =>
              handleLayerSelect(
                "Chlorophyll"
              )
            }
          >

            <span className="layer-icon">
              🌿
            </span>

            <span>

              <strong>
                Chlorophyll
              </strong>

              <small>
                Ocean colour / chlorophyll
              </small>

            </span>

          </button>


          {/* ==================================================
              COASTAL LINES
          ================================================== */}

          <button
            className={
              activeLayer ===
              "Coastal Lines"
                ? "layer-button selected"
                : "layer-button"
            }

            onClick={() => {
              if (cameraState !== 'idle') return;
              clearLayerAnimationTimer();
              if (activeLayer === "Coastal Lines") {
                setActiveLayer(null);
                setCoastalLinesOpen(false);
                setCoastalPinpoint(null);
              } else {
                setActiveLayer("Coastal Lines");
                setCoastalLinesOpen(true);
              }
            }}
          >

            <span className="layer-icon">
              🗺️
            </span>

            <span style={{ flex: 1 }}>

              <strong>
                Coastal Lines
              </strong>

              <small>
                Coastline boundaries
              </small>

            </span>

            <span
              style={{
                fontSize: 9,
                opacity: 0.7,
                transform: coastalLinesOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 160ms ease',
              }}
            >
              ▾
            </span>

          </button>

          {coastalLinesOpen && (
            <>
              {[
                ["MUMBAI_COAST", "Mumbai Coast", "Arabian Sea coastal line"],
                ["KOCHI_COAST", "Kochi Coast", "Arabian Sea coastal line"],
                ["CHENNAI_COAST", "Chennai Coast", "Bay of Bengal coastal line"],
              ].map(([key, name, description]) => (
                <button
                  key={key}
                  className={
                    coastalPinpoint?.key === key
                      ? "layer-button selected"
                      : "layer-button"
                  }
                  style={{ marginLeft: 16, width: 'calc(100% - 16px)' }}
                  onClick={() =>
                    goToCoastalLocation(
                      COASTAL_LINE_LOCATIONS[key],
                      key
                    )
                  }
                >
                  <span className="layer-icon">
                    📍
                  </span>
                  <span>
                    <strong>{name}</strong>
                    <small>{description}</small>
                  </span>
                </button>
              ))}
            </>
          )}


          {/* ==================================================
              REPORT ANALYSIS (additive feature)
          ================================================== */}

          <button
            type="button"
            className={
              reportOpen
                ? "layer-button selected"
                : "layer-button"
            }

            onClick={() =>
              setReportOpen(true)
            }
          >

            <span className="layer-icon">
              📊
            </span>

            <span>

              <strong>
                Report Analysis
              </strong>

              <small>
                Scientific data summary
              </small>

            </span>

          </button>


          {/* ==================================================
              HAZARDS
          ================================================== */}

          {matchingHazards.length > 0 && (
            <>

              <div className="panel-divider"></div>

              <div className="panel-section-title">
                HAZARDS
              </div>


              {matchingHazards.map(
                (hazard) => (
                  <button
                    key={hazard.name}

                    className={
                      activeLayer ===
                      hazard.name
                        ? "layer-button selected"
                        : "layer-button"
                    }

                    onClick={() =>
                      handleLayerSelect(
                        hazard.name
                      )
                    }
                  >

                    <span className="layer-icon">
                      {hazard.icon}
                    </span>

                    <span>

                      <strong>
                        {hazard.name}
                      </strong>

                      <small>
                        {hazard.description}
                      </small>

                    </span>

                  </button>
                )
              )}

            </>
          )}


        {/* ==================================================
              DEPTH
          ================================================== */}

          <div className="panel-divider"></div>

          <div className="panel-section-title">
            DEPTH
          </div>


          <div className="depth-values">

            <span>
              Surface
            </span>

            <strong>
              {depth} m
            </strong>

          </div>


          <input
            className="depth-slider"
            type="range"
            min="0"
            max="2000"
            step="50"
            value={depth}

            onChange={(e) =>
              setDepth(
                Number(
                  e.target.value
                )
              )
            }
          />


          <div className="depth-labels">

            <span>
              0 m
            </span>

            <span>
              2000 m
            </span>

          </div>


          {/* ================================================
              SETTINGS (existing lightMode state reused)
          ================================================ */}

          <div className="panel-divider"></div>

          <div className="panel-section-title">
            SETTINGS
          </div>

          <button
            type="button"
            className="layer-button"
            onClick={() => setLightMode((v) => !v)}
          >
            <span className="layer-icon">{lightMode ? "🌙" : "☀️"}</span>
            <span>
              <strong>{lightMode ? "Dark Mode" : "Light Mode"}</strong>
              <small>Interface appearance</small>
            </span>
          </button>

          {/* ================================================
              WATER COLUMN + ASK THE OCEAN + LOGOUT

              The 3D Water Column Studio opens an isolated
              Three.js inspection view of the water column at
              the current camera location. The chat bot is wired
              to the existing OceanAI chat endpoint. Logout
              remains a placeholder: authentication is developed
              separately. Clicking it is a safe no-op.
          ================================================ */}

          <button
            type="button"
            className="layer-button"
            title="3D Water Column — inspect the water column at the camera location"
            onClick={() => setWaterColumnOpen(true)}
          >
            <span className="layer-icon">🌊</span>
            <span>
              <strong>3D Water Column</strong>
              <small>Local water-column inspection</small>
            </span>
          </button>

          <button
            type="button"
            className="layer-button"
            title="Ask the Ocean"
            onClick={() => setAskOceanOpen(true)}
          >
            <span className="layer-icon">💬</span>
            <span>
              <strong>Ask the Ocean</strong>
              <small>Chat with the ocean AI</small>
            </span>
          </button>

          <button
            type="button"
            className="layer-button"
            title="Logout — authentication coming soon"
          >
            <span className="layer-icon">🚪</span>
            <span>
              <strong>Logout</strong>
              <small>Session — coming soon</small>
            </span>
          </button>

        </div>


        {/* ====================================================
            CESIUM GLOBE

            The 3D runtime is fully CesiumJS. The existing UI and
            state machine above remain unchanged.
        ==================================================== */}

        <CesiumOceanGlobe
          activeLayer={activeLayer}
          depth={depth}
          lightMode={lightMode}
          visibleLayers={visibleLayers}
          activeWarning={activeWarning}
          coastalPinpoint={coastalPinpoint}
          activeLocation={selectedLocation}
          cameraState={cameraState}
          playbackEpoch={playbackEpoch}
          reportOpen={reportOpen}
          onDataInfo={handleDataInfo}
          onCameraMove={handleCameraMove}
          onAnimationComplete={handleCameraAnimationComplete}
        />


        {/* ====================================================
            HTML OVERLAY COMPONENTS

            These sit on top of the Cesium canvas
            as absolutely positioned HTML elements.
        ==================================================== */}

        {/* Location label */}
        <LocationLabel
          name={activeWarning?.name}
          region={activeWarning?.latitude > 8 ? (activeWarning?.longitude < 80 ? "Arabian Sea" : "Bay of Bengal") : null}
          visible={!!activeWarning}
          lightMode={lightMode}
        />

        {/* Warning card */}
        <WarningCard
          advisory={activeWarning}
          onClose={handleCloseWarning}
          lightMode={lightMode}
        />

        {/* Data layer filter */}
        <DataLayerFilter
          visibleLayers={visibleLayers}
          onToggleLayer={handleToggleLayer}
          lightMode={lightMode}
        />

        {/* Temperature legend (bottom-right; real slice range) */}
        <TemperatureLegend
          visible={activeLayer === "Temperature" && visibleLayers.temperature}
          lightMode={lightMode}
          minValue={legendTempRange?.min}
          maxValue={legendTempRange?.max}
          raised={tempSlice3DOpen}
        />

        {/* Current legend */}
        <CurrentLegend
          visible={activeLayer === "Currents" && visibleLayers.current}
          lightMode={lightMode}
        />

        {/* ====================================================
            DATA INFO BOX (§10/§11) — existing visual language
        ==================================================== */}
        {dataInfo && (
          <div
            style={{
              position: "absolute",
              top: 90,
              right: 24,
              width: 250,
              background: lightMode
                ? "rgba(248, 253, 255, 0.96)"
                : "rgba(10, 18, 32, 0.96)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              border: `1px solid ${
                lightMode
                  ? "rgba(22, 135, 201, 0.20)"
                  : "rgba(148, 163, 184, 0.18)"
              }`,
              borderRadius: 12,
              boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
              zIndex: 30,
              padding: "14px 16px",
              fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
              color: lightMode ? "#163743" : "#e2e8f0",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: "0.8px",
                }}
              >
                {dataInfo.title}
              </div>
              <button
                onClick={() => handleDataInfo(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: lightMode ? "#8fadb8" : "#94a3b8",
                  fontSize: 16,
                  cursor: "pointer",
                  padding: "0 2px",
                  lineHeight: 1,
                }}
                aria-label="Close data info"
              >
                ×
              </button>
            </div>

            <div
              style={{
                display: "inline-block",
                padding: "3px 10px",
                borderRadius: 6,
                background: lightMode
                  ? "rgba(8, 126, 139, 0.12)"
                  : "rgba(59, 130, 246, 0.16)",
                color: lightMode ? "#087e8b" : "#7dd3fc",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.8px",
                marginBottom: 10,
              }}
            >
              {dataInfo.valueLabel}
            </div>

            <div style={{ fontSize: 11, lineHeight: 1.8 }}>
              {[
                ["Index", dataInfo.indexLabel],
                ["Ocean", dataInfo.oceanLabel],
                ["Latitude", `${dataInfo.latitude.toFixed(2)}°`],
                ["Longitude", `${dataInfo.longitude.toFixed(2)}°`],
                ["Depth", dataInfo.depthLabel],
                ["Time", dataInfo.timestampLabel],
              ].map(([label, value]) =>
                value ? (
                  <div
                    key={label}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "2px 0",
                    }}
                  >
                    <span
                      style={{
                        color: lightMode ? "#63818b" : "#94a3b8",
                        fontSize: 10,
                      }}
                    >
                      {label}
                    </span>
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 11,
                      }}
                    >
                      {value}
                    </span>
                  </div>
                ) : null
              )}
            </div>
          </div>
        )}

        {/* ====================================================
            DATA PLAYBACK BAR (§7) — below the globe area,
            existing visual language
        ==================================================== */}
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            background: lightMode
              ? "rgba(248, 253, 255, 0.92)"
              : "rgba(10, 18, 32, 0.92)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            border: `1px solid ${
              lightMode
                ? "rgba(22, 135, 201, 0.18)"
                : "rgba(148, 163, 184, 0.15)"
            }`,
            borderRadius: 10,
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            zIndex: 25,
            fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
          }}
        >
          <button
            type="button"
            onClick={handleTogglePlayback}
            aria-label={playing ? "Pause data playback" : "Play data playback"}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: `1px solid ${
                lightMode
                  ? "rgba(22, 135, 201, 0.45)"
                  : "rgba(36, 154, 255, 0.65)"
              }`,
              background: lightMode
                ? "rgba(8, 126, 139, 0.12)"
                : "rgba(4, 20, 35, 0.72)",
              color: lightMode ? "#087e8b" : "#bdefff",
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {playing ? "❚❚" : "▶"}
          </button>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              fontSize: 10,
              lineHeight: 1.5,
              color: lightMode ? "#163743" : "#e2e8f0",
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                fontWeight: 700,
                letterSpacing: "0.5px",
                color: lightMode ? "#087e8b" : "#7dd3fc",
              }}
            >
              {demoTimeLabel(playbackEpoch)}
            </span>
            <span style={{ color: lightMode ? "#63818b" : "#94a3b8" }}>
              Lat: {cameraReadout.lat.toFixed(1)}° · Lon: {cameraReadout.lon.toFixed(1)}°
            </span>
          </div>
        </div>

        {/* ====================================================
            REPORT ANALYSIS VIEW (additive)

            Mounts over the app without unmounting the globe.
            onBack simply flips state — the Cesium viewer, its
            layers, camera and pinpoint are never touched.
        ==================================================== */}
        {reportOpen && (
          <Suspense fallback={null}>
            <ReportAnalysis
              onBack={() => setReportOpen(false)}
              cameraLocation={cameraReadout}
              playbackEpoch={playbackEpoch}
              depth={depth}
              lightMode={lightMode}
            />
          </Suspense>
        )}

        {/* ================================================
            ASK THE OCEAN CHAT (additive)

            Fixed overlay next to the dashboard; the globe keeps
            its state underneath. Hidden while the report view is
            open so the two AI surfaces never overlap.
        ================================================ */}
        {askOceanOpen && !reportOpen && !waterColumnOpen && (
          <AskTheOceanPanel
            lightMode={lightMode}
            activeLayer={activeLayer}
            depth={depth}
            cameraReadout={cameraReadout}
            onClose={() => setAskOceanOpen(false)}
          />
        )}

        {/* ================================================
            3D DEPTH SLICE VIEWER — TEMPERATURE ONLY (additive)

            Compact isolated Three.js panel. Shares the app's
            single `depth` state: slider changes here update the
            Cesium temperature layer and vice versa. The globe
            keeps rendering underneath — nothing is blocked.
        ================================================ */}
        {tempSlice3DOpen && activeLayer === "Temperature" && (
          <Suspense fallback={null}>
            <TemperatureDepthSlice3D
              requestedDepth={depth}
              onRequestedDepthChange={setDepth}
              lightMode={lightMode}
              region={regionLabel}
              /* Additive: lets the slicer sidestep the LAYERS panel
                 lane (264px) only while that panel is open — the
                 slicer owns the lane when the panel is closed. */
              panelOpen={panelOpen}
              onClose={() => setTempSlice3DOpen(false)}
            />
          </Suspense>
        )}

        {/* ================================================
            3D WATER COLUMN STUDIO (additive)

            Full-screen overlay with its own Three.js canvas.
            The Cesium viewer keeps its state underneath; onBack
            simply flips state. Location = current camera center
            (the user's live selection on the globe).
        ================================================ */}
        {waterColumnOpen && (
          <Suspense fallback={null}>
            <OceanWaterColumnStudio
              open
              onClose={() => setWaterColumnOpen(false)}
              latitude={cameraReadout.lat}
              longitude={cameraReadout.lon}
              lightMode={lightMode}
            />
          </Suspense>
        )}

      </main>

    </div>
  );
}


export default App;