import { describe, expect, it } from "vitest";
import { lunarOps } from "../../src/missions/lunarOps";
import { BODIES } from "../../src/core/bodies";
import type { LunarOpsSpec } from "../../src/missions/types";

const R = BODIES.moon.equatorialRadius;
const norm = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
const spec: LunarOpsSpec = {
  loi: "2023-03-21T12:00:00Z", capture: { periAltKm: 100, apoAltKm: 2300 }, circularBy: "2023-04-24T00:00:00Z",
  orbitAltKm: 100, heading: "south", descentStart: "2023-04-25T15:40:00Z", pdiAltKm: 15, pdiDurationS: 600,
  landing: "2023-04-25T16:40:00Z", crash: { freeFallFromKm: 5 }, notes: [],
};

describe("lunar operations model", () => {
  const ops = lunarOps(spec, 47.581, 44.094);
  const { tLoi, tCirc, tEnd, tLand } = ops.times;

  it("starts at the capture perilune", () => {
    expect(norm(ops.at(tLoi)) - R).toBeCloseTo(100, 6);
  });

  it("is continuous where the orbit lowering ends", () => {
    const a = ops.at(tCirc - 0.01);
    const b = ops.at(tCirc + 0.01);
    expect(norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]])).toBeLessThan(0.1);
  });

  it("ends powered descent at rest 5 km above the site, then falls onto it", () => {
    expect(norm(ops.at(tEnd)) - R).toBeCloseTo(5, 6);
    const p = ops.at(tLand);
    expect(norm(p)).toBeCloseTo(R, 3);
    const d = [p[0] / R - ops.siteDir[0], p[1] / R - ops.siteDir[1], p[2] / R - ops.siteDir[2]];
    expect(norm(d)).toBeLessThan(1e-6);
  });

  it("predicts the free-fall impact speed from 5 km (~127 m/s)", () => {
    expect(ops.report.impactSpeedMs).toBeGreaterThan(120);
    expect(ops.report.impactSpeedMs).toBeLessThan(135);
  });
});
