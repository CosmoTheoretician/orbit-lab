import { Rotor } from "./ga";
import type { Epoch } from "./time";

const ARCSEC = Math.PI / (180 * 3600);

/** IAU 1976 precession angles (Lieske et al. 1977); T in Julian centuries TT from J2000. Radians. */
export function precessionAngles(T: number) {
  return {
    zeta: (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * ARCSEC,
    z: (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * ARCSEC,
    theta: (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * ARCSEC,
  };
}

/**
 * Rotor from J2000 mean equatorial axes to the mean equator and equinox of date:
 * turn by ζ about the pole, tilt the pole by θ, turn by z.
 */
export function precessionRotor(epoch: Epoch): Rotor {
  const { zeta, z, theta } = precessionAngles(epoch.julianCenturiesTT());
  return Rotor.inPlane("e12", z).mul(Rotor.inPlane("e31", -theta)).mul(Rotor.inPlane("e12", zeta));
}