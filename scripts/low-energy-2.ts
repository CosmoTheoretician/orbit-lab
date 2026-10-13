import { readFile, writeFile } from "node:fs/promises";
import { MISSIONS } from "../src/missions/catalog";
import { lunarOps } from "../src/missions/lunarOps";
import { refineTwoBurns } from "../src/missions/lowEnergy2";

/** Refines the one-maneuver Resilience solution with a post-flyby correction, tracing the Δv / apogee trade-off. */
const m = MISSIONS.find((x) => x.id === "resilience");
if (!m?.lunarOps || !m.site) throw new Error("Resilience lunar-operations spec not found in the catalog");
const ops = lunarOps(m.lunarOps, m.site.lat, m.site.lon);
const prev = JSON.parse(await readFile("validation/out/resilience-low-energy.json", "utf8")) as { x: number[] };

console.log("Resilience: two maneuvers (post-flyby correction + deep-space maneuver), published 1.1 million km apogee as target");
const t0 = Date.now();
const { results, samplesFor } = refineTwoBurns(
  {
    launch: "2025-01-15T06:11:39Z",
    flyby: { time: "2025-02-14T22:43:00Z", altitudeKm: 8400 },
    burn1Window: ["2025-02-16T00:00:00Z", "2025-03-04T00:00:00Z"],
    dsmWindow: ["2025-03-04T00:00:00Z", "2025-04-24T10:00:00Z"],
    apogee: { distanceKm: 1_100_000, by: "2025-03-04T00:00:00Z" },
    loi: { time: m.lunarOps.loi, periAltKm: m.lunarOps.capture.periAltKm },
    capture: m.lunarOps.capture,
    planeNormal: ops.normal,
  },
  prev.x,
  [960_000, 1_000_000, 1_040_000, 1_080_000, 1_100_000],
  (s) => console.log(s),
);
console.log(`solved in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

if (results.length > 0) {
  const final = results[results.length - 1];
  await writeFile(
    "validation/out/resilience-low-energy-2.json",
    JSON.stringify({ results: results.map((r) => ({ ...r, res: { ...r.res, F: undefined } })), post: samplesFor(final.x) }),
  );
  console.log("trajectory written to validation/out/resilience-low-energy-2.json");
}
