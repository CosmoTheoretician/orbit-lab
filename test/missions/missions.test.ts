import { describe, expect, it } from "vitest";
import { MISSIONS } from "../../src/missions/catalog";
import { parseCoverage, parseHorizonsVectors } from "../../src/missions/horizons";
import { sampleTrack, type Track } from "../../src/missions/track";
import { BODIES } from "../../src/core/bodies";

describe("mission catalog", () => {
  it("has unique ids and valid fields", () => {
    expect(new Set(MISSIONS.map((m) => m.id)).size).toBe(MISSIONS.length);
    for (const m of MISSIONS) {
      if (m.site) {
        expect(Math.abs(m.site.lat)).toBeLessThanOrEqual(90);
        expect(m.site.lon).toBeGreaterThan(-180);
        expect(m.site.lon).toBeLessThanOrEqual(180);
      }
      if (m.outcome === "planned") expect(m.horizons).toBeUndefined();
      if (m.horizons) expect(Date.parse(m.horizons.stop)).toBeGreaterThan(Date.parse(m.horizons.start));
    }
  });

  it("lists both government and commercial missions, flown and planned", () => {
    for (const sector of ["government", "commercial"] as const) {
      expect(MISSIONS.some((m) => m.sector === sector && m.outcome !== "planned")).toBe(true);
      expect(MISSIONS.some((m) => m.sector === sector && m.outcome === "planned")).toBe(true);
    }
  });
});

describe("Horizons parsing", () => {
  const text = `header
$$SOE
2460356.500000000, A.D. 2024-Feb-16 00:00:00.0000,  1.0E+05,  2.0E+05, -3.0E+04,  1.5, -0.5,  0.25,
2460356.506944444, A.D. 2024-Feb-16 00:10:00.0000,  1.1E+05,  2.1E+05, -3.1E+04,  1.4, -0.6,  0.24,
$$EOE
footer`;

  it("reads time (TDB seconds since J2000), position and velocity", () => {
    const s = parseHorizonsVectors(text);
    expect(s).toHaveLength(2);
    expect(s[0].t).toBeCloseTo((2460356.5 - 2451545) * 86400, 3);
    expect(s[1].t - s[0].t).toBeCloseTo(600, 2);
    expect(s[0].r).toEqual([1e5, 2e5, -3e4]);
    expect(s[1].v).toEqual([1.4, -0.6, 0.24]);
  });

  it("reads coverage limits from Horizons' out-of-range messages", () => {
    const cov = parseCoverage("No ephemeris for target \"X\" prior to A.D. 2024-FEB-15 07:11:36.4880 TD");
    expect(cov.earliest?.toISOString()).toBe("2024-02-15T07:11:36.000Z");
    expect(cov.latest).toBeUndefined();
  });
});

describe("track interpolation", () => {
  it("reproduces a low lunar orbit to better than 1 km from 10-minute samples", () => {
    // Circular orbit 100 km above the Moon: the hardest case for the sampling used in fetch-missions
    const r = BODIES.moon.equatorialRadius + 100;
    const w = Math.sqrt(BODIES.moon.gm / r ** 3);
    const at = (t: number) => [r * Math.cos(w * t), r * Math.sin(w * t), 0];
    const vel = (t: number) => [-r * w * Math.sin(w * t), r * w * Math.cos(w * t), 0];

    const times = Array.from({ length: 30 }, (_, k) => k * 600);
    const tr: Track = {
      t: Float64Array.from(times),
      r: Float64Array.from(times.flatMap(at)),
      v: Float64Array.from(times.flatMap(vel)),
    };
    let worst = 0;
    for (let t = 0; t < times[times.length - 1]; t += 37) {
      const p = sampleTrack(tr, t)!;
      const q = at(t);
      worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    expect(worst).toBeLessThan(1);
  });
});
