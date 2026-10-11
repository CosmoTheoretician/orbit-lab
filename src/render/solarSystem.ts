import * as THREE from "three";
import { BODIES, type BodyId, type Vec3 } from "../core/bodies";
import { AU_KM, moonGeocentric, planetGeocentric, type PlanetId } from "../core/ephemeris";
import { bodyOrientation } from "../core/rotation";
import { sunGeocentric } from "../core/sun";
import type { Epoch } from "../core/time";
import { loadTexture, makeDetailSwitch, type Variant } from "./textures";

const KM_TO_UNITS = 1e-3;
const PLANET_IDS: PlanetId[] = ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune"];
const BODY_IDS = ["sun", "mercury", "venus", "moon", "mars", "jupiter", "saturn", "uranus", "neptune"] as const;
type OtherBody = (typeof BODY_IDS)[number];

const TEXTURE: Record<OtherBody, string> = {
  sun: "sun", mercury: "mercury", venus: "venus_atmosphere", moon: "moon", mars: "mars",
  jupiter: "jupiter", saturn: "saturn", uranus: "uranus", neptune: "neptune",
};

/** Saturn's main ring system: C ring inner edge to F ring, km. */
const RING_INNER = 74_658;
const RING_OUTER = 140_220;

export interface DetailTarget {
  setVariant(v: Variant): Promise<void>;
}

/** Returns the Moon's geocentric position for an epoch, or null to use the analytical formula. */
export type MoonOverride = ((epoch: Epoch) => Vec3 | null) | null;

function makeLabel(): HTMLDivElement {
  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "fixed", color: "#cfe3ff", font: "11px ui-monospace, monospace",
    pointerEvents: "none", transform: "translate(10px, -50%)", whiteSpace: "nowrap", display: "none",
  });
  document.body.appendChild(el);
  return el;
}

/** Soft radial glow so the Sun reads on screen; the disc itself is at its true size. */
function glowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,250,235,1)");
  grad.addColorStop(0.12, "rgba(255,238,200,0.6)");
  grad.addColorStop(0.4, "rgba(255,205,130,0.12)");
  grad.addColorStop(1, "rgba(255,180,90,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Ring in Saturn's equatorial plane, texture mapped radially (the ring map is a radial strip). */
function makeRing(tex: THREE.Texture): THREE.Mesh {
  const geo = new THREE.RingGeometry(RING_INNER, RING_OUTER, 256, 1);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (r - RING_INNER) / (RING_OUTER - RING_INNER), 0.5);
  }
  const mat = new THREE.MeshPhongMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, shininess: 0 });
  return new THREE.Mesh(geo, mat);
}

/**
 * All solar-system bodies except Earth: true geocentric positions, IAU orientations,
 * true sizes and oblateness. Earth is passed in only for texture detail switching.
 */
export async function createSolarSystem(world: THREE.Group, base: string, earth: DetailTarget) {
  const km = {} as Record<BodyId, THREE.Vector3>;
  for (const id of Object.keys(BODIES) as BodyId[]) km[id] = new THREE.Vector3();

  const meshes = {} as Record<OtherBody, THREE.Mesh>;
  const detail = { earth: (v: Variant) => earth.setVariant(v) } as Record<BodyId, (v: Variant) => Promise<void>>;
  const labels = {} as Record<BodyId, HTMLDivElement>;
  labels.earth = makeLabel();
  let moonOverride: MoonOverride = null;

  await Promise.all(
    BODY_IDS.map(async (id) => {
      const b = BODIES[id];
      const tex = await loadTexture(base, "lo", TEXTURE[id]);
      const geo = new THREE.SphereGeometry(b.equatorialRadius, 128, 64);
      geo.rotateX(Math.PI / 2); // body frame: pole on Z, prime meridian on +X
      const mat = id === "sun"
        ? new THREE.MeshBasicMaterial({ map: tex }) // self-luminous
        : new THREE.MeshPhongMaterial({ map: tex, shininess: 3 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(1, 1, 1 - b.flattening); // oblate along the pole
      world.add(mesh);
      meshes[id] = mesh;
      labels[id] = makeLabel();
      detail[id] = makeDetailSwitch(base, [{ name: TEXTURE[id], color: true, apply: (t) => { mat.map = t; mat.needsUpdate = true; } }], [tex]);
    }),
  );

  // Sun glow
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  );
  glow.scale.setScalar(BODIES.sun.equatorialRadius * 12);
  meshes.sun.add(glow);

  // Saturn's rings, switched together with the planet
  const ringTex = await loadTexture(base, "lo", "saturn_ring");
  const ring = makeRing(ringTex);
  meshes.saturn.add(ring);
  const saturnMat = meshes.saturn.material as THREE.MeshPhongMaterial;
  const ringMat = ring.material as THREE.MeshPhongMaterial;
  detail.saturn = makeDetailSwitch(
    base,
    [
      { name: "saturn", color: true, apply: (t) => { saturnMat.map = t; saturnMat.needsUpdate = true; } },
      { name: "saturn_ring", color: true, apply: (t) => { ringMat.map = t; ringMat.needsUpdate = true; } },
    ],
    [saturnMat.map!, ringTex],
  );

  const v = new THREE.Vector3();
  function labelText(id: BodyId): string {
    if (id === "earth") return "Earth";
    const d = km[id].length();
    if (id === "moon") return `Moon · ${Math.round(d).toLocaleString("en")} km`;
    return `${BODIES[id].name} · ${(d / AU_KM).toFixed(3)} AU`;
  }

  function placeLabel(id: BodyId, camera: THREE.Camera, hidden: boolean) {
    const label = labels[id];
    v.copy(km[id]).multiplyScalar(KM_TO_UNITS).project(camera);
    if (hidden || v.z < -1 || v.z > 1) {
      label.style.display = "none";
      return;
    }
    label.style.display = "block";
    label.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
    label.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
    label.textContent = labelText(id);
  }

  function update(epoch: Epoch, camera: THREE.Camera, focus: BodyId) {
    km.sun.set(...sunGeocentric(epoch));
    // During a mission, the Moon comes from the same JPL ephemeris as the spacecraft.
    km.moon.set(...(moonOverride?.(epoch) ?? moonGeocentric(epoch)));
    for (const id of PLANET_IDS) km[id].set(...planetGeocentric(id, epoch));

    for (const id of BODY_IDS) {
      meshes[id].position.copy(km[id]);
      meshes[id].quaternion.set(...bodyOrientation(id, epoch).toQuaternion());
    }
    for (const id of Object.keys(BODIES) as BodyId[]) placeLabel(id, camera, id === focus);
  }

  /** Full resolution for the focused body, 2k for everything else. */
  async function setDetail(focus: BodyId) {
    await Promise.all((Object.keys(detail) as BodyId[]).map((id) => detail[id](id === focus ? "hi" : "lo")));
  }

  return {
    km,
    update,
    setDetail,
    moon: meshes.moon,
    setMoonOverride: (f: MoonOverride) => {
      moonOverride = f;
    },
  };
}
