import { describe, expect, it } from "vitest";
import { lunarPhase } from "../../src/missions/reconstruct";
import { BODIES } from "../../src/core/bodies";
import type { ReconstructionSpec } from "../../src/missions/types";

const R = BODIES.moon.equatorialRadius;
const spec: ReconstructionSpec = {
  tli: "2025-02-27T01:00:00Z", parkAltKm: 200, loi: { time: "2025-03-03T12:22:54Z" },
  orbitAltKm: 100, doi: "2025-03-06T09:33:00Z", pdiAltKm: 13, pdiDurationS: 680,
  landing: "2025-03-06T17:28:50Z", heading: "south", notes: [],
};
const norm = (v: number[]) => Math.hypot(v[0], v[1], v[2]);

describe("lunar phase reconstruction", () => {
  const lp = lunarPhase(spec, -84.7906, 29.1957);

  it("ends exactly on the landing site at the landing time", () => {
    const p = lp.at(lp.tLand);
    expect(norm(p)).toBeCloseTo(R, 6);
    const d = [p[0] / R - lp.siteDir[0], p[1] / R - lp.siteDir[1], p[2] / R - lp.siteDir[2]];
    expect(norm(d)).toBeLessThan(1e-9);
  });

  it("flies the published altitudes: 100 km circular orbit, 13 km at PDI", () => {
    expect(norm(lp.at(lp.tDoi - 3600)) - R).toBeCloseTo(100, 6);
    expect(norm(lp.at(lp.tPdi)) - R).toBeCloseTo(13, 6);
  });

  it("is continuous at descent orbit insertion and places DOI near the published time", () => {
    const a = lp.at(lp.tDoi - 0.01);
    const b = lp.at(lp.tDoi + 0.01);
    expect(norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]])).toBeLessThan(0.1);
    const published = Date.parse("2025-03-06T09:33:00Z") / 1000;
    const modeled = lp.tDoi + Date.UTC(2000, 0, 1, 12) / 1000 - 69.184; // TT since J2000 → Unix (approx.)
    expect(Math.abs(modeled - published)).toBeLessThan(3600);
  });
});
