import { sgp4, twoline2satrec } from "satellite.js";
import { loadVerification } from "../test/sgp4/verification";

const id = process.argv[2] ?? "20413#2";
const c = loadVerification("test/fixtures/sgp4").find((k) => k.id === id);
if (!c) throw new Error(`no case ${id}`);

const rec = twoline2satrec(c.line1, c.line2);
for (const row of c.rows) {
  const pv = sgp4(rec, row.tsince);
  const p = pv && typeof pv.position === "object" ? pv.position : null;
  if (!p) {
    console.log(`${row.tsince.toFixed(1).padStart(12)}  propagation error`);
    continue;
  }
  const dr = Math.hypot(p.x - row.r[0], p.y - row.r[1], p.z - row.r[2]);
  const rRef = Math.hypot(...row.r);
  console.log(`${row.tsince.toFixed(1).padStart(12)}  |Δr| = ${dr.toFixed(6).padStart(16)} km   |r_ref| = ${rRef.toFixed(1)} km`);
}