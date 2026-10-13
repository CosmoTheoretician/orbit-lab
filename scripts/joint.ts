import { mkdir, readFile, writeFile } from "node:fs/promises";
import { MISSIONS } from "../src/missions/catalog";
import { lunarOps } from "../src/missions/lunarOps";
import { reconstructJoint } from "../src/missions/joint";

/** Resilience, deployment → LOI solved jointly, starting from the departure and low-energy solutions. */
const m = MISSIONS.find((x) => x.id === "resilience");
if (!m?.lunarOps || !m.site) throw new Error("Resilience lunar-operations spec not found in the catalog");
const ops = lunarOps(m.lunarOps, m.site.lat, m.site.lon);

const dep = JSON.parse(await readFile("validation/out/resilience-departure.json", "utf8")) as {
  x: number[];
  report: Record<string, unknown>;
};
const le = JSON.parse(await readFile("validation/out/resilience-low-energy.json", "utf8")) as { x: number[] };

const DEPLOYMENT = "2025-01-15T07:44:24Z";
const periMin = (Date.parse(DEPLOYMENT) - Date.parse(String(dep.report.perigeeAt))) / 60000;
const x0 = [dep.x[0], dep.x[1], dep.x[2], dep.x[3], periMin, dep.x[5], ...le.x];

console.log("Resilience: joint solve, deployment → correction → flyby → DSM → LOI, Earth–Moon–Sun model");
const t0 = Date.now();
const res = reconstructJoint(
  {
    launch: "2025-01-15T06:11:39Z",
    deployment: DEPLOYMENT,
    perigeeAltKm: 200,
    firstManeuver: { time: "2025-01-16T19:40:18Z", distanceKm: 250_000 },
    correctionWindow: ["2025-01-18T00:00:00Z", "2025-02-10T00:00:00Z"],
    flyby: { time: "2025-02-14T22:43:00Z", altitudeKm: 8400 },
    dsmWindow: ["2025-03-04T00:00:00Z", "2025-04-24T10:00:00Z"],
    apogee: { distanceKm: 1_100_000, by: "2025-03-04T00:00:00Z" },
    loi: { time: m.lunarOps.loi, periAltKm: m.lunarOps.capture.periAltKm },
    capture: m.lunarOps.capture,
    planeNormal: ops.normal,
    correctionCapMs: 50,
    steps: 8,
  },
  x0,
  (s) => console.log(s),
);
console.log(`solved in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const [k, v] of Object.entries(res.report)) console.log(`  ${k.padEnd(28)} ${v}`);

await mkdir("validation/out", { recursive: true });
await writeFile("validation/out/resilience-joint.json", JSON.stringify(res));
console.log("trajectory written to validation/out/resilience-joint.json");
