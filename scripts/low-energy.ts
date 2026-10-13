import { mkdir, writeFile } from "node:fs/promises";
import { MISSIONS } from "../src/missions/catalog";
import { lunarOps } from "../src/missions/lunarOps";
import { reconstructLowEnergy } from "../src/missions/lowEnergy";

/** Stage 2a: Resilience's low-energy leg from the lunar flyby to lunar orbit insertion. */
const m = MISSIONS.find((x) => x.id === "resilience");
if (!m?.lunarOps || !m.site) throw new Error("Resilience lunar-operations spec not found in the catalog");
const ops = lunarOps(m.lunarOps, m.site.lat, m.site.lon);

console.log("Resilience: flyby → LOI with one deep-space maneuver (4 March – 24 April), published 1.1 million km apogee as a target, Earth–Moon–Sun model");
const t0 = Date.now();
const res = reconstructLowEnergy(
  {
    launch: "2025-01-15T06:11:39Z",
    flyby: { time: "2025-02-14T22:43:00Z", altitudeKm: 8400 },
    dsmWindow: ["2025-03-04T00:00:00Z", "2025-04-24T10:00:00Z"],
    apogee: { distanceKm: 1_100_000, by: "2025-03-04T00:00:00Z" },
    loi: { time: m.lunarOps.loi, periAltKm: m.lunarOps.capture.periAltKm },
    capture: m.lunarOps.capture,
    planeNormal: ops.normal,
  },
  (s) => console.log(s),
);
console.log(`solved in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const [k, v] of Object.entries(res.report)) console.log(`  ${k.padEnd(28)} ${v}`);

await mkdir("validation/out", { recursive: true });
await writeFile("validation/out/resilience-low-energy.json", JSON.stringify({ report: res.report, x: res.x, post: res.post, pre: res.pre }));
console.log("trajectory written to validation/out/resilience-low-energy.json");
