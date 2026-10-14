import { mkdir, writeFile } from "node:fs/promises";
import { MISSIONS } from "../src/missions/catalog";
import { lunarOps } from "../src/missions/lunarOps";
import { reconstructGlobal } from "../src/missions/global";

const m = MISSIONS.find((x) => x.id === "resilience");
if (!m?.lunarOps || !m.site) throw new Error("Resilience lunar-operations spec not found in the catalog");
const ops = lunarOps(m.lunarOps, m.site.lat, m.site.lon);

console.log("Resilience: global search with a single loop after the flyby (stays beyond 250,000 km)");
const t0 = Date.now();
const res = reconstructGlobal(
  {
    launch: "2025-01-15T06:11:39Z",
    deployment: "2025-01-15T07:44:24Z",
    perigeeAltKm: 200,
    firstManeuver: { time: "2025-01-16T19:40:18Z", distanceKm: 250_000 },
    correctionWindow: ["2025-01-18T00:00:00Z", "2025-02-10T00:00:00Z"],
    flyby: { time: "2025-02-14T22:43:00Z", altitudeKm: 8400 },
    dsmWindow: ["2025-03-04T00:00:00Z", "2025-04-24T10:00:00Z"],
    apogee: { distanceKm: 1_100_000, by: "2025-03-04T00:00:00Z" },
    loi: { time: m.lunarOps.loi, periAltKm: m.lunarOps.capture.periAltKm },
    capture: m.lunarOps.capture,
    planeNormal: ops.normal,
    apogeeMinKm: 900_000,
    keepFlybys: 1000,
    minEarthAfterFlybyKm: 250_000,
  },
  (s) => console.log(s),
);
console.log(`solved in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const [k, v] of Object.entries(res.report)) console.log(`  ${k.padEnd(28)} ${v}`);

await mkdir("validation/out", { recursive: true });
await writeFile("validation/out/resilience-single-loop.json", JSON.stringify(res));
console.log("trajectory written to validation/out/resilience-single-loop.json");
