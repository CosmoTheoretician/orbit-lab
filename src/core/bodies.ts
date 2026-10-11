import type { Epoch } from "./time";

export type Vec3 = [number, number, number];

export type BodyId = "sun" | "mercury" | "venus" | "earth" | "moon" | "mars" | "jupiter" | "saturn" | "uranus" | "neptune";

/** Axes only; the origin is given separately by `center`. */
export type FrameId =
  | "TEME"     // SGP4 output frame
  | "ICRF"     // inertial reference for planetary work
  | "ITRF"     // Earth-fixed
  | "MOON_PA"  // lunar principal axes, body-fixed
  | "IAU_MARS";

/** Every state carries its origin and axes explicitly. Units: km, km/s. */
export interface StateVector {
  center: BodyId;
  frame: FrameId;
  epoch: Epoch;
  r: Vec3;
  v: Vec3;
}

export interface CelestialBody {
  id: BodyId;
  name: string;
  /** Gravitational parameter, km^3/s^2 */
  gm: number;
  /** km */
  equatorialRadius: number;
  /** (a - c) / a */
  flattening: number;
  /** Unnormalized second zonal harmonic */
  j2: number;
  parent: BodyId | null;
}

/** Plug-in point for planetary ephemerides (analytical now, JPL DE data later). */
export interface EphemerisProvider {
  state(target: BodyId, center: BodyId, epoch: Epoch): StateVector;
}

export const BODIES: Record<BodyId, CelestialBody> = {
  sun:     { id: "sun",     name: "Sun",     gm: 1.32712440041e11, equatorialRadius: 695700,   flattening: 0,                 j2: 2.2e-7,       parent: null },
  mercury: { id: "mercury", name: "Mercury", gm: 22031.868551,     equatorialRadius: 2440.53,  flattening: 0,                 j2: 5.03e-5,      parent: "sun" },
  venus:   { id: "venus",   name: "Venus",   gm: 324858.592,       equatorialRadius: 6051.8,   flattening: 0,                 j2: 4.458e-6,     parent: "sun" },
  earth:   { id: "earth",   name: "Earth",   gm: 398600.4418,      equatorialRadius: 6378.137, flattening: 1 / 298.257223563, j2: 1.0826267e-3, parent: "sun" },
  moon:    { id: "moon",    name: "Moon",    gm: 4902.800118,      equatorialRadius: 1737.4,   flattening: 0.0012,            j2: 2.033e-4,     parent: "earth" },
  mars:    { id: "mars",    name: "Mars",    gm: 42828.37,         equatorialRadius: 3396.19,  flattening: 0.00589,           j2: 1.96045e-3,   parent: "sun" },
  jupiter: { id: "jupiter", name: "Jupiter", gm: 126712764.1,      equatorialRadius: 71492,    flattening: 0.06487,           j2: 1.4696e-2,    parent: "sun" },
  saturn:  { id: "saturn",  name: "Saturn",  gm: 37940584.8,       equatorialRadius: 60268,    flattening: 0.09796,           j2: 1.6291e-2,    parent: "sun" },
  uranus:  { id: "uranus",  name: "Uranus",  gm: 5794556.4,        equatorialRadius: 25559,    flattening: 0.02293,           j2: 3.5107e-3,    parent: "sun" },
  neptune: { id: "neptune", name: "Neptune", gm: 6836527.1,        equatorialRadius: 24764,    flattening: 0.01708,           j2: 3.4084e-3,    parent: "sun" },
};
