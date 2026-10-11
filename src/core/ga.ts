import type { Vec3 } from "./bodies";

/** Bivector in G(3,0): b12 e1∧e2 + b23 e2∧e3 + b31 e3∧e1. */
export interface Bivector {
  b12: number;
  b23: number;
  b31: number;
}

/** Outer product a∧b: the oriented plane spanned by a and b, with area |a||b|sin θ. */
export function wedge(a: Vec3, b: Vec3): Bivector {
  return {
    b12: a[0] * b[1] - a[1] * b[0],
    b23: a[1] * b[2] - a[2] * b[1],
    b31: a[2] * b[0] - a[0] * b[2],
  };
}

export function bivectorNorm(B: Bivector): number {
  return Math.hypot(B.b12, B.b23, B.b31);
}

/**
 * Rotor R = s + B in the even subalgebra of G(3,0), with R R̃ = 1.
 * Vectors rotate by the sandwich product v' = R v R̃.
 * (Isomorphic to unit quaternions; the GA form names a rotation by its plane, not by an axis.)
 */
export class Rotor {
  readonly s: number;
  readonly b12: number;
  readonly b23: number;
  readonly b31: number;

  constructor(s: number, b12: number, b23: number, b31: number) {
    this.s = s;
    this.b12 = b12;
    this.b23 = b23;
    this.b31 = b31;
  }

  static identity(): Rotor {
    return new Rotor(1, 0, 0, 0);
  }

  /**
   * Rotation by `angle` within the oriented plane `plane`: R = exp(-B·angle/2).
   * e12 turns e1 toward e2, e23 turns e2 toward e3, e31 turns e3 toward e1.
   */
  static inPlane(plane: "e12" | "e23" | "e31", angle: number): Rotor {
    const c = Math.cos(angle / 2);
    const sn = -Math.sin(angle / 2);
    return new Rotor(c, plane === "e12" ? sn : 0, plane === "e23" ? sn : 0, plane === "e31" ? sn : 0);
  }

  /** Geometric product this·o. As a rotation, `o` acts first, then `this`. */
  mul(o: Rotor): Rotor {
    return new Rotor(
      this.s * o.s - this.b12 * o.b12 - this.b23 * o.b23 - this.b31 * o.b31,
      this.s * o.b12 + this.b12 * o.s + this.b31 * o.b23 - this.b23 * o.b31,
      this.s * o.b23 + this.b23 * o.s + this.b12 * o.b31 - this.b31 * o.b12,
      this.s * o.b31 + this.b31 * o.s + this.b23 * o.b12 - this.b12 * o.b23,
    );
  }

  /** Reverse R̃: flips the sign of the bivector part. */
  reverse(): Rotor {
    return new Rotor(this.s, -this.b12, -this.b23, -this.b31);
  }

  /**
   * v' = R v R̃. Expanded with b = (b23, b31, b12), the dual vector of B (B = I b):
   * v' = (s² − |b|²) v − 2s (b × v) + 2 (b·v) b
   */
  apply(v: Vec3): Vec3 {
    const bx = this.b23;
    const by = this.b31;
    const bz = this.b12;
    const [x, y, z] = v;
    const cx = by * z - bz * y;
    const cy = bz * x - bx * z;
    const cz = bx * y - by * x;
    const dot = bx * x + by * y + bz * z;
    const k = this.s * this.s - (bx * bx + by * by + bz * bz);
    return [
      k * x - 2 * this.s * cx + 2 * dot * bx,
      k * y - 2 * this.s * cy + 2 * dot * by,
      k * z - 2 * this.s * cz + 2 * dot * bz,
    ];
  }

  /**
   * The same rotation as a unit quaternion [x, y, z, w] (three.js order).
   * Comparing the sandwich formula above with quaternion rotation gives q = (s, −b).
   */
  toQuaternion(): [number, number, number, number] {
    return [-this.b23, -this.b31, -this.b12, this.s];
  }
}
