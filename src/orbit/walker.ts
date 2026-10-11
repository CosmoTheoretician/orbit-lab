import { BODIES } from "../core/bodies";
import type { MeanElements } from "./j2secular";

const DEG = Math.PI / 180;

/** Walker Delta pattern i:T/P/F. */
export interface WalkerConfig {
  total: number;          // T
  planes: number;         // P
  phasing: number;        // F, 0..P-1
  altitudeKm: number;
  inclinationDeg: number;
  raan0Deg?: number;
}

/**
 * meoSphere phase 1 as publicly described: 28 satellites, 4 planes, ~8,000 km.
 * Inclination and phasing are NOT published; these are assumptions to vary.
 */
export const MEOSPHERE_PHASE1: WalkerConfig = {
  total: 28,
  planes: 4,
  phasing: 1,
  altitudeKm: 8000,
  inclinationDeg: 70,
};

export function walkerDelta(c: WalkerConfig): MeanElements[] {
  const perPlane = c.total / c.planes;
  if (!Number.isInteger(perPlane)) throw new Error(`T=${c.total} not divisible by P=${c.planes}`);

  const a = BODIES.earth.equatorialRadius + c.altitudeKm;
  const out: MeanElements[] = [];
  for (let p = 0; p < c.planes; p++) {
    for (let k = 0; k < perPlane; k++) {
      out.push({
        a,
        e: 0,
        i: c.inclinationDeg * DEG,
        raan: ((c.raan0Deg ?? 0) + (360 * p) / c.planes) * DEG,
        argp: 0,
        M: ((360 * k) / perPlane + (360 * c.phasing * p) / c.total) * DEG,
      });
    }
  }
  return out;
}