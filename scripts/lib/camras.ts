import { readFile } from "node:fs/promises";
import { gstime } from "satellite.js";
import { Epoch } from "../../src/core/time";
import { sampleTrack, type Track } from "../../src/missions/track";
import type { Sample } from "../../src/missions/horizons";

/**
 * Dwingeloo Radio Telescope (CAMRAS) X-band Doppler of Resilience, 5 June 2025,
 * https://data.camras.nl/hakuto-r/ (hakuto_maxfreq.csv), and the comparison with a modeled track.
 */
export const C = 299_792.458; // km/s
export const STATION = { name: "Dwingeloo", latDeg: 52.8122, lonDeg: 6.3964, hKm: 0.025 };
const OMEGA_E = 7.2921150e-5;
const WGS84_A = 6378.137;
const WGS84_F = 1 / 298.257223563;
/** Larger 1-second frequency changes than this cannot be Doppler near the Moon. */
const MAX_STEP_HZ = 300;
const MAX_GAP_S = 5;
/** The strongest-bin tracker sometimes switches to a sideband ~3.8 kHz from the carrier. */
const SIDEBAND_HZ = 3800;
const SIDEBAND_TOL_HZ = 300;
export const MIN_SEGMENT = 30;

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const utc = (unixS: number) => new Date(unixS * 1000).toISOString().slice(0, 19) + "Z";
export const hm = (unixS: number) => new Date(unixS * 1000).toISOString().slice(11, 19);

export interface Row {
  t: number;
  f: number;
  p: number;
}
export interface Pt {
  t: number;
  seg: number;
  rrMeas: number;
  rr: number;
  resMs: number;
}
export type RangeRate = (unixS: number, shiftS?: number) => number | null;

export async function loadCamras(path = "validation/data/camras/hakuto_maxfreq.csv", opts: { stitchSidebands?: boolean } = {}) {
  const text = await readFile(path, "utf8");
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("timestamp")) continue;
    const c = line.split(",");
    const r = { t: Number(c[0]), f: Number(c[16]), p: Number(c[17]) };
    if (Number.isFinite(r.t) && Number.isFinite(r.f) && Number.isFinite(r.p)) rows.push(r);
  }
  const sortedP = rows.map((r) => r.p).sort((a, b) => a - b);
  const noise = sortedP[Math.floor(sortedP.length / 2)];
  const thr = 3 * noise;
  const strong = rows.filter((r) => r.p >= thr);

  const segments: Row[][] = [];
  const jumps: Array<{ t: number; hz: number }> = [];
  let stitched = 0;
  let cur: Row[] = [];
  let corr = 0; // frequency correction inside the current stretch (sideband switches)
  for (const raw of strong) {
    const prev = cur[cur.length - 1];
    let r: Row = { ...raw, f: raw.f + corr };
    if (prev) {
      const dt = r.t - prev.t;
      const df = r.f - prev.f;
      const sideband = opts.stitchSidebands && dt <= MAX_GAP_S && Math.abs(Math.abs(df) - SIDEBAND_HZ) < SIDEBAND_TOL_HZ;
      if (sideband) {
        const pp = cur[cur.length - 2];
        const trend = pp && Math.abs(prev.t - pp.t - 1) < 0.01 ? (prev.f - pp.f) * dt : 0;
        corr -= df - trend;
        r = { ...raw, f: raw.f + corr };
        stitched++;
      } else if (dt > MAX_GAP_S || Math.abs(df) > MAX_STEP_HZ) {
        if (dt <= MAX_GAP_S) jumps.push({ t: r.t, hz: df });
        segments.push(cur);
        cur = [];
        corr = 0;
        r = { ...raw };
      }
    }
    cur.push(r);
  }
  if (cur.length) segments.push(cur);
  const segs = segments.filter((s) => s.length >= MIN_SEGMENT);
  return { rows, strong, segs, jumps, stitched, noise, thr, los: strong[strong.length - 1].t };
}

export function trackFromSamples(s: Sample[]): Track {
  return {
    t: Float64Array.from(s.map((x) => x.t)),
    r: Float64Array.from(s.flatMap((x) => x.r)),
    v: Float64Array.from(s.flatMap((x) => x.v)),
  };
}

/** Station position and velocity in the scene frame (equator and equinox of date), km and km/s. */
function station(unixS: number): { r: V3; v: V3 } {
  const lat = (STATION.latDeg * Math.PI) / 180;
  const lon = (STATION.lonDeg * Math.PI) / 180;
  const e2 = WGS84_F * (2 - WGS84_F);
  const N = WGS84_A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const x = (N + STATION.hKm) * Math.cos(lat) * Math.cos(lon);
  const y = (N + STATION.hKm) * Math.cos(lat) * Math.sin(lon);
  const z = (N * (1 - e2) + STATION.hKm) * Math.sin(lat);
  const g = gstime(new Date(unixS * 1000));
  const r: V3 = [Math.cos(g) * x - Math.sin(g) * y, Math.sin(g) * x + Math.cos(g) * y, z];
  return { r, v: [-OMEGA_E * r[1], OMEGA_E * r[0], 0] };
}

/** Modeled line-of-sight speed (km/s, positive = receding), spacecraft at signal emission time. */
export function makeRangeRate(track: Track): RangeRate {
  const pos = (tt: number): V3 | null => {
    const p = sampleTrack(track, tt, [0, 0, 0]);
    return p ? [p[0], p[1], p[2]] : null;
  };
  return (unixS, shiftS = 0) => {
    const st = station(unixS);
    const ttRx = Epoch.fromUnixMs(unixS * 1000).tt + shiftS;
    let tau = 1.3;
    let p: V3 | null = null;
    for (let it = 0; it < 3; it++) {
      p = pos(ttRx - tau);
      if (!p) return null;
      tau = norm(sub(p, st.r)) / C;
    }
    const a = pos(ttRx - tau - 0.5);
    const b = pos(ttRx - tau + 0.5);
    if (!p || !a || !b) return null;
    const d = sub(p, st.r);
    return dot(d, sub(sub(b, a), st.v)) / norm(d);
  };
}

/** One fitted frequency per continuous stretch (the transmitter changes in steps); residuals in m/s. */
export function compare(rangeRate: RangeRate, segs: Row[][], shiftS = 0) {
  const out: Pt[] = [];
  segs.forEach((s, si) => {
    const pairs: Array<{ t: number; f: number; rr: number }> = [];
    for (const m of s) {
      const rr = rangeRate(m.t, shiftS);
      if (rr !== null) pairs.push({ t: m.t, f: m.f, rr });
    }
    if (pairs.length < 10) return;
    let num = 0;
    let den = 0;
    for (const q of pairs) {
      const k = 1 - q.rr / C;
      num += q.f * k;
      den += k * k;
    }
    const fTx = num / den;
    for (const q of pairs) {
      const rrMeas = C * (1 - q.f / fTx);
      out.push({ t: q.t, seg: si, rrMeas, rr: q.rr, resMs: (rrMeas - q.rr) * 1000 });
    }
  });
  return { out, rms: rmsOf(out) };
}

export const rmsOf = (pts: Pt[]) =>
  pts.length ? Math.sqrt(pts.reduce((s, q) => s + q.resMs ** 2, 0) / pts.length) : Infinity;

/** Measured vs modeled line-of-sight speed, with the difference below; gaps stay empty. */
export function plotSvg(out: Pt[], nSegs: number, title: string, marks: Array<{ t: number; label: string }>): string {
  const W = 960;
  const H = 520;
  const t0 = out[0].t;
  const t1 = out[out.length - 1].t;
  const vals = out.flatMap((q) => [q.rrMeas, q.rr]);
  const [vMin, vMax] = [Math.min(...vals), Math.max(...vals)];
  const resMax = Math.max(...out.map((q) => Math.abs(q.resMs)), 1);
  const X = (t: number) => 60 + ((t - t0) / (t1 - t0)) * (W - 80);
  const Y1 = (v: number) => 40 + ((vMax - v) / (vMax - vMin || 1)) * 260;
  const Y2 = (r: number) => 400 - (r / resMax) * 80;
  const lines = (key: "rrMeas" | "rr" | "resMs", Y: (v: number) => number, color: string) =>
    Array.from({ length: nSegs }, (_, si) => out.filter((q) => q.seg === si))
      .filter((pts) => pts.length > 1)
      .map(
        (pts) =>
          `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts
            .filter((_, i) => i % 3 === 0)
            .map((q) => `${X(q.t).toFixed(1)},${Y(q[key]).toFixed(1)}`)
            .join(" ")}"/>`,
      )
      .join("\n");
  const vlines = marks
    .filter((m) => m.t >= t0 && m.t <= t1)
    .map(
      (m, i) =>
        `<line x1="${X(m.t)}" x2="${X(m.t)}" y1="30" y2="485" stroke="#5f7390" stroke-dasharray="4 4"/>` +
        `<text x="${X(m.t) + 4}" y="${44 + 14 * (i % 3)}" fill="#8fa6c4">${m.label}</text>`,
    )
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace" font-size="12">
<rect width="100%" height="100%" fill="#0b0f14"/>
<text x="60" y="18" fill="#cfe3ff">${title}</text>
${lines("rrMeas", Y1, "#64d2ff")}
${lines("rr", Y1, "#ff453a")}
<line x1="60" x2="${W - 20}" y1="${Y2(0)}" y2="${Y2(0)}" stroke="#2c3a4d"/>
<text x="60" y="318" fill="#cfe3ff">Measured − model (m/s), ±${resMax.toFixed(0)}</text>
${lines("resMs", Y2, "#ffd60a")}
${vlines}
<text x="60" y="${H - 25}" fill="#cfe3ff">${utc(t0)} → ${utc(t1)} · line-of-sight speed from ${STATION.name}, ${vMin.toFixed(2)} … ${vMax.toFixed(2)} km/s</text>
<text x="60" y="${H - 8}" fill="#64d2ff">measured (CAMRAS Dwingeloo)</text><text x="300" y="${H - 8}" fill="#ff453a">model</text><text x="380" y="${H - 8}" fill="#ffd60a">difference</text>
</svg>`;
}

// ---------- link model, found with the two-way test ----------
export interface Station {
  name: string;
  lat: number;
  lon: number;
  h: number;
}
export const DWINGELOO: Station = { name: "Dwingeloo", lat: STATION.latDeg, lon: STATION.lonDeg, h: STATION.hKm };
export const UPLINK_CANDIDATES: Station[] = [
  { name: "ESA Cebreros", lat: 40.4527, lon: -4.3676, h: 0.794 },
  { name: "ESA Malargüe", lat: -35.776, lon: -69.398, h: 1.55 },
  { name: "ESA Redu", lat: 50.0019, lon: 5.1453, h: 0.39 },
  { name: "ESA Kiruna", lat: 67.8571, lon: 20.9643, h: 0.402 },
  { name: "ESA Kourou", lat: 5.2514, lon: -52.8047, h: 0.015 },
  { name: "ESA Santa Maria", lat: 36.9973, lon: -25.1358, h: 0.276 },
  { name: "NASA Madrid", lat: 40.4314, lon: -4.2481, h: 0.835 },
  { name: "Goonhilly", lat: 50.0478, lon: -5.1822, h: 0.1 },
  { name: "DLR Weilheim", lat: 47.8813, lon: 11.0853, h: 0.6 },
];
export const CEBREROS = UPLINK_CANDIDATES[0];
/** One-way from the end of the occultation until the uplink lock; coherent two-way otherwise. */
export const LINK_ONE_WAY: [number, number] = [Date.parse("2025-06-05T18:15:00Z") / 1000, Date.parse("2025-06-05T18:31:00Z") / 1000];

export function stationStateOf(st: Station, unixS: number): { r: V3; v: V3; up: V3 } {
  const lat = (st.lat * Math.PI) / 180;
  const lon = (st.lon * Math.PI) / 180;
  const e2 = WGS84_F * (2 - WGS84_F);
  const N = WGS84_A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const x = (N + st.h) * Math.cos(lat) * Math.cos(lon);
  const y = (N + st.h) * Math.cos(lat) * Math.sin(lon);
  const z = (N * (1 - e2) + st.h) * Math.sin(lat);
  const g = gstime(new Date(unixS * 1000));
  const r: V3 = [Math.cos(g) * x - Math.sin(g) * y, Math.sin(g) * x + Math.cos(g) * y, z];
  return { r, v: [-OMEGA_E * r[1], OMEGA_E * r[0], 0], up: [Math.cos(lat) * Math.cos(lon + g), Math.cos(lat) * Math.sin(lon + g), Math.sin(lat)] };
}

/** Line-of-sight speed sum seen at Dwingeloo: one-way (uplink null, or inside `oneWay`), else uplink + downlink. */
export function makeLinkRangeRate(track: Track, uplink: Station | null, oneWay: [number, number] = LINK_ONE_WAY): RangeRate {
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
    const g = stationStateOf(st, u);
    const d = sub(sc.p, g.r);
    const rho = norm(d);
    return { rr: dot(d, sub(sc.v, g.v)) / rho, el: Math.asin(dot(d, g.up) / rho) / (Math.PI / 180), rho };
  };
  return (u: number) => {
    const ttRx = Epoch.fromUnixMs(u * 1000).tt;
    let tau = 1.3;
    let sc: { p: V3; v: V3 } | null = null;
    for (let i = 0; i < 3; i++) {
      sc = scState(ttRx - tau);
      if (!sc) return null;
      tau = norm(sub(sc.p, stationStateOf(DWINGELOO, u).r)) / C;
    }
    if (!sc) return null;
    const down = los(DWINGELOO, u, sc);
    if (!uplink || (u >= oneWay[0] && u < oneWay[1])) return down.rr;
    const up = los(uplink, u - tau - down.rho / C, sc);
    return up.el < 5 ? null : down.rr + up.rr;
  };
}
