import { mkdirSync, writeFileSync } from "node:fs";
import { BODIES } from "../src/core/bodies";
import { J2SecularPropagator } from "../src/orbit/j2secular";
import { MEOSPHERE_PHASE1, walkerDelta } from "../src/orbit/walker";

/** Exports the J2 secular ephemeris of the first meoSphere satellite for external validation. */
const DAYS = 7;
const STEP_S = 300;

const el = walkerDelta(MEOSPHERE_PHASE1)[0];
const prop = new J2SecularPropagator(el);

const rows = ["t_s,x_km,y_km,z_km,vx_kms,vy_kms,vz_kms"];
for (let t = 0; t <= DAYS * 86400; t += STEP_S) {
  const { r, v } = prop.stateAt(t);
  rows.push([String(t), ...[...r, ...v].map((x) => x.toPrecision(17))].join(","));
}

mkdirSync("validation/out", { recursive: true });
writeFileSync("validation/out/j2secular.csv", rows.join("\n"));
writeFileSync(
  "validation/out/constants.json",
  JSON.stringify({ gm: BODIES.earth.gm, re: BODIES.earth.equatorialRadius, j2: BODIES.earth.j2, elements: el }, null, 2),
);
console.log(`wrote ${rows.length - 1} states over ${DAYS} days`);