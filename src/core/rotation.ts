import type { BodyId } from "./bodies";
import { Rotor } from "./ga";
import { precessionRotor } from "./precession";
import type { Epoch } from "./time";

const DEG = Math.PI / 180;

/** Pole right ascension/declination (ICRF) and prime meridian angle, all degrees. */
type Model = (T: number, d: number) => { ra: number; dec: number; W: number };

/** IAU Moon model with all thirteen periodic terms (Archinal et al. 2011): surface features good to ~arcminutes. */
function moonModel(T: number, d: number) {
  const E = [
    125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
    357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.064993 * d, 276.617 + 0.3287146 * d,
    34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d,
    25.053 + 12.9590088 * d,
  ].map((x) => x * DEG);
  const s = (k: number) => Math.sin(E[k - 1]);
  const c = (k: number) => Math.cos(E[k - 1]);
  return {
    ra: 269.9949 + 0.0031 * T - 3.8787 * s(1) - 0.1204 * s(2) + 0.07 * s(3) - 0.0172 * s(4) + 0.0072 * s(6) - 0.0052 * s(10) + 0.0043 * s(13),
    dec: 66.5392 + 0.013 * T + 1.5419 * c(1) + 0.0239 * c(2) - 0.0278 * c(3) + 0.0068 * c(4) - 0.0029 * c(6) + 0.0009 * c(7) + 0.0008 * c(10) - 0.0009 * c(13),
    W:
      38.3213 + 13.17635815 * d - 1.4e-12 * d * d +
      3.561 * s(1) + 0.1208 * s(2) - 0.0642 * s(3) + 0.0158 * s(4) + 0.0252 * s(5) - 0.0066 * s(6) - 0.0047 * s(7) -
      0.0046 * s(8) + 0.0028 * s(9) + 0.0052 * s(10) + 0.004 * s(11) + 0.0019 * s(12) - 0.0044 * s(13),
  };
}

/**
 * IAU WGCCRE rotation models (Archinal et al.); small periodic terms omitted except for Neptune and the Moon.
 * d = days and T = Julian centuries since J2000 (TDB). Earth is handled by GMST in the scene.
 */
const MODELS: Partial<Record<BodyId, Model>> = {
  sun: (_T, d) => ({ ra: 286.13, dec: 63.87, W: 84.176 + 14.1844 * d }),
  mercury: (T, d) => ({ ra: 281.0103 - 0.0328 * T, dec: 61.4155 - 0.0049 * T, W: 329.5988 + 6.1385108 * d }),
  venus: (_T, d) => ({ ra: 272.76, dec: 67.16, W: 160.2 - 1.4813688 * d }),
  moon: moonModel,
  mars: (T, d) => ({ ra: 317.68143 - 0.1061 * T, dec: 52.8865 - 0.0609 * T, W: 176.63 + 350.89198226 * d }),
  jupiter: (T, d) => ({ ra: 268.056595 - 0.006499 * T, dec: 64.495303 + 0.002413 * T, W: 284.95 + 870.536 * d }),
  saturn: (T, d) => ({ ra: 40.589 - 0.036 * T, dec: 83.537 - 0.004 * T, W: 38.9 + 810.7939024 * d }),
  uranus: (_T, d) => ({ ra: 257.311, dec: -15.175, W: 203.81 - 501.1600928 * d }),
  neptune: (T, d) => {
    const N = (357.85 + 52.316 * T) * DEG;
    return { ra: 299.36 + 0.7 * Math.sin(N), dec: 43.46 - 0.51 * Math.cos(N), W: 249.978 + 541.1397757 * d - 0.48 * Math.sin(N) };
  },
};

/** IAU pole and prime meridian at an epoch (degrees), exposed for tests. */
export function iauAngles(id: BodyId, epoch: Epoch) {
  const model = MODELS[id];
  if (!model) throw new Error(`no IAU rotation model for ${id}`);
  const d = epoch.tdb() / 86400;
  return model(d / 36525, d);
}

/**
 * Rotor from body-fixed axes (z = north pole, x = prime meridian) to the scene frame:
 * R = P · Rz(α0 + 90°) · Rx(90° − δ0) · Rz(W), with P the precession J2000 → date.
 */
export function bodyOrientation(id: BodyId, epoch: Epoch): Rotor {
  const { ra, dec, W } = iauAngles(id, epoch);
  const toIcrf = Rotor.inPlane("e12", (ra + 90) * DEG)
    .mul(Rotor.inPlane("e23", (90 - dec) * DEG))
    .mul(Rotor.inPlane("e12", (W % 360) * DEG));
  return precessionRotor(epoch).mul(toIcrf);
}

/**
 * Rotor from the Moon's equatorial inertial axes (z = lunar pole, x = ascending node of the lunar
 * equator on the ICRF equator) to the scene frame. Lunar orbit elements are defined in these axes.
 */
export function moonEquatorRotor(epoch: Epoch): Rotor {
  const { ra, dec } = iauAngles("moon", epoch);
  return precessionRotor(epoch).mul(Rotor.inPlane("e12", (ra + 90) * DEG).mul(Rotor.inPlane("e23", (90 - dec) * DEG)));
}
