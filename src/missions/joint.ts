import { BODIES, type Vec3 } from "../core/bodies";
import { moonEquatorRotor } from "../core/rotation";
import { Epoch } from "../core/time";
import { cislunarDeriv, moonAt, moonVelocityAt } from "../orbit/cislunar";
import { integrate } from "../orbit/integrator";
import { solveKepler } from "../orbit/kepler";
import type { Sample } from "./horizons";

const R_M = BODIES.moon.equatorialRadius;
const MU_M = BODIES.moon.gm;
const R_E = BODIES.earth.equatorialRadius;
const MU_E = BODIES.earth.gm;
const DEG = Math.PI / 180;
const DAY = 86400;

const tt = (iso: string) => Epoch.fromUnixMs(Date.parse(iso)).tt;
const iso = (t: number) => Epoch.fromTT(t).toDate().toISOString().slice(0, 19) + "Z";
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3) => scale(a, 1 / norm(a));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface JointSpec {
  launch: string;
  deployment: string;
  perigeeAltKm: number;
  firstManeuver: { time: string; distanceKm: number };
  correctionWindow: [string, string];
  flyby: { time: string; altitudeKm: number };
  dsmWindow: [string, string];
  apogee: { distanceKm: number; by: string };
  loi: { time: string; periAltKm: number };
  capture: { periAltKm: number; apoAltKm: number };
  planeNormal: Vec3;
  /** Continuation only: final cap on the pre-flyby correction (m/s), and the number of steps. */
  correctionCapMs?: number;
  steps?: number;
  /** Allowed departure inclination range (degrees); absent = no limit. */
  departureIncDeg?: [number, number];
}

export interface State {
  r: Vec3;
  v: Vec3;
  maxEarthKm: number;
  tMaxEarth: number;
  minEarthKm: number;
  /** Perigee passes (local minima of the Earth distance below 200,000 km) since the leg's start. */
  perigees: number;
  /** Closest Moon distance since the leg's start, ignoring its first moonExclude seconds. */
  minMoonKm: number;
}

export interface Targets {
  m1: number;
  apo: number;
  /** km/s; Infinity disables the cap */
  cap: number;
  /** Scale of the correction Δv in the residual (km/s): 0.02 weighs it like the DSM, 0.2 more loosely. */
  dv1Scale: number;
  /** Minimum Earth distance after the flyby (km); 0 or absent disables. */
  minEarthKm?: number;
  /** Minimum Moon distance before the flyby's final approach (km); 0 or absent disables. */
  minMoonPreKm?: number;
}

export interface Res {
  F: number[];
  mis1: number;
  mis2: number;
  dv1: number;
  dv2: number;
  m1: number;
  apoKm: number;
  apoT: number;
  minPostKm: number;
  minMoonPreKm: number;
  perigeesPre: number;
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * The whole transfer, deployment → LOI, in the Earth–Moon–Sun model.
 * x = [ra/1e5 km, i, RAAN, argp, perigee minutes before deployment, correction-time fraction,
 *      flyby RA, flyby Dec, flyby motion angle, flyby speed, arrival phase, arrival speed, DSM-time fraction]
 * Junctions: pre-flyby correction (deployment leg ↔ backward flyby leg) and deep-space maneuver
 * (forward flyby leg ↔ backward arrival leg).
 */
export function createJointProblem(spec: JointSpec) {
  const tLaunch = tt(spec.launch);
  const tDep = tt(spec.deployment);
  const tM1 = tt(spec.firstManeuver.time);
  const [tC0, tC1] = spec.correctionWindow.map(tt);
  const [tD0, tD1] = spec.dsmWindow.map(tt);
  const tFb = tt(spec.flyby.time);
  const tLoi = tt(spec.loi.time);
  const apoBy = tt(spec.apogee.by);
  const rp = R_E + spec.perigeeAltKm;
  const rFb = R_M + spec.flyby.altitudeKm;
  const rArr = R_M + spec.loi.periAltKm;
  const tCorrOf = (s: number) => tC0 + clamp01(s) * (tC1 - tC0);
  const tDsmOf = (s: number) => tD0 + clamp01(s) * (tD1 - tD0);
  const maxPeriMin = (tDep - tLaunch) / 60 - 30;

  const n = unit(spec.planeNormal);
  let e1 = cross(n, [0, 0, 1]);
  if (norm(e1) < 1e-6) e1 = cross(n, [1, 0, 0]);
  e1 = unit(e1);
  const e2 = cross(n, e1);
  const mFb = moonAt(tFb);
  const mvFb = moonVelocityAt(tFb);
  const mLoi = moonAt(tLoi);
  const mvLoi = moonVelocityAt(tLoi);

  /** Deployment state on an ellipse with the fixed perigee altitude; perigee passed periMin minutes earlier. */
  function deployState(raE5: number, inc: number, raan: number, argp: number, periMin: number): Float64Array {
    const ra = raE5 * 1e5;
    const a = (rp + ra) / 2;
    const e = (ra - rp) / (ra + rp);
    const E = solveKepler(Math.sqrt(MU_E / a ** 3) * periMin * 60, e);
    const r = a * (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const k = Math.sqrt(MU_E * a) / r;
    const vxp = -k * Math.sin(E);
    const vyp = k * Math.sqrt(1 - e * e) * Math.cos(E);
    const [cO, sO, ci, si, cw, sw] = [Math.cos(raan), Math.sin(raan), Math.cos(inc), Math.sin(inc), Math.cos(argp), Math.sin(argp)];
    const P: Vec3 = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
    const Q: Vec3 = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
    return Float64Array.from([...add(scale(P, xp), scale(Q, yp)), ...add(scale(P, vxp), scale(Q, vyp))]);
  }

  /** Flyby periapsis: direction (a, d), motion angle b, speed v (same construction as the low-energy solver). */
  function flyState(a: number, d: number, b: number, v: number): Float64Array {
    const u: Vec3 = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
    let f1 = cross([0, 0, 1], u);
    if (norm(f1) < 1e-6) f1 = cross([1, 0, 0], u);
    f1 = unit(f1);
    const f2 = cross(u, f1);
    const vd = add(scale(f1, Math.cos(b)), scale(f2, Math.sin(b)));
    return Float64Array.from([...add(mFb, scale(u, rFb)), ...add(mvFb, scale(vd, v))]);
  }

  /** Perilune at LOI: in the lunar-operations plane, moving prograde. */
  function arrivalState(theta: number, va: number): Float64Array {
    const p = add(scale(e1, Math.cos(theta)), scale(e2, Math.sin(theta)));
    return Float64Array.from([...add(mLoi, scale(p, rArr)), ...add(mvLoi, scale(cross(n, p), va))]);
  }

  /** Integrates through a list of times (in the direction of travel). Null on Earth/Moon impact or escape. */
  function runTo(y0: Float64Array, tStart: number, times: number[], samples?: Sample[], moonExclude = 0): State[] | null {
    let y = y0;
    let t = tStart;
    let maxE = 0;
    let tMaxE = tStart;
    let minE = Infinity;
    let minM = Infinity;
    let perigees = 0;
    let prevR = NaN;
    let prevDr = 0;
    let dead = false;
    const out: State[] = [];
    for (const tNext of times) {
      const res = integrate(cislunarDeriv, t, y, tNext, {
        onStep: (ts, ys) => {
          samples?.push({ t: ts, r: [ys[0], ys[1], ys[2]], v: [ys[3], ys[4], ys[5]] });
          const rE = Math.hypot(ys[0], ys[1], ys[2]);
          if (rE < minE) minE = rE;
          if (!Number.isNaN(prevR)) {
            const dr = rE - prevR;
            if (prevDr < 0 && dr >= 0 && prevR < 200_000) perigees++;
            if (dr !== 0) prevDr = dr;
          }
          prevR = rE;
          if (rE > maxE) {
            maxE = rE;
            tMaxE = ts;
          }
          if (rE < R_E || rE > 5e6) {
            dead = true;
            return true;
          }
          const m = moonAt(ts);
          const dM = Math.hypot(ys[0] - m[0], ys[1] - m[1], ys[2] - m[2]);
          if (Math.abs(ts - tStart) > moonExclude && dM < minM) minM = dM;
          if (Math.abs(ts - tStart) > 3600 && dM < R_M) {
            dead = true;
            return true;
          }
          return false;
        },
      });
      if (dead) return null;
      y = res.y;
      t = tNext;
      out.push({ r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]], maxEarthKm: maxE, tMaxEarth: tMaxE, minEarthKm: minE, perigees, minMoonKm: minM });
    }
    return out;
  }

  // ---------- legs, each cached on the unknowns it depends on ----------
  const caches = [0, 1, 2, 3].map(() => new Map<string, State[] | null>());
  function cached(i: number, key: number[], f: () => State[] | null) {
    const c = caches[i];
    const k = key.join(",");
    if (!c.has(k)) {
      if (c.size > 5000) c.clear();
      c.set(k, f());
    }
    return c.get(k)!;
  }
  function legs(x: number[]) {
    const tC = tCorrOf(x[5]);
    const tD = tDsmOf(x[12]);
    const dep = cached(0, x.slice(0, 6), () => runTo(deployState(x[0], x[1], x[2], x[3], x[4]), tDep, [tM1, tC]));
    const fbB = cached(1, [...x.slice(6, 10), x[5]], () => runTo(flyState(x[6], x[7], x[8], x[9]), tFb, [tC], undefined, 2 * DAY));
    const fbF = cached(2, [...x.slice(6, 10), x[12]], () => runTo(flyState(x[6], x[7], x[8], x[9]), tFb, [tD]));
    const arB = cached(3, [x[10], x[11], x[12]], () => runTo(arrivalState(x[10], x[11]), tLoi, [tD]));
    if (!dep || !fbB || !fbF || !arB) return null;
    const A = fbF[0];
    const B = arB[0];
    const apo = A.maxEarthKm >= B.maxEarthKm ? { km: A.maxEarthKm, t: A.tMaxEarth } : { km: B.maxEarthKm, t: B.tMaxEarth };
    return {
      m1: norm(dep[0].r),
      dr1: sub(dep[1].r, fbB[0].r),
      dv1: sub(fbB[0].v, dep[1].v),
      dr2: sub(A.r, B.r),
      dv2: sub(B.v, A.v),
      apo,
      minPost: Math.min(A.minEarthKm, B.minEarthKm),
      minMoonPre: Math.min(dep[1].minMoonKm, fbB[0].minMoonKm),
      perigeesPre: dep[1].perigees + fbB[0].perigees,
    };
  }

  function residual(x: number[], wPosKm: number, tg: Targets): Res | null {
    const l = legs(x);
    if (!l) return null;
    const dv1 = norm(l.dv1);
    const F = [
      ...scale(l.dr1, 1 / wPosKm),
      ...scale(l.dv1, 1 / tg.dv1Scale),
      Math.max(0, dv1 - tg.cap) / 0.005,
      ...scale(l.dr2, 1 / wPosKm),
      ...scale(l.dv2, 1 / 0.02),
      (l.m1 - tg.m1) / 5_000,
      (l.apo.km - tg.apo) / 50_000,
      Math.max(0, l.apo.t - apoBy) / (3 * DAY),
      Math.max(0, (tg.minEarthKm ?? 0) - l.minPost) / 20_000,
      Math.max(0, (tg.minMoonPreKm ?? 0) - l.minMoonPre) / 20_000,
    ];
    return { F, mis1: norm(l.dr1), mis2: norm(l.dr2), dv1, dv2: norm(l.dv2), m1: l.m1, apoKm: l.apo.km, apoT: l.apo.t, minPostKm: l.minPost, minMoonPreKm: l.minMoonPre, perigeesPre: l.perigeesPre };
  }
  const cost = (r: Res) => r.F.reduce((s, f) => s + f * f, 0);

  function clampX(x: number[]) {
    x[0] = Math.max(x[0], 0.7);
    if (spec.departureIncDeg) x[1] = Math.min(spec.departureIncDeg[1] * DEG, Math.max(spec.departureIncDeg[0] * DEG, x[1]));
    x[4] = Math.min(maxPeriMin, Math.max(2, x[4]));
    x[5] = clamp01(x[5]);
    x[9] = Math.max(x[9], 0.5);
    x[11] = Math.max(x[11], 0.5);
    x[12] = clamp01(x[12]);
    return x;
  }

  const H = [1e-6, 1e-6, 1e-6, 1e-6, 1e-4, 1e-5, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-5];
  /** Levenberg–Marquardt over all residuals. */
  function lm(xStart: number[], wPosKm: number, iters: number, tg: Targets) {
    let x = clampX([...xStart]);
    let cur = residual(x, wPosKm, tg);
    if (!cur) return null;
    const nx = x.length;
    let lambda = 1e-3;
    for (let it = 0; it < iters; it++) {
      const m = cur.F.length;
      const J: number[][] = Array.from({ length: m }, () => new Array(nx).fill(0));
      let bad = false;
      for (let j = 0; j < nx; j++) {
        const xp = [...x];
        xp[j] += H[j];
        const rp2 = residual(xp, wPosKm, tg);
        if (!rp2) {
          bad = true;
          break;
        }
        for (let i = 0; i < m; i++) J[i][j] = (rp2.F[i] - cur.F[i]) / H[j];
      }
      if (bad) break;
      const JTJ = Array.from({ length: nx }, (_, i) => Array.from({ length: nx }, (_, j) => J.reduce((s, row) => s + row[i] * row[j], 0)));
      const JTF = Array.from({ length: nx }, (_, i) => J.reduce((s, row, k) => s + row[i] * cur!.F[k], 0));
      let improved = false;
      for (let tries = 0; tries < 10; tries++) {
        const Aug = JTJ.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (JTJ[i][i] || 1) : 0)));
        const step = solve(Aug, JTF.map((g) => -g));
        if (step) {
          const xn = clampX(x.map((xi, j) => xi + step[j]));
          const rn = residual(xn, wPosKm, tg);
          if (rn && cost(rn) < cost(cur)) {
            x = xn;
            cur = rn;
            lambda = Math.max(lambda / 3, 1e-12);
            improved = true;
            break;
          }
        }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { x, cur };
  }

  const line = (r: Res, x: number[]) =>
    `correction ${(r.dv1 * 1000).toFixed(1)} m/s on ${iso(tCorrOf(x[5])).slice(0, 10)}, ` +
    `DSM ${(r.dv2 * 1000).toFixed(1)} m/s on ${iso(tDsmOf(x[12])).slice(0, 10)}, total ${((r.dv1 + r.dv2) * 1000).toFixed(1)} m/s, ` +
    `first maneuver at ${Math.round(r.m1).toLocaleString("en")} km, max ${Math.round(r.apoKm).toLocaleString("en")} km on ${iso(r.apoT).slice(0, 10)}, ` +
    `${r.perigeesPre + 1} Earth loops, Moon ≥ ${Math.round(r.minMoonPreKm).toLocaleString("en")} km before flyby, closest after flyby ${Math.round(r.minPostKm).toLocaleString("en")} km, mismatch ${r.mis1.toFixed(3)} / ${r.mis2.toFixed(3)} km`;

  /** Full sampled path: deployment → correction → flyby → DSM → LOI, strictly increasing in time. */
  function trajectory(x: number[]): Sample[] {
    const tC = tCorrOf(x[5]);
    const tD = tDsmOf(x[12]);
    const y0 = deployState(x[0], x[1], x[2], x[3], x[4]);
    const yF = flyState(x[6], x[7], x[8], x[9]);
    const sa: Sample[] = [];
    const sb: Sample[] = [];
    const sc: Sample[] = [];
    const sd: Sample[] = [];
    runTo(y0, tDep, [tC], sa);
    runTo(yF, tFb, [tC], sb);
    runTo(yF, tFb, [tD], sc);
    runTo(arrivalState(x[10], x[11]), tLoi, [tD], sd);
    const all: Sample[] = [
      { t: tDep, r: [y0[0], y0[1], y0[2]], v: [y0[3], y0[4], y0[5]] },
      ...sa,
      ...sb.reverse(),
      { t: tFb, r: [yF[0], yF[1], yF[2]], v: [yF[3], yF[4], yF[5]] },
      ...sc,
      ...sd.reverse(),
    ];
    const out: Sample[] = [];
    for (const s of all) if (out.length === 0 || s.t > out[out.length - 1].t + 1e-6) out.push(s);
    return out;
  }

  /** Every pass within 60,000 km of the Moon (local minima of the distance). */
  function lunarPasses(samples: Sample[]): string {
    const d = samples.map((s) => {
      const m = moonAt(s.t);
      return Math.hypot(s.r[0] - m[0], s.r[1] - m[1], s.r[2] - m[2]);
    });
    const out: string[] = [];
    for (let i = 1; i < d.length - 1; i++) {
      if (d[i] < 60_000 && d[i] <= d[i - 1] && d[i] < d[i + 1]) {
        out.push(`${iso(samples[i].t).slice(0, 10)} at ${Math.round(d[i]).toLocaleString("en")} km`);
      }
    }
    return out.length ? out.join("; ") : "none";
  }

  function report(x: number[], cur: Res, samples: Sample[], extra: Record<string, unknown> = {}) {
    const tC = tCorrOf(x[5]);
    let close = { km: Infinity, t: tC };
    for (const s of samples) {
      if (s.t < tC || s.t >= tFb) continue;
      const r = norm(s.r);
      if (r < close.km) close = { km: r, t: s.t };
    }
    let post = { km: Infinity, t: tFb };
    for (const s of samples) {
      if (s.t <= tFb + DAY || s.t >= tLoi - DAY) continue;
      const r = norm(s.r);
      if (r < post.km) post = { km: r, t: s.t };
    }
    let loopsPre = 1;
    let moonPre = Infinity;
    for (let i = 1; i < samples.length - 1; i++) {
      const s = samples[i];
      if (s.t >= tFb) break;
      const rPrev = norm(samples[i - 1].r);
      const r = norm(s.r);
      const rNext = norm(samples[i + 1].r);
      if (r < rPrev && r <= rNext && r < 200_000) loopsPre++;
      if (s.t < tFb - 2 * DAY) {
        const m = moonAt(s.t);
        moonPre = Math.min(moonPre, Math.hypot(s.r[0] - m[0], s.r[1] - m[1], s.r[2] - m[2]));
      }
    }
    const rCapPeri = R_M + spec.capture.periAltKm;
    const rCapApo = R_M + spec.capture.apoAltKm;
    const vCapture = Math.sqrt(MU_M * (2 / rCapPeri - 2 / (rCapPeri + rCapApo)));
    const pole = moonEquatorRotor(Epoch.fromTT(tLoi)).apply([0, 0, 1]);
    return {
      converged: cur.mis1 < 1 && cur.mis2 < 1,
      ...extra,
      preFlybyMismatchKm: +cur.mis1.toFixed(3),
      postFlybyMismatchKm: +cur.mis2.toFixed(3),
      departureOrbitKm: `${spec.perigeeAltKm} × ${Math.round(x[0] * 1e5 - R_E).toLocaleString("en")}`,
      departureInclinationDeg: +(x[1] / DEG).toFixed(2),
      perigeeAt: iso(tDep - x[4] * 60),
      distanceAtFirstManeuverKm: Math.round(cur.m1),
      publishedFirstManeuver: `${spec.firstManeuver.distanceKm.toLocaleString("en")} km (16 s burn, not modeled)`,
      correctionManeuverMs: +(cur.dv1 * 1000).toFixed(1),
      correctionAt: iso(tC),
      preFlybyClosestEarthKm: Math.round(close.km),
      preFlybyClosestEarthAt: iso(close.t),
      postFlybyClosestEarthKm: Math.round(post.km),
      postFlybyClosestEarthAt: iso(post.t),
      earthLoopsBeforeFlyby: loopsPre,
      closestMoonBeforeFlybyKm: Math.round(moonPre),
      flybyVInfinityKms: +Math.sqrt(Math.max(0, x[9] * x[9] - (2 * MU_M) / rFb)).toFixed(3),
      maxEarthDistanceKm: Math.round(cur.apoKm),
      maxEarthDistanceAt: iso(cur.apoT),
      publishedMaxDistance: `${spec.apogee.distanceKm.toLocaleString("en")} km, reached by ${spec.apogee.by.slice(0, 10)}`,
      deepSpaceManeuverMs: +(cur.dv2 * 1000).toFixed(1),
      maneuverAt: iso(tDsmOf(x[12])),
      totalTransferDvMs: +((cur.dv1 + cur.dv2) * 1000).toFixed(1),
      loiDeltaVToCaptureMs: Math.round((x[11] - vCapture) * 1000),
      arrivalInclinationDeg: +(Math.acos(Math.max(-1, Math.min(1, dot(n, pole)))) / DEG).toFixed(2),
      lunarPasses: lunarPasses(samples),
    };
  }

  return {
    times: { tDep, tM1, tFb, tLoi, apoBy },
    tCorrOf,
    tDsmOf,
    deployState,
    flyState,
    arrivalState,
    runTo,
    residual,
    clampX,
    lm,
    line,
    trajectory,
    report,
  };
}

/** Continuation from given starting solutions: moves the published targets in gradually. */
export function reconstructJoint(spec: JointSpec, x0: number[], log: (s: string) => void = () => {}) {
  const P = createJointProblem(spec);
  const steps = spec.steps ?? 8;
  const capFinal = (spec.correctionCapMs ?? 50) / 1000;
  const r0 = P.residual(P.clampX([...x0]), 1, { m1: 0, apo: 0, cap: 10, dv1Scale: 0.2 });
  if (!r0) throw new Error("starting solutions do not propagate");
  const tgAt = (s: number): Targets => ({
    m1: r0.m1 + s * (spec.firstManeuver.distanceKm - r0.m1),
    apo: r0.apoKm + s * (spec.apogee.distanceKm - r0.apoKm),
    cap: r0.dv1 + s * (capFinal - r0.dv1),
    dv1Scale: 0.2,
  });
  log(`  start: ${P.line(r0, x0)}`);

  const z1 = P.lm(x0, 1000, 30, tgAt(0));
  const z2 = z1 ? P.lm(z1.x, 1, 30, tgAt(0)) : null;
  if (!z2) throw new Error("joint problem could not be re-converged at the start");
  let x = z2.x;
  let best = z2.cur.mis1 < 1 && z2.cur.mis2 < 1 ? { x, cur: z2.cur, step: 0 } : null;
  log(`  step 0/${steps}: ${P.line(z2.cur, x)}`);
  for (let k = 1; k <= steps; k++) {
    const r = P.lm(x, 1, 30, tgAt(k / steps));
    if (!r) {
      log(`  step ${k}/${steps}: failed (a leg hit a body or escaped)`);
      continue;
    }
    x = r.x;
    const ok = r.cur.mis1 < 1 && r.cur.mis2 < 1;
    log(`  step ${k}/${steps}: ${P.line(r.cur, x)}${ok ? "" : "  (junctions open)"}`);
    if (ok) best = { x, cur: r.cur, step: k };
  }
  if (!best) throw new Error("no step kept both junctions closed");
  const samples = P.trajectory(best.x);
  return {
    report: P.report(best.x, best.cur, samples, { continuationStepKept: `${best.step} of ${steps}` }),
    samples,
    x: best.x,
  };
}
