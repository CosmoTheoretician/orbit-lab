import { BODIES, type Vec3 } from "../core/bodies";
import { Rotor } from "../core/ga";
import { solveKepler } from "./kepler";

/** Mean orbital elements. Units: km, rad. */
export interface MeanElements {
  a: number;
  e: number;
  i: number;
  raan: number;
  argp: number;
  M: number;
}

/** Secular rates, rad/s. */
export interface J2Rates {
  n: number;
  raanDot: number;
  argpDot: number;
  mDot: number;
}

/** First-order secular J2 rates (Brouwer/Kozai). */
export function j2SecularRates(
  el: MeanElements,
  gm = BODIES.earth.gm,
  re = BODIES.earth.equatorialRadius,
  j2 = BODIES.earth.j2,
): J2Rates {
  const n = Math.sqrt(gm / el.a ** 3);
  const p = el.a * (1 - el.e ** 2);
  const f = j2 * (re / p) ** 2;
  const ci = Math.cos(el.i);
  const si2 = Math.sin(el.i) ** 2;
  return {
    n,
    raanDot: -1.5 * n * f * ci,                                   // node regresses in the equatorial plane
    argpDot: 0.75 * n * f * (4 - 5 * si2),                        // perigee rotates in the orbital plane
    mDot: n * (1 + 0.75 * f * Math.sqrt(1 - el.e ** 2) * (3 * ci * ci - 1)),
  };
}

/**
 * Mean-element propagator: Keplerian motion plus secular J2 drift of Ω, ω and M.
 * Output is Earth-centred inertial, equatorial axes (shown in the TEME scene frame).
 * Simplification: velocity is the Keplerian velocity in the instantaneous mean plane;
 * the slow rotation of that plane itself (|Ω̇|/n ~ 3e-4 at MEO) is not added.
 */
export class J2SecularPropagator {
  readonly el: MeanElements;
  readonly rates: J2Rates;
  private readonly gm: number;

  constructor(el: MeanElements, gm = BODIES.earth.gm, re = BODIES.earth.equatorialRadius, j2 = BODIES.earth.j2) {
    this.el = el;
    this.gm = gm;
    this.rates = j2SecularRates(el, gm, re, j2);
  }

  /**
   * Rotor taking perifocal axes to inertial axes, dt seconds after the element epoch:
   * turn by ω within the orbital plane, tilt by i, then turn by Ω in the equator.
   */
  orientationAt(dt: number): Rotor {
    const raan = this.el.raan + this.rates.raanDot * dt;
    const argp = this.el.argp + this.rates.argpDot * dt;
    return Rotor.inPlane("e12", raan).mul(Rotor.inPlane("e23", this.el.i)).mul(Rotor.inPlane("e12", argp));
  }

  /** State dt seconds after the element epoch. km, km/s. */
  stateAt(dt: number): { r: Vec3; v: Vec3 } {
    const { a, e } = this.el;
    const M = this.el.M + this.rates.mDot * dt;

    const E = solveKepler(M, e);
    const cE = Math.cos(E);
    const sE = Math.sin(E);
    const q = Math.sqrt(1 - e * e);
    const rPf: Vec3 = [a * (cE - e), a * q * sE, 0];
    const vScale = Math.sqrt(this.gm / a) / (1 - e * cE);
    const vPf: Vec3 = [-vScale * sE, vScale * q * cE, 0];

    const R = this.orientationAt(dt);
    return { r: R.apply(rPf), v: R.apply(vPf) };
  }
}