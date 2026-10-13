import { BODIES, type Vec3 } from "../core/bodies";
import { Epoch } from "../core/time";
import { cislunarDeriv, moonAt, moonVelocityAt } from "../orbit/cislunar";
import { integrate } from "../orbit/integrator";
import { solveKepler } from "../orbit/kepler";
import type { Sample } from "./horizons";

const R_M = BODIES.moon.equatorialRadius;
const R_E = BODIES.earth.equatorialRadius;
const MU_E = BODIES.earth.gm;
const DEG = Math.PI / 180;

const tt = (iso: string) => Epoch.fromUnixMs(Date.parse(iso)).tt;
const iso = (t: number) => Epoch.fromTT(t).toDate().toISOString().slice(0, 19) + "Z";
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3) => scale(a, 1 / norm(a));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface DepartureSpec {
  launch: string;
  deployment: string;
  /** Perigee altitude of the departure orbit (upper-stage trans-lunar-style burn). */
  perigeeAltKm: number;
  /** Published first maneuver: time and distance from Earth (a check on the departure orbit). */
  firstManeuver: { time: string; distanceKm: number };
  /** Window in which the pre-flyby correction may fall. */
  correctionWindow: [string, string];
  /** Lunar flyby periapsis: time and altitude. */
  flyby: { time: string; altitudeKm: number };
  /** Flyby parameters from the low-energy solution: [direction RA, Dec, motion angle, speed km/s]. */
  flybyX: number[];
}

interface State {
  r: Vec3;
  v: Vec3;
  maxEarthKm: number;
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
 * Deployment → lunar flyby with one correction maneuver, Earth–Moon–Sun model.
 * Forward leg: from deployment on an ellipse with fixed perigee altitude (unknown apogee, plane,
 * argument of perigee, perigee time). Backward leg: from the flyby state of the low-energy solution.
 * The correction time floats within a window. Goals: legs meet in position, the correction is small,
 * and the distance from Earth at the published first maneuver matches.
 */
export function reconstructDeparture(spec: DepartureSpec, log: (s: string) => void = () => {}) {
  const tLaunch = tt(spec.launch);
  const tDep = tt(spec.deployment);
  const tM1 = tt(spec.firstManeuver.time);
  const dM1 = spec.firstManeuver.distanceKm;
  const tLo = tt(spec.correctionWindow[0]);
  const tHi = tt(spec.correctionWindow[1]);
  const tFb = tt(spec.flyby.time);
  const rp = R_E + spec.perigeeAltKm;
  const tPeriLo = tLaunch + 30 * 60;
  const tPeriHi = tDep - 10 * 60;
  const tPeriOf = (tau: number) => tPeriLo + clamp01(tau) * (tPeriHi - tPeriLo);
  const tCorrOf = (sigma: number) => tLo + clamp01(sigma) * (tHi - tLo);

  // Flyby periapsis state: same construction as the low-energy solver
  const rFb = R_M + spec.flyby.altitudeKm;
  const mFb = moonAt(tFb);
  const mvFb = moonVelocityAt(tFb);
  const [fa, fd, fb, fv] = spec.flybyX;
  const u: Vec3 = [Math.cos(fd) * Math.cos(fa), Math.cos(fd) * Math.sin(fa), Math.sin(fd)];
  let f1 = cross([0, 0, 1], u);
  if (norm(f1) < 1e-6) f1 = cross([1, 0, 0], u);
  f1 = unit(f1);
  const f2 = cross(u, f1);
  const vd = add(scale(f1, Math.cos(fb)), scale(f2, Math.sin(fb)));
  const yFb = Float64Array.from([...add(mFb, scale(u, rFb)), ...add(mvFb, scale(vd, fv))]);

  /** Deployment state, x = [apogee radius / 1e5 km, i, RAAN, arg. of perigee, perigee-time fraction, ...]. */
  function deployState(x: number[]): Float64Array {
    const ra = x[0] * 1e5;
    const [inc, raan, argp] = [x[1], x[2], x[3]];
    const a = (rp + ra) / 2;
    const e = (ra - rp) / (ra + rp);
    const E = solveKepler(Math.sqrt(MU_E / a ** 3) * (tDep - tPeriOf(x[4])), e);
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

  /** Integrates through a list of times (in the direction of travel). Null on Earth/Moon impact or escape. */
  function runTo(y0: Float64Array, tStart: number, times: number[], samples?: Sample[]): State[] | null {
    let y = y0;
    let t = tStart;
    let maxE = 0;
    let dead = false;
    const out: State[] = [];
    for (const tNext of times) {
      const res = integrate(cislunarDeriv, t, y, tNext, {
        onStep: (ts, ys) => {
          samples?.push({ t: ts, r: [ys[0], ys[1], ys[2]], v: [ys[3], ys[4], ys[5]] });
          const rE = Math.hypot(ys[0], ys[1], ys[2]);
          maxE = Math.max(maxE, rE);
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
      out.push({ r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]], maxEarthKm: maxE });
    }
    return out;
  }

  // ---------- grid: departure orbits vs the backward leg at checkpoints in the window ----------
  const K = 8;
  const sigmas = Array.from({ length: K }, (_, k) => k / (K - 1));
  const checkTimes = sigmas.map(tCorrOf);
  const back = runTo(yFb, tFb, [...checkTimes].reverse());
  if (!back) throw new Error("backward leg from the flyby hit a body or escaped");
  const B = back.reverse(); // index k matches checkTimes[k]

  const t0 = Date.now();
  const best: Array<{ s: number; xa: number[]; k: number }> = [];
  let count = 0;
  for (const raKm of [400_000, 600_000, 800_000, 1_100_000, 1_500_000]) {
    for (const iDeg of [30, 40, 50, 60]) {
      for (let oDeg = 0; oDeg < 360; oDeg += 15) {
        for (let wDeg = 0; wDeg < 360; wDeg += 20) {
          const xa = [raKm / 1e5, iDeg * DEG, oDeg * DEG, wDeg * DEG, 0.5];
          const st = runTo(deployState(xa), tDep, [tM1, ...checkTimes]);
          if (++count % 1000 === 0) log(`  departure orbits ${count}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
          if (!st) continue;
          const m1 = Math.abs(norm(st[0].r) - dM1) / 50_000;
          for (let k = 0; k < K; k++) {
            const A = st[1 + k];
            const s = norm(sub(A.r, B[k].r)) / 20_000 + norm(sub(A.v, B[k].v)) / 0.2 + m1;
            if (best.length < 20 || s < best[best.length - 1].s) {
              best.push({ s, xa, k });
              best.sort((p, q) => p.s - q.s);
              if (best.length > 20) best.pop();
            }
          }
        }
      }
    }
  }
  if (best.length === 0) throw new Error("no departure orbit survived to the correction window");
  log(`  ${count} departure orbits, best pairing score ${best[0].s.toFixed(3)}`);

  // ---------- refinement: x = [ra/1e5, i, RAAN, argp, tau (perigee time), sigma (correction time)] ----------
  const cache = new Map<string, { A: State; B: State; dM1: number } | null>();
  function legs(x: number[]) {
    const key = x.join(",");
    if (!cache.has(key)) {
      if (cache.size > 20000) cache.clear();
      const tC = tCorrOf(x[5]);
      const A = runTo(deployState(x), tDep, [tM1, tC]);
      const Bk = runTo(yFb, tFb, [tC]);
      cache.set(key, A && Bk ? { A: A[1], B: Bk[0], dM1: norm(A[0].r) } : null);
    }
    return cache.get(key)!;
  }

  interface Res {
    F: number[];
    drKm: number;
    dvKms: number;
    dM1Km: number;
  }
  function residual(x: number[], wPosKm: number): Res | null {
    const l = legs(x);
    if (!l) return null;
    const dr = sub(l.A.r, l.B.r);
    const dv = sub(l.A.v, l.B.v);
    const F = [...scale(dr, 1 / wPosKm), ...scale(dv, 1 / 0.02), (l.dM1 - dM1) / 5_000];
    return { F, drKm: norm(dr), dvKms: norm(dv), dM1Km: l.dM1 };
  }
  const cost = (r: Res) => r.F.reduce((s, f) => s + f * f, 0);

  function lm(x0: number[], wPosKm: number, iters: number) {
    let x = [...x0];
    let cur = residual(x, wPosKm);
    if (!cur) return null;
    const nx = x.length;
    let lambda = 1e-3;
    const h = [1e-6, 1e-6, 1e-6, 1e-6, 1e-5, 1e-5];
    for (let it = 0; it < iters; it++) {
      const m = cur.F.length;
      const J: number[][] = Array.from({ length: m }, () => new Array(nx).fill(0));
      let bad = false;
      for (let j = 0; j < nx; j++) {
        const xp = [...x];
        xp[j] += h[j];
        const rp2 = residual(xp, wPosKm);
        if (!rp2) {
          bad = true;
          break;
        }
        for (let i = 0; i < m; i++) J[i][j] = (rp2.F[i] - cur.F[i]) / h[j];
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
          xn[0] = Math.max(xn[0], 0.7);
          xn[4] = clamp01(xn[4]);
          xn[5] = clamp01(xn[5]);
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
  const score = (r: Res) => r.dvKms * 1000 + Math.abs(r.dM1Km - dM1) / 10_000;
  for (const [i, p] of best.slice(0, 10).entries()) {
    const r1 = lm([...p.xa, sigmas[p.k]], 1000, 40);
    const r2 = r1 ? lm(r1.x, 1, 40) : null;
    if (!r2) continue;
    log(
      `  start ${i + 1}: mismatch ${r2.cur.drKm.toFixed(3)} km, correction ${(r2.cur.dvKms * 1000).toFixed(1)} m/s ` +
        `on ${iso(tCorrOf(r2.x[5])).slice(0, 10)}, distance at first maneuver ${Math.round(r2.cur.dM1Km).toLocaleString("en")} km`,
    );
    const ok = r2.cur.drKm < 1;
    const solOk = sol ? sol.cur.drKm < 1 : false;
    if (!sol || (ok && !solOk) || (ok === solOk && score(r2.cur) < score(sol.cur))) sol = r2;
  }
  if (!sol) throw new Error("no feasible departure found");
  const x = sol.x;
  const tC = tCorrOf(x[5]);

  // ---------- final legs with samples ----------
  const y0 = deployState(x);
  const sa: Sample[] = [];
  const sb: Sample[] = [];
  runTo(y0, tDep, [tC], sa);
  runTo(yFb, tFb, [tC], sb);
  const samples: Sample[] = [{ t: tDep, r: [y0[0], y0[1], y0[2]], v: [y0[3], y0[4], y0[5]] }, ...sa, ...sb.reverse()];
  const maxEarth = samples.reduce((m, s) => Math.max(m, norm(s.r)), 0);

  const report = {
    converged: sol.cur.drKm < 1,
    positionMismatchKm: +sol.cur.drKm.toFixed(3),
    departureOrbitKm: `${spec.perigeeAltKm} × ${Math.round(x[0] * 1e5 - R_E).toLocaleString("en")}`,
    departureInclinationDeg: +(x[1] / DEG).toFixed(2),
    perigeeAt: iso(tPeriOf(x[4])),
    distanceAtFirstManeuverKm: Math.round(sol.cur.dM1Km),
    publishedFirstManeuver: `${dM1.toLocaleString("en")} km on ${spec.firstManeuver.time.slice(0, 16).replace("T", " ")} UTC (16 s burn, not modeled)`,
    correctionManeuverMs: +(sol.cur.dvKms * 1000).toFixed(1),
    correctionAt: iso(tC),
    maxEarthDistanceBeforeFlybyKm: Math.round(maxEarth),
  };
  return { report, samples, x };
}
