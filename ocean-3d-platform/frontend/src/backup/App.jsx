import {
  Canvas,
  useFrame,
  useThree,
} from "@react-three/fiber";

import {
  OrbitControls,
  Stars,
} from "@react-three/drei";

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import * as THREE from "three";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

import "./App.css";

import { PinpointMarker, WarningCard } from "./components/CoastalWarning";
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


/* ============================================================
   CAMERA LOCATIONS
============================================================ */

const LOCATIONS = {
  ARABIAN_SEA: {
    lat: 15,
    lon: 75,
  },

  BAY_OF_BENGAL: {
    lat: 15,
    lon: 90,
  },

  INDIAN_OCEAN: {
    lat: -10,
    lon: 95,
  },
};


/* Coastal pinpoint locations.  The existing PinpointMarker animation is reused. */
const COASTAL_LINE_LOCATIONS = {
  MUMBAI_COAST: { lat: 19.076, lon: 72.8777, distance: 3.0 },
  KOCHI_COAST: { lat: 9.9312, lon: 76.2673, distance: 3.0 },
  CHENNAI_COAST: { lat: 13.0827, lon: 80.2707, distance: 3.0 },
};


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
   DEEP-ZOOM REGIONS
============================================================ */

const DEEP_ZOOM_REGIONS = [
  {
    name: "Arabian Sea",
    minLat: -8,
    maxLat: 32,
    minLon: 42,
    maxLon: 83,
  },

  {
    name: "Bay of Bengal",
    minLat: -8,
    maxLat: 32,
    minLon: 79,
    maxLon: 118,
  },

  {
    name: "Indian Ocean",
    minLat: -42,
    maxLat: 8,
    minLon: 38,
    maxLon: 128,
  },
];


/* ============================================================
   INDIAN COASTAL PRIORITY
============================================================ */

const INDIAN_COASTAL_PRIORITY = [
  {
    minLat: 8,
    maxLat: 25,
    minLon: 68,
    maxLon: 75,
  },

  {
    minLat: 8,
    maxLat: 21,
    minLon: 72,
    maxLon: 78,
  },

  {
    minLat: 8,
    maxLat: 16,
    minLon: 73,
    maxLon: 78,
  },

  {
    minLat: 7,
    maxLat: 13,
    minLon: 74,
    maxLon: 78,
  },

  {
    minLat: 7,
    maxLat: 13,
    minLon: 76,
    maxLon: 81,
  },

  {
    minLat: 8,
    maxLat: 19,
    minLon: 77,
    maxLon: 85,
  },

  {
    minLat: 15,
    maxLat: 22,
    minLon: 80,
    maxLon: 88,
  },

  {
    minLat: 20,
    maxLat: 25,
    minLon: 85,
    maxLon: 90,
  },

  {
    minLat: 5,
    maxLat: 11,
    minLon: 78,
    maxLon: 84,
  },

  /* Lakshadweep */

  {
    minLat: 7,
    maxLat: 13,
    minLon: 71,
    maxLon: 75,
  },

  /* Sri Lanka */

  {
    minLat: 5,
    maxLat: 11,
    minLon: 79,
    maxLon: 82,
  },

  /* Andaman & Nicobar */

  {
    minLat: 6,
    maxLat: 14,
    minLon: 91,
    maxLon: 95,
  },

  /* Southern Bay of Bengal */

  {
    minLat: 5,
    maxLat: 15,
    minLon: 82,
    maxLon: 91,
  },
];


/* ============================================================
   SATELLITE LAYER
============================================================ */

const SATELLITE_RADIUS = 2.025;

const DETAIL_SATELLITE_RADIUS = 2.030;


/* ============================================================
   SENTINEL ZOOM LEVELS
============================================================ */

const GLOBAL_SATELLITE_ZOOM = 2;

const DETAIL_SATELLITE_ZOOM = 7;

const MEDIUM_SATELLITE_ZOOM = 3;


const MEDIUM_ZOOM_ENTER_DISTANCE = 10.5;

const MEDIUM_ZOOM_EXIT_DISTANCE = 11.2;

const DETAIL_ZOOM_ENTER_DISTANCE = 5.8;

const DETAIL_ZOOM_EXIT_DISTANCE = 6.4;


/* ============================================================
   EOX CLOUDLESS SENTINEL-2 WGS84 TILE SERVICE
============================================================ */

const SATELLITE_TILE_URL =
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025/default/WGS84";


/* ============================================================
   DAY/NIGHT SUN DIRECTION
============================================================ */

const DEFAULT_SUN_DIRECTION = new THREE.Vector3(1, 0.3, 0.5).normalize();


/* ============================================================
   WGS84 TILE HELPERS
============================================================ */

function wgs84TileCountX(zoom) {
  return Math.pow(2, zoom + 1);
}

function wgs84TileCountY(zoom) {
  return Math.pow(2, zoom);
}


function lonToWGS84TileX(lon, zoom) {
  const tileCount =
    wgs84TileCountX(zoom);

  let normalized =
    (lon + 180) / 360;

  normalized =
    THREE.MathUtils.clamp(
      normalized,
      0,
      0.999999999
    );

  return normalized * tileCount;
}


function latToWGS84TileY(lat, zoom) {
  const tileCount =
    wgs84TileCountY(zoom);

  const normalized =
    (90 - lat) / 180;

  return (
    THREE.MathUtils.clamp(
      normalized,
      0,
      0.999999999
    ) * tileCount
  );
}


function wgs84TileXToLon(x, zoom) {
  const tileCount =
    wgs84TileCountX(zoom);

  return (
    (x / tileCount) * 360 - 180
  );
}


function wgs84TileYToLat(y, zoom) {
  const tileCount =
    wgs84TileCountY(zoom);

  return (
    90 -
    (y / tileCount) * 180
  );
}


/* ============================================================
   BACKWARD COMPATIBLE HELPERS
============================================================ */

function lonToTileX(lon, zoom) {
  return lonToWGS84TileX(
    lon,
    zoom
  );
}

function latToTileY(lat, zoom) {
  return latToWGS84TileY(
    lat,
    zoom
  );
}

function tileXToLon(x, zoom) {
  return wgs84TileXToLon(
    x,
    zoom
  );
}

function tileYToLat(y, zoom) {
  return wgs84TileYToLat(
    y,
    zoom
  );
}


/* ============================================================
   LAT/LON -> RATNAKARA GLOBE POSITION
============================================================ */

function satelliteLatLonToVector(
  lat,
  lon,
  radius
) {
  const phi =
    THREE.MathUtils.degToRad(
      90 - lat
    );

  const theta =
    THREE.MathUtils.degToRad(
      lon + 70
    );

  return new THREE.Vector3(
    radius *
      Math.sin(phi) *
      Math.sin(theta),

    radius *
      Math.cos(phi),

    radius *
      Math.sin(phi) *
      Math.cos(theta)
  );
}


/* ============================================================
   ============================================================
   TEMPERATURE SYSTEM
   ============================================================
============================================================ */


/*
  Thermal thresholds.

  NORMAL  < 29°C  -> GREEN
  MEDIUM 29-31°C  -> GREEN -> YELLOW -> RED
  HIGH   >= 31°C  -> RED

  These values can later be replaced by backend values.
*/

const NORMAL_TEMPERATURE_LIMIT = 29;

const HIGH_TEMPERATURE_LIMIT = 31;


/* ============================================================
   TEMPERATURE COLOR THEORY
============================================================ */

const DEFAULT_TEMPERATURE_RANGE = {
  min: 0,
  max: 34,
};

/*
  Backend integration point:
  Later, Ratnakara can assign an array/object to:

    globalThis.__RATNAKARA_TEMPERATURE_DATASET__

  Supported point shape:
    { latitude, longitude, temperature }

  Optional dataset shape:
    { points: [...], min, max, timestamp }

  With no dataset present, the deterministic default field below is used.
*/

function getTemperatureDataset() {
  if (typeof globalThis === "undefined") return null;
  return globalThis.__RATNAKARA_TEMPERATURE_DATASET__ || null;
}

function getDatasetPoints(dataset) {
  if (Array.isArray(dataset)) return dataset;
  if (Array.isArray(dataset?.points)) return dataset.points;
  if (Array.isArray(dataset?.data)) return dataset.data;
  return [];
}

function getTemperatureRange(dataset) {
  const points = getDatasetPoints(dataset);
  const values = points
    .map((point) => Number(point?.temperature))
    .filter(Number.isFinite);

  if (Number.isFinite(Number(dataset?.min)) && Number.isFinite(Number(dataset?.max))) {
    return {
      min: Number(dataset.min),
      max: Number(dataset.max),
    };
  }

  if (!values.length) return DEFAULT_TEMPERATURE_RANGE;

  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function temperatureToColor(temperature, min = DEFAULT_TEMPERATURE_RANGE.min, max = DEFAULT_TEMPERATURE_RANGE.max) {
  const stops = [
    { t: 0.00, color: new THREE.Color("#062c73") },
    { t: 0.18, color: new THREE.Color("#0077c8") },
    { t: 0.36, color: new THREE.Color("#00cfe8") },
    { t: 0.52, color: new THREE.Color("#29e36a") },
    { t: 0.66, color: new THREE.Color("#ffe500") },
    { t: 0.80, color: new THREE.Color("#ff8a00") },
    { t: 0.91, color: new THREE.Color("#f02b1d") },
    { t: 1.00, color: new THREE.Color("#8d0b5b") },
  ];

  const span = Math.max(0.001, max - min);
  const normalized = THREE.MathUtils.clamp((temperature - min) / span, 0, 1);

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (normalized <= b.t) {
      const local = (normalized - a.t) / Math.max(0.001, b.t - a.t);
      return a.color.clone().lerp(b.color, local);
    }
  }

  return stops[stops.length - 1].color.clone();
}

/* ============================================================
   DEFAULT GLOBAL SEA-SURFACE TEMPERATURE FIELD
============================================================ */

function getDemoTemperature(latitude, longitude, depth) {
  const latRad = THREE.MathUtils.degToRad(latitude);
  const lonRad = THREE.MathUtils.degToRad(longitude);

  const equatorialWarmth = 29.5 - Math.abs(latitude) * 0.22;
  const seasonalWave = Math.sin(lonRad * 3.0 + latRad * 1.4) * 1.7;
  const secondaryWave = Math.cos(lonRad * 7.0 - latRad * 2.0) * 0.65;
  const indianOceanWarmth =
    latitude >= -35 && latitude <= 28 && longitude >= 40 && longitude <= 110
      ? 1.1
      : 0;

  return equatorialWarmth + seasonalWave + secondaryWave + indianOceanWarmth - depth * 0.004;
}

/* Coarse continent mask keeps the default temperature field on ocean surface. */
function isGlobalOceanRegion(lat, lon) {
  const longitude = ((lon + 180) % 360 + 360) % 360 - 180;

  if (lat <= -60) return false;

  // North America / Greenland
  if (lat >= 7 && lat <= 75 && longitude >= -170 && longitude <= -50) return false;
  if (lat >= 58 && lat <= 85 && longitude >= -75 && longitude <= -5) return false;

  // South America
  if (lat >= -56 && lat <= 13 && longitude >= -85 && longitude <= -34) return false;

  // Africa
  if (lat >= -36 && lat <= 37 && longitude >= -20 && longitude <= 52) return false;

  // Europe + mainland Asia (keeps the major ocean basins open)
  if (lat >= 35 && lat <= 80 && longitude >= -10 && longitude <= 180) return false;

  // India / Sri Lanka
  if (lat >= 5 && lat <= 36 && longitude >= 68 && longitude <= 90) return false;
  if (lat >= 5.5 && lat <= 10.5 && longitude >= 79 && longitude <= 82.5) return false;

  // Arabian Peninsula
  if (lat >= 12 && lat <= 31 && longitude >= 35 && longitude <= 60) return false;

  // Southeast Asia / Indonesia rough land envelope
  if (lat >= -10 && lat <= 22 && longitude >= 95 && longitude <= 130) return false;

  // Australia
  if (lat >= -45 && lat <= -9 && longitude >= 110 && longitude <= 155) return false;

  return true;
}

function sampleBackendTemperature(points, latitude, longitude, fallback) {
  if (!points.length) return fallback;

  let best = null;
  let bestDistance = Infinity;

  for (const point of points) {
    const plat = Number(point?.latitude ?? point?.lat);
    const plon = Number(point?.longitude ?? point?.lon ?? point?.lng);
    const value = Number(point?.temperature ?? point?.temp ?? point?.sst);

    if (!Number.isFinite(plat) || !Number.isFinite(plon) || !Number.isFinite(value)) continue;

    let dLon = Math.abs(plon - longitude);
    dLon = Math.min(dLon, 360 - dLon);
    const dLat = plat - latitude;
    const distance = dLat * dLat + dLon * dLon;

    if (distance < bestDistance) {
      bestDistance = distance;
      best = value;
    }
  }

  return best === null ? fallback : best;
}

function createTemperatureGeometry(depth = 0, radius = 2.033) {
  const latStart = -58;
  const latEnd = 58;
  const lonStart = -180;
  const lonEnd = 180;
  const step = 3.0;

  const effectiveRadius = Math.max(radius, DETAIL_SATELLITE_RADIUS + 0.004);
  const positions = [];
  const colors = [];
  const alphas = [];
  const indices = [];

  const dataset = getTemperatureDataset();
  const points = getDatasetPoints(dataset);
  const range = getTemperatureRange(dataset);

  const latCount = Math.round((latEnd - latStart) / step) + 1;
  const lonCount = Math.round((lonEnd - lonStart) / step) + 1;

  for (let latIndex = 0; latIndex < latCount; latIndex++) {
    const latitude = latStart + latIndex * step;

    for (let lonIndex = 0; lonIndex < lonCount; lonIndex++) {
      const longitude = lonStart + lonIndex * step;
      const ocean = isGlobalOceanRegion(latitude, longitude);
      const fallback = getDemoTemperature(latitude, longitude, depth);
      const temperature = sampleBackendTemperature(points, latitude, longitude, fallback);
      const color = temperatureToColor(temperature, range.min, range.max);
      const position = satelliteLatLonToVector(latitude, longitude, effectiveRadius);

      positions.push(position.x, position.y, position.z);
      colors.push(color.r, color.g, color.b);
      alphas.push(ocean ? 1.0 : 0.0);
    }
  }

  for (let latIndex = 0; latIndex < latCount - 1; latIndex++) {
    for (let lonIndex = 0; lonIndex < lonCount - 1; lonIndex++) {
      const a = latIndex * lonCount + lonIndex;
      const b = a + 1;
      const c = a + lonCount;
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("alpha", new THREE.Float32BufferAttribute(alphas, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}


/* ============================================================
   TEMPERATURE LAYER

   Features:
   - Lift animation when activated (rises from ocean surface)
   - Color fade-in animation
   - Subtle thermal shimmer
   - Land masking (no green ring)
   - Edge opacity falloff
   - Data-ready color mapping
============================================================ */

function TemperatureLayer({ depth = 0, radius = 2.033 }) {
  const materialRef = useRef(null);
  const liftRef = useRef(0);
  const fadeInRef = useRef(0);
  const activatedRef = useRef(false);

  const geometry = useMemo(
    () => createTemperatureGeometry(depth, radius),
    [depth, radius]
  );

  useFrame((state, delta) => {
    if (!materialRef.current) return;

    const uniforms = materialRef.current.uniforms;
    uniforms.uTime.value = state.clock.elapsedTime;

    /* Lift animation: rises once when activated */
    if (!activatedRef.current) {
      activatedRef.current = true;
    }
    if (liftRef.current < 1) {
      liftRef.current = Math.min(1, liftRef.current + delta * 1.2);
      uniforms.uLift.value = liftRef.current;
    }

    /* Color fade-in */
    if (fadeInRef.current < 1) {
      fadeInRef.current = Math.min(1, fadeInRef.current + delta * 1.5);
      uniforms.uFadeIn.value = fadeInRef.current;
    }
  });

  useEffect(() => {
    return () => { geometry.dispose(); };
  }, [geometry]);

  return (
    <mesh geometry={geometry} renderOrder={25} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        depthTest={true}
        vertexColors
        uniforms={{
          uTime: { value: 0 },
          uLift: { value: 0 },
          uFadeIn: { value: 0 },
        }}
        vertexShader={`
          attribute float alpha;
          uniform float uLift;
          varying vec3 vColor;
          varying vec3 vNormal;
          varying float vAlpha;

          void main() {
            vColor = color;
            vNormal = normalize(normalMatrix * normal);
            vAlpha = alpha;

            /* Lift animation: displace along normal */
            float liftAmount = uLift * 0.008;
            vec3 displaced = position + normal * liftAmount;

            gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
          }
        `}
        fragmentShader={`
          uniform float uTime;
          uniform float uFadeIn;
          varying vec3 vColor;
          varying vec3 vNormal;
          varying float vAlpha;

          void main() {
            if (vAlpha < 0.01) discard;

            /* Slow directional thermal motion: the dataset colors remain unchanged. */
            float flowA = sin(gl_FragCoord.x * 0.018 + gl_FragCoord.y * 0.011 + uTime * 0.28);
            float flowB = sin(gl_FragCoord.y * 0.027 - gl_FragCoord.x * 0.009 - uTime * 0.18);
            float flow = (flowA + flowB) * 0.018;

            float edgeLight = 0.985 + dot(vNormal, vec3(0.15, 0.55, 0.82)) * 0.035;
            float brightness = edgeLight + flow;

            vec3 finalColor = clamp(vColor * brightness, 0.0, 1.0);
            float finalAlpha = vAlpha * uFadeIn * 0.70;

            gl_FragColor = vec4(finalColor, finalAlpha);
          }
        `}
        toneMapped={false}
      />
    </mesh>
  );
}


/* ============================================================
   SALINITY LAYER

   Lightweight default field with the same activation behavior
   as Temperature. It is intentionally data-ready so a backend
   salinity dataset can replace the fallback later.
============================================================ */

function getDemoSalinity(latitude, longitude, depth) {
  const latRad = THREE.MathUtils.degToRad(latitude);
  const lonRad = THREE.MathUtils.degToRad(longitude);

  return (
    34.6
    + Math.sin(lonRad * 2.4 + latRad) * 0.75
    + Math.cos(lonRad * 5.2 - latRad * 1.8) * 0.28
    - Math.abs(latitude) * 0.018
    - depth * 0.002
  );
}

function salinityToColor(value, min = 32, max = 37) {
  const t = THREE.MathUtils.clamp((value - min) / Math.max(0.001, max - min), 0, 1);
  const low = new THREE.Color("#063b8f");
  const mid = new THREE.Color("#00bcd4");
  const high = new THREE.Color("#f2e85c");

  if (t < 0.55) return low.clone().lerp(mid, t / 0.55);
  return mid.clone().lerp(high, (t - 0.55) / 0.45);
}

function createSalinityGeometry(depth = 0, radius = 2.034) {
  const latStart = -58;
  const latEnd = 58;
  const lonStart = -180;
  const lonEnd = 180;
  const step = 3.0;
  const effectiveRadius = Math.max(radius, DETAIL_SATELLITE_RADIUS + 0.004);
  const positions = [];
  const colors = [];
  const alphas = [];
  const indices = [];
  const latCount = Math.round((latEnd - latStart) / step) + 1;
  const lonCount = Math.round((lonEnd - lonStart) / step) + 1;

  for (let latIndex = 0; latIndex < latCount; latIndex++) {
    const latitude = latStart + latIndex * step;
    for (let lonIndex = 0; lonIndex < lonCount; lonIndex++) {
      const longitude = lonStart + lonIndex * step;
      const ocean = isGlobalOceanRegion(latitude, longitude);
      const value = getDemoSalinity(latitude, longitude, depth);
      const color = salinityToColor(value);
      const position = satelliteLatLonToVector(latitude, longitude, effectiveRadius);
      positions.push(position.x, position.y, position.z);
      colors.push(color.r, color.g, color.b);
      alphas.push(ocean ? 1 : 0);
    }
  }

  for (let latIndex = 0; latIndex < latCount - 1; latIndex++) {
    for (let lonIndex = 0; lonIndex < lonCount - 1; lonIndex++) {
      const a = latIndex * lonCount + lonIndex;
      const b = a + 1;
      const c = a + lonCount;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("alpha", new THREE.Float32BufferAttribute(alphas, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function SalinityLayer({ depth = 0, radius = 2.034 }) {
  const materialRef = useRef(null);
  const liftRef = useRef(0);
  const fadeRef = useRef(0);
  const geometry = useMemo(() => createSalinityGeometry(depth, radius), [depth, radius]);

  useFrame((state, delta) => {
    if (!materialRef.current) return;
    materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;
    liftRef.current = Math.min(1, liftRef.current + delta * 1.2);
    fadeRef.current = Math.min(1, fadeRef.current + delta * 1.5);
    materialRef.current.uniforms.uLift.value = liftRef.current;
    materialRef.current.uniforms.uFadeIn.value = fadeRef.current;
  });

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry} renderOrder={25} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        depthTest={true}
        vertexColors
        uniforms={{ uTime: { value: 0 }, uLift: { value: 0 }, uFadeIn: { value: 0 } }}
        vertexShader={`
          attribute float alpha;
          uniform float uLift;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            vColor = color;
            vAlpha = alpha;
            vec3 displaced = position + normal * (uLift * 0.008);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
          }
        `}
        fragmentShader={`
          uniform float uTime;
          uniform float uFadeIn;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            if (vAlpha < 0.01) discard;
            float flow = sin(gl_FragCoord.x * 0.016 + gl_FragCoord.y * 0.012 + uTime * 0.24) * 0.025;
            gl_FragColor = vec4(clamp(vColor * (0.98 + flow), 0.0, 1.0), vAlpha * uFadeIn * 0.66);
          }
        `}
        toneMapped={false}
      />
    </mesh>
  );
}


/* ============================================================
   SATELLITE TILE GEOMETRY
============================================================ */

function createSatelliteTileGeometry(
  tileX,
  tileY,
  zoom,
  radius
) {
  const segments = 16;

  const positions = [];

  const uvs = [];

  const indices = [];

  const startX = tileX;

  const endX =
    tileX + 1;

  const startY = tileY;

  const endY =
    tileY + 1;


  for (
    let row = 0;
    row <= segments;
    row++
  ) {
    const v =
      row / segments;

    const tileYPosition =
      startY +
      v *
        (endY - startY);

    const lat =
      tileYToLat(
        tileYPosition,
        zoom
      );


    for (
      let column = 0;
      column <= segments;
      column++
    ) {
      const u =
        column / segments;

      const tileXPosition =
        startX +
        u *
          (endX - startX);

      const lon =
        tileXToLon(
          tileXPosition,
          zoom
        );

      const position =
        satelliteLatLonToVector(
          lat,
          lon,
          radius
        );

      positions.push(
        position.x,
        position.y,
        position.z
      );

      uvs.push(
        u,
        1 - v
      );
    }
  }


  for (
    let row = 0;
    row < segments;
    row++
  ) {
    for (
      let column = 0;
      column < segments;
      column++
    ) {
      const a =
        row *
          (segments + 1) +
        column;

      const b =
        a + 1;

      const c =
        a +
        (segments + 1);

      const d =
        c + 1;


      indices.push(
        a,
        c,
        b
      );

      indices.push(
        b,
        c,
        d
      );
    }
  }


  const geometry =
    new THREE.BufferGeometry();

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      positions,
      3
    )
  );

  geometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(
      uvs,
      2
    )
  );

  geometry.setIndex(
    indices
  );

  geometry.computeVertexNormals();

  return geometry;
}


/* ============================================================
   SATELLITE MATERIAL
============================================================ */

function createSatelliteMaterial(
  texture
) {
  return new THREE.MeshBasicMaterial({
    map: texture,

    side:
      THREE.FrontSide,

    transparent: false,

    opacity: 1,

    depthWrite: true,

    depthTest: true,

    toneMapped: false,
  });
}


/* ============================================================
   INDIVIDUAL SATELLITE TILE
============================================================ */

function SatelliteTile({
  tileX,
  tileY,
  zoom,
  radius = SATELLITE_RADIUS,
}) {
  const [
    texture,
    setTexture,
  ] = useState(null);

  const [
    failed,
    setFailed,
  ] = useState(false);


  const tileCountY =
    wgs84TileCountY(
      zoom
    );


  const invalidTile =
    tileY < 0 ||
    tileY >= tileCountY;


  useEffect(() => {
    let mounted = true;

    const loader =
      new THREE.TextureLoader();

    loader.setCrossOrigin(
      "anonymous"
    );


    const tileCountX =
      wgs84TileCountX(
        zoom
      );


    const wrappedX =
      (
        tileX %
          tileCountX +
        tileCountX
      ) %
      tileCountX;


    if (invalidTile) {
      return undefined;
    }


    const integerX =
      Math.floor(
        wrappedX
      );

    const integerY =
      Math.floor(
        tileY
      );


    const url =
      SATELLITE_TILE_URL +
      "/" +
      zoom +
      "/" +
      integerY +
      "/" +
      integerX +
      ".jpg";


    loader.load(
      url,

      (loadedTexture) => {
        if (!mounted) {
          loadedTexture.dispose();
          return;
        }


        loadedTexture.colorSpace =
          THREE.SRGBColorSpace;

        loadedTexture.anisotropy = 8;

        loadedTexture.minFilter =
          THREE.LinearFilter;

        loadedTexture.magFilter =
          THREE.LinearFilter;

        loadedTexture.generateMipmaps =
          false;

        loadedTexture.wrapS =
          THREE.ClampToEdgeWrapping;

        loadedTexture.wrapT =
          THREE.ClampToEdgeWrapping;

        loadedTexture.needsUpdate =
          true;


        setTexture(
          loadedTexture
        );
      },

      undefined,

      () => {
        /*
          A failed satellite tile must NEVER
          kill the globe.
        */

        if (mounted) {
          setFailed(true);
        }
      }
    );


    return () => {
      mounted = false;
    };
  }, [
    tileX,
    tileY,
    zoom,
    invalidTile,
  ]);


  const geometry =
    texture &&
    !failed &&
    !invalidTile
      ? createSatelliteTileGeometry(
          tileX,
          tileY,
          zoom,
          radius
        )
      : null;


  const material =
    texture &&
    !failed &&
    !invalidTile
      ? createSatelliteMaterial(
          texture
        )
      : null;


  useEffect(() => {
    if (
      !geometry ||
      !material ||
      !texture
    ) {
      return undefined;
    }


    return () => {
      geometry.dispose();

      material.dispose();

      texture.dispose();
    };
  }, [
    geometry,
    material,
    texture,
  ]);


  if (
    !geometry ||
    !material
  ) {
    return null;
  }


  return (
    <mesh
      geometry={geometry}
      material={material}
      renderOrder={
        radius >
        SATELLITE_RADIUS
          ? 20
          : 10
      }
    />
  );
}


/* ============================================================
   GLOBAL SATELLITE GLOBE
============================================================ */

function GlobalSatelliteGlobe() {
  const tileMeshes = [];

  const tileCountX =
    wgs84TileCountX(
      GLOBAL_SATELLITE_ZOOM
    );

  const tileCountY =
    wgs84TileCountY(
      GLOBAL_SATELLITE_ZOOM
    );


  for (
    let y = 0;
    y < tileCountY;
    y++
  ) {
    for (
      let x = 0;
      x < tileCountX;
      x++
    ) {
      tileMeshes.push(
        <SatelliteTile
          key={
            `global-${x}-${y}`
          }
          tileX={x}
          tileY={y}
          zoom={
            GLOBAL_SATELLITE_ZOOM
          }
          radius={
            SATELLITE_RADIUS
          }
        />
      );
    }
  }


  return (
    <group
      renderOrder={5}
    >
      {tileMeshes}
    </group>
  );
}


/* ============================================================
   DETAIL SATELLITE LAYER
============================================================ */

function DetailSatelliteLayer() {
  const { camera } =
    useThree();


  const [
    satelliteState,
    setCenterTile,
  ] = useState(null);


  const lastState =
    useRef("");


  const mediumActive =
    useRef(false);


  const detailActive =
    useRef(false);


  useEffect(() => {
    let mounted = true;


    const updateDetail = () => {
      const distance =
        camera.position.length();


      const {
        lat,
        lon,
      } =
        getCameraLatLon(
          camera
        );


      const priorityRegion =
        isInsideIndianCoastalPriority(
          lat,
          lon
        );


      const regionalWater =
        isInsideDeepZoomRegion(
          lat,
          lon
        );


      if (regionalWater) {
        if (
          !mediumActive.current &&
          distance <
            MEDIUM_ZOOM_ENTER_DISTANCE
        ) {
          mediumActive.current =
            true;
        }


        if (
          mediumActive.current &&
          distance >
            MEDIUM_ZOOM_EXIT_DISTANCE
        ) {
          mediumActive.current =
            false;
        }


        if (
          !detailActive.current &&
          priorityRegion &&
          distance <
            DETAIL_ZOOM_ENTER_DISTANCE
        ) {
          detailActive.current =
            true;
        }


        if (
          detailActive.current &&
          (
            !priorityRegion ||
            distance >
              DETAIL_ZOOM_EXIT_DISTANCE
          )
        ) {
          detailActive.current =
            false;
        }
      } else {
        mediumActive.current =
          false;

        detailActive.current =
          false;
      }


      const mediumTileX =
        Math.floor(
          lonToTileX(
            lon,
            MEDIUM_SATELLITE_ZOOM
          )
        );


      const mediumTileY =
        Math.floor(
          latToTileY(
            lat,
            MEDIUM_SATELLITE_ZOOM
          )
        );


      const detailTileX =
        Math.floor(
          lonToTileX(
            lon,
            DETAIL_SATELLITE_ZOOM
          )
        );


      const detailTileY =
        Math.floor(
          latToTileY(
            lat,
            DETAIL_SATELLITE_ZOOM
          )
        );


      const nextState =
        mediumActive.current ||
        detailActive.current
          ? {
              medium:
                mediumActive.current
                  ? {
                      x:
                        mediumTileX,

                      y:
                        mediumTileY,

                      z:
                        MEDIUM_SATELLITE_ZOOM,
                    }
                  : null,

              detail:
                detailActive.current
                  ? {
                      x:
                        detailTileX,

                      y:
                        detailTileY,

                      z:
                        DETAIL_SATELLITE_ZOOM,
                    }
                  : null,
            }
          : null;


      const stateKey =
        nextState === null
          ? "hidden"
          : JSON.stringify(
              nextState
            );


      if (
        lastState.current !==
        stateKey
      ) {
        lastState.current =
          stateKey;


        if (mounted) {
          setCenterTile(
            nextState
          );
        }
      }
    };


    updateDetail();


    const interval =
      setInterval(
        updateDetail,
        250
      );


    return () => {
      mounted = false;

      clearInterval(
        interval
      );
    };
  }, [camera]);


  if (!satelliteState) {
    return null;
  }


  const tileMeshes = [];


  const addWindow = (
    center,
    radius,
    prefix
  ) => {
    if (!center) {
      return;
    }


    for (
      let y = -2;
      y <= 2;
      y++
    ) {
      for (
        let x = -2;
        x <= 2;
        x++
      ) {
        const tileX =
          center.x + x;

        const tileY =
          center.y + y;


        tileMeshes.push(
          <SatelliteTile
            key={
              `${prefix}-${center.z}-${tileX}-${tileY}`
            }
            tileX={tileX}
            tileY={tileY}
            zoom={center.z}
            radius={radius}
          />
        );
      }
    }
  };


  addWindow(
    satelliteState.medium,
    SATELLITE_RADIUS +
      0.002,
    "medium"
  );


  addWindow(
    satelliteState.detail,
    DETAIL_SATELLITE_RADIUS,
    "detail"
  );


  return (
    <group
      renderOrder={20}
    >
      {tileMeshes}
    </group>
  );
}


/* ============================================================
   SENTINEL LAYER
============================================================ */

function SatelliteLayer() {
  return (
    <>
      <GlobalSatelliteGlobe />

      <DetailSatelliteLayer />
    </>
  );
}


/* ============================================================
   ATMOSPHERE
============================================================ */

function Atmosphere({
  lightMode = false,
}) {
  return (
    <mesh
      scale={[
        1.012,
        1.012,
        1.012,
      ]}
    >
      <sphereGeometry
        args={[
          2,
          48,
          48,
        ]}
      />

      <meshBasicMaterial
        color={
          lightMode
            ? "#8ee8f5"
            : "#63c7d8"
        }
        transparent
        opacity={
          lightMode
            ? 0.055
            : 0.022
        }
        side={
          THREE.BackSide
        }
        blending={
          THREE.AdditiveBlending
        }
        depthWrite={false}
        depthTest={true}
        toneMapped={false}
      />
    </mesh>
  );
}


/* ============================================================
   OCEAN DATA POINTS
============================================================ */

function OceanGlowPoints() {
  return null;
}





/* ============================================================
   DAY/NIGHT OVERLAY

   A semi-transparent sphere that darkens one side
   of the globe based on a sun direction. Creates a
   subtle space-like day/night effect without replacing
   any existing textures or materials.
============================================================ */

function DayNightOverlay({ sunDirection = DEFAULT_SUN_DIRECTION }) {
  const materialRef = useRef(null);

  useFrame((state) => {
    if (!materialRef.current) return;

    materialRef.current.uniforms.uSunDir.value.copy(sunDirection);
  });

  return (
    <mesh scale={[2.005, 2.005, 2.005]}>
      <sphereGeometry args={[1, 48, 48]} />
      <shaderMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        depthTest={true}
        side={THREE.FrontSide}
        uniforms={{
          uSunDir: { value: sunDirection.clone() },
        }}
        vertexShader={`
          varying vec3 vNormal;
          varying vec3 vWorldPosition;

          void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPos.xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          uniform vec3 uSunDir;
          varying vec3 vNormal;
          varying vec3 vWorldPosition;

          void main() {
            vec3 normDir = normalize(vWorldPosition);
            float sunDot = dot(normDir, uSunDir);

            /*
              Smooth terminator: from fully lit to darker.
              sunDot > 0.15 → fully lit
              sunDot < -0.15 → darker
              Between: smooth transition
            */
            float terminator = smoothstep(-0.15, 0.15, sunDot);

            /*
              Night side: subtle darkening, NOT completely black.
              Keeps continents and oceans recognizable.
            */
            float darkness = mix(0.0, 0.55, 1.0 - terminator);

            gl_FragColor = vec4(vec3(0.0), darkness);
          }
        `}
        toneMapped={false}
      />
    </mesh>
  );
}


/* ============================================================
   CAMERA GEOGRAPHIC POSITION
============================================================ */

function getCameraLatLon(
  camera
) {
  const position =
    camera.position.clone();


  const distance =
    position.length();


  if (distance === 0) {
    return {
      lat: 0,
      lon: 0,
    };
  }


  const lat =
    THREE.MathUtils.radToDeg(
      Math.asin(
        THREE.MathUtils.clamp(
          position.y /
            distance,
          -1,
          1
        )
      )
    );


  const correctedLon =
    Math.atan2(
      position.x,
      position.z
    );


  let lon =
    THREE.MathUtils.radToDeg(
      correctedLon
    ) - 70;


  if (lon > 180) {
    lon -= 360;
  }


  if (lon < -180) {
    lon += 360;
  }


  return {
    lat,
    lon,
  };
}


/* ============================================================
   REGION CHECKS
============================================================ */

function isInsideDeepZoomRegion(
  lat,
  lon
) {
  return DEEP_ZOOM_REGIONS.some(
    (region) =>
      lat >= region.minLat &&
      lat <= region.maxLat &&
      lon >= region.minLon &&
      lon <= region.maxLon
  );
}


function isInsideIndianCoastalPriority(
  lat,
  lon
) {
  return INDIAN_COASTAL_PRIORITY.some(
    (region) =>
      lat >= region.minLat &&
      lat <= region.maxLat &&
      lon >= region.minLon &&
      lon <= region.maxLon
  );
}/* ============================================================
   CAMERA CONTROLLER

   State machine:
   - idle: normal OrbitControls
   - locationAnimating: camera moving to ocean location
   - dataAnimating: camera locked during data layer activation

   Same button clicked twice → returns to default view.
   Different button → smoothly transitions.
============================================================ */

function CameraController({
  activeLocation,
  cameraState,
  onAnimationComplete,
}) {
  const controlsRef = useRef(null);

  const targetPosition = useRef(new THREE.Vector3());
  const targetLookAt = useRef(new THREE.Vector3(0, 0, 0));
  const animating = useRef(false);
  const deepZoomActive = useRef(false);
  const prevLocationKey = useRef(null);

  /*
    Compute camera distance based on latitude.
    Larger regions (Indian Ocean) → farther view.
    Smaller regions (Arabian Sea) → closer view.
  */
  function getLocationDistance(lat, lon) {
    /* Indian Ocean spans a large area — wider framing */
    if (lat < -5) return 5.5;
    /* Arabian Sea / Bay of Bengal — regional framing */
    return 3.8;
  }

  useEffect(() => {
    if (!activeLocation) return;

    const distance =
      activeLocation.distance ||
      getLocationDistance(activeLocation.lat, activeLocation.lon);

    const lat = THREE.MathUtils.degToRad(activeLocation.lat);
    const lon = THREE.MathUtils.degToRad(activeLocation.lon + 70);

    targetPosition.current.set(
      distance * Math.cos(lat) * Math.sin(lon),
      distance * Math.sin(lat),
      distance * Math.cos(lat) * Math.cos(lon)
    );

    targetLookAt.current.set(0, 0, 0);
    animating.current = true;
  }, [activeLocation]);

  /*
    During locationAnimating: disable user rotate/zoom.
    During dataAnimating: disable user interaction.
    During idle: enable all controls.
  */
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (cameraState === 'locationAnimating' || cameraState === 'dataAnimating') {
      controls.enabled = false;
    } else {
      controls.enabled = true;
    }
  }, [cameraState]);

  useFrame((state, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (animating.current) {
      const cameraAlpha = 1 - Math.exp(-5.5 * delta);
      const targetAlpha = 1 - Math.exp(-6.5 * delta);

      state.camera.position.lerp(targetPosition.current, cameraAlpha);
      controls.target.lerp(targetLookAt.current, targetAlpha);

      const positionDistance = state.camera.position.distanceTo(targetPosition.current);
      const targetDistance = controls.target.distanceTo(targetLookAt.current);

      if (positionDistance < 0.008 && targetDistance < 0.008) {
        state.camera.position.copy(targetPosition.current);
        controls.target.copy(targetLookAt.current);
        animating.current = false;

        if (onAnimationComplete) {
          onAnimationComplete();
        }
      }
    }

    /* Deep zoom region detection */
    const { lat, lon } = getCameraLatLon(state.camera);
    const insideDeepRegion = isInsideDeepZoomRegion(lat, lon);

    if (insideDeepRegion !== deepZoomActive.current) {
      deepZoomActive.current = insideDeepRegion;
      controls.minDistance = insideDeepRegion ? 2.038 : 2.75;
    }

    const currentDistance = state.camera.position.length();
    if (currentDistance < controls.minDistance) {
      const direction = state.camera.position.clone().normalize();
      state.camera.position.copy(direction.multiplyScalar(controls.minDistance));
    }

    controls.update();
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableRotate={true}
      enableZoom={true}
      enablePan={false}
      enableDamping={true}
      dampingFactor={0.08}
      rotateSpeed={0.8}
      zoomSpeed={0.72}
      minDistance={2.038}
      maxDistance={14}
      minPolarAngle={0.05}
      maxPolarAngle={Math.PI - 0.05}
      autoRotate={false}
    />
  );
}


/* ============================================================
   DEEP SPACE / LIGHT SKY
============================================================ */

function DeepSpaceBackground({
  lightMode = false,
}) {
  const texture =
    useMemo(() => {
      const canvas =
        document.createElement(
          "canvas"
        );


      canvas.width = 2048;

      canvas.height = 1024;


      const ctx =
        canvas.getContext("2d");


      if (!ctx) {
        return null;
      }


      if (lightMode) {
        const sky =
          ctx.createLinearGradient(
            0,
            0,
            0,
            canvas.height
          );


        sky.addColorStop(
          0,
          "#86cce4"
        );

        sky.addColorStop(
          0.42,
          "#c8eaf5"
        );

        sky.addColorStop(
          1,
          "#eef9fc"
        );


        ctx.fillStyle =
          sky;


        ctx.fillRect(
          0,
          0,
          canvas.width,
          canvas.height
        );


        const sunlight =
          ctx.createRadialGradient(
            canvas.width * 0.83,
            canvas.height * 0.14,
            10,
            canvas.width * 0.83,
            canvas.height * 0.14,
            canvas.width * 0.62
          );


        sunlight.addColorStop(
          0,
          "rgba(255,245,175,0.46)"
        );

        sunlight.addColorStop(
          0.20,
          "rgba(255,238,170,0.20)"
        );

        sunlight.addColorStop(
          0.52,
          "rgba(255,242,190,0.07)"
        );

        sunlight.addColorStop(
          1,
          "rgba(255,255,255,0)"
        );


        ctx.fillStyle =
          sunlight;


        ctx.fillRect(
          0,
          0,
          canvas.width,
          canvas.height
        );


        for (
          let i = 0;
          i < 110;
          i++
        ) {
          const x =
            Math.random() *
            canvas.width;

          const y =
            Math.random() *
            canvas.height;


          const size =
            Math.random() *
              0.20 +
            0.07;


          const alpha =
            Math.random() *
              0.12 +
            0.035;


          ctx.fillStyle =
            `rgba(255,255,255,${alpha})`;


          ctx.beginPath();

          ctx.arc(
            x,
            y,
            size,
            0,
            Math.PI * 2
          );

          ctx.fill();
        }


        const haze =
          ctx.createRadialGradient(
            canvas.width * 0.46,
            canvas.height * 0.60,
            20,
            canvas.width * 0.46,
            canvas.height * 0.60,
            canvas.width * 0.76
          );


        haze.addColorStop(
          0,
          "rgba(255,255,255,0.15)"
        );

        haze.addColorStop(
          1,
          "rgba(255,255,255,0)"
        );


        ctx.fillStyle =
          haze;


        ctx.fillRect(
          0,
          0,
          canvas.width,
          canvas.height
        );

      } else {

        ctx.fillStyle =
          "#000000";


        ctx.fillRect(
          0,
          0,
          canvas.width,
          canvas.height
        );


        const glow =
          ctx.createRadialGradient(
            canvas.width * 0.5,
            canvas.height * 0.5,
            100,
            canvas.width * 0.5,
            canvas.height * 0.5,
            canvas.width * 0.85
          );


        glow.addColorStop(
          0,
          "rgba(8,16,24,0.10)"
        );

        glow.addColorStop(
          0.45,
          "rgba(3,8,14,0.05)"
        );

        glow.addColorStop(
          1,
          "rgba(0,0,0,0)"
        );


        ctx.fillStyle =
          glow;


        ctx.fillRect(
          0,
          0,
          canvas.width,
          canvas.height
        );


        ctx.save();

        ctx.translate(
          canvas.width / 2,
          canvas.height / 2
        );

        ctx.rotate(
          -0.18
        );


        const milkyWay =
          ctx.createLinearGradient(
            -canvas.width,
            0,
            canvas.width,
            0
          );


        milkyWay.addColorStop(
          0,
          "rgba(255,255,255,0)"
        );

        milkyWay.addColorStop(
          0.30,
          "rgba(130,150,165,0.004)"
        );

        milkyWay.addColorStop(
          0.42,
          "rgba(170,185,195,0.008)"
        );

        milkyWay.addColorStop(
          0.50,
          "rgba(205,215,220,0.012)"
        );

        milkyWay.addColorStop(
          0.58,
          "rgba(170,185,195,0.008)"
        );

        milkyWay.addColorStop(
          0.70,
          "rgba(130,150,165,0.004)"
        );

        milkyWay.addColorStop(
          1,
          "rgba(255,255,255,0)"
        );


        ctx.fillStyle =
          milkyWay;


        ctx.fillRect(
          -canvas.width,
          -canvas.height * 0.055,
          canvas.width * 2,
          canvas.height * 0.11
        );


        ctx.restore();


        for (
          let i = 0;
          i < 900;
          i++
        ) {
          const x =
            Math.random() *
            canvas.width;

          const y =
            Math.random() *
            canvas.height;


          const roll =
            Math.random();


          let size;

          let alpha;


          if (roll < 0.86) {
            size =
              Math.random() *
                0.18 +
              0.08;

            alpha =
              Math.random() *
                0.16 +
              0.07;

          } else if (
            roll < 0.98
          ) {
            size =
              Math.random() *
                0.28 +
              0.14;

            alpha =
              Math.random() *
                0.18 +
              0.14;

          } else {
            size =
              Math.random() *
                0.40 +
              0.20;

            alpha =
              Math.random() *
                0.20 +
              0.25;
          }


          const colorRoll =
            Math.random();


          let starColor;


          if (
            colorRoll < 0.88
          ) {
            starColor =
              "255,255,255";

          } else if (
            colorRoll < 0.96
          ) {
            starColor =
              "215,230,245";

          } else {
            starColor =
              "255,238,220";
          }


          ctx.fillStyle =
            `rgba(${starColor},${alpha})`;


          ctx.beginPath();


          ctx.arc(
            x,
            y,
            size,
            0,
            Math.PI * 2
          );


          ctx.fill();
        }


        for (
          let i = 0;
          i < 24;
          i++
        ) {
          const x =
            Math.random() *
            canvas.width;

          const y =
            Math.random() *
            canvas.height;


          const size =
            Math.random() *
              0.55 +
            0.35;


          const halo =
            ctx.createRadialGradient(
              x,
              y,
              0,
              x,
              y,
              size * 2.2
            );


          halo.addColorStop(
            0,
            "rgba(255,255,255,0.70)"
          );

          halo.addColorStop(
            0.30,
            "rgba(225,238,248,0.18)"
          );

          halo.addColorStop(
            1,
            "rgba(255,255,255,0)"
          );


          ctx.fillStyle =
            halo;


          ctx.beginPath();


          ctx.arc(
            x,
            y,
            size * 2.2,
            0,
            Math.PI * 2
          );


          ctx.fill();


          ctx.fillStyle =
            "rgba(255,255,255,0.92)";


          ctx.beginPath();


          ctx.arc(
            x,
            y,
            size * 0.35,
            0,
            Math.PI * 2
          );


          ctx.fill();
        }
      }


      const generatedTexture =
        new THREE.CanvasTexture(
          canvas
        );


      generatedTexture.colorSpace =
        THREE.SRGBColorSpace;


      generatedTexture.minFilter =
        THREE.LinearFilter;


      generatedTexture.magFilter =
        THREE.NearestFilter;


      generatedTexture.wrapS =
        THREE.ClampToEdgeWrapping;


      generatedTexture.wrapT =
        THREE.ClampToEdgeWrapping;


      generatedTexture.anisotropy =
        1;


      generatedTexture.generateMipmaps =
        false;


      generatedTexture.needsUpdate =
        true;


      return generatedTexture;
    }, [lightMode]);


  useEffect(() => {
    return () => {
      if (texture) {
        texture.dispose();
      }
    };
  }, [texture]);


  if (!texture) {
    return null;
  }


  return (
    <mesh
      scale={[
        90,
        90,
        90,
      ]}
      renderOrder={-1000}
      frustumCulled={false}
    >
      <sphereGeometry
        args={[
          1,
          64,
          64,
        ]}
      />

      <meshBasicMaterial
        map={texture}
        side={
          THREE.BackSide
        }
        transparent={false}
        opacity={1}
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
        fog={false}
      />
    </mesh>
  );
}



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
  onAnimationComplete,
}) {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const overlayRef = useRef(null);
  const animationRef = useRef(null);
  const currentLinesRef = useRef(null);
  const dataPointsRef = useRef(null);
  const warningEntityRef = useRef(null);
  const coastalEntityRef = useRef(null);

  const DEMO_BOUNDS = useMemo(
    () => ({ minLat: -28, maxLat: 26, minLon: 48, maxLon: 98 }),
    []
  );

  const colorForTemperature = (value) => {
    const t = Cesium.Math.clamp((value - 16) / 18, 0, 1);
    const stops = [
      [0.00, "#083b8c"],
      [0.20, "#0077c8"],
      [0.40, "#00cfe8"],
      [0.55, "#28df6b"],
      [0.68, "#ffe500"],
      [0.82, "#ff8500"],
      [0.93, "#f1261b"],
      [1.00, "#8c0a5b"],
    ];

    for (let i = 0; i < stops.length - 1; i += 1) {
      const a = stops[i];
      const b = stops[i + 1];
      if (t <= b[0]) {
        const f = (t - a[0]) / (b[0] - a[0]);
        return Cesium.Color.fromCssColorString(a[1]).lerp(
          Cesium.Color.fromCssColorString(b[1]),
          f,
          new Cesium.Color()
        );
      }
    }

    return Cesium.Color.fromCssColorString("#8c0a5b");
  };

  const colorForSalinity = (value) => {
    const t = Cesium.Math.clamp((value - 31) / 6, 0, 1);
    return Cesium.Color.fromHsl(
      0.56 - t * 0.38,
      0.92,
      0.48 + t * 0.10,
      1
    );
  };

  const demoTemperature = (lat, lon, d) => {
    let value = 29.6 - 0.34 * Math.abs(lat + 6);
    value += 0.8 * Math.exp(-(((lat - 13) ** 2) / 90 + ((lon - 88) ** 2) / 90));
    value -= 3.2 * Math.exp(-(((lat - 9) ** 2) / 14 + ((lon - 52) ** 2) / 14));
    value -= 2.2 * Math.exp(-(((lat - 19) ** 2) / 10 + ((lon - 58.5) ** 2) / 10));
    value -= 15 * (1 - Math.exp(-d / 420));
    return Cesium.Math.clamp(value, 16, 34);
  };

  const demoSalinity = (lat, lon, d) => {
    const asCore = Math.exp(-(((lat - 14) ** 2) / 60 + ((lon - 64) ** 2) / 90));
    const bobBroad = Math.exp(-(((lat - 15) ** 2) / 40 + ((lon - 86) ** 2) / 60));
    const bobPlume = Math.exp(-(((lat - 20.5) ** 2) / 12 + ((lon - 89.5) ** 2) / 18));
    return Cesium.Math.clamp(34.9 + 1.3 * asCore - 1.1 * bobBroad - 1.8 * bobPlume - d * 0.002, 31, 37);
  };

  const demoUV = (lat, lon, d) => {
    let u = 0;
    let v = 0;
    const somali = Math.exp(-(((lat - 6) ** 2) / 30 + ((lon - 50) ** 2) / 40));
    u += 0.85 * somali;
    v += 0.55 * somali;
    const jet = Math.exp(-(((lat - 8) ** 2) / 26 + ((lon - 72) ** 2) / 260));
    u += 0.65 * jet;
    v += 0.12 * jet;
    const bob = Math.exp(-(((lat - 10) ** 2) / 20 + ((lon - 90) ** 2) / 70));
    u += 0.45 * bob;
    v += 0.30 * bob;
    const eicc = Math.exp(-(((lat - 16) ** 2) / 18 + ((lon - 87.5) ** 2) / 6));
    u -= 0.15 * eicc;
    v -= 0.50 * eicc;
    const sec = Math.exp(-(((lat + 13) ** 2) / 40));
    u -= 0.55 * sec;
    u += 0.1 * Math.sin(lat * 0.5 + lon * 0.35) * Math.cos(lon * 0.28 - lat * 0.18);
    v += 0.08 * Math.cos(lat * 0.4 + lon * 0.22);
    const scale = Math.exp(-d / 350);
    return { u: u * scale, v: v * scale };
  };

  const flyToLocation = (location) => {
    const viewer = viewerRef.current;
    if (!viewer || !location) return;

    if (animationRef.current) {
      animationRef.current.cancel = true;
    }

    const height = Number(location.distance)
      ? Math.max(900000, Number(location.distance) * 700000)
      : 2600000;

    const destination = Cesium.Cartesian3.fromDegrees(
      Number(location.lon),
      Number(location.lat),
      height
    );

    viewer.camera.flyTo({
      destination,
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-52),
        roll: 0,
      },
      duration: 1.45,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: () => {
        if (onAnimationComplete) onAnimationComplete();
      },
      cancel: () => {
        if (onAnimationComplete) onAnimationComplete();
      },
    });
  };

  /* Viewer creation */
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return undefined;

    let destroyed = false;

    const viewer = new Cesium.Viewer(containerRef.current, {
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
    });

    viewerRef.current = viewer;
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.showGroundAtmosphere = true;
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.globe.maximumScreenSpaceError = 1.25;
    viewer.scene.globe.tileCacheSize = 1200;
    viewer.scene.highDynamicRange = false;
    viewer.scene.fxaa = true;
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(
      lightMode ? "#bfe9f7" : "#020b14"
    );

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(75, 8, 10500000),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
    });

    /* ------------------------------------------------------------
       IMAGERY
       Add a synchronous fallback first so the globe is NEVER blank.
       Satellite imagery is placed above it.
    ------------------------------------------------------------ */
    const fallbackImagery = new Cesium.OpenStreetMapImageryProvider({
      url: "https://tile.openstreetmap.org/",
    });
    viewer.imageryLayers.addImageryProvider(fallbackImagery);

    const satelliteImagery = new Cesium.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      credit: "Esri World Imagery",
      maximumLevel: 19,
      enablePickFeatures: false,
    });
    viewer.imageryLayers.addImageryProvider(satelliteImagery);

    /* ------------------------------------------------------------
       REAL 3D TERRAIN
       Keep the normal ellipsoid until ArcGIS terrain finishes loading.
    ------------------------------------------------------------ */
    const terrainUrl = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

    Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(terrainUrl)
      .then((terrainProvider) => {
        if (destroyed || viewer.isDestroyed()) return;
        viewer.terrainProvider = terrainProvider;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.scene.requestRender();
      })
      .catch((error) => {
        console.warn("[RATNAKARA] Cesium terrain unavailable; keeping globe terrain:", error);
      });

    const postRender = () => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const now = performance.now();
      overlay.style.setProperty("--cesium-time", String(now));
    };

    viewer.scene.postRender.addEventListener(postRender);

    return () => {
      destroyed = true;
      viewer.scene.postRender.removeEventListener(postRender);
      if (!viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  /* Theme / render quality */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(
      lightMode ? "#bfe9f7" : "#020b14"
    );
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(
      lightMode ? "#78c9d9" : "#123d4f"
    );
  }, [lightMode]);

  /* Keep Cesium input enabled only while idle, matching the old camera state machine. */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const controller = viewer.scene.screenSpaceCameraController;
    const enabled = cameraState === "idle";
    controller.enableRotate = enabled;
    controller.enableZoom = enabled;
    controller.enableTranslate = enabled;
    controller.enableTilt = enabled;
    controller.enableLook = enabled;
  }, [cameraState]);

  /* Fly-to animation */
  useEffect(() => {
    if (!activeLocation) return;
    flyToLocation(activeLocation);
  }, [activeLocation]);

  /* Pinpoint / coastal marker. */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (warningEntityRef.current) {
      viewer.entities.remove(warningEntityRef.current);
      warningEntityRef.current = null;
    }

    const point = activeWarning || coastalPinpoint;
    if (!point) return;

    const severity = activeWarning?.severity || "high";
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

    return () => {
      if (viewerRef.current && !viewerRef.current.isDestroyed() && entity) {
        viewerRef.current.entities.remove(entity);
      }
    };
  }, [activeWarning, coastalPinpoint]);

  /* Temperature / salinity point field. */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (dataPointsRef.current) {
      viewer.scene.primitives.remove(dataPointsRef.current);
      dataPointsRef.current = null;
    }

    if (
      (activeLayer !== "Temperature" && activeLayer !== "Salinity") ||
      (activeLayer === "Temperature" && !visibleLayers.temperature) ||
      (activeLayer === "Salinity" && !visibleLayers.salinity)
    ) {
      viewer.scene.requestRender();
      return;
    }

    const points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    const step = 2.0;

    for (let lat = DEMO_BOUNDS.minLat; lat <= DEMO_BOUNDS.maxLat; lat += step) {
      for (let lon = DEMO_BOUNDS.minLon; lon <= DEMO_BOUNDS.maxLon; lon += step) {
        /* Rough India / Sri Lanka / SE Asia land exclusion so data remains ocean-only. */
        const land =
          (lat > 5 && lat < 36 && lon > 68 && lon < 91) ||
          (lat > 5 && lat < 11 && lon > 79 && lon < 83) ||
          (lat > 12 && lat < 31 && lon > 35 && lon < 61) ||
          (lat > -10 && lat < 22 && lon > 95 && lon < 130);
        if (land) continue;

        const value = activeLayer === "Temperature"
          ? demoTemperature(lat, lon, depth)
          : demoSalinity(lat, lon, depth);

        const color = activeLayer === "Temperature"
          ? colorForTemperature(value)
          : colorForSalinity(value);

        points.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 4200),
          pixelSize: 8,
          color: color.withAlpha(0.70),
          outlineColor: color.withAlpha(0.15),
          outlineWidth: 1,
          disableDepthTestDistance: 200000,
        });
      }
    }

    dataPointsRef.current = points;
    viewer.scene.requestRender();

    return () => {
      if (viewerRef.current && !viewerRef.current.isDestroyed() && dataPointsRef.current === points) {
        viewerRef.current.scene.primitives.remove(points);
        dataPointsRef.current = null;
      }
    };
  }, [activeLayer, depth, visibleLayers.temperature, visibleLayers.salinity]);

  /* Animated Cesium current field. */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (currentLinesRef.current) {
      viewer.scene.primitives.remove(currentLinesRef.current);
      currentLinesRef.current = null;
    }

    if (activeLayer !== "Currents" || !visibleLayers.current) {
      viewer.scene.requestRender();
      return;
    }

    const lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    const vectors = [];

    for (let lat = -24; lat <= 24; lat += 4) {
      for (let lon = 50; lon <= 96; lon += 4) {
        const { u, v } = demoUV(lat, lon, depth);
        const speed = Math.sqrt(u * u + v * v);
        if (speed < 0.08) continue;
        vectors.push({ lat, lon, u, v, speed });
      }
    }

    let phase = 0;
    const tick = () => {
      phase += 0.035;
      lines.removeAll();

      for (const vector of vectors) {
        const scale = 1.15 + vector.speed * 2.2;
        const endLon = vector.lon + vector.u * scale;
        const endLat = vector.lat + vector.v * scale;
        const pulse = 0.50 + 0.35 * (0.5 + 0.5 * Math.sin(phase + vector.lon));

        lines.add({
          positions: Cesium.Cartesian3.fromDegreesArray([
            vector.lon,
            vector.lat,
            endLon,
            endLat,
          ]),
          width: 2.2,
          material: Cesium.PolylineDashMaterialProperty
            ? new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.CYAN.withAlpha(pulse),
                dashLength: 10,
              })
            : Cesium.Color.CYAN.withAlpha(pulse),
          clampToGround: true,
        });
      }

      viewer.scene.requestRender();
    };

    const removeListener = viewer.clock.onTick.addEventListener(tick);
    currentLinesRef.current = lines;

    return () => {
      removeListener();
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.scene.primitives.remove(lines);
      }
      if (currentLinesRef.current === lines) currentLinesRef.current = null;
    };
  }, [activeLayer, depth, visibleLayers.current]);

  /* Continuous soft marker pulse, replacing the old R3F pinpoint animation. */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!warningEntityRef.current) return;

    const entity = warningEntityRef.current;
    const start = performance.now();

    const listener = () => {
      if (!viewerRef.current || viewerRef.current.isDestroyed()) return;
      const t = (performance.now() - start) / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 4.0);
      if (entity.point) {
        entity.point.pixelSize = 11 + pulse * 7;
      }
      if (entity.ellipse) {
        entity.ellipse.semiMajorAxis = 18000 + pulse * 13000;
        entity.ellipse.semiMinorAxis = 18000 + pulse * 13000;
      }
    };

    viewer.scene.preRender.addEventListener(listener);
    return () => viewer.scene.preRender.removeEventListener(listener);
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
    >
      <div
        ref={overlayRef}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 1,
        }}
      />
    </div>
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


  const [
    activeLayer,
    setActiveLayer,
  ] = useState(
    "Temperature"
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
    if (cameraState !== 'idle') return;
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

  const DEFAULT_CAMERA = { lat: 0, lon: 0, distance: 7 };

  const clearLayerAnimationTimer = () => {
    if (layerAnimationTimerRef.current) {
      clearTimeout(layerAnimationTimerRef.current);
      layerAnimationTimerRef.current = null;
    }
  };

  const handleLayerSelect = (layerName) => {
    if (cameraState !== 'idle') return;

    clearLayerAnimationTimer();

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
    if (cameraState !== 'idle') return;

    clearLayerAnimationTimer();
    setCoastalPinpoint(null);

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
    if (cameraState !== 'idle') return;

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

        <div className="brand">

          <h1>
            RATNAKARA
          </h1>

          <p>
            Ocean Intelligence Platform
          </p>

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

            onClick={() =>
              handleLayerSelect(
                "Temperature"
              )
            }
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
          onAnimationComplete={handleCameraAnimationComplete}
        />


        {/* ====================================================
            HTML OVERLAY COMPONENTS

            These sit on top of the Three.js canvas
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

        {/* Temperature legend */}
        <TemperatureLegend
          visible={activeLayer === "Temperature" && visibleLayers.temperature}
          lightMode={lightMode}
        />

        {/* Current legend */}
        <CurrentLegend
          visible={activeLayer === "Currents" && visibleLayers.current}
          lightMode={lightMode}
        />

      </main>

    </div>
  );
}


export default App;