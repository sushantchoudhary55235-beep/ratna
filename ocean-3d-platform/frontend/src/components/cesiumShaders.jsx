// ============================================================
// RATNAKARA OCEAN DATA VISUALIZATION PROTOTYPE
// CesiumJS Sandcastle
//
// TEMPERATURE  -> continuous color field
// SALINITY     -> irregular clustered white points
// CURRENTS     -> dense animated streamlines
// CHLOROPHYLL  -> continuous green field
//
// Replace DEMO_DATA later with real NetCDF/API data.
// ============================================================

const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
});

viewer.scene.globe.depthTestAgainstTerrain = false;
viewer.scene.globe.enableLighting = false;

viewer.scene.backgroundColor = Cesium.Color.BLACK;


// ============================================================
// CONFIGURATION
// ============================================================

const OCEAN = {
  west: 45,
  east: 110,
  south: -25,
  north: 30,
};

const FIELD_HEIGHT = 5000.0;


// ============================================================
// DEMO DATA
//
// THIS IS THE ONLY PART THAT SHOULD LATER BE REPLACED.
//
// Real pipeline:
//
// NetCDF / API
//       ↓
// Python xarray
//       ↓
// JSON / binary grid
//       ↓
// DEMO_DATA-compatible structure
//       ↓
// Cesium renderer
// ============================================================

const DEMO_DATA = {

  temperature: {
    min: 4,
    max: 34,

    // Demo mathematical field.
    // Later replace with real grid values.
    value(lat, lon, time) {

      const x = (lon - 45) / 65;
      const y = (lat + 25) / 55;

      let value =
        28
        - 13 * Math.abs(y - 0.50)
        + 3.5 * Math.sin(x * Math.PI * 3.0)
        + 2.5 * Math.sin(y * Math.PI * 4.0)
        + 1.5 * Math.sin((x + y) * Math.PI * 6.0 + time);

      return Math.max(4, Math.min(34, value));
    },
  },


  salinity: {
    min: 30,
    max: 38,

    value(lat, lon) {

      let base =
        34.5
        + 1.5 * Math.sin(lon * 0.18)
        + 0.8 * Math.cos(lat * 0.25);

      return Math.max(30, Math.min(38, base));
    },
  },


  currents: {

    vector(lat, lon, time) {

      const x = lon;
      const y = lat;

      // Large-scale Indian Ocean flow
      let u =
        0.75
        + 0.25 * Math.sin(y * 0.18)
        + 0.20 * Math.cos(x * 0.11 + time);

      let v =
        0.35 * Math.sin(x * 0.15)
        + 0.25 * Math.cos(y * 0.20);

      // Add swirling structures
      const dx = x - 78;
      const dy = y - 5;

      const r2 = dx * dx + dy * dy + 20;

      u += (-dy / r2) * 25;
      v += ( dx / r2) * 25;

      return {
        u,
        v,
      };
    },
  },


  chlorophyll: {

    min: 0,
    max: 10,

    value(lat, lon) {

      const coastal =
        Math.exp(
          -Math.abs(lon - 70) * 0.08
        );

      const equatorial =
        Math.exp(
          -Math.abs(lat) * 0.12
        );

      return Math.min(
        10,
        1.0 +
        coastal * 5.5 +
        equatorial * 2.5 +
        Math.sin(lon * 0.3) * 0.7
      );
    },
  },
};


// ============================================================
// COLOR FUNCTIONS
// ============================================================

function temperatureColor(value) {

  const t =
    (value - 4) /
    (34 - 4);

  const stops = [
    [0.00, new Cesium.Color(0.02, 0.15, 0.65, 0.82)],
    [0.20, new Cesium.Color(0.00, 0.70, 0.95, 0.82)],
    [0.40, new Cesium.Color(0.10, 0.85, 0.45, 0.82)],
    [0.55, new Cesium.Color(0.95, 0.95, 0.05, 0.84)],
    [0.70, new Cesium.Color(1.00, 0.55, 0.00, 0.86)],
    [0.85, new Cesium.Color(1.00, 0.18, 0.02, 0.88)],
    [1.00, new Cesium.Color(0.70, 0.00, 0.15, 0.90)],
  ];

  for (let i = 0; i < stops.length - 1; i++) {

    if (t >= stops[i][0] && t <= stops[i + 1][0]) {

      const a = stops[i];
      const b = stops[i + 1];

      const f =
        (t - a[0]) /
        (b[0] - a[0]);

      return Cesium.Color.lerp(
        a[1],
        b[1],
        f,
        new Cesium.Color()
      );
    }
  }

  return stops[stops.length - 1][1];
}


function chlorophyllColor(value) {

  const t =
    Math.max(0, Math.min(1, value / 10));

  return new Cesium.Color(
    0.02 + 0.05 * t,
    0.18 + 0.75 * t,
    0.10 + 0.15 * t,
    0.72
  );
}


// ============================================================
// OCEAN CELL FIELD
//
// This deliberately uses contiguous cells rather than dots.
// The cells touch each other, so the result reads as a field.
// ============================================================

let temperaturePrimitive = null;
let chlorophyllPrimitive = null;

function createField(variable) {

  const instances = [];

  const COLS = 70;
  const ROWS = 55;

  const lonStep =
    (OCEAN.east - OCEAN.west) / COLS;

  const latStep =
    (OCEAN.north - OCEAN.south) / ROWS;

  for (let iy = 0; iy < ROWS; iy++) {

    for (let ix = 0; ix < COLS; ix++) {

      const west =
        OCEAN.west + ix * lonStep;

      const east =
        west + lonStep;

      const south =
        OCEAN.south + iy * latStep;

      const north =
        south + latStep;

      const centerLon =
        (west + east) / 2;

      const centerLat =
        (south + north) / 2;

      let color;

      if (variable === "temperature") {

        color = temperatureColor(
          DEMO_DATA.temperature.value(
            centerLat,
            centerLon,
            animationTime
          )
        );

      } else {

        color = chlorophyllColor(
          DEMO_DATA.chlorophyll.value(
            centerLat,
            centerLon
          )
        );
      }

      instances.push(
        new Cesium.GeometryInstance({

          geometry:
            new Cesium.RectangleGeometry({

              rectangle:
                Cesium.Rectangle.fromDegrees(
                  west,
                  south,
                  east,
                  north
                ),

              height:
                FIELD_HEIGHT,

              vertexFormat:
                Cesium.PerInstanceColorAppearance
                  .VERTEX_FORMAT,
            }),

          attributes:
            {
              color:
                Cesium.ColorGeometryInstanceAttribute.fromColor(
                  color
                ),
            },
        })
      );
    }
  }

  return new Cesium.Primitive({

    geometryInstances: instances,

    appearance:
      new Cesium.PerInstanceColorAppearance({

        flat: true,

        translucent: true,

        closed: false,
      }),

    asynchronous: false,
  });
}


// ============================================================
// SALINITY
//
// Irregular clustered points.
// NOT a rectangular grid.
// ============================================================

let salinityEntities = [];

function createSalinity() {

  const entities = [];

  const clusters = [

    {
      lon: 62,
      lat: 8,
      radius: 9,
      count: 80,
    },

    {
      lon: 73,
      lat: 15,
      radius: 7,
      count: 70,
    },

    {
      lon: 88,
      lat: 5,
      radius: 10,
      count: 90,
    },

    {
      lon: 96,
      lat: 12,
      radius: 6,
      count: 55,
    },
  ];

  clusters.forEach(cluster => {

    for (
      let i = 0;
      i < cluster.count;
      i++
    ) {

      const angle =
        Math.random() *
        Math.PI *
        2;

      const radius =
        Math.sqrt(Math.random()) *
        cluster.radius;

      const lon =
        cluster.lon +
        Math.cos(angle) * radius;

      const lat =
        cluster.lat +
        Math.sin(angle) * radius * 0.7;

      const salinity =
        DEMO_DATA.salinity.value(
          lat,
          lon
        );

      entities.push(

        viewer.entities.add({

          position:
            Cesium.Cartesian3.fromDegrees(
              lon,
              lat,
              FIELD_HEIGHT + 100
            ),

          point: {

            pixelSize:
              3 + salinity * 0.12,

            color:
              Cesium.Color.WHITE
                .withAlpha(0.82),

            outlineColor:
              Cesium.Color.WHITE
                .withAlpha(0.25),

            outlineWidth: 1,

            disableDepthTestDistance:
              Number.POSITIVE_INFINITY,
          },

          properties: {

            variable:
              "Salinity",

            value:
              salinity.toFixed(2),

            latitude:
              lat.toFixed(3),

            longitude:
              lon.toFixed(3),
          },
        })
      );
    }
  });

  return entities;
}


// ============================================================
// CURRENTS
//
// Dense curved streamlines.
// Each streamline is generated by integrating the vector field.
// ============================================================

let currentEntities = [];

function createCurrents() {

  const entities = [];

  const STREAMLINES = 110;

  const STEPS = 55;

  const STEP_SIZE = 0.18;

  for (
    let i = 0;
    i < STREAMLINES;
    i++
  ) {

    let lat =
      OCEAN.south +
      Math.random() *
      (OCEAN.north - OCEAN.south);

    let lon =
      OCEAN.west +
      Math.random() *
      (OCEAN.east - OCEAN.west);

    const positions = [];

    for (
      let s = 0;
      s < STEPS;
      s++
    ) {

      if (
        lon < OCEAN.west ||
        lon > OCEAN.east ||
        lat < OCEAN.south ||
        lat > OCEAN.north
      ) {
        break;
      }

      positions.push(

        Cesium.Cartesian3.fromDegrees(
          lon,
          lat,
          FIELD_HEIGHT + 180
        )
      );

      const vector =
        DEMO_DATA.currents.vector(
          lat,
          lon,
          0
        );

      const magnitude =
        Math.sqrt(
          vector.u * vector.u +
          vector.v * vector.v
        ) || 1;

      lon +=
        (vector.u / magnitude) *
        STEP_SIZE;

      lat +=
        (vector.v / magnitude) *
        STEP_SIZE;
    }

    if (positions.length > 10) {

      entities.push(

        viewer.entities.add({

          polyline: {

            positions,

            width: 1.6,

            material:
              new Cesium.PolylineGlowMaterialProperty({

                glowPower: 0.08,

                taperPower: 0.65,

                color:
                  Cesium.Color.CYAN
                    .withAlpha(0.72),
              }),

            clampToGround: false,
          },
        })
      );
    }
  }

  return entities;
}


// ============================================================
// CURRENT FLOW ANIMATION
//
// Instead of stationary arrows/dots, the streamlines themselves
// are continuously regenerated with a moving time phase.
// ============================================================

let animationTime = 0;

function animateCurrents() {

  animationTime += 0.018;

  // Remove previous lines
  currentEntities.forEach(entity => {

    viewer.entities.remove(entity);

  });

  currentEntities = [];

  const STREAMLINES = 90;

  const STEPS = 55;

  const STEP_SIZE = 0.18;

  for (
    let i = 0;
    i < STREAMLINES;
    i++
  ) {

    let lon =
      OCEAN.west +
      ((i * 7.13) % 1) *
      (OCEAN.east - OCEAN.west);

    let lat =
      OCEAN.south +
      ((i * 13.71) % 1) *
      (OCEAN.north - OCEAN.south);

    const positions = [];

    for (
      let s = 0;
      s < STEPS;
      s++
    ) {

      if (
        lon < OCEAN.west ||
        lon > OCEAN.east ||
        lat < OCEAN.south ||
        lat > OCEAN.north
      ) {
        break;
      }

      positions.push(
        Cesium.Cartesian3.fromDegrees(
          lon,
          lat,
          FIELD_HEIGHT + 180
        )
      );

      const vector =
        DEMO_DATA.currents.vector(
          lat,
          lon,
          animationTime
        );

      const magnitude =
        Math.sqrt(
          vector.u * vector.u +
          vector.v * vector.v
        ) || 1;

      lon +=
        (vector.u / magnitude) *
        STEP_SIZE;

      lat +=
        (vector.v / magnitude) *
        STEP_SIZE;
    }

    if (positions.length > 12) {

      currentEntities.push(

        viewer.entities.add({

          polyline: {

            positions,

            width: 1.5,

            material:
              new Cesium.PolylineGlowMaterialProperty({

                glowPower: 0.08,

                taperPower: 0.75,

                color:
                  Cesium.Color.WHITE
                    .withAlpha(0.55),
              }),
          },
        })
      );
    }
  }
}


// ============================================================
// REMOVE VISUALIZATIONS
// ============================================================

function clearVisualization() {

  if (temperaturePrimitive) {

    viewer.scene.primitives.remove(
      temperaturePrimitive
    );

    temperaturePrimitive = null;
  }

  if (chlorophyllPrimitive) {

    viewer.scene.primitives.remove(
      chlorophyllPrimitive
    );

    chlorophyllPrimitive = null;
  }

  salinityEntities.forEach(
    entity => viewer.entities.remove(entity)
  );

  salinityEntities = [];

  currentEntities.forEach(
    entity => viewer.entities.remove(entity)
  );

  currentEntities = [];
}


// ============================================================
// LAYER CONTROLS
// ============================================================

function showTemperature() {

  clearVisualization();

  temperaturePrimitive =
    createField("temperature");

  viewer.scene.primitives.add(
    temperaturePrimitive
  );
}


function showSalinity() {

  clearVisualization();

  salinityEntities =
    createSalinity();
}


function showCurrents() {

  clearVisualization();

  animateCurrents();
}


function showChlorophyll() {

  clearVisualization();

  chlorophyllPrimitive =
    createField("chlorophyll");

  viewer.scene.primitives.add(
    chlorophyllPrimitive
  );
}


// ============================================================
// BUTTON PANEL
// ============================================================

const panel =
  document.createElement("div");

panel.style.position = "absolute";
panel.style.top = "20px";
panel.style.left = "20px";
panel.style.zIndex = "100";
panel.style.background = "rgba(10,18,30,.94)";
panel.style.padding = "12px";
panel.style.borderRadius = "10px";
panel.style.fontFamily = "sans-serif";

[
  ["TEMPERATURE", showTemperature],
  ["SALINITY", showSalinity],
  ["CURRENTS", showCurrents],
  ["CHLOROPHYLL", showChlorophyll],
].forEach(([label, action]) => {

  const button =
    document.createElement("button");

  button.textContent = label;

  button.style.display = "block";
  button.style.width = "150px";
  button.style.margin = "5px 0";
  button.style.padding = "8px";
  button.style.background = "#122338";
  button.style.color = "white";
  button.style.border = "1px solid #1c8cff";
  button.style.borderRadius = "6px";
  button.style.cursor = "pointer";

  button.onclick = action;

  panel.appendChild(button);
});

document.body.appendChild(panel);


// ============================================================
// START POSITION
// ============================================================

viewer.camera.flyTo({

  destination:
    Cesium.Cartesian3.fromDegrees(
      78,
      5,
      11000000
    ),

  orientation: {

    heading:
      Cesium.Math.toRadians(0),

    pitch:
      Cesium.Math.toRadians(-55),

    roll: 0,
  },
});


// ============================================================
// DEFAULT = TEMPERATURE
// ============================================================

showTemperature();


// ============================================================
// CURRENT ANIMATION LOOP
// ============================================================

let currentMode = false;

const originalShowCurrents =
  showCurrents;

showCurrents = function () {

  clearVisualization();

  currentMode = true;

  animateCurrents();
};


// Stop current animation when another layer is selected.

const oldClear =
  clearVisualization;

clearVisualization = function () {

  currentMode = false;

  oldClear();
};


viewer.clock.onTick.addEventListener(
  function () {

    if (!currentMode) {
      return;
    }

    animateCurrents();

  }
);