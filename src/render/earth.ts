import * as THREE from "three";
import { BODIES } from "../core/bodies";
import { loadTexture, makeDetailSwitch, type Variant } from "./textures";

const DEG = Math.PI / 180;

const MAPS = [
  { name: "earth_day", color: true, uniform: "dayMap" },
  { name: "earth_night", color: true, uniform: "nightMap" },
  { name: "earth_clouds", color: false, uniform: "cloudMap" },
  { name: "earth_specular", color: false, uniform: "specMap" },
  { name: "earth_normal", color: false, uniform: "normalMap" },
];

const surfaceVertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  varying vec3 vObj;    // body-fixed position (z = pole, x = Greenwich)
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vObj = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

const surfaceFragment = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D cloudMap;
  uniform sampler2D specMap;
  uniform sampler2D normalMap;
  uniform vec3 sunDirWorld;   // unit vector Earth -> Sun
  uniform mat3 objToWorld;    // Earth rotation (GMST)
  varying vec2 vUv;
  varying vec3 vObj;
  varying vec3 vWorld;

  void main() {
    #include <logdepthbuf_fragment>
    // Local tangent frame on the sphere: east, north, up
    vec3 up = normalize(vObj);
    vec3 east = normalize(vec3(-up.y, up.x, 0.0) + vec3(1e-9, 0.0, 0.0));
    vec3 north = cross(up, east);
    vec3 tn = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
    vec3 n = normalize(objToWorld * normalize(tn.x * east + tn.y * north + tn.z * up)); // terrain normal
    vec3 nGeo = normalize(objToWorld * up);                                               // smooth sphere normal
    vec3 l = sunDirWorld;
    vec3 v = normalize(cameraPosition - vWorld);

    float sunAlt = dot(nGeo, l);                       // sine of the Sun's altitude
    float daylight = smoothstep(-0.10, 0.10, sunAlt);  // twilight band of about ±6°

    // Day side: terrain-shaded surface plus sun glint on water
    vec3 color = texture2D(dayMap, vUv).rgb * (0.015 + 1.1 * max(dot(n, l), 0.0));
    vec3 h = normalize(l + v);
    color += vec3(1.0, 0.95, 0.85) * texture2D(specMap, vUv).r * pow(max(dot(nGeo, h), 0.0), 60.0) * 0.5 * step(0.0, sunAlt);

    // Night side: city lights fade in through twilight; clouds hide what is beneath them
    float clouds = texture2D(cloudMap, vUv).r;
    color += texture2D(nightMap, vUv).rgb * (1.0 - daylight) * (1.0 - 0.85 * clouds) * 1.5;

    // Clouds on top, lit by the Sun
    color = mix(color, vec3(0.015 + 1.05 * max(sunAlt, 0.0)), clouds * 0.85);

    // Thin blue limb of the atmosphere on the sunlit side
    float rim = pow(1.0 - max(dot(nGeo, v), 0.0), 4.0);
    color += vec3(0.30, 0.55, 1.0) * rim * smoothstep(-0.3, 0.3, sunAlt) * 0.8;

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }`;

const haloVertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vNormalW;
  varying vec3 vWorld;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

const haloFragment = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 sunDirWorld;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vWorld);
    // Back faces of the shell: 0 at the shell's outer edge, rising toward the planet's limb
    float limb = smoothstep(0.0, 0.3, -dot(n, v));
    float lit = smoothstep(-0.25, 0.35, dot(n, sunDirWorld));
    gl_FragColor = vec4(vec3(0.30, 0.55, 1.0) * limb * lit * 0.9, 1.0);
    #include <colorspace_fragment>
  }`;

function onSphere(r: number, latDeg: number, lonDeg: number): THREE.Vector3 {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return new THREE.Vector3(r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat));
}

function createGraticule(radiusKm: number): THREE.Group {
  const group = new THREE.Group();
  const r = radiusKm * 1.002;
  const gridMat = new THREE.LineBasicMaterial({ color: 0x4f7aa3, transparent: true, opacity: 0.45 });
  const keyMat = new THREE.LineBasicMaterial({ color: 0xffcc33 });
  for (let lon = -180; lon < 180; lon += 30) {
    const pts: THREE.Vector3[] = [];
    for (let lat = -90; lat <= 90; lat += 2) pts.push(onSphere(r, lat, lon));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lon === 0 ? keyMat : gridMat));
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts: THREE.Vector3[] = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push(onSphere(r, lat, lon));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lat === 0 ? keyMat : gridMat));
  }
  return group;
}

/** Earth in its body-fixed frame (z = pole, x = Greenwich), km; the group rotates by GMST. */
export async function createEarth(base: string) {
  const R = BODIES.earth.equatorialRadius;
  const group = new THREE.Group();
  group.scale.set(1, 1, 1 - BODIES.earth.flattening);

  const lo = await Promise.all(MAPS.map((m) => loadTexture(base, "lo", m.name, m.color)));
  const sunDirWorld = { value: new THREE.Vector3(1, 0, 0) };
  const uniforms: Record<string, THREE.IUniform> = { sunDirWorld, objToWorld: { value: new THREE.Matrix3() } };
  MAPS.forEach((m, k) => (uniforms[m.uniform] = { value: lo[k] }));

  const geo = new THREE.SphereGeometry(R, 256, 128);
  geo.rotateX(Math.PI / 2); // three.js poles on Y -> pole on Z, Greenwich on +X, 90°E on +Y
  group.add(new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms, vertexShader: surfaceVertex, fragmentShader: surfaceFragment })));

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.03, 128, 64),
    new THREE.ShaderMaterial({
      uniforms: { sunDirWorld },
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  group.add(halo);

  const grid = createGraticule(R);
  grid.visible = false;
  group.add(grid);

  const setVariant: (v: Variant) => Promise<void> = makeDetailSwitch(
    base,
    MAPS.map((m) => ({ name: m.name, color: m.color, apply: (t: THREE.Texture) => (uniforms[m.uniform].value = t) })),
    lo,
  );

  const rot = new THREE.Matrix4();
  function update(gmst: number, sunDir: THREE.Vector3) {
    group.rotation.z = gmst;
    sunDirWorld.value.copy(sunDir);
    (uniforms.objToWorld.value as THREE.Matrix3).setFromMatrix4(rot.makeRotationZ(gmst));
  }

  return { group, grid, setVariant, update };
}
