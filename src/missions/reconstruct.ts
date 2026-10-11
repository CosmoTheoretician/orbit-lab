import { BODIES, type Vec3 } from "../core/bodies";
import { Rotor, wedge, type Bivector } from "../core/ga";
import { bodyOrientation } from "../core/rotation";
import { Epoch } from "../core/time";
import { cislunarDeriv, moonAt, moonVelocityAt } from "../orbit/cislunar";
import { integrate } from "../orbit/integrator";
import { solveKepler } from "../orbit/kepler";
import type { Sample } from "./horizons";
import { sampleTrack } from "./track";
import type { ReconstructionSpec } from "./types";

const R_M = BODIES.moon.equatorialRadius;
const MU_M = BODIES.moon.gm;
const R_E = BODIES.earth.equatorialRadius;
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
const surfaceUnit = (latDeg: number, lonDeg: number): Vec3 => {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};

/** Rotation by `angle` within the oriented unit plane B (turns a toward b for B = a∧b). */
function planeRotor(B: Bivector, angle: number): Rotor {
  const s = Math.sin(angle / 2);
  return new Rotor(Math.cos(angle / 2), -s * B.b12, -s * B.b23, -s * B.b31);
}

/**
 * Ground-track azimuth (degrees from north toward east) of a lander that passes over `feature`
 * on its way to the site: the direction of motion points away from the feature.
 */
export function approachAzimuthDeg(latDeg: number, lonDeg: number, feature: { lat: number; lon: number }): number {
  const s = surfaceUnit(latDeg, lonDeg);
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const north: Vec3 = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
  const f = surfaceUnit(feature.lat, feature.lon);
  const toFeature = sub(f, scale(s, dot(f, s)));
  const bearing = Math.atan2(dot(toFeature, east), dot(toFeature, north)) / DEG;
  return (bearing + 180 + 360) % 360;
}

/** Where LOI happened: time, and angle around the circular orbit measured from the DOI point. */
export interface LoiPoint {
  t: number;
  theta: number;
}

/**
 * Lunar phase built backward from the landing: circular orbit → descent orbit (after DOI) →
 * powered descent decelerating to rest exactly on the site. Moon-centred, scene axes, km.
 * The orbit plane is set by the ground-track azimuth over the site (degrees from north toward east;
 * default from `spec.heading`). With `loi`, the circular orbit runs from the LOI point to the DOI point
 * in a whole number of revolutions; its effective rate is reported as an implied altitude.
 */
export function lunarPhase(spec: ReconstructionSpec, latDeg: number, lonDeg: number, loi?: LoiPoint, azimuthDeg?: number) {
  const tLand = tt(spec.landing);
  const T = spec.pdiDurationS;
  const tPdi = tLand - T;

  // Site and pole in inertial axes at touchdown (IAU Moon orientation, as rendered)
  const q = bodyOrientation("moon", Epoch.fromTT(tLand));
  const sHat = q.apply(surfaceUnit(latDeg, lonDeg));
  const pole = q.apply([0, 0, 1]);
  const north = unit(sub(pole, scale(sHat, dot(pole, sHat))));
  const east = unit(cross(pole, sHat));
  const az = (azimuthDeg ?? (spec.heading === "south" ? 180 : 0)) * DEG;
  const along = add(scale(north, Math.cos(az)), scale(east, Math.sin(az)));
  const plane = wedge(sHat, along); // unit bivector of the orbital plane
  const normal: Vec3 = [plane.b23, plane.b31, plane.b12]; // its dual: angular momentum direction
  const rot = (v: Vec3, angle: number) => planeRotor(plane, angle).apply(v);
  const inclinationDeg = Math.acos(clamp(dot(normal, pole), -1, 1)) / DEG;

  // Descent orbit: aposelene at the circular radius, periselene at the PDI point
  const rc = R_M + spec.orbitAltKm;
  const rp = R_M + spec.pdiAltKm;
  const aE = (rc + rp) / 2;
  const eE = (rc - rp) / (rc + rp);
  const nE = Math.sqrt(MU_M / aE ** 3);
  const TE = TWO_PI / nE;
  const vPdi = Math.sqrt(MU_M * (2 / rp - 1 / aE));

  // Powered descent: decelerating linearly from vPdi to rest covers ½·vPdi·T of ground track
  const phi = (0.5 * vPdi * T) / R_M;
  const pHat = rot(sHat, -phi); // PDI point, uprange of the site

  // DOI is an aposelene passage (k + ½) descent-orbit revolutions before PDI, nearest the published time
  const tDoiTarget = spec.doi ? tt(spec.doi) : tPdi - TE / 2;
  const k = Math.max(0, Math.round((tPdi - tDoiTarget) / TE - 0.5));
  const tDoi = tPdi - (k + 0.5) * TE;
  const aHat = scale(pHat, -1); // DOI point

  // Circular orbit: nominal rate backward from DOI, or an effective rate linking the LOI point to DOI
  const wNom = Math.sqrt(MU_M / rc ** 3);
  let wEff = wNom;
  let revs = 0;
  let circAngle = (t: number) => wNom * (t - tDoi);
  if (loi) {
    if (loi.t >= tDoi) throw new Error("LOI must precede DOI");
    const span = tDoi - loi.t;
    revs = Math.max(1, Math.round((wNom * span + loi.theta) / TWO_PI));
    wEff = (TWO_PI * revs - loi.theta) / span;
    circAngle = (t: number) => loi.theta + wEff * (t - loi.t);
  }

  function at(t: number): Vec3 {
    if (t >= tPdi) {
      const s = Math.min(1, (t - tPdi) / T);
      const r = rp - (rp - R_M) * (3 * s * s - 2 * s * s * s); // smooth touchdown, zero vertical speed at both ends
      return scale(rot(pHat, phi * (2 * s - s * s)), r);
    }
    if (t >= tDoi) {
      const E = solveKepler(nE * (t - tPdi), eE);
      const nu = 2 * Math.atan2(Math.sqrt(1 + eE) * Math.sin(E / 2), Math.sqrt(1 - eE) * Math.cos(E / 2));
      return scale(rot(pHat, nu), aE * (1 - eE * Math.cos(E)));
    }
    return scale(rot(aHat, circAngle(t)), rc);
  }

  const velocity = (t: number): Vec3 => sub(at(t + 0.5), at(t - 0.5));
  const impliedAltKm = Math.cbrt(MU_M / (wEff * wEff)) - R_M;
  const descentOrbitRevs = k + 0.5;
  return { at, velocity, rot, aHat, normal, tLand, tPdi, tDoi, rc, siteDir: sHat, impliedAltKm, inclinationDeg, revs, descentOrbitRevs };
}

interface Attempt {
  F: [number, number];
  interior: boolean;
  rp: number;
  tp: number;
  tLoi: number;
  theta: number;
  azDeg: number;
  v: number;
  samples: Sample[];
}

/** Golden-section refinement of the perigee between three Hermite samples. */
function refinePerigee(s: Sample[], i: number): { r: number; t: number } {
  const pts = [s[i - 1], s[i], s[i + 1]].sort((a, b) => a.t - b.t);
  const tr = {
    t: Float64Array.from(pts.map((p) => p.t)),
    r: Float64Array.from(pts.flatMap((p) => p.r)),
    v: Float64Array.from(pts.flatMap((p) => p.v)),
  };
  const f = (t: number) => norm(sampleTrack(tr, t)!);
  let a = pts[0].t;
  let b = pts[2].t;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 60; it++) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (f(c) < f(d)) b = d;
    else a = c;
  }
  const t = (a + b) / 2;
  return { r: f(t), t };
}

/**
 * Reconstructs a direct-transfer lunar landing: lunar phase from the published milestones, plus the
 * trans-lunar transfer solved in an Earth–Moon–Sun model by integrating backward from LOI to a
 * perigee at the TLI time. Arrival is coplanar with the lunar orbit (no plane change at LOI).
 * Unknowns: arrival speed, arrival point around the orbit, the orbit plane (ground-track azimuth over
 * the site, unless fixed by a published approach feature) and, within published bounds, the LOI time.
 * Among converged solutions the one with the lowest LOI Δv is kept.
 */
export function reconstruct(spec: ReconstructionSpec, latDeg: number, lonDeg: number) {
  const tTli = tt(spec.tli);
  const rPark = R_E + spec.parkAltKm;
  const tLoi0 = tt(spec.loi.time);
  const free = spec.loi.window !== undefined;
  const dtLo = free ? (tt(spec.loi.window![0]) - tLoi0) / 3600 : 0;
  const dtHi = free ? (tt(spec.loi.window![1]) - tLoi0) / 3600 : 0;

  // Orbit plane: fixed by a published approach feature, or solved for
  const fixedAz = spec.approachOver ? approachAzimuthDeg(latDeg, lonDeg, spec.approachOver) : null;
  const solveAz = fixedAz === null;
  const iAz = solveAz ? 2 : -1;
  const iDt = free ? (solveAz ? 3 : 2) : -1;

  function attempt(v: number, theta: number, azDeg: number, dtH: number): Attempt {
    const tLoi = tLoi0 + clamp(dtH, dtLo, dtHi) * 3600;
    const lp = lunarPhase(spec, latDeg, lonDeg, undefined, azDeg);
    const rRel = scale(lp.rot(lp.aHat, theta), lp.rc);
    const along = lp.rot(lp.aHat, theta + Math.PI / 2); // prograde along the orbit: coplanar arrival
    const y0 = [...add(moonAt(tLoi), rRel), ...add(moonVelocityAt(tLoi), scale(along, v))];

    const samples: Sample[] = [];
    integrate(cislunarDeriv, tLoi, y0, tTli - 2 * 86400, {
      onStep: (t, y) => {
        samples.push({ t, r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]] });
        return Math.hypot(y[0], y[1], y[2]) < R_E * 0.5; // went through the Earth: stop
      },
    });

    let iMin = 0;
    for (let i = 1; i < samples.length; i++) if (norm(samples[i].r) < norm(samples[iMin].r)) iMin = i;
    const interior = iMin > 0 && iMin < samples.length - 1;
    const per = interior ? refinePerigee(samples, iMin) : { r: norm(samples[iMin].r), t: samples[iMin].t };
    return { F: [(per.r - rPark) / 100, (per.t - tTli) / 3600], interior, rp: per.r, tp: per.t, tLoi, theta, azDeg, v, samples };
  }

  const size = (a: Attempt) => (a.interior ? Math.hypot(a.F[0], a.F[1]) : Infinity);
  // x = [v (km/s), theta (rad), azimuth (rad, if solved), dt (h, if free)]
  const run = (x: number[]) => attempt(x[0], x[1], solveAz ? x[iAz] / DEG : fixedAz!, iDt >= 0 ? x[iDt] : 0);
  const scales = [0.05, 0.1, ...(solveAz ? [0.1] : []), ...(free ? [1] : [])];
  const ok = (a: Attempt) => a.interior && Math.abs(a.rp - rPark) < 1 && Math.abs(a.tp - tTli) < 120;

  function newton(x0: number[], a0: Attempt) {
    let x = [...x0];
    let cur = a0;
    for (let it = 0; it < 60 && !ok(cur); it++) {
      const J: number[][] = [[], []];
      for (let j = 0; j < x.length; j++) {
        const h = 1e-4 * scales[j];
        const xp = [...x];
        xp[j] += h;
        const ap = run(xp);
        J[0][j] = ((ap.F[0] - cur.F[0]) / h) * scales[j];
        J[1][j] = ((ap.F[1] - cur.F[1]) / h) * scales[j];
      }
      const m00 = J[0].reduce((s, a) => s + a * a, 0);
      const m11 = J[1].reduce((s, a) => s + a * a, 0);
      const m01 = J[0].reduce((s, a, j) => s + a * J[1][j], 0);
      const det = m00 * m11 - m01 * m01;
      if (Math.abs(det) < 1e-30) break;
      const w0 = (m11 * cur.F[0] - m01 * cur.F[1]) / det;
      const w1 = (-m01 * cur.F[0] + m00 * cur.F[1]) / det;
      const dz = J[0].map((a, j) => a * w0 + J[1][j] * w1);

      let lambda = 1;
      let accepted = false;
      for (let tries = 0; tries < 10; tries++) {
        const xn = x.map((xi, j) => xi - lambda * dz[j] * scales[j]);
        if (iDt >= 0) xn[iDt] = clamp(xn[iDt], dtLo, dtHi);
        const an = run(xn);
        if (size(an) < size(cur)) {
          x = xn;
          cur = an;
          accepted = true;
          break;
        }
        lambda /= 2;
      }
      if (!accepted) break;
    }
    return { x, cur };
  }

  // Global search: LOI time (if free) × orbit plane (if solved) × arrival point × arrival speed
  const grid: Array<{ x: number[]; a: Attempt }> = [];
  const dts = free ? [0, 1, 2, 3].map((k) => dtLo + ((dtHi - dtLo) * k) / 3) : [0];
  const azs = solveAz ? Array.from({ length: 12 }, (_, k) => k * 30) : [fixedAz!];
  for (const dt of dts) {
    for (const az of azs) {
      for (let th = 0; th < 360; th += solveAz ? 15 : 5) {
        for (let v = 2.3; v <= 2.95; v += solveAz ? 0.1 : 0.05) {
          const x = [v, th * DEG, ...(solveAz ? [az * DEG] : []), ...(free ? [dt] : [])];
          const a = run(x);
          if (a.interior) grid.push({ x, a });
        }
      }
    }
  }
  grid.sort((p, q) => size(p.a) - size(q.a));

  // Refine the best starting points; keep the converged solution with the lowest LOI Δv
  const solutions = grid.slice(0, 8).map((g) => newton(g.x, g.a));
  const converged = solutions.filter((s) => ok(s.cur));
  const best = (converged.length > 0 ? converged : solutions).reduce((p, q) =>
    converged.length > 0 ? (q.cur.v < p.cur.v ? q : p) : size(q.cur) < size(p.cur) ? q : p,
  );
  const cur = best.cur;

  // Assemble: transfer from perigee forward to LOI, then the lunar phase (Moon-relative + Moon)
  const theta = ((cur.theta % TWO_PI) + TWO_PI) % TWO_PI;
  const azDeg = ((cur.azDeg % 360) + 360) % 360;
  const lunar = lunarPhase(spec, latDeg, lonDeg, { t: cur.tLoi, theta }, azDeg);
  const transfer = cur.samples.filter((s) => s.t >= cur.tp).reverse();
  const lunarSamples: Sample[] = [];
  for (let t = cur.tLoi + 60; t < lunar.tLand; t += t < lunar.tPdi ? 60 : 5) {
    lunarSamples.push({ t, r: add(moonAt(t), lunar.at(t)), v: add(moonVelocityAt(t), lunar.velocity(t)) });
  }
  lunarSamples.push({ t: lunar.tLand, r: add(moonAt(lunar.tLand), lunar.at(lunar.tLand)), v: moonVelocityAt(lunar.tLand) });
  const samples = [...transfer, ...lunarSamples];

  let pathKm = 0;
  for (let i = 1; i < transfer.length; i++) pathKm += norm(sub(transfer[i].r, transfer[i - 1].r));
  const vCirc = Math.sqrt(MU_M / lunar.rc);

  const report = {
    converged: ok(cur),
    solutionsFound: converged.length,
    tli: iso(cur.tp),
    tliErrorMin: +((cur.tp - tTli) / 60).toFixed(1),
    perigeeAltKm: +(cur.rp - R_E).toFixed(1),
    loi: iso(cur.tLoi),
    loiAtWindowEdge: free && (Math.abs(cur.tLoi - (tLoi0 + dtLo * 3600)) < 60 || Math.abs(cur.tLoi - (tLoi0 + dtHi * 3600)) < 60),
    loiDeltaVms: +((cur.v - vCirc) * 1000).toFixed(0), // coplanar arrival: speed difference is the full Δv
    vInfinityKms: +Math.sqrt(Math.max(0, cur.v ** 2 - (2 * MU_M) / lunar.rc)).toFixed(3),
    orbitPlane: spec.approachOver ? `fixed: passes over ${spec.approachOver.label}` : "solved",
    orbitInclinationDeg: +lunar.inclinationDeg.toFixed(1),
    groundTrackAzimuthDeg: +azDeg.toFixed(1),
    loiPhaseDeg: +(theta / DEG).toFixed(1),
    impliedOrbitAltKm: +lunar.impliedAltKm.toFixed(1),
    lunarRevolutions: +(lunar.revs + lunar.descentOrbitRevs).toFixed(1),
    transferDays: +((cur.tLoi - cur.tp) / 86400).toFixed(2),
    transferPathKm: Math.round(pathKm),
    lunarOrbitAltKm: spec.orbitAltKm,
    doi: iso(lunar.tDoi),
    pdi: iso(lunar.tPdi),
    landing: iso(lunar.tLand),
  };
  return { samples, report };
}
