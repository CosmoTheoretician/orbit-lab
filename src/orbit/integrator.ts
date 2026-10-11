/** dy/dt = f(t, y), written into `out`. */
export type Deriv = (t: number, y: Float64Array, out: Float64Array) => void;

export interface IntegrateOptions {
  rtol?: number;
  atol?: number;
  /** Initial step size magnitude, s. */
  h0?: number;
  /** Called after every accepted step; return true to stop. */
  onStep?: (t: number, y: Float64Array) => boolean | void;
}

// Dormand–Prince 5(4) coefficients
const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const A: number[][] = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];

/**
 * Adaptive Dormand–Prince 5(4) with error control and FSAL; integrates forward or backward.
 * Returns the final time and state.
 */
export function integrate(f: Deriv, t0: number, y0: ArrayLike<number>, t1: number, o: IntegrateOptions = {}) {
  const n = y0.length;
  const dir = Math.sign(t1 - t0) || 1;
  const rtol = o.rtol ?? 1e-10;
  const atol = o.atol ?? 1e-9;
  let t = t0;
  const y = Float64Array.from(y0);
  let h = dir * Math.min(Math.abs(o.h0 ?? 60), Math.abs(t1 - t0) || 1);

  const k = Array.from({ length: 7 }, () => new Float64Array(n));
  const tmp = new Float64Array(n);
  f(t, y, k[0]);
  if (o.onStep?.(t, y)) return { t, y };

  let steps = 0;
  while (dir * (t1 - t) > 0) {
    if (++steps > 2_000_000) throw new Error("integrator: too many steps");
    if (dir * (t + h - t1) > 0) h = t1 - t;

    for (let s = 1; s < 7; s++) {
      for (let i = 0; i < n; i++) {
        let acc = y[i];
        for (let j = 0; j < s; j++) acc += h * A[s][j] * k[j][i];
        tmp[i] = acc;
      }
      f(t + C[s] * h, tmp, k[s]); // stage 7 is evaluated at the 5th-order solution (FSAL)
    }

    let err = 0;
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let j = 0; j < 7; j++) e += (B5[j] - B4[j]) * k[j][i];
      const sc = atol + rtol * Math.max(Math.abs(y[i]), Math.abs(tmp[i]));
      err = Math.max(err, Math.abs(h * e) / sc);
    }

    if (err <= 1) {
      t += h;
      y.set(tmp);
      k[0].set(k[6]);
      if (o.onStep?.(t, y)) break;
      h *= err === 0 ? 5 : Math.min(5, Math.max(0.2, 0.9 * Math.pow(err, -0.2)));
    } else {
      h *= Math.max(0.2, 0.9 * Math.pow(err, -0.2));
    }
  }
  return { t, y };
}
