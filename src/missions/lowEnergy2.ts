import { BODIES, type Vec3 } from "../core/bodies";
import { Epoch } from "../core/time";
import { cislunarDeriv, moonAt, moonVelocityAt } from "../orbit/cislunar";
import { integrate } from "../orbit/integrator";
import type { Sample } from "./horizons";
import type { LowEnergySpec } from "./lowEnergy";

const R_M = BODIES.moon.equatorialRadius;
const R_E = BODIES.earth.equatorialRadius;

const tt = (iso: string) => Epoch.fromUnixMs(Date.parse(iso)).tt;
const iso = (t: number) => Epoch.fromTT(t).toDate().toISOString().slice(0, 19) + "Z";
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3) => scale(a, 1 / norm(a));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface TwoBurnSpec extends LowEnergySpec {
  /** Window for the first correction after the flyby. */
  burn1Window: [string, string];
}

interface State {
  r: Vec3;
  v: Vec3;
  maxEarthKm: number;
  tMaxEarth: number;
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
 * Refines a one-maneuver low-energy solution by adding a correction after the flyby.
 * x = [a, d, b, vFlyby, theta, vArrival, tau2, tau1, dv1x, dv1y, dv1z]:
 * flyby → (maneuver 1 at tau1) → (maneuver 2 at tau2) ← LOI.
 * Residuals: position match at maneuver 2, both maneuvers (minimized), published apogee.
 * Runs once per apogee weight, warm-starting each run from the previous one.
 */
export function refineTwoBurns(spec: TwoBurnSpec, x7: number[], apogeeTargetsKm: number[], log: (s: string) => void = () => {}) {
  const tFb = tt(spec.flyby.time);
  const t2Lo = tt(spec.dsmWindow[0]);
  const t2Hi = tt(spec.dsmWindow[1]);
  const t1Lo = tt(spec.burn1Window[0]);
  const t1Hi = tt(spec.burn1Window[1]);
  const tLoi = tt(spec.loi.time);
  const rFb = R_M + spec.flyby.altitudeKm;
  const rArr = R_M + spec.loi.periAltKm;
  let apoKm = spec.apogee?.distanceKm ?? 0;
  const apoBy = spec.apogee ? tt(spec.apogee.by) : 0;
  const t2Of = (tau: number) => t2Lo + clamp01(tau) * (t2Hi - t2Lo);
  const t1Of = (tau: number) => t1Lo + clamp01(tau) * (t1Hi - t1Lo);

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

  function arrivalState(theta: number, va: number): Float64Array {
    const p = add(scale(e1, Math.cos(theta)), scale(e2, Math.sin(theta)));
    return Float64Array.from([...add(mLoi, scale(p, rArr)), ...add(mvLoi, scale(cross(n, p), va))]);
  }

  function runTo(y0: Float64Array, tStart: number, tEnd: number, samples?: Sample[]): State | null {
    let maxE = 0;
    let tMaxE = tStart;
    let dead = false;
    const res = integrate(cislunarDeriv, tStart, y0, tEnd, {
      onStep: (t, y) => {
        samples?.push({ t, r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]] });
        const rE = Math.hypot(y[0], y[1], y[2]);
        if (rE > maxE) {
          maxE = rE;
          tMaxE = t;
        }
        if (rE < R_E || rE > 5e6) {
          dead = true;
          return true;
        }
        if (Math.abs(t - tStart) > 3600) {
          const m = moonAt(t);
          if (Math.hypot(y[0] - m[0], y[1] - m[1], y[2] - m[2]) < R_M) {
            dead = true;
            return true;
          }
        }
        return false;
      },
    });
    if (dead) return null;
    return { r: [res.y[0], res.y[1], res.y[2]], v: [res.y[3], res.y[4], res.y[5]], maxEarthKm: maxE, tMaxEarth: tMaxE };
  }

  interface Legs {
    A2: State;
    B: State;
    apoKm: number;
    apoT: number;
  }
  const cache = new Map<string, Legs | null>();
  function legs(x: number[]): Legs | null {
    const key = x.join(",");
    if (!cache.has(key)) {
      if (cache.size > 20000) cache.clear();
      const t1 = t1Of(x[7]);
      const t2 = t2Of(x[6]);
      let out: Legs | null = null;
      const A1 = runTo(flybyState(x[0], x[1], x[2], x[3]), tFb, t1);
      if (A1) {
        const y1 = Float64Array.from([...A1.r, ...add(A1.v, [x[8], x[9], x[10]])]);
        const A2 = runTo(y1, t1, t2);
        const B = runTo(arrivalState(x[4], x[5]), tLoi, t2);
        if (A2 && B) {
          const cands = [A1, A2, B].map((s) => ({ km: s.maxEarthKm, t: s.tMaxEarth }));
          const ap = cands.reduce((p, q) => (q.km > p.km ? q : p));
          out = { A2, B, apoKm: ap.km, apoT: ap.t };
        }
      }
      cache.set(key, out);
    }
    return cache.get(key)!;
  }

  interface Res {
    F: number[];
    drKm: number;
    dv1Ms: number;
    dv2Ms: number;
    apoKm: number;
    apoT: number;
  }
  function residual(x: number[], wPosKm: number, wApoKm: number): Res | null {
    const l = legs(x);
    if (!l) return null;
    const dr = sub(l.A2.r, l.B.r);
    const dv2 = sub(l.A2.v, l.B.v);
    const dv1: Vec3 = [x[8], x[9], x[10]];
    const F = [...scale(dr, 1 / wPosKm), ...scale(dv2, 1 / 0.02), ...scale(dv1, 1 / 0.02)];
    if (apoKm) F.push((l.apoKm - apoKm) / wApoKm, Math.max(0, l.apoT - apoBy) / (3 * 86400));
    return { F, drKm: norm(dr), dv1Ms: norm(dv1) * 1000, dv2Ms: norm(dv2) * 1000, apoKm: l.apoKm, apoT: l.apoT };
  }
  const cost = (r: Res) => r.F.reduce((s, f) => s + f * f, 0);

  function lm(x0: number[], wPosKm: number, wApoKm: number, iters: number) {
    let x = [...x0];
    let cur = residual(x, wPosKm, wApoKm);
    if (!cur) return null;
    const nx = x.length;
    let lambda = 1e-3;
    const h = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-5, 1e-5, 1e-6, 1e-6, 1e-6];
    for (let it = 0; it < iters; it++) {
      const m = cur.F.length;
      const J: number[][] = Array.from({ length: m }, () => new Array(nx).fill(0));
      let bad = false;
      for (let j = 0; j < nx; j++) {
        const xp = [...x];
        xp[j] += h[j];
        const rp = residual(xp, wPosKm, wApoKm);
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
          xn[7] = clamp01(xn[7]);
          const rn = residual(xn, wPosKm, wApoKm);
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

  // Warm start from the one-maneuver solution: no first correction yet, placed mid-window
  let x = [...x7.slice(0, 6), x7[6], 0.5, 0, 0, 0];
  const results: Array<{ wApoKm: number; x: number[]; res: Res; t1: number; t2: number }> = [];
  for (const target of apogeeTargetsKm) {
    apoKm = target;
    const wApoKm = 5_000;
    const r1 = lm(x, 1000, wApoKm, 40);
    const r2 = r1 ? lm(r1.x, 1, wApoKm, 40) : null;
    if (!r2) {
      log(`  apogee weight ${wApoKm.toLocaleString("en")} km: refinement failed`);
      break;
    }
    x = r2.x;
    const t1 = t1Of(x[7]);
    const t2 = t2Of(x[6]);
    results.push({ wApoKm, x: [...x], res: r2.cur, t1, t2 });
    log(
      `  target ${target.toLocaleString("en").padStart(9)} km: ` +
        `burn 1 ${r2.cur.dv1Ms.toFixed(1).padStart(6)} m/s on ${iso(t1).slice(0, 10)}, ` +
        `burn 2 ${r2.cur.dv2Ms.toFixed(1).padStart(6)} m/s on ${iso(t2).slice(0, 10)}, ` +
        `total ${(r2.cur.dv1Ms + r2.cur.dv2Ms).toFixed(1).padStart(6)} m/s, ` +
        `max distance ${Math.round(r2.cur.apoKm).toLocaleString("en")} km on ${iso(r2.cur.apoT).slice(0, 10)}, ` +
        `mismatch ${r2.cur.drKm.toFixed(3)} km`,
    );
  }

  /** Full flyby → LOI trajectory for a solution, with both maneuvers applied. */
  function samplesFor(xs: number[]): Sample[] {
    const t1 = t1Of(xs[7]);
    const t2 = t2Of(xs[6]);
    const s1: Sample[] = [];
    const s2: Sample[] = [];
    const sb: Sample[] = [];
    const A1 = runTo(flybyState(xs[0], xs[1], xs[2], xs[3]), tFb, t1, s1)!;
    runTo(Float64Array.from([...A1.r, ...add(A1.v, [xs[8], xs[9], xs[10]])]), t1, t2, s2);
    runTo(arrivalState(xs[4], xs[5]), tLoi, t2, sb);
    return [...s1, ...s2, ...sb.reverse()];
  }

  return { results, samplesFor };
}
