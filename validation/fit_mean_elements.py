"""
Fits mean elements of the J2 secular model to the Orekit ephemeris,
the same way TLEs are fitted to tracking data.
"""
import json
from pathlib import Path

import matplotlib
import numpy as np
from scipy.optimize import least_squares

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from j2model import j2_secular_positions

OUT = Path(__file__).parent / "out"
const = json.loads((OUT / "constants.json").read_text())
gm, re, j2 = const["gm"], const["re"], const["j2"]
el0 = const["elements"]
el_vec = np.array([el0[k] for k in ("a", "e", "i", "raan", "argp", "M")])

ts = np.loadtxt(OUT / "j2secular.csv", delimiter=",", skiprows=1)
ok = np.loadtxt(OUT / "orekit_j2.csv", delimiter=",", skiprows=1)
t, r_ok, v_ok = ok[:, 0], ok[:, 1:4], ok[:, 4:7]

# --- 1. the Python port must reproduce the TypeScript ephemeris ---
port_err = np.max(np.linalg.norm(j2_secular_positions(el_vec, ts[:, 0], gm, re, j2) - ts[:, 1:4], axis=1))
print(f"Python port (matrices) vs TypeScript (rotors): max |Δr| = {port_err * 1e6:.4f} mm")
assert port_err < 1e-6, "port does not match the TypeScript model"


# --- 2. fit in nonsingular elements x = (a, e cos ω, e sin ω, i, Ω, λ = ω + M) ---
def to_classical(x):
    a, ex, ey, i, raan, lam = x
    argp = np.arctan2(ey, ex)
    return np.array([a, np.hypot(ex, ey), i, raan, argp, lam - argp])


def residuals(x):
    return (j2_secular_positions(to_classical(x), t, gm, re, j2) - r_ok).ravel()


x0 = np.array([el0["a"], 0.0, 0.0, el0["i"], el0["raan"], el0["argp"] + el0["M"]])
sol = least_squares(residuals, x0, x_scale=[1.0, 1e-4, 1e-4, 1e-4, 1e-4, 1e-4], method="lm")
xf = sol.x
cl = to_classical(xf)

u0 = el0["argp"] + el0["M"]
theory_da = -1.5 * j2 * re**2 / el0["a"] * np.sin(el0["i"]) ** 2 * np.cos(2 * u0)
arcsec = np.degrees(1) * 3600

print(f"\nfit: status {sol.status}, {sol.nfev} evaluations")
print("mean elements relative to the initial (osculating) state:")
print(f"  Δa = {xf[0] - el0['a']:+.4f} km    (first-order theory: {theory_da:+.4f} km)")
print(f"  e  = {cl[1]:.3e}")
print(f"  Δi = {(xf[3] - el0['i']) * arcsec:+.2f} arcsec")
print(f"  ΔΩ = {(xf[4] - el0['raan']) * arcsec:+.2f} arcsec")
print(f"  Δλ = {(xf[5] - x0[5]) * arcsec:+.2f} arcsec")

# --- 3. residuals of the fitted model in the radial / along-track / cross-track frame ---
d = j2_secular_positions(cl, t, gm, re, j2) - r_ok
R = r_ok / np.linalg.norm(r_ok, axis=1, keepdims=True)
C = np.cross(r_ok, v_ok)
C /= np.linalg.norm(C, axis=1, keepdims=True)
I = np.cross(C, R)
comps = {"radial": np.sum(d * R, axis=1), "along-track": np.sum(d * I, axis=1), "cross-track": np.sum(d * C, axis=1)}

print("\nresiduals after the fit:")
for name, c in comps.items():
    print(f"  {name:12s} RMS = {np.sqrt(np.mean(c**2)):7.3f} km   max |Δ| = {np.max(np.abs(c)):7.3f} km")

days = t / 86400
fig, axes = plt.subplots(3, 1, figsize=(10, 8), sharex=True)
for ax, (name, c) in zip(axes, comps.items()):
    ax.plot(days, c, lw=0.8)
    ax.set_ylabel(f"{name} [km]")
    ax.grid(alpha=0.3)
axes[0].set_title("J2 secular model with fitted mean elements minus Orekit numerical (point mass + J2)")
axes[-1].set_xlabel("time since epoch [days]")
fig.tight_layout()
fig.savefig(OUT / "fit_residuals.png", dpi=150)
print(f"\nplot saved to {OUT / 'fit_residuals.png'}")