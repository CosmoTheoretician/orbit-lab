import { mkdir, writeFile } from "node:fs/promises";
import { MISSIONS } from "../src/missions/catalog";
import { lunarOps } from "../src/missions/lunarOps";
import type { LunarOpsSpec } from "../src/missions/types";
import { compare, hm, loadCamras, makeRangeRate, plotSvg, rmsOf, trackFromSamples, utc } from "./lib/camras";

/**
 * Fits Resilience's landing sequence to the Dwingeloo Doppler: impact fixed at the measured loss of
 * signal; deorbit time, powered-descent start altitude and duration chosen by the data.
 */
const m = MISSIONS.find((x) => x.id === "resilience");
if (!m?.lunarOps || !m.site) throw new Error("Resilience lunar-operations spec not found");
const base = m.lunarOps;
const site = m.site;
const cam = await loadCamras();
const isoS = (unixS: number) => new Date(Math.round(unixS) * 1000).toISOString().replace(".000Z", "Z");
const landing = isoS(cam.los);
console.log(`Impact fixed at the measured loss of signal: ${landing}`);

interface Fit {
  descentStart: number;
  pdiAltKm: number;
  pdiDurationS: number;
}
function evaluate(f: Fit) {
  const spec: LunarOpsSpec = {
    ...base,
    descentStart: isoS(f.descentStart),
    pdiAltKm: f.pdiAltKm,
    pdiDurationS: f.pdiDurationS,
    landing,
  };
  try {
    const ops = lunarOps(spec, site.lat, site.lon);
    const c = compare(makeRangeRate(trackFromSamples(ops.samples)), cam.segs);
    return Number.isFinite(c.rms) ? c : null;
  } catch {
    return null;
  }
}

const t0 = Date.now();
let best: { f: Fit; rms: number } = {
  f: { descentStart: Date.parse(base.descentStart) / 1000, pdiAltKm: base.pdiAltKm, pdiDurationS: base.pdiDurationS },
  rms: Infinity,
};
const tryFit = (f: Fit) => {
  const c = evaluate(f);
  if (c && c.rms < best.rms) best = { f, rms: c.rms };
  return c ? c.rms : Infinity;
};

console.log(`\nAssumed sequence (deorbit ${hm(best.f.descentStart)}, PDI ${base.pdiAltKm} km for ${base.pdiDurationS} s): RMS ${tryFit(best.f).toFixed(1)} m/s`);

console.log("\n1. Deorbit time, PDI as assumed:");
const pdi0 = { pdiAltKm: base.pdiAltKm, pdiDurationS: base.pdiDurationS };
for (let ts = Date.parse("2025-06-05T17:40:00Z") / 1000; ts <= Date.parse("2025-06-05T18:40:00Z") / 1000; ts += 120) {
  console.log(`   deorbit ${hm(ts)}   RMS ${tryFit({ descentStart: ts, ...pdi0 }).toFixed(1)} m/s`);
}

console.log(`\n2. Powered descent at deorbit ${hm(best.f.descentStart)}:`);
const ds = best.f.descentStart;
for (const pdiAltKm of [10, 15, 20, 30]) {
  for (const pdiDurationS of [480, 600, 720, 900, 1200]) {
    console.log(`   PDI ${String(pdiAltKm).padStart(2)} km, ${String(pdiDurationS).padStart(4)} s   RMS ${tryFit({ descentStart: ds, pdiAltKm, pdiDurationS }).toFixed(1)} m/s`);
  }
}

console.log("\n3. Deorbit time, fine:");
const center = best.f;
for (let dt = -180; dt <= 180; dt += 15) tryFit({ ...center, descentStart: center.descentStart + dt });

const fit = evaluate(best.f);
if (!fit) throw new Error("best fit could not be re-evaluated");
const tPdi = cam.los - best.f.pdiDurationS;
console.log(`\nBest fit (${((Date.now() - t0) / 1000).toFixed(0)} s):`);
console.log(`  deorbit            ${utc(best.f.descentStart)}   (reported: 18:09 UTC)`);
console.log(`  powered descent    from ${best.f.pdiAltKm} km, ${best.f.pdiDurationS} s, starting ${hm(tPdi)}`);
console.log(`  impact             ${landing}   (measured loss of signal)`);
console.log(`  RMS all            ${fit.rms.toFixed(1)} m/s`);
console.log(`  circular orbit     ${rmsOf(fit.out.filter((q) => q.t < best.f.descentStart)).toFixed(1)} m/s`);
console.log(`  descent coast      ${rmsOf(fit.out.filter((q) => q.t >= best.f.descentStart && q.t < tPdi)).toFixed(1)} m/s`);
console.log(`  powered descent    ${rmsOf(fit.out.filter((q) => q.t >= tPdi)).toFixed(1)} m/s`);

await mkdir("validation/out", { recursive: true });
await writeFile(
  "validation/out/resilience-descent-fit.json",
  JSON.stringify({ descentStart: isoS(best.f.descentStart), pdiAltKm: best.f.pdiAltKm, pdiDurationS: best.f.pdiDurationS, landing, rmsMs: +fit.rms.toFixed(1) }, null, 2),
);
await writeFile(
  "validation/out/camras-fit.svg",
  plotSvg(fit.out, cam.segs.length, "Fitted landing sequence vs Dwingeloo Doppler (one frequency offset per stretch)", [
    { t: best.f.descentStart, label: "deorbit (fit)" },
    { t: tPdi, label: "PDI (fit)" },
    { t: cam.los, label: "LOS" },
  ]),
);
console.log("\nwritten validation/out/resilience-descent-fit.json and camras-fit.svg");
