import { BODIES, type Vec3 } from "../core/bodies";
import { moonEquatorRotor } from "../core/rotation";
import { Epoch } from "../core/time";
import { cislunarDeriv, moonAt, moonVelocityAt } from "../orbit/cislunar";
import { integrate } from "../orbit/integrator";
import type { Sample } from "./horizons";

const R_M = BODIES.moon.equatorialRadius;
const MU_M = BODIES.moon.gm;
const R_E = BODIES.earth.equatorialRadius;
const DEG = Math.PI / 180;

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

export interface LowEnergySpec {
  launch: string;
  /** Closest approach of the lunar flyby: time and altitude above the surface. */
  flyby: { time: string; altitudeKm: number };
  /** Window in which the last deep-space maneuver may fall; the two legs meet there. */
  dsmWindow: [string, string];
  /** Published farthest distance from Earth, and the date by which it had been reached. */
  apogee?: { distanceKm: number; by: string };
  /** Lunar orbit insertion: time and perilune altitude. */
  loi: { time: string; periAltKm: number };
  /** Capture orbit after insertion (for the LOI Δv). */
  capture: { periAltKm: number; apoAltKm: number };
  /** Normal of the lunar orbit plane (scene axes), from the lunar-operations model. */
  planeNormal: Vec3;
}

interface State {
  r: Vec3;
  v: Vec3;
  maxEarthKm: number;
  tMaxEarth: number;
}

/** Small dense linear solve (Gaussian elimination with partial pivoting). */
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
 * Low-energy leg from a lunar flyby to lunar orbit insertion with one deep-space maneuver,
 * in the Earth–Moon–Sun model. Leg A runs forward from the flyby periapsis (published time and
 * altitude; unknown direction, motion and speed). Leg B runs backward from the LOI perilune
 * (published time and altitude, in the lunar-operations orbit plane; unknown phase and speed).
 * The maneuver time floats within a window. Goals: legs meet in position, the maneuver is small,
 * and (if given) the farthest distance from Earth matches the published value and date.
 */
export function reconstructLowEnergy(spec: LowEnergySpec, log: (s: string) => void = () => {}) {
  const tFb = tt(spec.flyby.time);
  const tLo = tt(spec.dsmWindow[0]);
  const tHi = tt(spec.dsmWindow[1]);
  const tLoi = tt(spec.loi.time);
  const tLaunch = tt(spec.launch);
  const rFb = R_M + spec.flyby.altitudeKm;
  const rArr = R_M + spec.loi.periAltKm;
  const apoKm = spec.apogee?.distanceKm;
  const apoBy = spec.apogee ? tt(spec.apogee.by) : 0;
  const tDsmOf = (tau: number) => tLo + clamp01(tau) * (tHi - tLo);

  // Orbit plane basis for the arrival
  const n = unit(spec.planeNormal);
  let e1 = cross(n, [0, 0, 1]);
  if (norm(e1) < 1e-6) e1 = cross(n, [1, 0, 0]);
  e1 = unit(e1);
  const e2 = cross(n, e1);

  const mFb = moonAt(tFb);
  const mvFb = moonVelocityAt(tFb);
  const mLoi = moonAt(tLoi);
  const mvLoi = moonVelocityAt(tLoi);

  function flybyState(a: number, d: number, b: number, v: number): Float64Array {
    const u: Vec3 = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
    let f1 = cross([0, 0, 1], u);
    if (norm(f1) < 1e-6) f1 = cross([1, 0, 0], u);
    f1 = unit(f1);
    const f2 = cross(u, f1);
    const vd = add(scale(f1, Math.cos(b)), scale(f2, Math.sin(b)));
    return Float64Array.from([...add(mFb, scale(u, rFb)), ...add(mvFb, scale(vd, v))]);
  }

  /** Perilune at LOI: in the orbit plane, moving prograde (angular momentum along n). */
  function arrivalState(theta: number, va: number): Float64Array {
    const p = add(scale(e1, Math.cos(theta)), scale(e2, Math.sin(theta)));
    return Float64Array.from([...add(mLoi, scale(p, rArr)), ...add(mvLoi, scale(cross(n, p), va))]);
  }

  /**
   * Integrates through a list of times (in the direction of travel), returning the state at each,
   * with the farthest distance from Earth so far. Null if it hits Earth or the Moon, or escapes.
   */
  function runTo(y0: Float64Array, tStart: number, times: number[], samples?: Sample[]): State[] | null {
    let y = y0;
    let t = tStart;
    let maxE = 0;
    let tMaxE = tStart;
    let dead = false;
    const out: State[] = [];
    for (const tNext of times) {
      const res = integrate(cislunarDeriv, t, y, tNext, {
        onStep: (ts, ys) => {
          samples?.push({ t: ts, r: [ys[0], ys[1], ys[2]], v: [ys[3], ys[4], ys[5]] });
          const rE = Math.hypot(ys[0], ys[1], ys[2]);
          if (rE > maxE) {
            maxE = rE;
            tMaxE = ts;
          }
          if (rE < R_E || rE > 5e6) {
            dead = true;
            return true;
          }
          if (Math.abs(ts - tStart) > 3600) {
            const m = moonAt(ts);
            if (Math.hypot(ys[0] - m[0], ys[1] - m[1], ys[2] - m[2]) < R_M) {
              dead = true;
              return true;
            }
          }
          return false;
        },
      });
      if (dead) return null;
      y = res.y;
      t = tNext;
      out.push({ r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]], maxEarthKm: maxE, tMaxEarth: tMaxE });
    }
    return out;
  }

  /** Farthest distance over both legs, and how far the result is from the published apogee. */
  function apogeeOf(A: State, B: State) {
    const m = A.maxEarthKm >= B.maxEarthKm ? { km: A.maxEarthKm, t: A.tMaxEarth } : { km: B.maxEarthKm, t: B.tMaxEarth };
    return m;
  }

  // ---------- grids: states at checkpoints across the maneuver window ----------
  const K = 6;
  const taus = Array.from({ length: K }, (_, k) => k / (K - 1));
  const checkTimes = taus.map(tDsmOf);

  const t0 = Date.now();
  const gridA: Array<{ xa: number[]; states: State[] }> = [];
  let count = 0;
  for (let aDeg = 0; aDeg < 360; aDeg += 15) {
    for (let dDeg = -75; dDeg <= 75; dDeg += 15) {
      for (let bDeg = 0; bDeg < 360; bDeg += 45) {
        for (const v of [1.25, 1.35, 1.45, 1.55, 1.65, 1.75, 1.85]) {
          const xa = [aDeg * DEG, dDeg * DEG, bDeg * DEG, v];
          const states = runTo(flybyState(xa[0], xa[1], xa[2], xa[3]), tFb, checkTimes);
          if (states && states[K - 1].maxEarthKm > 700_000) gridA.push({ xa, states });
          if (++count % 1000 === 0) log(`  forward legs ${count}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        }
      }
    }
  }
  const gridB: Array<{ xb: number[]; states: State[] }> = [];
  const backTimes = [...checkTimes].reverse();
  for (let thDeg = 0; thDeg < 360; thDeg += 10) {
    for (let va = 2.33; va <= 2.63; va += 0.03) {
      const st = runTo(arrivalState(thDeg * DEG, va), tLoi, backTimes);
      if (st) gridB.push({ xb: [thDeg * DEG, va], states: st.reverse() }); // index k matches checkTimes[k]
    }
  }
  log(`  ${gridA.length} forward legs (reaching > 700,000 km) and ${gridB.length} backward legs across the window`);

  // Pair forward and backward legs at each checkpoint, ranking by mismatch and (if given) the published apogee
  const best: Array<{ s: number; ia: number; ib: number; k: number }> = [];
  for (let ia = 0; ia < gridA.length; ia++) {
    for (let ib = 0; ib < gridB.length; ib++) {
      for (let k = 0; k < K; k++) {
        const A = gridA[ia].states[k];
        const B = gridB[ib].states[k];
        let s = norm(sub(A.r, B.r)) / 20000 + norm(sub(A.v, B.v)) / 0.2;
        if (apoKm) {
          const ap = apogeeOf(A, B);
          s += Math.abs(ap.km - apoKm) / 50_000 + Math.max(0, ap.t - apoBy) / (10 * 86400);
        }
        if (best.length < 20 || s < best[best.length - 1].s) {
          best.push({ s, ia, ib, k });
          best.sort((p, q) => p.s - q.s);
          if (best.length > 20) best.pop();
        }
      }
    }
  }
  log(`  best pairing score ${best[0].s.toFixed(3)}`);

  // ---------- refinement: x = [a, d, b, vFlyby, theta, vArrival, tau] ----------
  const cache = new Map<string, { A: State; B: State } | null>();
  function legs(x: number[]) {
    const key = x.join(",");
    if (!cache.has(key)) {
      if (cache.size > 20000) cache.clear();
      const tD = tDsmOf(x[6]);
      const A = runTo(flybyState(x[0], x[1], x[2], x[3]), tFb, [tD]);
      const B = runTo(arrivalState(x[4], x[5]), tLoi, [tD]);
      cache.set(key, A && B ? { A: A[0], B: B[0] } : null);
    }
    return cache.get(key)!;
  }

  interface Res {
    F: number[];
    drKm: number;
    dvKms: number;
    apoKm: number;
    apoT: number;
  }
  function residual(x: number[], wPosKm: number): Res | null {
    const l = legs(x);
    if (!l) return null;
    const dr = sub(l.A.r, l.B.r);
    const dv = sub(l.A.v, l.B.v);
    const ap = apogeeOf(l.A, l.B);
    const F = [...scale(dr, 1 / wPosKm), ...scale(dv, 1 / 0.02)];
    if (apoKm) F.push((ap.km - apoKm) / 10_000, Math.max(0, ap.t - apoBy) / (3 * 86400));
    return { F, drKm: norm(dr), dvKms: norm(dv), apoKm: ap.km, apoT: ap.t };
  }
  const cost = (r: Res) => r.F.reduce((s, f) => s + f * f, 0);

  /** Levenberg–Marquardt over all residuals (leg mismatch, maneuver, published apogee). */
  function lm(x0: number[], wPosKm: number, iters: number) {
    let x = [...x0];
    let cur = residual(x, wPosKm);
    if (!cur) return null;
    const nx = x.length;
    let lambda = 1e-3;
    const h = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-5];
    for (let it = 0; it < iters; it++) {
      const m = cur.F.length;
      const J: number[][] = Array.from({ length: m }, () => new Array(nx).fill(0));
      let bad = false;
      for (let j = 0; j < nx; j++) {
        const xp = [...x];
        xp[j] += h[j];
        const rp = residual(xp, wPosKm);
        if (!rp) {
          bad = true;
          break;
        }
        for (let i = 0; i < m; i++) J[i][j] = (rp.F[i] - cur.F[i]) / h[j];
      }
      if (bad) break;
      const JTJ = Array.from({ length: nx }, (_, i) => Array.from({ length: nx }, (_, j) => J.reduce((s, row) => s + row[i] * row[j], 0)));
      const JTF = Array.from({ length: nx }, (_, i) => J.reduce((s, row, k) => s + row[i] * cur!.F[k], 0));
      let improved = false;
      for (let tries = 0; tries < 10; tries++) {
        const Aug = JTJ.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (JTJ[i][i] || 1) : 0)));
        const step = solve(Aug, JTF.map((g) => -g));
        if (step) {
          const xn = x.map((xi, j) => xi + step[j]);
          xn[6] = clamp01(xn[6]);
          const rn = residual(xn, wPosKm);
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

  let sol: { x: number[]; cur: Res } | null = null;
  const score = (r: Res) => r.dvKms * 1000 + (apoKm ? Math.abs(r.apoKm - apoKm) / 1_000 + Math.max(0, r.apoT - apoBy) / 86400 : 0);
  for (const [i, p] of best.slice(0, 10).entries()) {
    const x0 = [...gridA[p.ia].xa, ...gridB[p.ib].xb, taus[p.k]];
    const r1 = lm(x0, 1000, 40);
    const r2 = r1 ? lm(r1.x, 1, 40) : null;
    if (!r2) continue;
    log(
      `  start ${i + 1}: mismatch ${r2.cur.drKm.toFixed(3)} km, maneuver ${(r2.cur.dvKms * 1000).toFixed(1)} m/s ` +
        `on ${iso(tDsmOf(r2.x[6])).slice(0, 10)}, max distance ${Math.round(r2.cur.apoKm).toLocaleString("en")} km on ${iso(r2.cur.apoT).slice(0, 10)}`,
    );
    const ok = r2.cur.drKm < 1;
    const solOk = sol ? sol.cur.drKm < 1 : false;
    if (!sol || (ok && !solOk) || (ok === solOk && score(r2.cur) < score(sol.cur))) sol = r2;
  }
  if (!sol) throw new Error("no feasible pair found");
  const x = sol.x;
  const tDsm = tDsmOf(x[6]);

  // ---------- final legs with samples ----------
  const sa: Sample[] = [];
  const sb: Sample[] = [];
  const A = runTo(flybyState(x[0], x[1], x[2], x[3]), tFb, [tDsm], sa)![0];
  const B = runTo(arrivalState(x[4], x[5]), tLoi, [tDsm], sb)![0];
  const post = [...sa, ...sb.reverse()];

  // Pre-flyby diagnostic: backward from the flyby to the launch date
  let minEarth = Infinity;
  let tMinEarth = tFb;
  const pre: Sample[] = [];
  integrate(cislunarDeriv, tFb, flybyState(x[0], x[1], x[2], x[3]), tLaunch, {
    onStep: (t, y) => {
      pre.push({ t, r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]] });
      const rE = Math.hypot(y[0], y[1], y[2]);
      if (rE < minEarth) {
        minEarth = rE;
        tMinEarth = t;
      }
      return rE < R_E;
    },
  });

  // ---------- report ----------
  const rCapPeri = R_M + spec.capture.periAltKm;
  const rCapApo = R_M + spec.capture.apoAltKm;
  const vCapture = Math.sqrt(MU_M * (2 / rCapPeri - 2 / (rCapPeri + rCapApo)));
  const pole = moonEquatorRotor(Epoch.fromTT(tLoi)).apply([0, 0, 1]);
  const ap = apogeeOf(A, B);
  const report = {
    converged: sol.cur.drKm < 1,
    positionMismatchKm: +sol.cur.drKm.toFixed(3),
    deepSpaceManeuverMs: +(sol.cur.dvKms * 1000).toFixed(1),
    maneuverAt: iso(tDsm),
    maxEarthDistanceKm: Math.round(ap.km),
    maxEarthDistanceAt: iso(ap.t),
    publishedMaxDistance: apoKm ? `${apoKm.toLocaleString("en")} km, reached by ${spec.apogee!.by.slice(0, 10)}` : "n/a",
    flybyPeriapsisDirDeg: `${(x[0] / DEG).toFixed(2)}, ${(x[1] / DEG).toFixed(2)}`,
    flybyMotionAngleDeg: +(x[2] / DEG).toFixed(2),
    flybySpeedKms: +x[3].toFixed(4),
    flybyVInfinityKms: +Math.sqrt(Math.max(0, x[3] * x[3] - (2 * MU_M) / rFb)).toFixed(3),
    arrivalSpeedKms: +x[5].toFixed(4),
    arrivalVInfinityKms: +Math.sqrt(Math.max(0, x[5] * x[5] - (2 * MU_M) / rArr)).toFixed(3),
    loiDeltaVToCaptureMs: Math.round((x[5] - vCapture) * 1000),
    arrivalInclinationDeg: +(Math.acos(Math.max(-1, Math.min(1, dot(n, pole)))) / DEG).toFixed(2),
    flybyToLoiDays: +((tLoi - tFb) / 86400).toFixed(2),
    preFlybyClosestEarthKm: Math.round(minEarth),
    preFlybyClosestEarthAt: iso(tMinEarth),
  };
  return { report, post, pre: pre.reverse(), x };
}

/** Unit perilune direction at LOI for phase theta in the plane with the given normal (same basis as the solver). */
export function arrivalDirection(normal: Vec3, theta: number): Vec3 {
  const n = unit(normal);
  let e1 = cross(n, [0, 0, 1]);
  if (norm(e1) < 1e-6) e1 = cross(n, [1, 0, 0]);
  e1 = unit(e1);
  const e2 = cross(n, e1);
  return add(scale(e1, Math.cos(theta)), scale(e2, Math.sin(theta)));
}
