import { describe, expect, it } from "vitest";
import { Rotor } from "../../src/core/ga";
import type { Vec3 } from "../../src/core/bodies";

// Classical rotation matrices, applied directly: the independent reference
const rz = (t: number, [x, y, z]: Vec3): Vec3 => [Math.cos(t) * x - Math.sin(t) * y, Math.sin(t) * x + Math.cos(t) * y, z];
const rx = (t: number, [x, y, z]: Vec3): Vec3 => [x, Math.cos(t) * y - Math.sin(t) * z, Math.sin(t) * y + Math.cos(t) * z];

// Deterministic pseudo-random numbers so failures are reproducible
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

describe("rotors", () => {
  it("R_Ω R_i R_ω matches the 3-1-3 rotation matrix Rz(Ω) Rx(i) Rz(ω)", () => {
    for (let n = 0; n < 1000; n++) {
      const raan = rand() * 2 * Math.PI;
      const inc = rand() * Math.PI;
      const argp = rand() * 2 * Math.PI;
      const v: Vec3 = [rand() * 2e4 - 1e4, rand() * 2e4 - 1e4, rand() * 2e4 - 1e4];

      const R = Rotor.inPlane("e12", raan).mul(Rotor.inPlane("e23", inc)).mul(Rotor.inPlane("e12", argp));
      const ga = R.apply(v);
      const mat = rz(raan, rx(inc, rz(argp, v)));

      for (let k = 0; k < 3; k++) expect(Math.abs(ga[k] - mat[k])).toBeLessThan(1e-9); // km, at 10^4 km scale
    }
  });

  it("composed rotors stay normalised (R R̃ = 1)", () => {
    const R = Rotor.inPlane("e12", 1.1).mul(Rotor.inPlane("e23", 0.7)).mul(Rotor.inPlane("e31", -2.3));
    const RR = R.mul(R.reverse());
    expect(RR.s).toBeCloseTo(1, 14);
    expect(Math.hypot(RR.b12, RR.b23, RR.b31)).toBeLessThan(1e-15);
  });
});