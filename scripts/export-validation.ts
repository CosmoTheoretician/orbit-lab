import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { Epoch } from "../src/core/time";
import { moonAt, moonVelocityAt } from "../src/orbit/cislunar";
import type { Sample } from "../src/missions/horizons";
import { CEBREROS, compare, loadCamras, makeLinkRangeRate, rmsOf, trackFromSamples, UPLINK_CANDIDATES, type Row } from "./lib/camras";

/** Writes the CSV/JSON the Python plots read (validation/out/plots). */
const OUT = "validation/out/plots";
const R_SURF = 1737.4;
const T = (hhmm: string) => Date.parse(`2025-06-05T${hhmm}:00Z`) / 1000;
const unixOf = (tt: number) => Epoch.fromTT(tt).toDate().getTime() / 1000;
await mkdir(OUT, { recursive: true });
const cam = await loadCamras(undefined, { stitchSidebands: true });

// 1. the raw recording
await writeFile(`${OUT}/raw.csv`, "unix,freq_hz,power,signal\n" + cam.rows.map((r) => `${r.t},${r.f},${r.p},${r.p >= cam.thr ? 1 : 0}`).join("\n"));

// 2. "before": the original model vs the data (from npm run validate-camras), kept once
try {
  await access(`${OUT}/before.csv`);
} catch {
  try {
    await copyFile("validation/out/camras-compare.csv", `${OUT}/before.csv`);
  } catch {
    console.log("note: no validation/out/camras-compare.csv, so the 'before' plot is skipped");
  }
}

// 3. two-way test against the stage-1 coast
const coast = JSON.parse(await readFile("validation/out/resilience-coast.json", "utf8")) as { samples: Sample[] };
const coastTrack = trackFromSamples(coast.samples);
const WINDOWS: Array<[string, string]> = [["17:13", "17:31"], ["18:18", "18:30"], ["18:32", "19:00"]];
const segsIn = (lo: number, hi: number): Row[][] => cam.segs.map((s) => s.filter((r) => r.t >= lo && r.t < hi)).filter((s) => s.length >= 10);
const twoWay = [null, ...UPLINK_CANDIDATES].map((st) => ({
  name: st ? st.name : "one-way",
  rms: WINDOWS.map(([a, b]) => {
    const segs = segsIn(T(a), T(b));
    const c = compare(makeLinkRangeRate(coastTrack, st, [0, 0]), segs);
    return c.out.length ? rmsOf(c.out) : null;
  }),
}));
await writeFile(`${OUT}/two-way.json`, JSON.stringify({ windows: WINDOWS.map(([a, b]) => `${a}–${b}`), rows: twoWay }));

// 4. the final reconstruction vs the data, with the link model
const descent = JSON.parse(await readFile("validation/out/resilience-descent.json", "utf8")) as {
  fit: Record<string, { value: number }>;
  impact: string;
  samples: Sample[];
};
const fin = compare(makeLinkRangeRate(trackFromSamples(descent.samples), CEBREROS), cam.segs);
await writeFile(
  `${OUT}/final.csv`,
  "unix,stretch,rr_meas_kms,rr_model_kms,residual_ms\n" + fin.out.map((q) => `${q.t},${q.seg},${q.rrMeas},${q.rr},${q.resMs}`).join("\n"),
);

// 5. altitude and speed profile
const profile = descent.samples.map((s) => {
  const mp = moonAt(s.t);
  const mv = moonVelocityAt(s.t);
  const alt = Math.hypot(s.r[0] - mp[0], s.r[1] - mp[1], s.r[2] - mp[2]) - R_SURF;
  const sp = Math.hypot(s.v[0] - mv[0], s.v[1] - mv[1], s.v[2] - mv[2]) * 1000;
  return `${unixOf(s.t)},${alt},${sp}`;
});
await writeFile(`${OUT}/profile.csv`, "unix,alt_km,speed_ms\n" + profile.join("\n"));

// 6. events
const tRef = T("17:10");
const at = (k: string) => (descent.fit[k] ? tRef + descent.fit[k].value : null);
await writeFile(
  `${OUT}/events.json`,
  JSON.stringify({
    occultation: [T("17:31"), T("18:18")],
    oneWay: [T("18:18"), T("18:31")],
    deorbit: at("deorbit"),
    braking: at("brake start"),
    approach: at("approach start"),
    los: cam.los,
    impact: Date.parse(descent.impact) / 1000,
    rms: rmsOf(fin.out),
    telemetry: { unix: Date.parse("2025-06-05T19:15:27Z") / 1000, altKm: 0.192, speedMs: 42 },
    ispaceBrakingAltKm: 20,
  }),
);
console.log(`exported to ${OUT}: final RMS ${rmsOf(fin.out).toFixed(1)} m/s over ${fin.out.length} points`);
