import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Track } from "../src/missions/track";
import { compare, hm, loadCamras, makeRangeRate, MIN_SEGMENT, plotSvg, rmsOf, utc } from "./lib/camras";

const DEORBIT_UTC = "2025-06-05T18:09:00Z"; // reported deorbit burn (Seradata)
const PERIOD_MIN = 117.8; // circular orbit at 100 km

const cam = await loadCamras();
console.log(`CAMRAS Dwingeloo X-band: ${cam.segs.length} continuous stretches, ${cam.jumps.length} non-Doppler jumps`);
console.log(`  signal ${utc(cam.strong[0].t)} → ${utc(cam.los)} (loss of signal)`);

const file = JSON.parse(await readFile("public/missions/resilience.json", "utf8")) as { t: number[]; r: number[]; v: number[] };
const track: Track = { t: Float64Array.from(file.t), r: Float64Array.from(file.r), v: Float64Array.from(file.v) };
const rr = makeRangeRate(track);
const tDeorbit = Date.parse(DEORBIT_UTC) / 1000;

const all = compare(rr, cam.segs);
console.log(`\nModel as in the app: RMS ${all.rms.toFixed(1)} m/s over ${all.out.length} points`);
console.log(`  lunar orbit (before ${hm(tDeorbit)}): ${rmsOf(all.out.filter((q) => q.t < tDeorbit)).toFixed(1)} m/s`);
console.log(`  descent (after ${hm(tDeorbit)}):      ${rmsOf(all.out.filter((q) => q.t >= tDeorbit)).toFixed(1)} m/s`);

// Robustness: RMS for every timing shift over more than one orbital period
const orbitSegs = cam.segs.map((s) => s.filter((m) => m.t < tDeorbit)).filter((s) => s.length >= MIN_SEGMENT);
const curve: Array<{ s: number; rms: number }> = [];
for (let s = -7800; s <= 7800; s += 20) curve.push({ s, rms: compare(rr, orbitSegs, s).rms });
const minima = curve
  .filter((c, i) => i > 0 && i < curve.length - 1 && c.rms < curve[i - 1].rms && c.rms <= curve[i + 1].rms && Number.isFinite(c.rms))
  .sort((a, b) => a.rms - b.rms)
  .slice(0, 6);
console.log(`\nTiming shift scan, ±130 min (orbit period ${PERIOD_MIN} min); best minima:`);
for (const m of minima) console.log(`  shift ${(m.s / 60).toFixed(1).padStart(6)} min   RMS ${m.rms.toFixed(1)} m/s`);
if (minima.length > 1) {
  const ratio = minima[1].rms / minima[0].rms;
  console.log(`  second-best / best = ${ratio.toFixed(2)} ${ratio > 1.5 ? "(clear single minimum)" : "(ambiguous: several shifts fit similarly)"}`);
}

await mkdir("validation/out", { recursive: true });
await writeFile(
  "validation/out/camras-compare.svg",
  plotSvg(all.out, cam.segs.length, "Model as in the app vs Dwingeloo Doppler (one frequency offset per stretch)", [
    { t: tDeorbit, label: "deorbit (reported)" },
    { t: cam.los, label: "LOS" },
  ]),
);
const finite = curve.filter((c) => Number.isFinite(c.rms));
const cap = Math.min(400, Math.max(...finite.map((c) => c.rms)));
const W = 900;
const H = 300;
const X = (s: number) => 50 + ((s + 7800) / 15600) * (W - 70);
const Y = (r: number) => 20 + (Math.min(r, cap) / cap) * (H - 60);
await writeFile(
  "validation/out/camras-shift-scan.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace" font-size="12">
<rect width="100%" height="100%" fill="#0b0f14"/>
<polyline fill="none" stroke="#64d2ff" stroke-width="1.5" points="${finite.map((c) => `${X(c.s).toFixed(1)},${Y(c.rms).toFixed(1)}`).join(" ")}"/>
<line x1="${X(0)}" x2="${X(0)}" y1="15" y2="${H - 40}" stroke="#5f7390" stroke-dasharray="4 4"/>
<text x="50" y="${H - 22}" fill="#cfe3ff">model timing shift −130 … +130 min (dashed: no shift); RMS (m/s, top = 0, bottom = ${cap.toFixed(0)})</text>
<text x="50" y="${H - 6}" fill="#8fa6c4">lunar-orbit data before the reported deorbit only</text>
</svg>`,
);
console.log("\nwritten validation/out/camras-compare.svg and camras-shift-scan.svg");
