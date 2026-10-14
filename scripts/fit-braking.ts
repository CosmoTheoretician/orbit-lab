import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gstime } from "satellite.js";
import { BODIES } from "../src/core/bodies";
import { Epoch } from "../src/core/time";
import { moonAt, moonVelocityAt } from "../src/orbit/cislunar";
import { MISSIONS } from "../src/missions/catalog";
import { lunarOps } from "../src/missions/lunarOps";
import { sampleTrack, type Track } from "../src/missions/track";
import type { Sample } from "../src/missions/horizons";
import { C, compare, hm, loadCamras, plotSvg, rmsOf, trackFromSamples, utc, type Pt, type Row } from "./lib/camras";

/**
 * Resilience's braking and final descent, fitted to Dwingeloo's Doppler with the link model found by the
 * two-way test (coherent before the occultation and after 18:31, one-way 18:18–18:31). Starts from the
 * stage-1 coast at 18:45; impact at the LRO site at the measured loss of signal.
 */
type V3 = [number, number, number];
interface Station {
  name: string;
  lat: number;
  lon: number;
  h: number;
}
const DW: Station = { name: "Dwingeloo", lat: 52.8122, lon: 6.3964, h: 0.025 };
const UPLINKS: Station[] = [
  { name: "ESA Cebreros", lat: 40.4527, lon: -4.3676, h: 0.794 },
  { name: "ESA Redu", lat: 50.0019, lon: 5.1453, h: 0.39 },
  { name: "ESA Kiruna", lat: 67.8571, lon: 20.9643, h: 0.402 },
  { name: "ESA Kourou", lat: 5.2514, lon: -52.8047, h: 0.015 },
];
const MU = BODIES.moon.gm;
const R_SURF = 1737.4;
const V_FLOOR = 0.05;
const SIGMA_DOP = 10;
const MISSING_MS = 200;
const LIGHT_S = 1.3;
const DEG = Math.PI / 180;
const OMEGA_E = 7.2921150e-5;
const WA = 6378.137;
const WF = 1 / 298.257223563;
const CHECK = { utc: "2025-06-05T19:15:27Z", altKm: 0.192, speedMs: 42 };
const T = (hms: string) => Date.parse(`2025-06-05T${hms.length === 5 ? hms + ":00" : hms}Z`) / 1000;
const ONE_WAY: [number, number] = [T("18:15"), T("18:31")];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: V3) => scale(a, 1 / norm(a));
const isoS = (u: number) => new Date(Math.round(u) * 1000).toISOString().replace(".000Z", "Z");

// ---------- link model ----------
function stationState(st: Station, unixS: number): { r: V3; v: V3; up: V3 } {
  const lat = st.lat * DEG;
  const lon = st.lon * DEG;
  const e2 = WF * (2 - WF);
  const N = WA / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const x = (N + st.h) * Math.cos(lat) * Math.cos(lon);
  const y = (N + st.h) * Math.cos(lat) * Math.sin(lon);
  const z = (N * (1 - e2) + st.h) * Math.sin(lat);
  const g = gstime(new Date(unixS * 1000));
  const r: V3 = [Math.cos(g) * x - Math.sin(g) * y, Math.sin(g) * x + Math.cos(g) * y, z];
  return { r, v: [-OMEGA_E * r[1], OMEGA_E * r[0], 0], up: [Math.cos(lat) * Math.cos(lon + g), Math.cos(lat) * Math.sin(lon + g), Math.sin(lat)] };
}
function linkRangeRate(track: Track, uplink: Station) {
  const pos = (tt: number): V3 | null => {
    const p = sampleTrack(track, tt, [0, 0, 0]);
    return p ? [p[0], p[1], p[2]] : null;
  };
  const scState = (tt: number) => {
    const p = pos(tt);
    const a = pos(tt - 0.5);
    const b = pos(tt + 0.5);
    return p && a && b ? { p, v: sub(b, a) } : null;
  };
  const los = (st: Station, u: number, sc: { p: V3; v: V3 }) => {
    const g = stationState(st, u);
    const d = sub(sc.p, g.r);
    const rho = norm(d);
    return { rr: dot(d, sub(sc.v, g.v)) / rho, el: Math.asin(dot(d, g.up) / rho) / DEG, rho };
  };
  return (u: number): number | null => {
    const ttRx = Epoch.fromUnixMs(u * 1000).tt;
    let tau = 1.3;
    let sc: { p: V3; v: V3 } | null = null;
    for (let i = 0; i < 3; i++) {
      sc = scState(ttRx - tau);
      if (!sc) return null;
      tau = norm(sub(sc.p, stationState(DW, u).r)) / C;
    }
    if (!sc) return null;
    const down = los(DW, u, sc);
    if (u >= ONE_WAY[0] && u < ONE_WAY[1]) return down.rr;
    const up = los(uplink, u - tau - down.rho / C, sc);
    return up.el < 5 ? null : down.rr + up.rr;
  };
}

// ---------- data, site, starting state ----------
const m = MISSIONS.find((x) => x.id === "resilience");
if (!m?.lunarOps || !m.site) throw new Error("Resilience spec not found");
const cam = await loadCamras(undefined, { stitchSidebands: true });
const tImpactTarget = cam.los - LIGHT_S;
const ops = lunarOps({ ...m.lunarOps, landing: isoS(tImpactTarget) }, m.site.lat, m.site.lon);
const siteVec = scale(unit(ops.siteDir as V3), R_SURF);

const coast = JSON.parse(await readFile("validation/out/resilience-coast.json", "utf8")) as { samples: Sample[] };
const tS = T("18:45");
const tt0 = Epoch.fromUnixMs(tS * 1000).tt;
const i0 = coast.samples.reduce((b, s, i) => (Math.abs(s.t - tt0) < Math.abs(coast.samples[b].t - tt0) ? i : b), 0);
const s0 = coast.samples[i0];
const mp0 = moonAt(s0.t) as V3;
const mv0 = moonVelocityAt(s0.t) as V3;
const y0 = Float64Array.from([...sub(s0.r as V3, mp0), ...sub(s0.v as V3, mv0)]);
console.log(`start ${utc(tS)} from the stage-1 coast: altitude ${(norm([y0[0], y0[1], y0[2]]) - R_SURF).toFixed(1)} km, speed ${(norm([y0[3], y0[4], y0[5]]) * 1000).toFixed(0)} m/s`);

const tEnd = cam.los + 5;
const N = Math.ceil(tEnd - tS);
const ttGrid = Array.from({ length: N + 1 }, (_, i) => Epoch.fromUnixMs((tS + i) * 1000).tt);
const moonP = ttGrid.map((tt) => moonAt(tt) as V3);
const moonV = ttGrid.map((tt) => moonVelocityAt(tt) as V3);

// ---------- dynamics ----------
/** x = [brake start s after 18:45, brake m/s², pitch start °, pitch end °, final phase s after 18:45, final m/s², final pitch °] */
const NAMES = ["brake start", "brake accel", "brake pitch 0", "brake pitch 1", "final start", "final accel", "final pitch"];
const UNITS = ["", "m/s²", "°", "°", "", "m/s²", "°"];
interface Params {
  tb: number;
  a1: number;
  g1a: number;
  g1b: number;
  t2: number;
  a2: number;
  g2: number;
}
const P = (x: number[]): Params => ({ tb: tS + x[0], a1: x[1] / 1000, g1a: x[2] * DEG, g1b: x[3] * DEG, t2: tS + x[4], a2: x[5] / 1000, g2: x[6] * DEG });
const k1 = new Float64Array(6);
const k2 = new Float64Array(6);
const k3 = new Float64Array(6);
const k4 = new Float64Array(6);
const tmp = new Float64Array(6);
function deriv(y: Float64Array, a: number, g: number, out: Float64Array) {
  const r2 = y[0] * y[0] + y[1] * y[1] + y[2] * y[2];
  const r = Math.sqrt(r2);
  const kk = -MU / (r2 * r);
  let ax = kk * y[0];
  let ay = kk * y[1];
  let az = kk * y[2];
  if (a > 0) {
    const sp = Math.hypot(y[3], y[4], y[5]);
    if (sp > V_FLOOR) {
      const c = Math.cos(g) / sp;
      const s = Math.sin(g) / r;
      let dx = -c * y[3] + s * y[0];
      let dy = -c * y[4] + s * y[1];
      let dz = -c * y[5] + s * y[2];
      const dn = Math.hypot(dx, dy, dz);
      ax += (a * dx) / dn;
      ay += (a * dy) / dn;
      az += (a * dz) / dn;
    } else {
      ax = 0;
      ay = 0;
      az = 0;
    }
  }
  out[0] = y[3];
  out[1] = y[4];
  out[2] = y[5];
  out[3] = ax;
  out[4] = ay;
  out[5] = az;
}
function rk4(y: Float64Array, h: number, a: number, g: number) {
  deriv(y, a, g, k1);
  for (let i = 0; i < 6; i++) tmp[i] = y[i] + 0.5 * h * k1[i];
  deriv(tmp, a, g, k2);
  for (let i = 0; i < 6; i++) tmp[i] = y[i] + 0.5 * h * k2[i];
  deriv(tmp, a, g, k3);
  for (let i = 0; i < 6; i++) tmp[i] = y[i] + h * k3[i];
  deriv(tmp, a, g, k4);
  for (let i = 0; i < 6; i++) y[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
}
function thrustAt(tc: number, p: Params): [number, number] {
  if (tc >= p.t2) return [p.a2, p.g2];
  if (tc >= p.tb) return [p.a1, p.g1a + ((tc - p.tb) / (p.t2 - p.tb)) * (p.g1b - p.g1a)];
  return [0, 0];
}
function advance(y: Float64Array, t: number, p: Params) {
  const events = [p.tb, p.t2].filter((e) => e > t && e <= t + 1).sort((a, b) => a - b);
  let tc = t;
  for (const e of events) {
    if (e > tc) rk4(y, e - tc, ...thrustAt(tc, p));
    tc = e;
  }
  if (t + 1 > tc) rk4(y, t + 1 - tc, ...thrustAt(tc, p));
}

interface Sim {
  samples: Sample[];
  alt: number[];
  speed: number[];
  vz: number[];
  endT: number;
  endPos: V3;
  impactSpeed: number;
  tFloor: number | null;
}
function simulate(p: Params): Sim | null {
  const y = Float64Array.from(y0);
  const samples: Sample[] = [];
  const alt: number[] = [];
  const speed: number[] = [];
  const vz: number[] = [];
  let tFloor: number | null = null;
  for (let i = 0; i < N; i++) {
    const t = tS + i;
    samples.push({
      t: ttGrid[i],
      r: [moonP[i][0] + y[0], moonP[i][1] + y[1], moonP[i][2] + y[2]],
      v: [moonV[i][0] + y[3], moonV[i][1] + y[4], moonV[i][2] + y[5]],
    });
    const rPrev = Math.hypot(y[0], y[1], y[2]);
    alt.push(rPrev - R_SURF);
    speed.push(Math.hypot(y[3], y[4], y[5]) * 1000);
    vz.push(((y[0] * y[3] + y[1] * y[4] + y[2] * y[5]) / rPrev) * 1000);
    const prev = Float64Array.from(y);
    advance(y, t, p);
    if (tFloor === null && t >= p.t2 && Math.hypot(y[3], y[4], y[5]) < V_FLOOR) tFloor = t + 1;
    const r = Math.hypot(y[0], y[1], y[2]);
    if (!Number.isFinite(r) || r > 5000) return null;
    if (r < R_SURF) {
      const f = (rPrev - R_SURF) / (rPrev - r);
      const pos: V3 = [prev[0] + f * (y[0] - prev[0]), prev[1] + f * (y[1] - prev[1]), prev[2] + f * (y[2] - prev[2])];
      return { samples, alt, speed, vz, endT: t + f, endPos: pos, impactSpeed: Math.hypot(y[3], y[4], y[5]) * 1000, tFloor };
    }
  }
  return { samples, alt, speed, vz, endT: tEnd, endPos: [y[0], y[1], y[2]], impactSpeed: 0, tFloor };
}

// ---------- residuals ----------
const segs: Row[][] = cam.segs.map((s) => s.filter((r) => r.t >= tS)).filter((s) => s.length >= 10);
const pts = segs.flat();
const index = new Map(pts.map((r, i) => [r.t, i]));
interface Eval {
  F: number[];
  out: Pt[];
  sim: Sim;
}
function evaluate(x: number[], uplink = UPLINKS[0]): Eval | null {
  const p = P(x);
  if (p.tb < tS + 60 || p.t2 < p.tb + 30) return null;
  const sim = simulate(p);
  if (!sim) return null;
  const c = compare(linkRangeRate(trackFromSamples(sim.samples), uplink), segs);
  const F = new Array(pts.length + 4).fill(MISSING_MS / SIGMA_DOP);
  for (const q of c.out) F[index.get(q.t)!] = q.resMs / SIGMA_DOP;
  const miss = sub(sim.endPos, siteVec);
  F[pts.length] = miss[0];
  F[pts.length + 1] = miss[1];
  F[pts.length + 2] = miss[2];
  F[pts.length + 3] = (sim.endT - tImpactTarget) / 5;
  return { F, out: c.out, sim };
}
const cost = (e: Eval) => e.F.reduce((s, f) => s + f * f, 0);

function solve(A: number[][], b: number[]): number[] | null {
  const k = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-15) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[k] / row[i]);
}
const H = [1, 0.001, 0.01, 0.01, 1, 0.001, 0.01];
function clampX(x: number[]) {
  x[0] = Math.max(60, x[0]);
  x[1] = Math.min(6, Math.max(0.3, x[1]));
  x[5] = Math.min(6, Math.max(0, x[5]));
  for (const i of [2, 3, 6]) x[i] = Math.min(90, Math.max(-30, x[i]));
  x[4] = Math.max(x[0] + 30, x[4]);
  return x;
}
function jacobian(x: number[], cur: Eval) {
  const J: number[][] = Array.from({ length: cur.F.length }, () => new Array(7).fill(0));
  for (let j = 0; j < 7; j++) {
    const xp = [...x];
    xp[j] += H[j];
    const e = evaluate(xp);
    if (!e) return null;
    for (let i = 0; i < cur.F.length; i++) J[i][j] = (e.F[i] - cur.F[i]) / H[j];
  }
  return J;
}
const normalEq = (J: number[][], F: number[]) => ({
  JTJ: Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) => J.reduce((s, row) => s + row[i] * row[j], 0))),
  JTF: Array.from({ length: 7 }, (_, i) => J.reduce((s, row, r) => s + row[i] * F[r], 0)),
});
function lm(x0: number[], iters: number) {
  let x = clampX([...x0]);
  let cur = evaluate(x);
  if (!cur) return null;
  let lambda = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J = jacobian(x, cur);
    if (!J) break;
    const { JTJ, JTF } = normalEq(J, cur.F);
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const Aug = JTJ.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (JTJ[i][i] || 1) : 0)));
      const step = solve(Aug, JTF.map((g) => -g));
      if (step) {
        const xn = clampX(x.map((xi, j) => xi + step[j]));
        const en = evaluate(xn);
        if (en && cost(en) < cost(cur)) {
          x = xn;
          cur = en;
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

// ---------- grid and refinement ----------
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
const rel = (hhmm: string) => T(hhmm) - tS;
const grid: Array<{ x: number[]; c: number }> = [];
for (const tb of ["18:55", "18:58", "19:00", "19:02", "19:04", "19:06"]) {
  for (const durMin of [3, 5, 7, 9]) {
    for (const a1 of [1.5, 2, 2.5, 3]) {
      for (const g1a of [0, 20]) {
        for (const g1b of [20, 50]) {
          for (const a2 of [1, 1.6, 2.2]) {
            for (const g2 of [70, 90]) {
              const x = [rel(tb), a1, g1a, g1b, rel(tb) + durMin * 60, a2, g2];
              const e = evaluate(x);
              if (e) grid.push({ x, c: cost(e) });
            }
          }
        }
      }
    }
  }
}
grid.sort((a, b) => a.c - b.c);
console.log(`grid: ${grid.length} combinations (${secs()})`);

const finals: Array<{ x: number[]; cur: Eval }> = [];
for (const [i, g] of grid.slice(0, 5).entries()) {
  const r = lm(g.x, 40);
  if (!r) continue;
  finals.push(r);
  const p = P(r.x);
  console.log(
    `  start ${i + 1}: RMS ${rmsOf(r.cur.out).toFixed(1)} m/s, braking ${hm(p.tb)} at ${(p.a1 * 1000).toFixed(2)} m/s², final ${hm(p.t2)}, ` +
      `impact ${hm(r.cur.sim.endT)} at ${r.cur.sim.impactSpeed.toFixed(0)} m/s, ${norm(sub(r.cur.sim.endPos, siteVec)).toFixed(2)} km from site`,
  );
}
if (!finals.length) throw new Error("no fit converged");
finals.sort((a, b) => cost(a.cur) - cost(b.cur));
const { x, cur } = finals[0];
const p = P(x);
const sim = cur.sim;

const sig = new Array(7).fill(NaN);
const J = jacobian(x, cur);
if (J) {
  const { JTJ } = normalEq(J, cur.F);
  const s2 = cost(cur) / Math.max(1, cur.F.length - 7);
  for (let j = 0; j < 7; j++) {
    const col = solve(JTJ, Array.from({ length: 7 }, (_, i) => (i === j ? 1 : 0)));
    if (col) sig[j] = Math.sqrt(Math.max(0, col[j] * s2));
  }
}
const good = finals.filter((f) => cost(f.cur) < 1.5 * cost(cur));
const spread = x.map((_, j) => (good.length > 1 ? Math.max(...good.map((f) => f.x[j])) - Math.min(...good.map((f) => f.x[j])) : NaN));

console.log(`\nFitted braking and final descent (${secs()}); ± formal 1σ, [spread across ${good.length} comparable refinements]:`);
for (let j = 0; j < 7; j++) {
  const val = j === 0 || j === 4 ? utc(tS + x[j]) : x[j].toFixed(2);
  console.log(`  ${NAMES[j].padEnd(14)} ${String(val).padEnd(22)} ± ${Number.isFinite(sig[j]) ? sig[j].toFixed(2) : "?"} ${UNITS[j] || "s"}  [${Number.isFinite(spread[j]) ? spread[j].toFixed(2) : "-"}]`);
}
const tFl = sim.tFloor ?? sim.endT;
console.log(`\n  braking Δv ≈ ${(Math.max(0, Math.min(p.t2, sim.endT) - p.tb) * p.a1 * 1000).toFixed(0)} m/s, final phase Δv ≈ ${(Math.max(0, tFl - p.t2) * p.a2 * 1000).toFixed(0)} m/s`);
console.log(`  impact ${utc(sim.endT)} at ${sim.impactSpeed.toFixed(0)} m/s, ${norm(sub(sim.endPos, siteVec)).toFixed(2)} km from the LRO site`);
console.log(`  RMS ${rmsOf(cur.out).toFixed(1)} m/s: coast ${rmsOf(cur.out.filter((q) => q.t < p.tb)).toFixed(1)}, braking ${rmsOf(cur.out.filter((q) => q.t >= p.tb && q.t < p.t2)).toFixed(1)}, final ${rmsOf(cur.out.filter((q) => q.t >= p.t2)).toFixed(1)} m/s`);

console.log("\n  time      altitude      speed   vertical");
const times = ["18:45", "18:50", "18:55", "19:00", "19:02", "19:04", "19:06", "19:08", "19:10", "19:12", "19:14", "19:15", "19:15:20", "19:15:27"];
for (const hh of times) {
  const i = Math.round(T(hh) - tS);
  if (i >= 0 && i < sim.alt.length) {
    const alt = sim.alt[i] < 10 ? `${(sim.alt[i] * 1000).toFixed(0)} m` : `${sim.alt[i].toFixed(1)} km`;
    console.log(`  ${hh.padEnd(9)} ${alt.padStart(9)}  ${sim.speed[i].toFixed(0).padStart(6)} m/s  ${sim.vz[i].toFixed(0).padStart(6)} m/s`);
  }
}
const ic = Math.round(T(CHECK.utc.slice(11, 19)) - tS);
console.log(
  ic < sim.alt.length
    ? `  check vs ispace's last telemetry (${CHECK.utc.slice(11, 19)}): model ${(sim.alt[ic] * 1000).toFixed(0)} m at ${sim.speed[ic].toFixed(0)} m/s, ispace ${CHECK.altKm * 1000} m at ${CHECK.speedMs} m/s`
    : `  check vs ispace's last telemetry: the model had already impacted`,
);

console.log("\n  sensitivity to the assumed uplink station (same fitted descent):");
for (const st of UPLINKS) {
  const e = evaluate(x, st);
  console.log(`    ${st.name.padEnd(14)} RMS ${e ? rmsOf(e.out).toFixed(1) : "-"} m/s`);
}

// ---------- whole pass: coast before 18:45 + fitted descent, link model throughout ----------
const full = [...coast.samples.filter((s) => s.t < tt0), ...sim.samples];
const whole = compare(linkRangeRate(trackFromSamples(full), UPLINKS[0]), cam.segs);
console.log("\n  whole pass with the link model:");
for (const [a, b, label] of [["17:13", "17:31", "orbit, two-way"], ["18:18", "18:31", "coast, one-way"], ["18:31", "19:00", "coast, two-way"], ["19:00", "19:16", "descent, two-way"]] as const) {
  const part = whole.out.filter((q) => q.t >= T(a) && q.t < T(b));
  console.log(`    ${a}–${b} ${label.padEnd(18)} RMS ${part.length ? rmsOf(part).toFixed(1) : "-"} m/s over ${part.length} points`);
}

await mkdir("validation/out", { recursive: true });
await writeFile(
  "validation/out/resilience-final.json",
  JSON.stringify({
    fit: Object.fromEntries(NAMES.map((nm, j) => [nm, { value: x[j], sigma: sig[j], spread: spread[j] }])),
    impact: utc(sim.endT),
    impactSpeedMs: sim.impactSpeed,
    samples: full,
  }),
);
await writeFile(
  "validation/out/camras-final.svg",
  plotSvg(whole.out, cam.segs.length, "Whole pass: coast + fitted descent, link model (two-way / one-way / two-way)", [
    { t: ONE_WAY[1], label: "uplink lock" },
    { t: p.tb, label: "braking" },
    { t: p.t2, label: "final phase" },
    { t: cam.los, label: "LOS" },
  ]),
);
console.log("\nwritten validation/out/resilience-final.json and camras-final.svg");
