"""Python port of src/orbit/j2secular.ts, using rotation matrices instead of rotors."""
import numpy as np


def solve_kepler(M, e, iters=30):
    """Solves E - e sin E = M, vectorized (Newton-Raphson)."""
    M = np.asarray(M, dtype=float)
    Mw = M - 2 * np.pi * np.round(M / (2 * np.pi))
    E = Mw.copy() if e < 0.8 else np.where(Mw >= 0, np.pi, -np.pi)
    for _ in range(iters):
        E = E - (E - e * np.sin(E) - Mw) / (1 - e * np.cos(E))
    return E


def j2_secular_positions(el, t, gm, re, j2):
    """Positions [km] at times t [s]; el = (a, e, i, raan, argp, M) in km and rad."""
    a, e, i, raan0, argp0, M0 = el
    n = np.sqrt(gm / a**3)
    p = a * (1 - e**2)
    f = j2 * (re / p) ** 2
    ci, si = np.cos(i), np.sin(i)

    raan = raan0 - 1.5 * n * f * ci * t
    argp = argp0 + 0.75 * n * f * (4 - 5 * si**2) * t
    M = M0 + n * (1 + 0.75 * f * np.sqrt(1 - e**2) * (3 * ci**2 - 1)) * t

    E = solve_kepler(M, e)
    xp = a * (np.cos(E) - e)
    yp = a * np.sqrt(1 - e**2) * np.sin(E)

    # Columns of Rz(raan) Rx(i) Rz(argp): perifocal axes P, Q in inertial coordinates
    cO, sO, cw, sw = np.cos(raan), np.sin(raan), np.cos(argp), np.sin(argp)
    P = np.stack([cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si], axis=1)
    Q = np.stack([-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si], axis=1)
    return xp[:, None] * P + yp[:, None] * Q