import { BODIES, type Vec3 } from "../core/bodies";
import { Rotor } from "../core/ga";
import { moonEquatorRotor } from "../core/rotation";
import { Epoch } from "../core/time";
import { solveKepler } from "../orbit/kepler";
import type { KeplerModel } from "./orbiters";

const MU_M = BODIES.moon.gm;
const DEG = Math.PI / 180;

export interface KeplerSatellite {
  periodS: number;
  /** Position in lunar equatorial axes, km. */
  local(tt: number): Vec3;
  /** Moon-centred position in scene axes, km. */
  rel(tt: number): Vec3;
  /** One full orbit in lunar equatorial axes. */
  ring(segments: number): Vec3[];
}

/** Satellite k of a constellation: nodes and phases spaced evenly; Keplerian about the Moon. */
export function keplerSat(m: KeplerModel, k: number): KeplerSatellite {
  const n = Math.sqrt(MU_M / m.aKm ** 3);
  const raan = (m.raanDeg + (360 * k) / m.count) * DEG;
  const M0 = ((360 * k) / m.count) * DEG;
  const orbit = Rotor.inPlane("e12", raan).mul(Rotor.inPlane("e23", m.iDeg * DEG)).mul(Rotor.inPlane("e12", m.argpDeg * DEG));
  const q = Math.sqrt(1 - m.e * m.e);
  const inPlane = (E: number): Vec3 => [m.aKm * (Math.cos(E) - m.e), m.aKm * q * Math.sin(E), 0];
  const local = (tt: number): Vec3 => orbit.apply(inPlane(solveKepler(M0 + n * tt, m.e)));
  return {
    periodS: (2 * Math.PI) / n,
    local,
    rel: (tt) => moonEquatorRotor(Epoch.fromTT(tt)).apply(local(tt)),
    ring: (segments) => Array.from({ length: segments + 1 }, (_, j) => orbit.apply(inPlane((2 * Math.PI * j) / segments))),
  };
}

export function constellation(m: KeplerModel): KeplerSatellite[] {
  return Array.from({ length: m.count }, (_, k) => keplerSat(m, k));
}
