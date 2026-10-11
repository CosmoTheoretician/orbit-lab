import * as THREE from "three";
import type { Rotor } from "../core/ga";

/** Just beyond the star points (9e5), inside the camera far plane (1e6). Keep centred on the camera. */
const RADIUS = 6e7;

/**
 * Milky Way background from NASA SVS Deep Star Maps 2020: plate carrée in ICRF/J2000,
 * centred on RA 0h with RA increasing to the left.
 * The texture is looked up per pixel from the view direction, so the mapping is exact:
 * scene axes → J2000 (inverse precession) → (RA, Dec) → (u, v).
 */
export function createSkyBackground(texture: THREE.Texture, j2000ToScene: Rotor, intensity = 0.35): THREE.Mesh {
  texture.generateMipmaps = false; // avoids a visible seam where RA wraps around
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // Scene → J2000 is the inverse precession; its matrix columns are the images of the basis vectors.
  const inv = j2000ToScene.reverse();
  const [cx, cy, cz] = [inv.apply([1, 0, 0]), inv.apply([0, 1, 0]), inv.apply([0, 0, 1])];
  const sceneToJ2000 = new THREE.Matrix3().set(
    cx[0], cy[0], cz[0],
    cx[1], cy[1], cz[1],
    cx[2], cy[2], cz[2],
  );

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      sceneToJ2000: { value: sceneToJ2000 },
      intensity: { value: intensity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform mat3 sceneToJ2000;
      uniform float intensity;
      varying vec3 vDir;
      const float PI = 3.141592653589793;
      void main() {
        vec3 d = normalize(sceneToJ2000 * vDir);
        float ra = atan(d.y, d.x);                 // (-pi, pi], 0 at the vernal equinox
        float dec = asin(clamp(d.z, -1.0, 1.0));
        vec2 uv = vec2(0.5 - ra / (2.0 * PI), 0.5 + dec / PI); // RA 0h at centre, increasing to the left
        gl_FragColor = vec4(texture2D(map, uv).rgb * intensity, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 64, 32), material);
  mesh.renderOrder = -2; // first: behind the star points and everything else
  mesh.frustumCulled = false;
  return mesh;
}