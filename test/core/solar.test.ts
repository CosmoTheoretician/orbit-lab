import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Epoch } from "../../src/core/time";
import { AU_KM, embHeliocentricScene, planetGeocentric } from "../../src/core/ephemeris";
import { sunGeocentric } from "../../src/core/sun";
import { bodyOrientation, iauAngles } from "../../src/core/rotation";
import { precessionRotor } from "../../src/core/precession";
import type { Vec3 } from "../../src/core/bodies";

const DEG = Math.PI / 180;
const day = 86_400_000;
const norm = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
/** Angle between vectors in degrees, numerically stable for tiny angles. */
const angleDeg = (a: Vec3, b: Vec3) => {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(norm(c), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / DEG;
};

describe("planetary ephemerides", () => {
  it("Earth–Sun vector from the JPL elements agrees with the independent low-precision Sun formula", () => {
    for (let d = 0; d < 365; d += 30) {
      const ep = Epoch.fromUnixMs(Date.UTC(2026, 0, 1) + d * day);
      const sun = sunGeocentric(ep);
      const emb = embHeliocentricScene(ep);
      const fromElements: Vec3 = [-emb[0], -emb[1], -emb[2]];
      expect(angleDeg(sun, fromElements)).toBeLessThan(0.03);
      expect(Math.abs(norm(sun) - norm(fromElements)) / AU_KM).toBeLessThan(5e-4);
    }
  });

  it("Mercury and Venus never exceed their greatest elongations (~28° and ~47°)", () => {
    let mercury = 0;
    let venus = 0;
    for (let d = 0; d < 730; d++) {
      const ep = Epoch.fromUnixMs(Date.UTC(2026, 0, 1) + d * day);
      const s = sunGeocentric(ep);
      mercury = Math.max(mercury, angleDeg(s, planetGeocentric("mercury", ep)));
      venus = Math.max(venus, angleDeg(s, planetGeocentric("venus", ep)));
    }
    expect(mercury).toBeGreaterThan(17.5);
    expect(mercury).toBeLessThan(28.5);
    expect(venus).toBeGreaterThan(45);
    expect(venus).toBeLessThan(47.9);
  });
});

describe("IAU body orientation", () => {
  const ep = Epoch.fromUnixMs(Date.UTC(2026, 9, 11));

  it("points each body's north pole at its IAU right ascension and declination, precessed to date", () => {
    for (const id of ["mars", "jupiter", "saturn", "uranus", "neptune"] as const) {
      const { ra, dec } = iauAngles(id, ep);
      const r = ra * DEG;
      const d = dec * DEG;
      const expected = precessionRotor(ep).apply([Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)]);
      expect(angleDeg(bodyOrientation(id, ep).apply([0, 0, 1]), expected)).toBeLessThan(1e-9);
    }
  });

  it("rotor and quaternion forms describe the same rotation", () => {
    const R = bodyOrientation("jupiter", ep);
    const q = new THREE.Quaternion(...R.toQuaternion());
    const viaQuaternion = new THREE.Vector3(1.2, -0.7, 3.1).applyQuaternion(q);
    const viaRotor = R.apply([1.2, -0.7, 3.1]);
    expect(Math.hypot(viaQuaternion.x - viaRotor[0], viaQuaternion.y - viaRotor[1], viaQuaternion.z - viaRotor[2])).toBeLessThan(1e-12);
  });

  it("turns Mars once per sidereal day (24.6229 h)", () => {
    const periodMs = (360 / 350.89198226) * day;
    const a = bodyOrientation("mars", ep).apply([1, 0, 0]);
    const b = bodyOrientation("mars", Epoch.fromUnixMs(ep.toUnixMs() + periodMs)).apply([1, 0, 0]);
    expect(angleDeg(a, b)).toBeLessThan(0.01);
  });
});
