import { mkdir, readFile, writeFile } from "node:fs/promises";
import { reconstructDeparture } from "../src/missions/departure";

/** Stage 2c: Resilience from deployment to the lunar flyby, joined to the saved low-energy solution. */
const transfer = JSON.parse(await readFile("validation/out/resilience-low-energy.json", "utf8")) as { x: number[] };

console.log("Resilience: deployment → flyby with one correction maneuver, Earth–Moon–Sun model");
const t0 = Date.now();
const res = reconstructDeparture(
  {
    launch: "2025-01-15T06:11:39Z",
    deployment: "2025-01-15T07:44:24Z",
    perigeeAltKm: 200,
    firstManeuver: { time: "2025-01-16T19:40:18Z", distanceKm: 250_000 },
    correctionWindow: ["2025-01-18T00:00:00Z", "2025-02-10T00:00:00Z"],
    flyby: { time: "2025-02-14T22:43:00Z", altitudeKm: 8400 },
    flybyX: transfer.x.slice(0, 4),
  },
  (s) => console.log(s),
);
console.log(`solved in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const [k, v] of Object.entries(res.report)) console.log(`  ${k.padEnd(32)} ${v}`);

await mkdir("validation/out", { recursive: true });
await writeFile("validation/out/resilience-departure.json", JSON.stringify({ report: res.report, samples: res.samples, x: res.x }));
console.log("trajectory written to validation/out/resilience-departure.json");
