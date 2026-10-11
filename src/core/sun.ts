import type { Vec3 } from "./bodies";
import { AU_KM } from "./ephemeris";
import type { Epoch } from "./time";

const DEG = Math.PI / 180;

/** Astronomical Almanac low-precision Sun (~0.01°), mean equator and equinox of date. */
function lowPrecisionSun(epoch: Epoch) {
  const n = epoch.daysSinceJ2000();
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const rAu = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  const dir: Vec3 = [Math.cos(lambda), Math.cos(eps) * Math.sin(lambda), Math.sin(eps) * Math.sin(lambda)];
  return { dir, rAu };
}

/** Unit vector Earth → Sun. */
export function sunDirection(epoch: Epoch): Vec3 {
  return lowPrecisionSun(epoch).dir;
}

/** Geocentric Sun position, km. */
export function sunGeocentric(epoch: Epoch): Vec3 {
  const { dir, rAu } = lowPrecisionSun(epoch);
  const r = rAu * AU_KM;
  return [dir[0] * r, dir[1] * r, dir[2] * r];
}
