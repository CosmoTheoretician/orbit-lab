import { mkdir, writeFile } from "node:fs/promises";
import { BODIES } from "../src/core/bodies";
import { moonEquatorRotor } from "../src/core/rotation";
import { Epoch } from "../src/core/time";
import { moonAt, moonVelocityAt } from "../src/orbit/cislunar";
import { MISSIONS } from "../src/missions/catalog";
import { lunarOps } from "../src/missions/lunarOps";
import type { Sample } from "../src/missions/horizons";
import { compare, hm, loadCamras, makeRangeRate, plotSvg, rmsOf, trackFromSamples, utc, type Pt, type Row } from "./lib/camras";
import { C } from "./lib/camras";
import { gstime } from "satellite.js";
import { sampleTrack, type Track } from "../src/missions/track";

/**
 * Resilience's landing sequence fitted to Dwingeloo's X-band Doppler, following ispace's published
 * profile: deorbit from ~100 km, coast toward ~20 km, main-engine braking, near-vertical final phase,
 * impact at the LRO site at the measured loss of signal. The orbit plane is rotated about the site
 * (heading free). Point-mass Moon, numerical integration at 1 s.
 */
const MU = BODIES.moon.gm;
const R_SURF = 1737.4;
const V_FLOOR = 0.03; // below this the engine only holds the speed (must allow ispace's 42 m/s)
const SIGMA_DOP = 10;
const MISSING_MS = 200;
const LIGHT_S = 1.3;
const DEG = Math.PI / 180;
const PRIOR = { orbitAltKm: [100, 10], doiPeriAltKm: [20, 5] } as const; // ispace: ~100 km orbit, braking from ~20 km
const T45 = Date.parse("2025-06-05T18:45:00Z") / 1000;
const AHEAD_KM: [number, number] = [1200, 3200]; // impact site ahead along track at 18:45
const BRAKE_ALT_KM: [number, number] = [20, 3]; // ispace: main-engine braking began at ~20 km
const TELEM = { altKm: 0.192, speedMs: 42, beforeImpactS: 5 }; // ispace: last telemetry 192 m, 42 m/s
const CHECK = { utc: "2025-06-05T19:15:27Z", altKm: 0.192, speedMs: 42 }; // ispace cause analysis: last telemetry

const m = MISSIONS.find((x) => x.id === "resilience");
if (!m?.lunarOps || !m.site) throw new Error("Resilience spec not found");
const site = m.site;

const cam = await loadCamras(undefined, { stitchSidebands: true });
const tImpactTarget = cam.los - LIGHT_S;
const CUT = Date.parse("2025-06-05T18:29:30Z") / 1000;
console.log(`Dwingeloo data: ${cam.segs.flat().length} points in ${cam.segs.length} stretches (${cam.stitched} sideband switches joined)`);
console.log(`Impact target: LRO site at ${utc(tImpactTarget)}`);

// ---------- geometry ----------
type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subV = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V) => scale(a, 1 / norm(a));
const isoS = (u: number) => new Date(Math.round(u) * 1000).toISOString().replace(".000Z", "Z");

const ops = lunarOps({ ...m.lunarOps, landing: isoS(tImpactTarget) }, site.lat, site.lon);
const n0 = unit(ops.normal as V);
const sDir = unit(ops.siteDir as V);
const siteVec = scale(sDir, R_SURF);
const pole = moonEquatorRotor(Epoch.fromUnixMs(tImpactTarget * 1000)).apply([0, 0, 1]) as V;

/** Orbit plane rotated about the impact-site direction by psi (deg): the site stays in the plane. */
function basis(psiDeg: number) {
  const c = Math.cos(psiDeg * DEG);
  const s = Math.sin(psiDeg * DEG);
  const nn = unit(add(add(scale(n0, c), scale(cross(sDir, n0), s)), scale(sDir, dot(sDir, n0) * (1 - c))));
  const b1 = unit(subV(sDir, scale(nn, dot(sDir, nn))));
  return { nn, b1, b2: cross(nn, b1) };
}
const inclinationDeg = (psiDeg: number) => Math.acos(Math.max(-1, Math.min(1, dot(basis(psiDeg).nn, pole)))) / DEG;

/** Distance along the track from the lander to the impact site, in the direction of motion (km). */
function aheadKm(s: { r: V; v: V }): number {
  const nh = unit(cross(s.r, s.v));
  const sp = unit(subV(sDir, scale(nh, dot(sDir, nh))));
  const rh = unit(s.r);
  let a = Math.atan2(dot(cross(rh, sp), nh), dot(rh, sp));
  if (a < 0) a += 2 * Math.PI;
  return a * R_SURF;
}

// ---------- time grid ----------
const tRef = Date.parse("2025-06-05T17:10:00Z") / 1000;
const tEnd = cam.los + 5;
const N = Math.ceil(tEnd - tRef);
const ttGrid = Array.from({ length: N + 1 }, (_, i) => Epoch.fromUnixMs((tRef + i) * 1000).tt);
const moonP = ttGrid.map((tt) => moonAt(tt) as V);
const moonV = ttGrid.map((tt) => moonVelocityAt(tt) as V);

// ---------- parameters ----------
/** x = [alt km, phase rad, radial m/s, deorbit s, deorbit Δv m/s, brake s, brake m/s², pitch0 °, pitch1 °, approach s, approach m/s², approach pitch °, plane heading °] */
const NAMES = ["orbit alt", "phase", "radial speed", "deorbit", "deorbit Δv", "brake start", "brake accel", "brake pitch 0", "brake pitch 1", "approach start", "approach accel", "approach pitch", "plane heading"];
const UNITS = ["km", "rad", "m/s", "s", "m/s", "s", "m/s²", "°", "°", "s", "m/s²", "°", "°"];
interface Params {
  h0: number; th0: number; vr0: number; td: number; dvd: number;
  tb: number; a1: number; g1a: number; g1b: number; t2: number; a2: number; g2: number; psi: number;
}
const P = (x: number[]): Params => ({
  h0: x[0], th0: x[1], vr0: x[2] / 1000, td: tRef + x[3], dvd: x[4] / 1000,
  tb: tRef + x[5], a1: x[6] / 1000, g1a: x[7] * DEG, g1b: x[8] * DEG, t2: tRef + x[9], a2: x[10] / 1000, g2: x[11] * DEG, psi: x[12],
});

// ---------- dynamics ----------
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
      dx /= dn;
      dy /= dn;
      dz /= dn;
      ax += a * dx;
      ay += a * dy;
      az += a * dz;
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
/** Lowest altitude of the osculating orbit right after the deorbit burn. */
let doiPeri = NaN;
function advance(y: Float64Array, t: number, p: Params) {
  const events = [p.td, p.tb, p.t2].filter((e) => e > t && e <= t + 1).sort((a, b) => a - b);
  let tc = t;
  for (const e of events) {
    if (e > tc) rk4(y, e - tc, ...thrustAt(tc, p));
    if (e === p.td) {
      const sp = Math.hypot(y[3], y[4], y[5]);
      for (let i = 3; i < 6; i++) y[i] -= (p.dvd * y[i]) / sp;
      const r: V = [y[0], y[1], y[2]];
      const v: V = [y[3], y[4], y[5]];
      const rr = norm(r);
      const a = -MU / (2 * (dot(v, v) / 2 - MU / rr));
      const hh = norm(cross(r, v));
      const e = Math.sqrt(Math.max(0, 1 - (hh * hh) / (MU * a)));
      doiPeri = a * (1 - e) - R_SURF;
    }
    tc = e;
  }
  if (t + 1 > tc) rk4(y, t + 1 - tc, ...thrustAt(tc, p));
}

interface Sim {
  samples: Sample[];
  alt: number[];
  speed: number[];
  endT: number;
  endPos: V;
  impactSpeed: number;
  tFloor: number | null;
  doiPeri: number;
  rel45: { r: V; v: V } | null;
}
function simulate(p: Params): Sim | null {
  const { b1, b2 } = basis(p.psi);
  const r0 = R_SURF + p.h0;
  const rh = add(scale(b1, Math.cos(p.th0)), scale(b2, Math.sin(p.th0)));
  const th = add(scale(b1, -Math.sin(p.th0)), scale(b2, Math.cos(p.th0)));
  const y = Float64Array.from([...scale(rh, r0), ...add(scale(th, Math.sqrt(MU / r0)), scale(rh, p.vr0))]);
  const samples: Sample[] = [];
  const alt: number[] = [];
  const speed: number[] = [];
  let tFloor: number | null = null;
  doiPeri = NaN;
  let rel45: { r: V; v: V } | null = null;
  for (let i = 0; i < N; i++) {
    const t = tRef + i;
    samples.push({
      t: ttGrid[i],
      r: [moonP[i][0] + y[0], moonP[i][1] + y[1], moonP[i][2] + y[2]],
      v: [moonV[i][0] + y[3], moonV[i][1] + y[4], moonV[i][2] + y[5]],
    });
    const rPrev = Math.hypot(y[0], y[1], y[2]);
    alt.push(rPrev - R_SURF);
    speed.push(Math.hypot(y[3], y[4], y[5]) * 1000);
    if (tRef + i === T45) rel45 = { r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]] };
    const prev = Float64Array.from(y);
    advance(y, t, p);
    if (tFloor === null && t >= p.t2 && Math.hypot(y[3], y[4], y[5]) < V_FLOOR) tFloor = t + 1;
    const r = Math.hypot(y[0], y[1], y[2]);
    if (!Number.isFinite(r) || r > 5000) return null;
    if (r < R_SURF) {
      const f = (rPrev - R_SURF) / (rPrev - r);
      const pos: V = [prev[0] + f * (y[0] - prev[0]), prev[1] + f * (y[1] - prev[1]), prev[2] + f * (y[2] - prev[2])];
      return { samples, alt, speed, endT: t + f, endPos: pos, impactSpeed: Math.hypot(y[3], y[4], y[5]) * 1000, tFloor, doiPeri, rel45 };
    }
  }
  return { samples, alt, speed, endT: tEnd, endPos: [y[0], y[1], y[2]], impactSpeed: 0, tFloor, doiPeri, rel45 };
}

// ---------- link model: two-way before the occultation and after 18:31, one-way 18:15–18:31 ----------
type LinkStation = { name: string; lat: number; lon: number; h: number };
const DW_ST: LinkStation = { name: "Dwingeloo", lat: 52.8122, lon: 6.3964, h: 0.025 };
const UPLINK: LinkStation = { name: "ESA Cebreros", lat: 40.4527, lon: -4.3676, h: 0.794 };
const ONE_WAY: [number, number] = [Date.parse("2025-06-05T18:15:00Z") / 1000, Date.parse("2025-06-05T18:31:00Z") / 1000];
function stationState(st: LinkStation, unixS: number): { r: V; v: V; up: V } {
  const lat = st.lat * DEG;
  const lon = st.lon * DEG;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const Nn = 6378.137 / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const x = (Nn + st.h) * Math.cos(lat) * Math.cos(lon);
  const y = (Nn + st.h) * Math.cos(lat) * Math.sin(lon);
  const z = (Nn * (1 - e2) + st.h) * Math.sin(lat);
  const g = gstime(new Date(unixS * 1000));
  const r: V = [Math.cos(g) * x - Math.sin(g) * y, Math.sin(g) * x + Math.cos(g) * y, z];
  const w = 7.2921150e-5;
  return { r, v: [-w * r[1], w * r[0], 0], up: [Math.cos(lat) * Math.cos(lon + g), Math.cos(lat) * Math.sin(lon + g), Math.sin(lat)] };
}
function linkRangeRate(track: Track, uplink: LinkStation) {
  const pos = (tt: number): V | null => {
    const q = sampleTrack(track, tt, [0, 0, 0]);
    return q ? [q[0], q[1], q[2]] : null;
  };
  const scState = (tt: number) => {
    const q = pos(tt);
    const a = pos(tt - 0.5);
    const b = pos(tt + 0.5);
    return q && a && b ? { p: q, v: subV(b, a) } : null;
  };
  const los = (st: LinkStation, u: number, sc: { p: V; v: V }) => {
    const g = stationState(st, u);
    const d = subV(sc.p, g.r);
    const rho = norm(d);
    return { rr: dot(d, subV(sc.v, g.v)) / rho, el: Math.asin(dot(d, g.up) / rho) / DEG, rho };
  };
  return (u: number): number | null => {
    const ttRx = Epoch.fromUnixMs(u * 1000).tt;
    let tau = 1.3;
    let sc: { p: V; v: V } | null = null;
    for (let i = 0; i < 3; i++) {
      sc = scState(ttRx - tau);
      if (!sc) return null;
      tau = norm(subV(sc.p, stationState(DW_ST, u).r)) / C;
    }
    if (!sc) return null;
    const down = los(DW_ST, u, sc);
    if (u >= ONE_WAY[0] && u < ONE_WAY[1]) return down.rr;
    const up = los(uplink, u - tau - down.rho / C, sc);
    return up.el < 5 ? null : down.rr + up.rr;
  };
}

// ---------- residuals ----------
interface Mode {
  segs: Row[][];
  index: Map<number, number>;
  count: number;
  impact: boolean;
}
function makeMode(segs: Row[][], impact: boolean): Mode {
  const pts = segs.flat();
  return { segs, index: new Map(pts.map((r, i) => [r.t, i])), count: pts.length, impact };
}
const PRE = makeMode(cam.segs.map((s) => s.filter((r) => r.t < CUT)).filter((s) => s.length >= 10), false);
const FULL = makeMode(cam.segs, true);

interface Eval {
  F: number[];
  out: Pt[];
  sim: Sim;
}
function evaluate(x: number[], mode: Mode): Eval | null {
  const p = P(x);
  if (p.tb < p.td + 60 || p.t2 < p.tb + 60) return null;
  const sim = simulate(p);
  if (!sim) return null;
  const c = compare(linkRangeRate(trackFromSamples(sim.samples), UPLINK), mode.segs);
  const extra = mode.impact ? 10 : 3;
  const F = new Array(mode.count + extra).fill(MISSING_MS / SIGMA_DOP);
  for (const q of c.out) F[mode.index.get(q.t)!] = q.resMs / SIGMA_DOP;
  let k = mode.count;
  F[k++] = (x[0] - PRIOR.orbitAltKm[0]) / PRIOR.orbitAltKm[1];
  F[k++] = Number.isFinite(sim.doiPeri) ? (sim.doiPeri - PRIOR.doiPeriAltKm[0]) / PRIOR.doiPeriAltKm[1] : 50;
  const ah = sim.rel45 ? aheadKm(sim.rel45) : NaN;
  F[k++] = !Number.isFinite(ah) ? 50 : ah < AHEAD_KM[0] ? (AHEAD_KM[0] - ah) / 300 : ah > AHEAD_KM[1] ? (ah - AHEAD_KM[1]) / 300 : 0;
  if (mode.impact) {
    const miss = subV(sim.endPos, siteVec);
    F[k++] = miss[0];
    F[k++] = miss[1];
    F[k++] = miss[2];
    F[k++] = (sim.endT - tImpactTarget) / 5;
    const ib = Math.round(P(x).tb - tRef);
    const il = Math.round(tImpactTarget - TELEM.beforeImpactS - tRef);
    F[k++] = ib >= 0 && ib < sim.alt.length ? (sim.alt[ib] - BRAKE_ALT_KM[0]) / BRAKE_ALT_KM[1] : 50;
    F[k++] = il >= 0 && il < sim.alt.length ? (sim.alt[il] - TELEM.altKm) / 0.05 : 50;
    F[k++] = il >= 0 && il < sim.speed.length ? (sim.speed[il] - TELEM.speedMs) / 10 : 50;
  }
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

const H = [0.01, 1e-5, 0.01, 1, 0.01, 1, 0.001, 0.01, 0.01, 1, 0.001, 0.01, 0.01];
function clampX(x: number[]) {
  x[0] = Math.min(200, Math.max(20, x[0]));
  x[4] = Math.min(200, Math.max(0, x[4]));
  x[6] = Math.min(6, Math.max(0.2, x[6]));
  x[10] = Math.min(6, Math.max(0, x[10]));
  for (const i of [7, 8, 11]) x[i] = Math.min(90, Math.max(-30, x[i]));
  x[12] = ((((x[12] + 180) % 360) + 360) % 360) - 180;
  return x;
}
function jacobian(x: number[], cur: Eval, free: number[], mode: Mode) {
  const J: number[][] = Array.from({ length: cur.F.length }, () => new Array(free.length).fill(0));
  for (const [jj, j] of free.entries()) {
    const xp = [...x];
    xp[j] += H[j];
    const e = evaluate(xp, mode);
    if (!e) return null;
    for (let i = 0; i < cur.F.length; i++) J[i][jj] = (e.F[i] - cur.F[i]) / H[j];
  }
  return J;
}
function normal(J: number[][], F: number[]) {
  const k = J[0].length;
  const JTJ = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => J.reduce((s, row) => s + row[i] * row[j], 0)));
  const JTF = Array.from({ length: k }, (_, i) => J.reduce((s, row, r) => s + row[i] * F[r], 0));
  return { JTJ, JTF };
}
function lm(x0: number[], free: number[], iters: number, mode: Mode) {
  let x = clampX([...x0]);
  let cur = evaluate(x, mode);
  if (!cur) return null;
  let lambda = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J = jacobian(x, cur, free, mode);
    if (!J) break;
    const { JTJ, JTF } = normal(J, cur.F);
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const Aug = JTJ.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (JTJ[i][i] || 1) : 0)));
      const step = solve(Aug, JTF.map((g) => -g));
      if (step) {
        const xn = [...x];
        free.forEach((j, jj) => (xn[j] += step[jj]));
        clampX(xn);
        const en = evaluate(xn, mode);
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

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
const at = (hhmm: string) => Date.parse(`2025-06-05T${hhmm}:00Z`) / 1000 - tRef;
const ALL = Array.from({ length: 13 }, (_, i) => i);
const ORBIT = [0, 1, 2, 3, 4, 12];
const DEFAULT_THRUST = [at("19:00"), 1.5, 0, 15, at("19:06"), 1.6, 85];

// ---------- stage 1: orbit, deorbit and plane heading from the data before 18:29:30 ----------
const stage1: Array<{ x: number[]; c: number }> = [];
for (let ph = 0; ph < 72; ph++) {
  for (const td of ["18:05", "18:10", "18:13", "18:16", "18:20"]) {
    for (let psi = -180; psi < 180; psi += 30) {
      const x = [100, ph * 5 * DEG, 0, at(td), 20, ...DEFAULT_THRUST, psi];
      const e = evaluate(x, PRE);
      if (e) stage1.push({ x, c: cost(e) });
    }
  }
}
stage1.sort((a, b) => a.c - b.c);
let orbit: { x: number[]; cur: Eval } | null = null;
for (const s of stage1.slice(0, 5)) {
  const r = lm(s.x, ORBIT, 30, PRE);
  if (r && (!orbit || cost(r.cur) < cost(orbit.cur))) orbit = r;
}
if (!orbit) throw new Error("stage 1 failed");
console.log(
  `stage 1: RMS ${rmsOf(orbit.cur.out).toFixed(1)} m/s, orbit ${orbit.x[0].toFixed(1)} km, deorbit ${hm(P(orbit.x).td)} with ${orbit.x[4].toFixed(1)} m/s ` +
    `→ lowest point ${orbit.cur.sim.doiPeri.toFixed(1)} km, site ${orbit.cur.sim.rel45 ? aheadKm(orbit.cur.sim.rel45).toFixed(0) : "?"} km ahead at 18:45, plane heading ${orbit.x[12].toFixed(1)}° (inclination ${inclinationDeg(orbit.x[12]).toFixed(1)}°) (${secs()})`,
);

// ---------- diagnostic: does a pure coast explain the data after the deorbit? ----------
{
  const coast = [...orbit.x.slice(0, 5), at("19:14"), 0.2, 0, 0, at("19:15"), 0, 0, orbit.x[12]];
  const e = evaluate(coast, FULL);
  if (e) {
    await mkdir("validation/out", { recursive: true });
    await writeFile("validation/out/resilience-coast.json", JSON.stringify({ orbit: orbit.x, samples: e.sim.samples }));
    console.log(`  diagnostic: pure coast after the fitted deorbit (lander ${e.sim.endT < tImpactTarget - 60 ? `hits the surface at ${hm(e.sim.endT)}` : "still flying at the end"}):`);
    for (const [a, b] of [["18:18", "18:30"], ["18:30", "18:45"], ["18:45", "19:00"], ["19:00", "19:16"]]) {
      const lo = Date.parse(`2025-06-05T${a}:00Z`) / 1000;
      const hi = Date.parse(`2025-06-05T${b}:00Z`) / 1000;
      const part = e.out.filter((q) => q.t >= lo && q.t < hi);
      console.log(`    ${a}–${b}: RMS ${part.length ? rmsOf(part).toFixed(1) : "-"} m/s over ${part.length} points`);
    }
  }
}

{
  const coastX = [...orbit.x.slice(0, 5), at("19:14"), 0.2, 0, 0, at("19:15"), 0, 0, orbit.x[12]];
  const ce = evaluate(coastX, FULL);
  if (ce) {
    const from = Date.parse("2025-06-05T18:45:00Z") / 1000;
    let best = { d: Infinity, i: 0 };
    ce.sim.samples.forEach((s, i) => {
      if (tRef + i < from) return;
      const relp: V = [s.r[0] - moonP[i][0], s.r[1] - moonP[i][1], s.r[2] - moonP[i][2]];
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(unit(relp), sDir))));
      if (ang * R_SURF < best.d) best = { d: ang * R_SURF, i };
    });
    console.log(
      `  site check: the pure coast passes closest to the impact site at ${hm(tRef + best.i)}, ${best.d.toFixed(0)} km from it ` +
        `(altitude ${ce.sim.alt[best.i].toFixed(1)} km); impact was at ${hm(tImpactTarget)}`,
    );
  }
}

if (process.env.STAGE1_ONLY) {
  console.log("STAGE1_ONLY: coast trajectory written to validation/out/resilience-coast.json");
  process.exit(0);
}

// ---------- stage 2: braking grid following ispace's profile, orbit and plane fixed ----------
const stage2: Array<{ x: number[]; c: number }> = [];
for (const tb of ["18:50", "18:55", "19:00", "19:03", "19:06", "19:09"]) {
  for (const durMin of [4, 7, 10]) {
    for (const a1 of [1.5, 2.0, 2.5]) {
      for (const g1a of [0, 15]) {
        for (const g1b of [15, 45]) {
          for (const a2 of [1, 1.6, 2]) {
            for (const g2 of [60, 85]) {
              const x = [...orbit.x.slice(0, 5), at(tb), a1, g1a, g1b, at(tb) + durMin * 60, a2, g2, orbit.x[12]];
              const e = evaluate(x, FULL);
              if (e) stage2.push({ x, c: cost(e) });
            }
          }
        }
      }
    }
  }
}
stage2.sort((a, b) => a.c - b.c);
console.log(`stage 2 (braking grid): ${stage2.length} valid combinations (${secs()})`);

// ---------- stage 3: all 13 parameters ----------
const finals: Array<{ x: number[]; cur: Eval }> = [];
for (const [i, s] of stage2.slice(0, 5).entries()) {
  const r = lm(s.x, ALL, 40, FULL);
  if (!r) continue;
  finals.push(r);
  const p = P(r.x);
  console.log(
    `  start ${i + 1}: RMS ${rmsOf(r.cur.out).toFixed(1)} m/s, deorbit ${hm(p.td)}, brake ${hm(p.tb)} at ${(p.a1 * 1000).toFixed(2)} m/s², ` +
      `impact ${hm(r.cur.sim.endT)} at ${r.cur.sim.impactSpeed.toFixed(0)} m/s, ${norm(subV(r.cur.sim.endPos, siteVec)).toFixed(1)} km from site`,
  );
}
if (finals.length === 0) throw new Error("stage 3 failed");
finals.sort((a, b) => cost(a.cur) - cost(b.cur));
const { x, cur } = finals[0];
const p = P(x);
const sim = cur.sim;

// ---------- uncertainties ----------
const sig = new Array(13).fill(NaN);
const J = jacobian(x, cur, ALL, FULL);
if (J) {
  const { JTJ } = normal(J, cur.F);
  const s2 = cost(cur) / Math.max(1, cur.F.length - 13);
  for (let j = 0; j < 13; j++) {
    const col = solve(JTJ, Array.from({ length: 13 }, (_, i) => (i === j ? 1 : 0)));
    if (col) sig[j] = Math.sqrt(Math.max(0, col[j] * s2));
  }
}
const good = finals.filter((f) => cost(f.cur) < 1.5 * cost(cur));
const spread = ALL.map((j) => (good.length > 1 ? Math.max(...good.map((f) => f.x[j])) - Math.min(...good.map((f) => f.x[j])) : NaN));

console.log(`\nFitted landing sequence (${secs()}); ± formal 1σ, [spread across ${good.length} comparable refinements]:`);
for (const j of ALL) {
  const val = [3, 5, 9].includes(j) ? utc(tRef + x[j]) : x[j].toFixed(j === 1 ? 4 : 2);
  console.log(`  ${NAMES[j].padEnd(16)} ${String(val).padEnd(22)} ± ${Number.isFinite(sig[j]) ? sig[j].toFixed(2) : "?"} ${UNITS[j]}  [${Number.isFinite(spread[j]) ? spread[j].toFixed(2) : "-"}]`);
}
const tFl = sim.tFloor ?? sim.endT;
const brakeDv = Math.max(0, Math.min(p.t2, sim.endT) - p.tb) * p.a1 * 1000;
const apprDv = Math.max(0, tFl - p.t2) * p.a2 * 1000;
console.log(`\n  inclination ${inclinationDeg(x[12]).toFixed(1)}° (Scott Tilley: 104°), lowest point after deorbit ${sim.doiPeri.toFixed(1)} km (ispace: braking from ~20 km)`);
console.log(`  altitude at braking start ${(sim.alt[Math.round(p.tb - tRef)] ?? NaN).toFixed(1)} km (ispace: ~20 km, now a constraint)`);
console.log(`  braking Δv ≈ ${brakeDv.toFixed(0)} m/s, approach Δv ≈ ${apprDv.toFixed(0)} m/s`);
console.log(`  impact ${utc(sim.endT)} at ${sim.impactSpeed.toFixed(0)} m/s, ${norm(subV(sim.endPos, siteVec)).toFixed(2)} km from the LRO site`);
console.log(
  `  RMS all ${rmsOf(cur.out).toFixed(1)} m/s; orbit ${rmsOf(cur.out.filter((q) => q.t < p.td)).toFixed(1)}, coast ${rmsOf(cur.out.filter((q) => q.t >= p.td && q.t < p.tb)).toFixed(1)}, ` +
    `braking ${rmsOf(cur.out.filter((q) => q.t >= p.tb && q.t < p.t2)).toFixed(1)}, approach ${rmsOf(cur.out.filter((q) => q.t >= p.t2 && q.t < tFl)).toFixed(1)}, final ${rmsOf(cur.out.filter((q) => q.t >= tFl)).toFixed(1)} m/s`,
);
console.log("\n  altitude and speed along the fitted descent:");
for (const hhmm of ["18:13", "18:20", "18:30", "18:40", "18:50", "19:00", "19:05", "19:10", "19:13", "19:15"]) {
  const i = Math.round(at(hhmm));
  if (i >= 0 && i < sim.alt.length) console.log(`    ${hhmm}  ${sim.alt[i].toFixed(1).padStart(7)} km  ${sim.speed[i].toFixed(0).padStart(5)} m/s`);
}
const ic = Math.round(Date.parse(CHECK.utc) / 1000 - tRef);
console.log(
  ic < sim.alt.length
    ? `  ispace's last telemetry (now a constraint) (${CHECK.utc.slice(11, 19)}): model ${(sim.alt[ic] * 1000).toFixed(0)} m at ${sim.speed[ic].toFixed(0)} m/s, ispace ${CHECK.altKm * 1000} m at ${CHECK.speedMs} m/s`
    : `  ispace's last telemetry (now a constraint) (${CHECK.utc.slice(11, 19)}): the model had already impacted`,
);

await mkdir("validation/out", { recursive: true });
await writeFile(
  "validation/out/resilience-descent.json",
  JSON.stringify({
    fit: Object.fromEntries(NAMES.map((nm, j) => [nm, { value: x[j], sigma: sig[j], spread: spread[j] }])),
    inclinationDeg: inclinationDeg(x[12]),
    impact: utc(sim.endT),
    impactSpeedMs: sim.impactSpeed,
    rmsMs: rmsOf(cur.out),
    samples: sim.samples,
  }),
);
await writeFile(
  "validation/out/camras-powered-fit.svg",
  plotSvg(cur.out, cam.segs.length, "Landing sequence fitted to Dwingeloo Doppler (ispace profile, plane heading free)", [
    { t: p.td, label: "deorbit" },
    { t: p.tb, label: "braking" },
    { t: p.t2, label: "approach" },
    ...(sim.tFloor ? [{ t: sim.tFloor, label: "< 50 m/s" }] : []),
    { t: cam.los, label: "LOS" },
  ]),
);
console.log("\nwritten validation/out/resilience-descent.json and camras-powered-fit.svg");
