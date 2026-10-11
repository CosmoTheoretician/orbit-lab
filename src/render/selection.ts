import * as THREE from "three";
import { BODIES } from "../core/bodies";

const KM_TO_UNITS = 1e-3;
const PICK_RADIUS_PX = 10;
const RE = BODIES.earth.equatorialRadius;

export const ORBIT_TRACE_SAMPLES = 240;

/** Anything clickable: the real catalog, a simulated constellation, ... */
export interface SelectableSource {
  count: number;
  positions: Float32Array; // km, scene frame, 3 per object
  isVisible(i: number): boolean;
  color(i: number): number;
  /** Fills `out` with ORBIT_TRACE_SAMPLES + 1 points (km) of one orbit starting at shownMs. */
  traceOrbit(i: number, shownMs: number, out: Float32Array): void;
  /** Simulated time after which the trace is recomputed, ms. */
  traceValidityMs(i: number): number;
  describe(i: number, shownMs: number): string;
}

export interface SelectionDeps {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  world: THREE.Group;
  sources: SelectableSource[];
}

type Selected = { source: SelectableSource; index: number } | null;

/** True if the straight line from the camera to the point passes through the Earth. */
function occludedByEarth(cam: THREE.Vector3, x: number, y: number, z: number): boolean {
  const dx = x - cam.x;
  const dy = y - cam.y;
  const dz = z - cam.z;
  const t = Math.min(1, Math.max(0, -(cam.x * dx + cam.y * dy + cam.z * dz) / (dx * dx + dy * dy + dz * dz)));
  return Math.hypot(cam.x + t * dx, cam.y + t * dy, cam.z + t * dz) < RE;
}

export function createSelection(d: SelectionDeps) {
  let sel: Selected = null;
  let tracedAt = Number.NaN;
  let lastPanel = 0;

  const markerAttr = new THREE.BufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage);
  const markerGeom = new THREE.BufferGeometry();
  markerGeom.setAttribute("position", markerAttr);
  const marker = new THREE.Points(markerGeom, new THREE.PointsMaterial({ color: 0xffffff, size: 10, sizeAttenuation: false }));
  marker.frustumCulled = false;
  marker.visible = false;
  d.world.add(marker);

  const orbitAttr = new THREE.BufferAttribute(new Float32Array((ORBIT_TRACE_SAMPLES + 1) * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const orbitGeom = new THREE.BufferGeometry();
  orbitGeom.setAttribute("position", orbitAttr);
  const orbitMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
  const orbit = new THREE.Line(orbitGeom, orbitMat);
  orbit.frustumCulled = false;
  orbit.visible = false;
  d.world.add(orbit);

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed", top: "10px", right: "10px", color: "#cfe3ff", font: "12px/1.5 ui-monospace, monospace",
    background: "rgba(0,0,0,.6)", padding: "8px 10px", borderRadius: "6px", whiteSpace: "pre",
    pointerEvents: "none", display: "none",
  });
  document.body.appendChild(panel);

  function select(s: Selected) {
    sel = s;
    if (!s) {
      marker.visible = orbit.visible = false;
      panel.style.display = "none";
      return;
    }
    orbitMat.color.setHex(s.source.color(s.index));
    tracedAt = Number.NaN;
    marker.visible = orbit.visible = true;
    panel.style.display = "block";
    lastPanel = 0;
  }

  function pick(clientX: number, clientY: number): Selected {
    const rect = d.canvas.getBoundingClientRect();
    const camKm = d.camera.position.clone().divideScalar(KM_TO_UNITS);
    const v = new THREE.Vector3();
    let best: Selected = null;
    let bestD2 = PICK_RADIUS_PX * PICK_RADIUS_PX;

    for (const source of d.sources) {
      const pos = source.positions;
      for (let i = 0; i < source.count; i++) {
        if (!source.isVisible(i)) continue;
        const x = pos[3 * i];
        const y = pos[3 * i + 1];
        const z = pos[3 * i + 2];
        if (x === 0 && y === 0 && z === 0) continue; // failed propagation
        v.set(x * KM_TO_UNITS, y * KM_TO_UNITS, z * KM_TO_UNITS).project(d.camera);
        if (v.z < -1 || v.z > 1) continue;
        const sx = rect.left + ((v.x + 1) / 2) * rect.width;
        const sy = rect.top + ((1 - v.y) / 2) * rect.height;
        const d2 = (sx - clientX) ** 2 + (sy - clientY) ** 2;
        if (d2 < bestD2 && !occludedByEarth(camKm, x, y, z)) {
          best = { source, index: i };
          bestD2 = d2;
        }
      }
    }
    return best;
  }

  // A click is a press and release without dragging; drags rotate the view.
  let downX = 0;
  let downY = 0;
  d.canvas.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    downY = e.clientY;
  });
  d.canvas.addEventListener("pointerup", (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
    select(pick(e.clientX, e.clientY));
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") select(null);
  });

  /** Call every frame with the time of the positions on screen. */
  function update(shownMs: number) {
    if (!sel) return;
    const { source, index } = sel;
    if (!source.isVisible(index)) {
      select(null); // its layer was hidden
      return;
    }

    const p = source.positions;
    (markerAttr.array as Float32Array).set([p[3 * index], p[3 * index + 1], p[3 * index + 2]]);
    markerAttr.needsUpdate = true;

    if (!(Math.abs(shownMs - tracedAt) < source.traceValidityMs(index))) {
      source.traceOrbit(index, shownMs, orbitAttr.array as Float32Array);
      orbitAttr.needsUpdate = true;
      tracedAt = shownMs;
    }

    const now = performance.now();
    if (now - lastPanel < 250) return;
    lastPanel = now;
    panel.textContent = source.describe(index, shownMs);
  }

  return { update, select };
}