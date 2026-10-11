import type { Epoch } from "./time";
import type { Vec3 } from "./bodies";

const DEG = Math.PI / 180;

/**
 * Unit vector Earth→Sun in equatorial axes of date.
 * Low-precision Astronomical Almanac formula (~0.01°); replaced by real
 * ephemerides once the EphemerisProvider exists.
 */
export function sunDirection(epoch: Epoch): Vec3 {
  const n = epoch.daysSinceJ2000();
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  return [Math.cos(lambda), Math.cos(eps) * Math.sin(lambda), Math.sin(eps) * Math.sin(lambda)];
}