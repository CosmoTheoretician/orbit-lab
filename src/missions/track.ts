import type { Vec3 } from "../core/bodies";

/** Time-ordered states: t in seconds (TDB since J2000), r and v flattened (km, km/s). */
export interface Track {
  t: Float64Array;
  r: Float64Array;
  v: Float64Array;
}

/** Index of the last sample at or before `time`, or -1 before the start. */
export function indexAt(tr: Track, time: number): number {
  const n = tr.t.length;
  if (n === 0 || time < tr.t[0]) return -1;
  if (time >= tr.t[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr.t[mid] <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Cubic Hermite interpolation from positions and velocities: exact for cubic motion,
 * and accurate to ~0.4 km for 10-minute samples even in low lunar orbit.
 * Returns null outside the track.
 */
export function sampleTrack(tr: Track, time: number, out: Vec3 = [0, 0, 0]): Vec3 | null {
  const n = tr.t.length;
  if (n === 0 || time < tr.t[0] || time > tr.t[n - 1]) return null;
  const i = Math.min(indexAt(tr, time), n - 2);
  if (i < 0) {
    out[0] = tr.r[0]; out[1] = tr.r[1]; out[2] = tr.r[2];
    return out;
  }
  const h = tr.t[i + 1] - tr.t[i];
  const s = h > 0 ? (time - tr.t[i]) / h : 0;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  for (let k = 0; k < 3; k++) {
    out[k] =
      h00 * tr.r[3 * i + k] + h10 * h * tr.v[3 * i + k] +
      h01 * tr.r[3 * (i + 1) + k] + h11 * h * tr.v[3 * (i + 1) + k];
  }
  return out;
}
