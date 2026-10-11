import { describe, expect, it } from "vitest";
import { J2SecularPropagator, type MeanElements } from "../../src/orbit/j2secular";
import { bivectorNorm, wedge } from "../../src/core/ga";
import { BODIES } from "../../src/core/bodies";

const DEG = Math.PI / 180;
const wrapPi = (x: number) => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));

const el: MeanElements = { a: 14378, e: 0.01, i: 70 * DEG, raan: 30 * DEG, argp: 45 * DEG, M: 10 * DEG };

/** Orbital plane read from the bivector L = r∧v. Its dual h = (L23, L31, L12) is the angular momentum. */
function planeOf(r: [number, number, number], v: [number, number, number]) {
  const L = wedge(r, v);
  const h = Math.sqrt(L.b23 ** 2 + L.b31 ** 2 + L.b12 ** 2);
  return { raan: Math.atan2(L.b23, -L.b31), inc: Math.acos(L.b12 / h), h };
}

describe("J2 secular propagator", () => {
  it("without J2 the orbit closes after one period and |r∧v| = sqrt(μp)", () => {
    const prop = new J2SecularPropagator(el, BODIES.earth.gm, BODIES.earth.equatorialRadius, 0);
    const T = (2 * Math.PI) / prop.rates.n;
    const s0 = prop.stateAt(0);
    const s1 = prop.stateAt(T);
    expect(Math.hypot(s1.r[0] - s0.r[0], s1.r[1] - s0.r[1], s1.r[2] - s0.r[2])).toBeLessThan(1e-6);

    const expected = Math.sqrt(BODIES.earth.gm * el.a * (1 - el.e ** 2));
    for (const t of [0, T / 3, T / 2, 2 * T]) {
      const s = prop.stateAt(t);
      expect(bivectorNorm(wedge(s.r, s.v)) / expected).toBeCloseTo(1, 12);
    }
  });

  it("the plane bivector r∧v regresses at exactly the secular J2 rate", () => {
    const prop = new J2SecularPropagator(el);
    for (const days of [0, 1, 10, 30]) {
      const t = days * 86400;
      const s = prop.stateAt(t);
      const plane = planeOf(s.r, s.v);
      expect(Math.abs(wrapPi(plane.raan - (el.raan + prop.rates.raanDot * t)))).toBeLessThan(1e-12);
      expect(Math.abs(plane.inc - el.i)).toBeLessThan(1e-12);
    }
  });
});