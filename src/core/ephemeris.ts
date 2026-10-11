import { BODIES, type Vec3 } from "./bodies";
import { Rotor } from "./ga";
import { precessionRotor } from "./precession";
import type { Epoch } from "./time";
import { solveKepler } from "../orbit/kepler";

export const AU_KM = 149_597_870.7;
const DEG = Math.PI / 180;

export type PlanetId = "mercury" | "venus" | "mars" | "jupiter" | "saturn" | "uranus" | "neptune";
type ElementSet = { el: number[]; rate: number[] }; // a [AU], e, I, L, ϖ, Ω [deg]; rates per Julian century

/** JPL "Approximate Positions of the Planets" (E.M. Standish), Table 1, valid 1800–2050, J2000 ecliptic. */
const EMB: ElementSet = {
  el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
  rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
};
const PLANETS: Record<PlanetId, ElementSet> = {
  mercury: {
    el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  },
  venus: {
    el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    rate: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  },
  mars: {
    el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  },
  jupiter: {
    el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  },
  saturn: {
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  },
  uranus: {
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  },
  neptune: {
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  },
};

/** Heliocentric position, J2000 ecliptic axes, km. Same rotor composition as satellite orbits. */
function heliocentric(set: ElementSet, T: number): Vec3 {
  const [a, e, I, L, varpi, node] = set.el.map((x, k) => x + set.rate[k] * T);
  const argp = varpi - node;
  const E = solveKepler((L - varpi) * DEG, e);
  const rPf: Vec3 = [a * (Math.cos(E) - e), a * Math.sqrt(1 - e * e) * Math.sin(E), 0];
  const R = Rotor.inPlane("e12", node * DEG).mul(Rotor.inPlane("e23", I * DEG)).mul(Rotor.inPlane("e12", argp * DEG));
  const r = R.apply(rPf);
  return [r[0] * AU_KM, r[1] * AU_KM, r[2] * AU_KM];
}

const OBLIQUITY_J2000 = 23.43928 * DEG;
const centuriesTDB = (epoch: Epoch) => epoch.tdb() / (86400 * 36525);

/** J2000 ecliptic → J2000 equator → mean equator and equinox of date (the scene frame). */
function eclipticJ2000ToScene(v: Vec3, epoch: Epoch): Vec3 {
  return precessionRotor(epoch).apply(Rotor.inPlane("e23", OBLIQUITY_J2000).apply(v));
}

/** Heliocentric Earth–Moon barycentre in scene axes, km (used to cross-check the Sun formula). */
export function embHeliocentricScene(epoch: Epoch): Vec3 {
  return eclipticJ2000ToScene(heliocentric(EMB, centuriesTDB(epoch)), epoch);
}

/**
 * Geocentric planet position, km, scene frame. Uses the Earth–Moon barycentre for Earth
 * (≤ 4,700 km offset) and ignores light time; both are far below the elements' accuracy.
 */
export function planetGeocentric(id: PlanetId, epoch: Epoch): Vec3 {
  const T = centuriesTDB(epoch);
  const p = heliocentric(PLANETS[id], T);
  const e = heliocentric(EMB, T);
  return eclipticJ2000ToScene([p[0] - e[0], p[1] - e[1], p[2] - e[2]], epoch);
}

export function marsGeocentric(epoch: Epoch): Vec3 {
  return planetGeocentric("mars", epoch);
}

/**
 * Geocentric Moon, km, mean equator and equinox of date.
 * Astronomical Almanac low-precision formula: ~0.3° in longitude, ~0.2° in latitude.
 */
export function moonGeocentric(epoch: Epoch): Vec3 {
  const T = epoch.julianCenturiesTT();
  const s = (d: number) => Math.sin(d * DEG);
  const c = (d: number) => Math.cos(d * DEG);

  const lambda =
    218.32 + 481267.881 * T +
    6.29 * s(135.0 + 477198.87 * T) - 1.27 * s(259.3 - 413335.36 * T) +
    0.66 * s(235.7 + 890534.22 * T) + 0.21 * s(269.9 + 954397.74 * T) -
    0.19 * s(357.5 + 35999.05 * T) - 0.11 * s(186.5 + 966404.03 * T);
  const beta =
    5.13 * s(93.3 + 483202.02 * T) + 0.28 * s(228.2 + 960400.89 * T) -
    0.28 * s(318.3 + 6003.15 * T) - 0.17 * s(217.6 - 407332.21 * T);
  const parallax =
    0.9508 + 0.0518 * c(135.0 + 477198.87 * T) + 0.0095 * c(259.3 - 413335.36 * T) +
    0.0078 * c(235.7 + 890534.22 * T) + 0.0028 * c(269.9 + 954397.74 * T);

  const r = BODIES.earth.equatorialRadius / Math.sin(parallax * DEG);
  const ecl: Vec3 = [r * c(beta) * c(lambda), r * c(beta) * s(lambda), r * s(beta)];
  const eps = (23.439 - 0.0000004 * epoch.daysSinceJ2000()) * DEG; // same obliquity as sun.ts
  return Rotor.inPlane("e23", eps).apply(ecl);
}
