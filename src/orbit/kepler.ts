const TWO_PI = 2 * Math.PI;

/** Solves Kepler's equation E − e sin E = M for elliptic orbits (Newton–Raphson). */
export function solveKepler(M: number, e: number): number {
  const Mw = M - TWO_PI * Math.round(M / TWO_PI); // wrap to [-π, π] for robust convergence
  let E = e < 0.8 ? Mw : Mw >= 0 ? Math.PI : -Math.PI;
  for (let k = 0; k < 30; k++) {
    const d = (E - e * Math.sin(E) - Mw) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}