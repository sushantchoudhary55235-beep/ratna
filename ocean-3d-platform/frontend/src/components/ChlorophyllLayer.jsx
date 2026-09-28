import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  getDemoChlorophyllTexture,
  getDemoChlorophyllPointAt,
} from "../data/demoData";

/* ============================================================
   CHLOROPHYLL LAYER (DEMO DATA)

   Continuous ocean-colour field built from the demo data
   provider's equirectangular texture. Renders on the same
   overlay radius concept as the temperature field, ocean-only
   and footprint-feathered by the provider itself.

   The layer consumes ONLY the normalized provider output —
   a future real chlorophyll provider can supply the same
   texture + point lookup without any renderer change.
============================================================ */

const CHLOROPHYLL_RADIUS = 2.034;

function createChlorophyllTexture() {
  const { data, width, height } =
    getDemoChlorophyllTexture();

  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );

  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  return texture;
}

export default function ChlorophyllLayer({
  onSelect = null,
}) {
  const materialRef = useRef(null);

  const texture = useMemo(createChlorophyllTexture, []);

  useEffect(() => {
    return () => {
      texture.dispose();
    };
  }, [texture]);

  useFrame(({ clock }) => {
    if (!materialRef.current) return;
    materialRef.current.uniforms.uTime.value =
      clock.elapsedTime;

    /* DEV DEBUG HANDLE — production builds strip this. */
    if (import.meta.env.DEV) {
      window.__ratnakaraChl = {
        textureId: texture.id,
        uniformId:
          materialRef.current.uniforms.uChlorophyll?.value
            ?.id ?? null,
      };
    }
  });

  return (
    <mesh
      renderOrder={12}
      frustumCulled={false}
      onClick={(event) => {
        if (!onSelect) return;

        event.stopPropagation();

        const uv = event.uv;

        if (!uv) return;

        /*
          Same inverse projection the temperature field uses
          (three.js SphereGeometry UV convention): longitude
          = uv.x·360 − 160, latitude = (uv.y − 0.5)·180.
        */
        const longitude = uv.x * 360 - 160;
        const latitude = (uv.y - 0.5) * 180;

        const demoPoint = getDemoChlorophyllPointAt(
          latitude,
          longitude
        );

        if (demoPoint) {
          onSelect({
            title: "CHLOROPHYLL",
            latitude: demoPoint.latitude,
            longitude: demoPoint.longitude,
            valueLabel: `${demoPoint.value.toFixed(2)} mg/m³`,
            rows: [
              { label: "Index", value: demoPoint.indexLabel },
              { label: "Latitude", value: `${demoPoint.latitude.toFixed(2)}°N` },
              { label: "Longitude", value: `${demoPoint.longitude.toFixed(2)}°E` },
              { label: "Depth", value: demoPoint.depthLabel },
              { label: "Ocean", value: demoPoint.oceanLabel },
            ],
          });
        }
      }}
      onPointerMissed={() => {
        if (onSelect) onSelect(null);
      }}
    >
      <sphereGeometry
        args={[CHLOROPHYLL_RADIUS, 256, 128]}
      />

      <shaderMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        depthTest={true}
        side={THREE.FrontSide}
        blending={THREE.NormalBlending}
        uniforms={{
          uChlorophyll: {
            value: texture,
          },
          uTime: {
            value: 0,
          },
        }}
        vertexShader={`
          varying vec3 vSurfacePosition;

          void main() {
            vSurfacePosition = normalize(position);
            gl_Position =
              projectionMatrix *
              modelViewMatrix *
              vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          uniform sampler2D uChlorophyll;
          uniform float uTime;
          varying vec3 vSurfacePosition;

          void main() {
            vec3 p = normalize(vSurfacePosition);

            /* Matches satelliteLatLonToVector():
               theta = longitude + 70° */
            float latitude =
              asin(clamp(p.y, -1.0, 1.0));

            float longitude =
              atan(p.x, p.z) - radians(70.0);

            if (longitude < -3.14159265) {
              longitude += 6.28318530;
            }
            if (longitude > 3.14159265) {
              longitude -= 6.28318530;
            }

            float u = longitude / 6.28318530 + 0.5;
            float v = latitude / 3.14159265 + 0.5;

            v = clamp(v, 0.001, 0.999);

            vec4 field = texture2D(
              uChlorophyll,
              vec2(fract(u), v)
            );

            if (field.a < 0.03) {
              discard;
            }

            /*
              Subtle brightness pulse only — the field position
              and values never move (representation-only motion).
            */
            float shimmer =
              1.0 +
              sin(p.x * 15.0 + p.z * 11.0 + uTime * 0.3) * 0.02;

            vec3 finalColor = clamp(
              field.rgb * shimmer,
              0.0,
              1.0
            );

            gl_FragColor = vec4(
              finalColor,
              field.a
            );
          }
        `}
      />
    </mesh>
  );
}
