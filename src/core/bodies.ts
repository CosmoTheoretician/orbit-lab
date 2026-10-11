import type { Epoch } from "./time";

export type Vec3 = [number, number, number];

export type BodyId = "sun" | "earth" | "moon" | "mars";

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
  /** Unnormalized second zonal harmonic */
  j2: number;
  parent: BodyId | null;
}

/** Plug-in point for planetary ephemerides (analytical first, JPL DE data later). */
export interface EphemerisProvider {
  state(target: BodyId, center: BodyId, epoch: Epoch): StateVector;
}

export const BODIES: Record<BodyId, CelestialBody> = {
  sun:   { id: "sun",   name: "Sun",   gm: 1.32712440041e11, equatorialRadius: 695700,   j2: 2.2e-7,      parent: null },
  earth: { id: "earth", name: "Earth", gm: 398600.4418,      equatorialRadius: 6378.137, j2: 1.0826267e-3, parent: "sun" },
  moon:  { id: "moon",  name: "Moon",  gm: 4902.800118,      equatorialRadius: 1737.4,   j2: 2.033e-4,    parent: "earth" },
  mars:  { id: "mars",  name: "Mars",  gm: 42828.37,         equatorialRadius: 3396.19,  j2: 1.96045e-3,  parent: "sun" },
};