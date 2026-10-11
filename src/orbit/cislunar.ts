import { BODIES, type Vec3 } from "../core/bodies";
import { moonGeocentric } from "../core/ephemeris";
import { sunGeocentric } from "../core/sun";
import { Epoch } from "../core/time";

const MU_E = BODIES.earth.gm;
const MU_M = BODIES.moon.gm;
const MU_S = BODIES.sun.gm;

/** Geocentric Moon position, km, scene frame (same analytical Moon as the renderer). */
export const moonAt = (tt: number): Vec3 => moonGeocentric(Epoch.fromTT(tt));

/** Geocentric Moon velocity by central difference, km/s. */
export function moonVelocityAt(tt: number): Vec3 {
  const a = moonAt(tt - 30);
  const b = moonAt(tt + 30);
  return [(b[0] - a[0]) / 60, (b[1] - a[1]) / 60, (b[2] - a[2]) / 60];
}

/**
 * Geocentric equations of motion: Earth, Moon and Sun as point masses.
 * The geocentric frame accelerates toward the Moon and Sun, hence the indirect terms −μ r_body/|r_body|³.
 * State y = [x, y, z, vx, vy, vz] in km and km/s, t in TT seconds since J2000.
 */
export function cislunarDeriv(t: number, y: Float64Array, out: Float64Array) {
  const rm = moonAt(t);
  const rs = sunGeocentric(Epoch.fromTT(t));
  const x = y[0];
  const yy = y[1];
  const z = y[2];
  const r3 = Math.pow(x * x + yy * yy + z * z, 1.5);
  let ax = (-MU_E * x) / r3;
  let ay = (-MU_E * yy) / r3;
  let az = (-MU_E * z) / r3;

  for (const [mu, rb] of [[MU_M, rm], [MU_S, rs]] as Array<[number, Vec3]>) {
    const dx = rb[0] - x;
    const dy = rb[1] - yy;
    const dz = rb[2] - z;
    const d3 = Math.pow(dx * dx + dy * dy + dz * dz, 1.5);
    const b3 = Math.pow(rb[0] * rb[0] + rb[1] * rb[1] + rb[2] * rb[2], 1.5);
    ax += mu * (dx / d3 - rb[0] / b3);
    ay += mu * (dy / d3 - rb[1] / b3);
    az += mu * (dz / d3 - rb[2] / b3);
  }

  out[0] = y[3];
  out[1] = y[4];
  out[2] = y[5];
  out[3] = ax;
  out[4] = ay;
  out[5] = az;
}
