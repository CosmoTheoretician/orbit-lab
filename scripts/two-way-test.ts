import { readFile } from "node:fs/promises";
import { gstime } from "satellite.js";
import { Epoch } from "../src/core/time";
import { sampleTrack } from "../src/missions/track";
import type { Sample } from "../src/missions/horizons";
import { C, compare, loadCamras, rmsOf, trackFromSamples, type Row } from "./lib/camras";

/**
 * Is the change at ~18:30 a switch to a coherent (two-way) link? With an unramped uplink from station S,
 * Dwingeloo receives a frequency shifted by both line-of-sight speeds (S → lander and lander → Dwingeloo).
 * Each candidate S is tested against the stage-1 coast trajectory, one frequency offset per stretch.
 */
type V3 = [number, number, number];
interface Station {
  name: string;
  lat: number;
  lon: number;
  h: number;
}
const DW: Station = { name: "Dwingeloo", lat: 52.8122, lon: 6.3964, h: 0.025 };
const CANDIDATES: Station[] = [
  { name: "ESA Cebreros", lat: 40.4527, lon: -4.3676, h: 0.794 },
  { name: "ESA Malargüe", lat: -35.776, lon: -69.398, h: 1.55 },
  { name: "ESA New Norcia", lat: -31.048, lon: 116.191, h: 0.252 },
  { name: "ESA Redu", lat: 50.0019, lon: 5.1453, h: 0.39 },
  { name: "ESA Kiruna", lat: 67.8571, lon: 20.9643, h: 0.402 },
  { name: "ESA Kourou", lat: 5.2514, lon: -52.8047, h: 0.015 },
  { name: "ESA Santa Maria", lat: 36.9973, lon: -25.1358, h: 0.276 },
  { name: "NASA Madrid", lat: 40.4314, lon: -4.2481, h: 0.835 },
  { name: "NASA Goldstone", lat: 35.4259, lon: -116.889, h: 1.0 },
  { name: "Goonhilly", lat: 50.0478, lon: -5.1822, h: 0.1 },
  { name: "DLR Weilheim", lat: 47.8813, lon: 11.0853, h: 0.6 },
  { name: "JAXA Usuda", lat: 36.1328, lon: 138.3627, h: 1.46 },
  { name: "JAXA Misasa", lat: 36.1353, lon: 138.7706, h: 1.5 },
];
const MIN_EL = 5;
const OMEGA_E = 7.2921150e-5;
const A = 6378.137;
const F = 1 / 298.257223563;
const DEG = Math.PI / 180;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);

function stationState(st: Station, unixS: number): { r: V3; v: V3; up: V3 } {
  const lat = st.lat * DEG;
  const lon = st.lon * DEG;
  const e2 = F * (2 - F);
  const N = A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const x = (N + st.h) * Math.cos(lat) * Math.cos(lon);
  const y = (N + st.h) * Math.cos(lat) * Math.sin(lon);
  const z = (N * (1 - e2) + st.h) * Math.sin(lat);
  const g = gstime(new Date(unixS * 1000));
  const r: V3 = [Math.cos(g) * x - Math.sin(g) * y, Math.sin(g) * x + Math.cos(g) * y, z];
  const up: V3 = [Math.cos(lat) * Math.cos(lon + g), Math.cos(lat) * Math.sin(lon + g), Math.sin(lat)];
  return { r, v: [-OMEGA_E * r[1], OMEGA_E * r[0], 0], up };
}

const coast = JSON.parse(await readFile("validation/out/resilience-coast.json", "utf8")) as { samples: Sample[] };
const track = trackFromSamples(coast.samples);
const pos = (tt: number): V3 | null => {
  const p = sampleTrack(track, tt, [0, 0, 0]);
  return p ? [p[0], p[1], p[2]] : null;
};
function scState(tt: number): { p: V3; v: V3 } | null {
  const p = pos(tt);
  const a = pos(tt - 0.5);
  const b = pos(tt + 0.5);
  return p && a && b ? { p, v: sub(b, a) } : null;
}
const lineOfSight = (st: Station, unixS: number, sc: { p: V3; v: V3 }) => {
  const g = stationState(st, unixS);
  const d = sub(sc.p, g.r);
  const rho = norm(d);
  return { rr: dot(d, sub(sc.v, g.v)) / rho, el: Math.asin(dot(d, g.up) / rho) / DEG, rho };
};

/** Line-of-sight speed sum seen at Dwingeloo: downlink only (up = null) or uplink from `up` + downlink. */
const elevations = new Map<string, number[]>();
function rangeRateFor(up: Station | null) {
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
    const down = lineOfSight(DW, u, sc);
    if (!up) return down.rr;
    const tUp = u - tau - down.rho / C; // uplink transmitted about one light time before the lander received it
    const upl = lineOfSight(up, tUp, sc);
    const list = elevations.get(up.name) ?? [];
    list.push(upl.el);
    elevations.set(up.name, list);
    if (upl.el < MIN_EL) return null;
    return down.rr + upl.rr;
  };
}

const cam = await loadCamras(undefined, { stitchSidebands: true });
const T = (hhmm: string) => Date.parse(`2025-06-05T${hhmm}:00Z`) / 1000;
const WINDOWS: Array<[string, string, string]> = [
  ["17:13", "17:31", "control, before occultation"],
  ["18:18", "18:30", "control, clean coast"],
  ["18:32", "19:00", "TEST: after the break"],
  ["19:00", "19:16", "info: braking"],
];
const segsIn = (lo: number, hi: number): Row[][] => cam.segs.map((s) => s.filter((r) => r.t >= lo && r.t < hi)).filter((s) => s.length >= 10);

function row(label: string, up: Station | null) {
  const cells = WINDOWS.map(([a, b]) => {
    const segs = segsIn(T(a), T(b));
    const total = segs.flat().length;
    const c = compare(rangeRateFor(up), segs);
    const used = c.out.length;
    if (used === 0) return "      —      ".padStart(16);
    return `${rmsOf(c.out).toFixed(1).padStart(7)} m/s${used < total ? ` (${Math.round((100 * used) / total)}%)` : ""}`.padStart(16);
  });
  return `${label.padEnd(18)}${cells.join("")}`;
}

console.log(`Two-way test against the stage-1 coast trajectory; RMS per window (one frequency offset per stretch)`);
console.log(`${"".padEnd(18)}${WINDOWS.map(([a, b]) => `${a}–${b}`.padStart(16)).join("")}`);
console.log(`${"".padEnd(18)}${WINDOWS.map(([, , d]) => d.slice(0, 15).padStart(16)).join("")}`);
console.log(row("one-way (now)", null));
const results: Array<{ name: string; test: number; maxEl: number }> = [];
for (const st of CANDIDATES) {
  elevations.delete(st.name);
  console.log(row(st.name, st));
  const els = elevations.get(st.name) ?? [];
  const maxEl = els.length ? Math.max(...els) : -90;
  const c = compare(rangeRateFor(st), segsIn(T("18:32"), T("19:00")));
  results.push({ name: st.name, test: c.out.length ? rmsOf(c.out) : Infinity, maxEl });
}

const oneWayTest = rmsOf(compare(rangeRateFor(null), segsIn(T("18:32"), T("19:00"))).out);
console.log(`\nVisibility (highest elevation of the lander during the pass):`);
for (const r of results) console.log(`  ${r.name.padEnd(18)} ${r.maxEl.toFixed(1).padStart(6)}°${r.maxEl < MIN_EL ? "  (below the horizon: cannot be the uplink)" : ""}`);
const visible = results.filter((r) => r.maxEl >= MIN_EL && Number.isFinite(r.test)).sort((a, b) => a.test - b.test);
console.log(`\nAfter the break (18:32–19:00): one-way ${oneWayTest.toFixed(1)} m/s`);
if (visible.length) {
  const best = visible[0];
  console.log(`  best two-way: ${best.name} at ${best.test.toFixed(1)} m/s (${(oneWayTest / best.test).toFixed(1)}× better than one-way)`);
  if (visible[1]) console.log(`  runner-up:    ${visible[1].name} at ${visible[1].test.toFixed(1)} m/s`);
}
