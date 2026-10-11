import { describe, expect, it } from "vitest";
import { integrate } from "../../src/orbit/integrator";

const mu = 398600.4418;
const twoBody = (_t: number, y: Float64Array, o: Float64Array) => {
  const r3 = Math.pow(y[0] ** 2 + y[1] ** 2 + y[2] ** 2, 1.5);
  o[0] = y[3]; o[1] = y[4]; o[2] = y[5];
  o[3] = (-mu * y[0]) / r3; o[4] = (-mu * y[1]) / r3; o[5] = (-mu * y[2]) / r3;
};

describe("Dormand–Prince integrator", () => {
  const r0 = 7000;
  const v0 = Math.sqrt(mu / r0);
  const T = 2 * Math.PI * Math.sqrt(r0 ** 3 / mu);
  const start = [r0, 0, 0, 0, v0, 0];

  it("closes a circular orbit after 10 periods to within 10 m", () => {
    const { y } = integrate(twoBody, 0, start, 10 * T);
    expect(Math.hypot(y[0] - r0, y[1], y[2])).toBeLessThan(0.01);
  });

  /** Forward one day, then backward to t = 0: error in km. */
  const roundTrip = (rtol: number) => {
    const fwd = integrate(twoBody, 0, start, 86400, { rtol });
    const back = integrate(twoBody, 86400, fwd.y, 0, { rtol });
    return Math.hypot(back.y[0] - r0, back.y[1], back.y[2]);
  };

  it("integrates backward to the starting state, with error shrinking as the tolerance tightens", () => {
    const coarse = roundTrip(1e-10);
    const fine = roundTrip(1e-12);
    expect(coarse).toBeLessThan(0.01); // ~34 orbits out and back
    expect(fine).toBeLessThan(coarse / 10); // converges: 100× tighter tolerance → >10× smaller error
  });
});
