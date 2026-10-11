import { gstime } from "satellite.js";
import type { Vec3 } from "../core/bodies";

/** WGS84 ellipsoid */
const A = 6378.137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

export interface GroundStation {
  name: string;
  latDeg: number;
  lonDeg: number;
  altKm: number;
}

/** Château de Betzdorf, approximate (±1 km): plenty for pointing and Doppler. */
export const SES_BETZDORF: GroundStation = { name: "SES HQ, Betzdorf (approx.)", latDeg: 49.69, lonDeg: 6.33, altKm: 0.3 };

/** Geodetic → Earth-fixed Cartesian (km). */
export function ecef(s: GroundStation): Vec3 {
  const phi = s.latDeg * DEG;
  const lam = s.lonDeg * DEG;
  const N = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  return [
    (N + s.altKm) * Math.cos(phi) * Math.cos(lam),
    (N + s.altKm) * Math.cos(phi) * Math.sin(lam),
    (N * (1 - E2) + s.altKm) * Math.sin(phi),
  ];
}

/** Local east, north, up unit vectors in Earth-fixed axes (geodetic up). */
export function enu(s: GroundStation): { e: Vec3; n: Vec3; u: Vec3 } {
  const phi = s.latDeg * DEG;
  const lam = s.lonDeg * DEG;
  return {
    e: [-Math.sin(lam), Math.cos(lam), 0],
    n: [-Math.sin(phi) * Math.cos(lam), -Math.sin(phi) * Math.sin(lam), Math.cos(phi)],
    u: [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)],
  };
}

/** Earth-fixed → scene (inertial, equator of date): rotation by GMST about the pole (UT1 ≈ UTC). */
function rotZ([x, y, z]: Vec3, g: number): Vec3 {
  return [x * Math.cos(g) - y * Math.sin(g), x * Math.sin(g) + y * Math.cos(g), z];
}

export function stationInertial(s: GroundStation, date: Date): Vec3 {
  return rotZ(ecef(s), gstime(date));
}

/** Azimuth (from north toward east), elevation and range of an inertial target position (km). */
export function lookAngles(s: GroundStation, date: Date, target: Vec3) {
  const g = gstime(date);
  const st = rotZ(ecef(s), g);
  const d = rotZ([target[0] - st[0], target[1] - st[1], target[2] - st[2]], -g); // back to Earth-fixed axes
  const { e, n, u } = enu(s);
  const de = d[0] * e[0] + d[1] * e[1] + d[2] * e[2];
  const dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  const du = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  const range = Math.hypot(d[0], d[1], d[2]);
  return {
    azDeg: ((Math.atan2(de, dn) / DEG) % 360 + 360) % 360,
    elDeg: Math.asin(du / range) / DEG,
    rangeKm: range,
  };
}
