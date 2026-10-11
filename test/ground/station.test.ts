import { describe, expect, it } from "vitest";
import { ecef, lookAngles, stationInertial, type GroundStation } from "../../src/ground/station";

describe("ground station geometry", () => {
  it("places points on the WGS84 ellipsoid", () => {
    const eq = ecef({ name: "", latDeg: 0, lonDeg: 0, altKm: 0 });
    expect(eq[0]).toBeCloseTo(6378.137, 6);
    const pole = ecef({ name: "", latDeg: 90, lonDeg: 0, altKm: 0 });
    expect(pole[2]).toBeCloseTo(6356.752, 3);
  });

  it("sees a target straight above at 90° elevation", () => {
    const s: GroundStation = { name: "", latDeg: 49.69, lonDeg: 6.33, altKm: 0.3 };
    const date = new Date(Date.UTC(2026, 9, 11, 12));
    const st = stationInertial(s, date);
    const r = Math.hypot(...st);
    const above: [number, number, number] = [st[0] * (1 + 1000 / r), st[1] * (1 + 1000 / r), st[2] * (1 + 1000 / r)];
    // Geocentric and geodetic verticals differ by ~0.2° at this latitude
    expect(lookAngles(s, date, above).elDeg).toBeGreaterThan(89.5);
  });
});
