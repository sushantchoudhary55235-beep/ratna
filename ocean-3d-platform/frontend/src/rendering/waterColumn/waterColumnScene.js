/* ============================================================
   RATNAKARA — 3D WATER COLUMN STUDIO · ISOLATED THREE.JS SCENE

   Owns a private WebGLRenderer on its own <canvas> — the Cesium
   globe's WebGL context is never touched or shared (spec Phase 19).

   Scene inventory (spec Phases 4, 7, 11, 12, 15, 21-22):
   - transparent BoxGeometry water volume + wireframe boundary
   - surface plane, seabed plane (visual only, labeled so)
   - depth ruler with real/visual tick labels
   - four side walls textured from REAL multi-level sections
   - laser scan plane textured from the ONE selected real slice
   - stratification planes from REAL model levels (toggleable)
   - current vectors from REAL U/V data (toggleable)
   - location pin at the selected coordinates
   - OrbitControls + subtle auto-rotation + reset camera

   Every GPU resource is tracked and disposed on destroy(). The
   animation loop is fully owned here and cancelled on unmount.
============================================================ */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  CUBE_W,
  CUBE_L,
  CUBE_H,
  VISUAL_MAX_DEPTH,
  depthToY,
  formatMeters,
} from "./waterColumnDepth";

const OCEAN_TINT = 0x0a3a52;
const ACCENT = 0x7dd3fc;

/* ============================================================
   TEXT BUILDING BLOCKS (canvas → sprite/plane)
============================================================ */

function makeCanvasTexture(width, height, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  draw(context, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function makeLabelSprite(text, { color = "#e2e8f0", size = 46 } = {}) {
  const texture = makeCanvasTexture(512, 128, (context, w, h) => {
    context.clearRect(0, 0, w, h);
    context.font = `600 ${size}px Inter, 'Segoe UI', Arial, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.shadowColor = "rgba(2, 11, 20, 0.95)";
    context.shadowBlur = 10;
    context.fillStyle = color;
    context.fillText(text, w / 2, h / 2);
  });
  if (!texture) return null;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(4.4, 1.1, 1);
  return sprite;
}

/* ============================================================
   SCENE FACTORY
============================================================ */

/**
 * Create the water-column scene.
 *
 * @param {HTMLCanvasElement} canvas render target (owned by caller)
 * @param {object} handlers callbacks: { onDepthPicked(meters) }
 * @returns {object|null} controller, or null when WebGL is unavailable
 */
export function createWaterColumnScene(canvas, handlers = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
  } catch (err) {
    console.error("WaterColumnStudio: WebGL initialization failed:", err);
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0); /* transparent — CSS supplies the ocean backdrop */

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
  const HOME = new THREE.Vector3(16, 11, 20);
  camera.position.copy(HOME);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 6;
  controls.maxDistance = 50;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.target.set(0, 0, 0);

  /* --- lights --- */
  scene.add(new THREE.AmbientLight(0xbfd9e8, 0.9));
  const keyLight = new THREE.DirectionalLight(0xdff3ff, 1.15);
  keyLight.position.set(12, 18, 8);
  scene.add(keyLight);

  /* --- disposals registry --- */
  const disposables = [];
  const track = (resource) => {
    disposables.push(resource);
    return resource;
  };

  const groups = {};
  const state = {
    stratificationVisible: true,
    vectorsVisible: true,
    autoRotate: false,
    maxRealDepth: 0,
  };

  /* ============================================================
     WATER VOLUME + STRUCTURE
  ============================================================ */

  function buildStructure() {
    const group = new THREE.Group();
    groups.structure = group;
    scene.add(group);

    /* Transparent outer volume */
    const volumeGeo = track(new THREE.BoxGeometry(CUBE_W, CUBE_H, CUBE_L));
    const volumeMat = track(
      new THREE.MeshPhysicalMaterial({
        color: OCEAN_TINT,
        transparent: true,
        opacity: 0.16,
        roughness: 0.35,
        metalness: 0,
        transmission: 0.55,
        thickness: 1.5,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    group.add(new THREE.Mesh(volumeGeo, volumeMat));

    /* Wireframe boundary (subtle cyan) */
    const edgesGeo = track(new THREE.EdgesGeometry(volumeGeo));
    const edgesMat = track(
      new THREE.LineBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: 0.55,
      })
    );
    group.add(new THREE.LineSegments(edgesGeo, edgesMat));

    /* Surface plane — procedural water shimmer (visual only, spec
       Phase 36 allows procedural SURFACE graphics). */
    const surfaceTex = track(
      makeCanvasTexture(512, 256, (context, w, h) => {
        const grad = context.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, "rgba(64, 148, 190, 0.85)");
        grad.addColorStop(1, "rgba(20, 84, 118, 0.55)");
        context.fillStyle = grad;
        context.fillRect(0, 0, w, h);
        context.strokeStyle = "rgba(210, 240, 255, 0.20)";
        context.lineWidth = 1.5;
        for (let i = 0; i < 26; i++) {
          const y = (i / 26) * h + Math.sin(i * 2.7) * 4;
          context.beginPath();
          context.moveTo(0, y);
          for (let x = 0; x <= w; x += 16) {
            context.lineTo(x, y + Math.sin(x * 0.05 + i) * 3);
          }
          context.stroke();
        }
      })
    );
    const surfaceMat = track(
      new THREE.MeshBasicMaterial({
        map: surfaceTex,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    const surface = new THREE.Mesh(
      track(new THREE.PlaneGeometry(CUBE_W, CUBE_L)),
      surfaceMat
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = CUBE_H / 2;
    group.add(surface);
    const surfaceLabel = makeLabelSprite("SURFACE", { color: "#bae6fd" });
    if (surfaceLabel) {
      surfaceLabel.position.set(CUBE_W / 2 + 2.4, CUBE_H / 2, 0);
      group.add(surfaceLabel);
    }

    /* Seabed plane — VISUAL ONLY (model data does not reach it) */
    const seabedMat = track(
      new THREE.MeshBasicMaterial({
        color: 0x24303a,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      })
    );
    const seabed = new THREE.Mesh(
      track(new THREE.PlaneGeometry(CUBE_W, CUBE_L)),
      seabedMat
    );
    seabed.rotation.x = -Math.PI / 2;
    seabed.position.y = -CUBE_H / 2;
    group.add(seabed);
    const seabedLabel = makeLabelSprite("BELOW MODEL DATA (visual)", {
      color: "#94a3b8",
      size: 34,
    });
    if (seabedLabel) {
      seabedLabel.position.set(0, -CUBE_H / 2 - 1.1, 0);
      group.add(seabedLabel);
    }

    /* Depth ruler along one edge */
    const rulerGroup = new THREE.Group();
    group.add(rulerGroup);
    const rulerX = CUBE_W / 2 + 0.15;
    const rulerMat = track(
      new THREE.LineBasicMaterial({ color: 0x8fadb8, transparent: true, opacity: 0.8 })
    );
    const rulerPts = [
      new THREE.Vector3(rulerX, CUBE_H / 2, -CUBE_L / 2),
      new THREE.Vector3(rulerX, -CUBE_H / 2, -CUBE_L / 2),
    ];
    const rulerGeo = track(
      new THREE.BufferGeometry().setFromPoints(rulerPts)
    );
    rulerGroup.add(new THREE.Line(rulerGeo, rulerMat));

    /* Ticks: visual depths every 500m + the real model limit when set */
    const tickDepths = [0, 500, 1000, 1500, 2000];
    if (state.maxRealDepth > 0 && state.maxRealDepth < VISUAL_MAX_DEPTH) {
      tickDepths.push(state.maxRealDepth);
    }
    for (const d of tickDepths) {
      const y = depthToY(d);
      const isModelLimit =
        state.maxRealDepth > 0 && Math.abs(d - state.maxRealDepth) < 0.01;
      const tickGeo = track(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(rulerX, y, -CUBE_L / 2),
          new THREE.Vector3(rulerX + 0.9, y, -CUBE_L / 2),
        ])
      );
      rulerGroup.add(
        new THREE.Line(
          tickGeo,
          track(
            new THREE.LineBasicMaterial({
              color: isModelLimit ? 0xfbbf24 : 0x8fadb8,
              transparent: true,
              opacity: 0.9,
            })
          )
        )
      );
      const label = makeLabelSprite(
        isModelLimit
          ? `MODEL LIMIT ${formatMeters(d)} m`
          : `${formatMeters(d)} m`,
        { color: isModelLimit ? "#fbbf24" : "#94a3b8", size: 30 }
      );
      if (label) {
        label.position.set(rulerX + 1.4, y, -CUBE_L / 2);
        label.scale.set(2.6, 0.62, 1);
        rulerGroup.add(label);
      }
    }
  }

  /* ============================================================
     SIDE WALLS (real multi-level section textures)
  ============================================================ */

  /**
   * @param {HTMLCanvasElement|null} wallCanvas shared RGBA section canvas
   * @param {Array<{depth:number,label:string}>} ticks REAL levels to mark
   */
  function buildWalls(wallCanvas, ticks) {
    if (groups.walls) {
      disposeObject(groups.walls);
      scene.remove(groups.walls);
    }
    const group = new THREE.Group();
    groups.walls = group;
    scene.add(group);

    if (!wallCanvas) return;

    const wallTexture = track(new THREE.CanvasTexture(wallCanvas));
    wallTexture.colorSpace = THREE.SRGBColorSpace;

    /* Canvas row 0 = surface; Three.js textures flip Y by default so
       row 0 lands at the TOP of the plane — exactly the surface. */
    const wallMat = track(
      new THREE.MeshBasicMaterial({
        map: wallTexture,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );

    /* Vertical extent: top = surface (y=+H/2); bottom = deepest REAL
       level mapped through depthToY (NOT the cube bottom). */
    const topY = CUBE_H / 2;
    const bottomY = depthToY(state.maxRealDepth || VISUAL_MAX_DEPTH);
    const wallH = topY - bottomY;
    const wallGeo = track(new THREE.PlaneGeometry(CUBE_W * 0.995, wallH));

    const yCenter = (topY + bottomY) / 2;
    const placements = [
      { z: -CUBE_L / 2, rotY: 0 },
      { z: CUBE_L / 2, rotY: Math.PI },
      { x: -CUBE_W / 2, rotY: Math.PI / 2 },
      { x: CUBE_W / 2, rotY: -Math.PI / 2 },
    ];
    for (const p of placements) {
      const wall = new THREE.Mesh(wallGeo, wallMat);
      if (p.z !== undefined) {
        wall.position.set(0, yCenter, p.z);
      } else {
        wall.position.set(p.x, yCenter, 0);
      }
      wall.rotation.y = p.rotY;
      group.add(wall);
    }

    /* REAL-level tick marks + labels on the front-left edge —
       honest depth labels that only mark levels that exist. */
    for (const tick of ticks || []) {
      const y = depthToY(tick.depth);
      const tickGeo = track(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-CUBE_W / 2 - 0.05, y, CUBE_L / 2 + 0.05),
          new THREE.Vector3(-CUBE_W / 2 - 0.65, y, CUBE_L / 2 + 0.05),
        ])
      );
      group.add(
        new THREE.Line(
          tickGeo,
          track(
            new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.85 })
          )
        )
      );
      const label = makeLabelSprite(tick.label, { color: "#7dd3fc", size: 28 });
      if (label) {
        label.position.set(-CUBE_W / 2 - 1.2, y, CUBE_L / 2 + 0.05);
        label.scale.set(1.9, 0.5, 1);
        group.add(label);
      }
    }
  }

  /* ============================================================
     LASER DEPTH SCAN PLANE
  ============================================================ */

  let laserMesh = null;
  function buildLaser() {
    const group = new THREE.Group();
    groups.laser = group;
    scene.add(group);

    const geo = track(new THREE.PlaneGeometry(CUBE_W * 0.99, CUBE_L * 0.99));
    const mat = track(
      new THREE.MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    laserMesh = new THREE.Mesh(geo, mat);
    laserMesh.rotation.x = -Math.PI / 2;
    group.add(laserMesh);

    /* Frame around the scan plane */
    const frameSource = track(new THREE.PlaneGeometry(CUBE_W * 0.99, CUBE_L * 0.99));
    const frameGeo = track(new THREE.EdgesGeometry(frameSource));
    const frameMat = track(
      new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.75 })
    );
    const frame = new THREE.LineSegments(frameGeo, frameMat);
    frame.rotation.x = -Math.PI / 2;
    group.add(frame);

    const label = makeLabelSprite("DEPTH SCAN", { color: "#67e8f9", size: 34 });
    if (label) {
      label.position.set(CUBE_W / 2 + 1.8, 0, CUBE_L / 2 + 0.4);
      label.scale.set(2.8, 0.68, 1);
      group.add(label);
    }
  }

  /**
   * @param {HTMLCanvasElement|null} canvas real-slice canvas (or null to clear)
   */
  function setLaserTexture(canvas) {
    if (!laserMesh) return;
    const mat = laserMesh.material;
    if (mat.map) {
      mat.map.dispose();
      mat.map = null;
    }
    if (canvas) {
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      mat.map = texture;
      mat.opacity = 0.88;
    } else {
      mat.opacity = 0.22;
    }
    mat.needsUpdate = true;
  }

  function setLaserDepth(depthMeters) {
    if (groups.laser) {
      groups.laser.position.y = depthToY(depthMeters);
    }
  }

  /* ============================================================
     STRATIFICATION PLANES (REAL levels, toggleable)
  ============================================================ */

  function setStratificationLevels(levels) {
    if (groups.stratification) {
      disposeObject(groups.stratification);
      scene.remove(groups.stratification);
    }
    const group = new THREE.Group();
    groups.stratification = group;
    scene.add(group);

    for (const depth of levels || []) {
      const y = depthToY(depth);
      const geo = track(
        new THREE.PlaneGeometry(CUBE_W * 0.96, CUBE_L * 0.96)
      );
      const mat = track(
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.07,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      const plane = new THREE.Mesh(geo, mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = y;
      group.add(plane);

      const edges = track(new THREE.EdgesGeometry(geo));
      group.add(
        new THREE.LineSegments(
          edges,
          track(
            new THREE.LineBasicMaterial({
              color: 0x38bdf8,
              transparent: true,
              opacity: 0.28,
            })
          )
        )
      );

      const label = makeLabelSprite(`${formatMeters(depth)} m`, {
        color: "#7dd3fc",
        size: 30,
      });
      if (label) {
        label.position.set(-CUBE_W / 2 - 1.6, y, CUBE_L / 2);
        label.scale.set(2.2, 0.55, 1);
        group.add(label);
      }
    }
    group.visible = state.stratificationVisible;
  }

  /* ============================================================
     CURRENT VECTORS (REAL U/V, toggleable)
  ============================================================ */

  function setCurrentVectors(vectors) {
    if (groups.vectors) {
      disposeObject(groups.vectors);
      scene.remove(groups.vectors);
    }
    const group = new THREE.Group();
    groups.vectors = group;
    scene.add(group);

    for (const v of (vectors || []).slice(0, 260)) {
      /* Geographic direction (u east, v north) into scene axes:
         scene +X = east, scene -Z = north. */
      const dirX = v.u;
      const dirZ = -v.v;
      const mag = Math.hypot(dirX, dirZ);
      if (!Number.isFinite(mag) || mag < 1e-4) continue;

      /* x/y plane position of the grid cell inside the column footprint.
         Grid bounds come from the first vector's slice, provided by the
         caller as v._bounds. Vectors cluster around the pin location. */
      const bounds = v._bounds;
      if (!bounds) continue;
      const fx = (v.longitude - bounds.minLon) / (bounds.maxLon - bounds.minLon);
      const fy = (v.latitude - bounds.minLat) / (bounds.maxLat - bounds.minLat);
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
      const x = -CUBE_W / 2 + fx * CUBE_W;
      const z = CUBE_L / 2 - fy * CUBE_L;

      const length = Math.min(0.25 + mag * 2.2, 2.4);
      const dir = new THREE.Vector3(dirX / mag, 0, dirZ / mag);

      const origin = new THREE.Vector3(x, 0.18, z);
      const arrow = new THREE.ArrowHelper(dir, origin, length, 0x86efac, length * 0.3, length * 0.14);
      group.add(arrow);
    }
    group.visible = state.vectorsVisible;
  }

  /* ============================================================
     LOCATION PIN
  ============================================================ */

  function setLocationPin(lat, lon, bounds) {
    if (groups.pin) {
      disposeObject(groups.pin);
      scene.remove(groups.pin);
    }
    const group = new THREE.Group();
    groups.pin = group;
    scene.add(group);

    let x = 0;
    let z = 0;
    if (bounds) {
      const fx = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
      const fy = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
      if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
        x = -CUBE_W / 2 + fx * CUBE_W;
        z = CUBE_L / 2 - fy * CUBE_L;
      }
    }

    const geo = track(new THREE.CylinderGeometry(0.05, 0.05, CUBE_H, 10));
    const mat = track(
      new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.85 })
    );
    const line = new THREE.Mesh(geo, mat);
    group.add(line);

    const label = makeLabelSprite("LOCATION", { color: "#fbbf24", size: 30 });
    if (label) {
      label.position.set(x, CUBE_H / 2 + 0.9, z);
      label.scale.set(2.2, 0.55, 1);
      group.add(label);
    }
    group.position.x = x;
    group.position.z = z;
    label?.position.set(0, CUBE_H / 2 + 0.9, 0);
  }

  /* ============================================================
     PICK DEPTH (click on column → depth under cursor)
  ============================================================ */

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function onPointerDown(event) {
    if (!handlers.onDepthPicked) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    /* Intersect the vertical center plane of the column. */
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, hit)) {
      if (Math.abs(hit.x) <= CUBE_W / 2 && hit.y <= CUBE_H / 2) {
        const depth = ((CUBE_H / 2 - hit.y) / CUBE_H) * VISUAL_MAX_DEPTH;
        if (depth >= 0 && depth <= VISUAL_MAX_DEPTH) {
          handlers.onDepthPicked(Math.round(depth));
        }
      }
    }
  }
  canvas.addEventListener("pointerdown", onPointerDown);

  /* ============================================================
     RESIZE + LOOP
  ============================================================ */

  function resize(width, height) {
    if (width <= 0 || height <= 0) return; /* never crash on 0-size (spec Phase 19) */
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  let animationId = 0;
  const clock = new THREE.Clock();
  function animate() {
    animationId = requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (state.autoRotate && groups.structure) {
      /* Rotate the COLUMN, not the camera (spec Phase 22) — keeps
         laser plane, ruler and labels perfectly aligned. */
      const speed = 0.25 * delta; /* ≈ 0.004 rad/frame @60fps */
      scene.rotation.y += speed;
    }
    controls.update();
    renderer.render(scene, camera);
  }

  /* ============================================================
     CONTROLLER + DISPOSAL
  ============================================================ */

  function disposeObject(root) {
    root.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const mat of mats) {
          if (mat.map) mat.map.dispose();
          mat.dispose();
        }
      }
    });
  }

  buildStructure();
  buildLaser();
  animate();

  return {
    resize,
    dispose() {
      cancelAnimationFrame(animationId);
      canvas.removeEventListener("pointerdown", onPointerDown);
      controls.dispose();
      for (const key of Object.keys(groups)) {
        disposeObject(groups[key]);
        scene.remove(groups[key]);
      }
      disposeObject(scene);
      for (const resource of disposables) {
        resource.dispose?.();
      }
      disposables.length = 0;
      renderer.dispose();
    },
    setMaxRealDepth(depth) {
      /* The ruler's MODEL LIMIT tick is built from this value, so
         rebuild the structure once the real max is known. */
      const changed = Math.abs((state.maxRealDepth || 0) - depth) > 0.01;
      state.maxRealDepth = depth;
      if (changed && groups.structure) {
        disposeObject(groups.structure);
        scene.remove(groups.structure);
        buildStructure();
      }
    },
    setLaserDepth,
    setLaserTexture,
    buildWalls,
    setStratificationLevels,
    setCurrentVectors,
    setLocationPin,
    setStratificationVisible(visible) {
      state.stratificationVisible = visible;
      if (groups.stratification) groups.stratification.visible = visible;
    },
    setVectorsVisible(visible) {
      state.vectorsVisible = visible;
      if (groups.vectors) groups.vectors.visible = visible;
    },
    setAutoRotate(enabled) {
      state.autoRotate = enabled;
    },
    resetCamera() {
      camera.position.copy(HOME);
      controls.target.set(0, 0, 0);
      controls.update();
    },
    home: HOME,
  };
}
