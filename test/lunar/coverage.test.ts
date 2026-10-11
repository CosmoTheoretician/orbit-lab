import { describe, expect, it } from "vitest";
import { relayCoverage, moonBlocks, type RelaySat } from "../../src/lunar/coverage";
import { siteState } from "../../src/ground/planner";
import { moonGeocentric } from "../../src/core/ephemeris";
import { Epoch } from "../../src/core/time";

const start = Date.UTC(2026, 9, 1);
// Near-side centre: Earth is always close to the zenith there
const nearSide = { name: "near-side centre", latDeg: 0, lonDeg: 0 };

describe("relay coverage", () => {
  it("without relays, combined availability equals direct availability", () => {
    const r = relayCoverage(nearSide, [], start, 5);
    expect(r.relayPct).toBe(0);
    expect(r.combinedPct).toBe(r.directPct);
    expect(r.directPct).toBe(100);
  });

  it("a relay hovering 3,000 km above a near-side site is always usable", () => {
    const hover: RelaySat = {
      rel: (tt) => {
        const s = siteState(nearSide, Epoch.fromTT(tt).toDate());
        const m = moonGeocentric(s.ep);
        const k = 1 + 3000 / 1737.4;
        return [(s.pos[0] - m[0]) * k, (s.pos[1] - m[1]) * k, (s.pos[2] - m[2]) * k];
      },
    };
    const r = relayCoverage(nearSide, [hover], start, 5);
    expect(r.relayPct).toBe(100);
    expect(r.meanRelaysInView).toBe(1);
  });

  it("detects when the Moon blocks a line of sight", () => {
    expect(moonBlocks([5000, 0, 0], [-5000, 0, 0])).toBe(true);
    expect(moonBlocks([5000, 0, 0], [5000, 5000, 0])).toBe(false);
  });
});
