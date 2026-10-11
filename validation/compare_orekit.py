"""
Compares the TypeScript J2 secular model against Orekit numerical propagation.

Orekit is given exactly the same physics (point mass + J2 with identical mu, Re, J2,
acting about the inertial z-axis), so the remaining differences come from the models
themselves: short-period J2 terms and the mean-vs-osculating initial state.
"""
import json
from pathlib import Path

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt

import orekit_jpype as orekit

orekit.initVM()
from orekit_jpype.pyhelpers import setup_orekit_data

setup_orekit_data()

from org.hipparchus.geometry.euclidean.threed import Vector3D
from org.hipparchus.ode.nonstiff import DormandPrince853Integrator
from org.orekit.forces.gravity import J2OnlyPerturbation
from org.orekit.frames import FramesFactory
from org.orekit.orbits import CartesianOrbit, OrbitType
from org.orekit.propagation import SpacecraftState
from org.orekit.propagation.numerical import NumericalPropagator
from org.orekit.time import AbsoluteDate, TimeScalesFactory
from org.orekit.utils import PVCoordinates

OUT = Path(__file__).parent / "out"

# --- the TypeScript ephemeris and the constants it used (converted to SI) ---
const = json.loads((OUT / "constants.json").read_text())
mu = const["gm"] * 1e9
re = const["re"] * 1e3
j2 = const["j2"]

data = np.loadtxt(OUT / "j2secular.csv", delimiter=",", skiprows=1)
t = data[:, 0]
r_ts = data[:, 1:4] * 1e3
v_ts = data[:, 4:7] * 1e3

# --- Orekit: same initial state, same physics ---
# EME2000 serves as both the inertial frame and the J2 frame, so J2 acts about the
# same z-axis as in the TypeScript model (no precession/nutation mismatch).
frame = FramesFactory.getEME2000()
epoch = AbsoluteDate(2026, 10, 11, 0, 0, 0.0, TimeScalesFactory.getUTC())
pv0 = PVCoordinates(Vector3D(*map(float, r_ts[0])), Vector3D(*map(float, v_ts[0])))
orbit = CartesianOrbit(pv0, frame, epoch, mu)

integrator = DormandPrince853Integrator(1e-3, 300.0, 1e-6, 1e-12)  # min step, max step, abs tol [m], rel tol
propagator = NumericalPropagator(integrator)
propagator.setOrbitType(OrbitType.CARTESIAN)
propagator.addForceModel(J2OnlyPerturbation(mu, re, j2, frame))
propagator.setInitialState(SpacecraftState(orbit))

generator = propagator.getEphemerisGenerator()
propagator.propagate(epoch, epoch.shiftedBy(float(t[-1])))
ephemeris = generator.getGeneratedEphemeris()

r_ok = np.empty_like(r_ts)
v_ok = np.empty_like(v_ts)
for k, tk in enumerate(t):
    pv = ephemeris.getPVCoordinates(epoch.shiftedBy(float(tk)), frame)
    p, v = pv.getPosition(), pv.getVelocity()
    r_ok[k] = [p.getX(), p.getY(), p.getZ()]
    v_ok[k] = [v.getX(), v.getY(), v.getZ()]

np.savetxt(
    OUT / "orekit_j2.csv",
    np.column_stack([t, r_ok / 1e3, v_ok / 1e3]),
    delimiter=",",
    header="t_s,x_km,y_km,z_km,vx_kms,vy_kms,vz_kms",
    comments="",
)

# --- differences in the radial / in-track / cross-track frame of the Orekit reference ---
R = r_ok / np.linalg.norm(r_ok, axis=1, keepdims=True)
C = np.cross(r_ok, v_ok)
C /= np.linalg.norm(C, axis=1, keepdims=True)
I = np.cross(C, R)
d = (r_ts - r_ok) / 1e3  # km
radial = np.sum(d * R, axis=1)
intrack = np.sum(d * I, axis=1)
crosstrack = np.sum(d * C, axis=1)

days = t / 86400
print(f"duration {days[-1]:.1f} days, {len(t)} samples")
for name, comp in (("radial", radial), ("along-track", intrack), ("cross-track", crosstrack)):
    print(f"  {name:12s} max |Δ| = {np.max(np.abs(comp)):10.3f} km   final = {comp[-1]:10.3f} km")

fig, axes = plt.subplots(3, 1, figsize=(10, 8), sharex=True)
for ax, comp, label in zip(axes, (radial, intrack, crosstrack), ("radial", "along-track", "cross-track")):
    ax.plot(days, comp, lw=0.8)
    ax.set_ylabel(f"{label} [km]")
    ax.grid(alpha=0.3)
axes[0].set_title("J2 secular model (TypeScript) minus Orekit numerical (point mass + J2)")
axes[-1].set_xlabel("time since epoch [days]")
fig.tight_layout()
fig.savefig(OUT / "j2_vs_orekit.png", dpi=150)
print(f"plot saved to {OUT / 'j2_vs_orekit.png'}")