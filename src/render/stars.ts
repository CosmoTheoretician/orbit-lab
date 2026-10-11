import * as THREE from "three";
import type { Rotor } from "../core/ga";

export interface StarFile {
  source: string;
  epoch: string;
  data: number[]; // flat: raDeg, decDeg, vmag, bv
}

/** Render units: beyond Mars even at conjunction (~4e5), inside the camera far plane (1e6). */
const RADIUS = 5e7; // render units: beyond Neptune (~4.5e6), inside the camera far plane (1e8)
const DEG = Math.PI / 180;

/** Approximate star colour from the B−V index (display mapping, not colorimetry). */
const BV_STOPS: Array<[number, number, number, number]> = [
  [-0.4, 0.62, 0.71, 1.0],
  [0.0, 0.8, 0.85, 1.0],
  [0.4, 1.0, 0.98, 0.95],
  [0.8, 1.0, 0.9, 0.76],
  [1.2, 1.0, 0.81, 0.6],
  [2.0, 1.0, 0.7, 0.45],
];

function bvColor(bv: number): [number, number, number] {
  if (bv <= BV_STOPS[0][0]) return [BV_STOPS[0][1], BV_STOPS[0][2], BV_STOPS[0][3]];
  for (let k = 0; k < BV_STOPS.length - 1; k++) {
    const [b0, r0, g0, c0] = BV_STOPS[k];
    const [b1, r1, g1, c1] = BV_STOPS[k + 1];
    if (bv <= b1) {
      const f = (bv - b0) / (b1 - b0);
      return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), c0 + f * (c1 - c0)];
    }
  }
  const last = BV_STOPS[BV_STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

/** Display brightness from visual magnitude (tuned for readability, not photometric). */
const intensity = (v: number) => 0.25 + 0.75 * Math.min(1, Math.max(0, (6.5 - v) / 7.5));

const BUCKETS = [
  { maxMag: 1.5, size: 3.2 },
  { maxMag: 3.5, size: 2.2 },
  { maxMag: Infinity, size: 1.3 },
];

/**
 * Star sphere in scene axes. Keep it centred on the camera every frame,
 * so the stars behave as if infinitely far away (no parallax).
 */
export function createStarfield(file: StarFile, j2000ToScene: Rotor): THREE.Group {
  const group = new THREE.Group();
  const pos: number[][] = BUCKETS.map(() => []);
  const col: number[][] = BUCKETS.map(() => []);

  const d = file.data;
  for (let k = 0; k < d.length; k += 4) {
    const ra = d[k] * DEG;
    const dec = d[k + 1] * DEG;
    const vmag = d[k + 2];
    const p = j2000ToScene.apply([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]);
    const b = BUCKETS.findIndex((x) => vmag <= x.maxMag);
    const [r, g, bl] = bvColor(d[k + 3]);
    const s = intensity(vmag);
    pos[b].push(p[0] * RADIUS, p[1] * RADIUS, p[2] * RADIUS);
    col[b].push(r * s, g * s, bl * s);
  }

  BUCKETS.forEach((bucket, b) => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(pos[b], 3));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(col[b], 3));
    const pts = new THREE.Points(
      geom,
      new THREE.PointsMaterial({ size: bucket.size, sizeAttenuation: false, vertexColors: true, depthWrite: false }),
    );
    pts.frustumCulled = false;
    pts.renderOrder = -1;
    group.add(pts);
  });
  return group;
}