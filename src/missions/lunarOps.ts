import { BODIES, type Vec3 } from "../core/bodies";
import { Rotor, wedge, type Bivector } from "../core/ga";
import { bodyOrientation } from "../core/rotation";
import { Epoch } from "../core/time";
import { moonAt, moonVelocityAt } from "../orbit/cislunar";
import { solveKepler } from "../orbit/kepler";
import type { Sample } from "./horizons";
import type { LunarOpsSpec } from "./types";

const R_M = BODIES.moon.equatorialRadius;
const MU_M = BODIES.moon.gm;
const G_M = MU_M / (R_M * R_M); // surface gravity, km/s²
const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

const tt = (iso: string) => Epoch.fromUnixMs(Date.parse(iso)).tt;
const iso = (t: number) => Epoch.fromTT(t).toDate().toISOString().slice(0, 19) + "Z";
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3) => scale(a, 1 / norm(a));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function planeRotor(B: Bivector, angle: number): Rotor {
  const s = Math.sin(angle / 2);
  return new Rotor(Math.cos(angle / 2), -s * B.b12, -s * B.b23, -s * B.b31);
}

function trueAnomaly(M: number, e: number): number {
  const E = solveKepler(M, e);
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

/**
 * Lunar operations from orbit insertion to touchdown or impact, Moon-centred, scene axes, km:
 * capture ellipse at LOI → gradual lowering to the circular orbit → circular orbit →
 * descent orbit (DOI at the published landing-sequence start) → powered descent →
 * optionally a free fall from the altitude where propellant ran out.
 */
export function lunarOps(spec: LunarOpsSpec, latDeg: number, lonDeg: number) {
  const tLoi = tt(spec.loi);
  const tCirc = tt(spec.circularBy);
  const tLand = tt(spec.landing);

  // Final free fall (crash) and powered descent timing
  const hFF = spec.crash?.freeFallFromKm ?? 0;
  const tFall = hFF > 0 ? Math.sqrt((2 * hFF) / G_M) : 0;
  const tEnd = tLand - tFall; // end of powered descent: at rest, hFF above the site
  const T = spec.pdiDurationS;
  const tPdi = tEnd - T;

  // Site, pole and orbit plane at touchdown
  const q = bodyOrientation("moon", Epoch.fromTT(tLand));
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sHat = q.apply([Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]);
  const pole = q.apply([0, 0, 1]);
  const north = unit(sub(pole, scale(sHat, dot(pole, sHat))));
  const east = unit(cross(pole, sHat));
  let azDeg = spec.heading === "south" ? 180 : 0;
  if (spec.inclinationDeg !== undefined) {
    // cos i = cos(lat) · sin(azimuth): two solutions, picked by the heading
    const a0 = Math.asin(clamp(Math.cos(spec.inclinationDeg * DEG) / Math.cos(lat), -1, 1)) / DEG;
    azDeg = spec.heading === "south" ? 180 - a0 : a0;
  }
  const az = azDeg * DEG;
  const along = add(scale(north, Math.cos(az)), scale(east, Math.sin(az)));
  const plane = wedge(sHat, along);
  const normal: Vec3 = [plane.b23, plane.b31, plane.b12];
  const rot = (v: Vec3, angle: number) => planeRotor(plane, angle).apply(v);
  const inclinationDeg = Math.acos(clamp(dot(normal, pole), -1, 1)) / DEG;

  // Descent orbit and powered descent (ends at rest, hFF above the site)
  const rc = R_M + spec.orbitAltKm;
  const rp = R_M + spec.pdiAltKm;
  const rEnd = R_M + hFF;
  const aE = (rc + rp) / 2;
  const eE = (rc - rp) / (rc + rp);
  const nE = Math.sqrt(MU_M / aE ** 3);
  const TE = TWO_PI / nE;
  const vPdi = Math.sqrt(MU_M * (2 / rp - 1 / aE));
  const phi = (0.5 * vPdi * T) / R_M;
  const pHat = rot(sHat, -phi);
  const k = Math.max(0, Math.round((tPdi - tt(spec.descentStart)) / TE - 0.5));
  const tDoi = tPdi - (k + 0.5) * TE;
  const aHat = scale(pHat, -1);
  const wC = Math.sqrt(MU_M / rc ** 3);
  if (!(tLoi < tCirc && tCirc < tDoi)) throw new Error("expected LOI < circularBy < descent start");

  // Orbit lowering: perilune and apolune altitudes change linearly from capture to circular;
  // mean anomaly is integrated so the motion stays continuous, and the argument of perilune is
  // chosen so the lowering ends exactly on the circular orbit's position at `circularBy`.
  const STEP = 60;
  const lowT: number[] = [];
  const lowM: number[] = [];
  const elements = (t: number) => {
    const s = clamp((t - tLoi) / (tCirc - tLoi), 0, 1);
    const rPeri = R_M + spec.capture.periAltKm + s * (spec.orbitAltKm - spec.capture.periAltKm);
    const rApo = R_M + spec.capture.apoAltKm + s * (spec.orbitAltKm - spec.capture.apoAltKm);
    return { a: (rPeri + rApo) / 2, e: (rApo - rPeri) / (rApo + rPeri) };
  };
  let M = 0;
  for (let t = tLoi; t <= tCirc + STEP; t += STEP) {
    lowT.push(t);
    lowM.push(M);
    const n0 = Math.sqrt(MU_M / elements(t).a ** 3);
    const n1 = Math.sqrt(MU_M / elements(t + STEP).a ** 3);
    M += 0.5 * (n0 + n1) * STEP;
  }
  const meanAnomaly = (t: number) => {
    const i = clamp(Math.floor((t - tLoi) / STEP), 0, lowT.length - 2);
    const f = (t - lowT[i]) / STEP;
    return lowM[i] + f * (lowM[i + 1] - lowM[i]);
  };
  const omega = wC * (tCirc - tDoi) - meanAnomaly(tCirc); // at tCirc, e = 0 and ν = M

  function at(t: number): Vec3 {
    if (t >= tEnd) {
      const dt = t - tEnd;
      return scale(sHat, Math.max(R_M, rEnd - 0.5 * G_M * dt * dt)); // free fall, straight down
    }
    if (t >= tPdi) {
      const s = (t - tPdi) / T;
      const r = rp - (rp - rEnd) * (3 * s * s - 2 * s * s * s);
      return scale(rot(pHat, phi * (2 * s - s * s)), r);
    }
    if (t >= tDoi) {
      const E = solveKepler(nE * (t - tPdi), eE);
      const nu = 2 * Math.atan2(Math.sqrt(1 + eE) * Math.sin(E / 2), Math.sqrt(1 - eE) * Math.cos(E / 2));
      return scale(rot(pHat, nu), aE * (1 - eE * Math.cos(E)));
    }
    if (t >= tCirc) return scale(rot(aHat, wC * (t - tDoi)), rc);
    const { a, e } = elements(t);
    const Mt = meanAnomaly(t);
    const E = solveKepler(Mt, e);
    return scale(rot(aHat, omega + trueAnomaly(Mt, e)), a * (1 - e * Math.cos(E)));
  }

  // Geocentric samples (Moon-relative + Moon), velocities by central difference
  const geo = (t: number) => add(moonAt(t), at(t));
  const samples: Sample[] = [];
  for (let t = tLoi; t < tLand; t += t < tPdi ? 120 : t < tEnd ? 5 : 1) {
    samples.push({ t, r: geo(t), v: scale(sub(geo(t + 0.5), geo(t - 0.5)), 1) });
  }
  samples.push({ t: tLand, r: geo(tLand), v: moonVelocityAt(tLand) });

  const revs = (meanAnomaly(tCirc) + wC * (tDoi - tCirc)) / TWO_PI + k + 0.5;
  const report = {
    modeledPhase: "lunar operations only (LOI → impact); transfer not reconstructed yet",
    loi: iso(tLoi),
    captureOrbitKm: `${spec.capture.periAltKm} × ${spec.capture.apoAltKm}`,
    circularBy: iso(tCirc),
    orbitAltKm: spec.orbitAltKm,
    orbitInclinationDeg: +inclinationDeg.toFixed(1),
    groundTrackAzimuthDeg: +(((azDeg % 360) + 360) % 360).toFixed(1),
    lunarRevolutions: +revs.toFixed(1),
    doi: iso(tDoi),
    pdi: iso(tPdi),
    freeFallFromKm: hFF,
    freeFallSeconds: +tFall.toFixed(1),
    impactSpeedMs: hFF > 0 ? Math.round(G_M * tFall * 1000) : "n/a (descent modeled to scheduled touchdown)",
    impact: iso(tLand),
  };
  return { samples, report, at, times: { tLoi, tCirc, tDoi, tPdi, tEnd, tLand }, siteDir: sHat };
}
