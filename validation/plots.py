#!/usr/bin/env python3
"""Validation plots: Resilience reconstruction vs Dwingeloo (CAMRAS) Doppler. Writes PNGs to public/validation/."""
import csv
import json
import os
from datetime import datetime, timezone

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D

IN = "validation/out/plots"
OUT = "public/validation"
os.makedirs(OUT, exist_ok=True)
BG, FG, DIM = "#0b0f14", "#e6eefb", "#6f83a0"
MEAS, MODEL, RES, ONE = "#64d2ff", "#ff6b5e", "#ffd60a", "#ff453a"
plt.rcParams.update({
    "figure.facecolor": BG, "axes.facecolor": BG, "savefig.facecolor": BG,
    "text.color": FG, "axes.labelcolor": FG, "xtick.color": FG, "ytick.color": FG,
    "axes.edgecolor": DIM, "font.family": "monospace", "font.size": 12,
    "axes.titlesize": 14, "axes.titleweight": "bold", "axes.labelsize": 12,
    "legend.fontsize": 11, "axes.grid": True, "grid.color": "#1c2836",
})
SIZE = (11, 5.2)


def read(name):
    path = os.path.join(IN, name)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        rows = list(csv.DictReader(f))
    out = {}
    for k in rows[0]:
        try:
            out[k] = np.array([float(r[k]) for r in rows])
        except ValueError:
            pass
    return out


def dt(u):
    return [datetime.fromtimestamp(float(x), tz=timezone.utc) for x in np.atleast_1d(u)]


ev = json.load(open(os.path.join(IN, "events.json")))


def decorate(ax, marks=True, label=True, names=True):
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=timezone.utc))
    a, b = dt(ev["occultation"])
    ax.axvspan(a, b, color="#1c2836", alpha=0.95, lw=0)
    c, e = dt(ev["oneWay"])
    ax.axvspan(c, e, color="#22331a", alpha=0.8, lw=0)
    if names:
        tr = ax.get_xaxis_transform()
        ax.text(a + (b - a) / 2, 0.97, "behind\nthe Moon", transform=tr, ha="center", va="top", color=DIM, fontsize=10)
        ax.text(c + (e - c) / 2, 0.97, "one-\nway", transform=tr, ha="center", va="top", color="#8fbf6a", fontsize=10)
    if marks:
        for key, txt in (("braking", "braking"), ("los", "LOS")):
            if ev.get(key):
                x = dt(ev[key])[0]
                ax.axvline(x, color=DIM, ls="--", lw=1)
                if names:
                    ax.text(x, 0.03, f" {txt}", transform=ax.get_xaxis_transform(), color=DIM, fontsize=10)
    if label:
        ax.set_xlabel("UTC, 5 June 2025")


def save(fig, name):
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, name), dpi=140)
    plt.close(fig)
    print("wrote", os.path.join(OUT, name))


def rms(x):
    return float(np.sqrt(np.mean(np.asarray(x) ** 2)))


# 1. the raw recording, zoomed to the signal
raw = read("raw.csv")
sig = raw["signal"] > 0
off = (raw["freq_hz"] - 8492.5e6) / 1e3
lo, hi = np.percentile(off[sig], [0.5, 99.5])
pad = 0.15 * (hi - lo)
fig, ax = plt.subplots(figsize=SIZE)
ax.scatter(dt(raw["unix"][sig]), off[sig], s=3, color=MEAS)
ax.set_ylim(lo - pad, hi + pad)
ax.set_ylabel("received − 8492.5 MHz (kHz)")
ax.set_title("The raw data: Resilience's carrier at Dwingeloo, one point per second")
decorate(ax)
save(fig, "01-data.png")

# 2. before
before = read("before.csv")
if before:
    fig, ax = plt.subplots(figsize=SIZE)
    ax.scatter(dt(before["unix"]), before["residual_ms"], s=3, color=RES)
    ax.axhline(0, color=DIM, lw=0.8)
    ax.set_ylabel("measured − model (m/s)")
    ax.set_title(f"First comparison: milestone model, one-way link, off by {rms(before['residual_ms']):.0f} m/s")
    decorate(ax, marks=False)
    save(fig, "02-before.png")

# 3. the two-way test
tw = json.load(open(os.path.join(IN, "two-way.json")))
rows = [r for r in tw["rows"] if r["rms"][2] is not None]
names = [r["name"] for r in rows]
test = np.array([r["rms"][2] for r in rows], dtype=float)
clean = np.array([np.nan if r["rms"][1] is None else r["rms"][1] for r in rows], dtype=float)
y = np.arange(len(rows))
fig, ax = plt.subplots(figsize=SIZE)
ax.barh(y - 0.2, test, 0.38, color=[ONE if n == "one-way" else RES for n in names], label=f"after the break ({tw['windows'][2]})")
ax.barh(y + 0.2, clean, 0.38, color=MEAS, label=f"before it ({tw['windows'][1]})")
for yi, v in zip(y, test):
    ax.text(v * 1.08, yi - 0.2, f"{v:.1f}", va="center", fontsize=10, color=FG)
for yi, v in zip(y, clean):
    if np.isfinite(v):
        ax.text(v * 1.08, yi + 0.2, f"{v:.1f}", va="center", fontsize=10, color=FG)
ax.set_xscale("log")
ax.set_yticks(y, names)
ax.invert_yaxis()
ax.set_xlabel("misfit, RMS (m/s, log scale)")
ax.set_title("The clue: after 18:32 the link is two-way (any visible station fits)")
ax.legend(loc="lower right")
save(fig, "03-two-way.png")

# 4. final reconstruction vs measurement
f = read("final.csv")
fig, (a1, a2) = plt.subplots(2, 1, figsize=(11, 6.4), sharex=True, gridspec_kw={"height_ratios": [2.2, 1]})
for s in np.unique(f["stretch"]):
    m = f["stretch"] == s
    a1.plot(dt(f["unix"][m]), f["rr_meas_kms"][m], color=MEAS, lw=2.2)
    a1.plot(dt(f["unix"][m]), f["rr_model_kms"][m], color=MODEL, lw=1.2, ls="--")
a1.set_ylabel("line-of-sight speed (km/s)")
a1.set_title(f"The reconstruction matches the measurement within {ev['rms']:.1f} m/s")
a1.legend(handles=[Line2D([], [], color=MEAS, lw=2.2, label="measured"), Line2D([], [], color=MODEL, ls="--", label="reconstruction")], loc="lower left")
a2.scatter(dt(f["unix"]), f["residual_ms"], s=3, color=RES)
a2.axhline(0, color=DIM, lw=0.8)
a2.set_ylabel("difference (m/s)")
a2.set_ylim(-80, 80)
decorate(a1, label=False)
decorate(a2, names=False)
save(fig, "04-final-fit.png")

# 5. residuals
pre = f["unix"] < (ev["braking"] or np.inf)
r = np.clip(f["residual_ms"], -100, 100)
fig, ax = plt.subplots(figsize=SIZE)
ax.hist(r[pre], bins=90, color=MEAS, alpha=0.9, label=f"orbit and coast: {rms(f['residual_ms'][pre]):.1f} m/s")
ax.hist(r[~pre], bins=90, color=RES, alpha=0.75, label=f"braking and final phase: {rms(f['residual_ms'][~pre]):.1f} m/s")
ax.set_xlabel("measured − reconstruction (m/s, clipped at ±100)")
ax.set_ylabel("seconds of data")
ax.set_title("How good: a few m/s in orbit, larger only during braking")
ax.legend(loc="upper right")
save(fig, "05-residuals.png")

# 6. what happened: the fitted descent
p = read("profile.csv")
t0 = (ev["deorbit"] or p["unix"][0]) - 600
m = p["unix"] >= t0
fig, ax = plt.subplots(figsize=SIZE)
ax2 = ax.twinx()
ax.plot(dt(p["unix"][m]), p["alt_km"][m], color=MEAS, lw=2.2)
ax2.plot(dt(p["unix"][m]), p["speed_ms"][m], color=MODEL, lw=2.2)
ax.set_ylabel("altitude (km)", color=MEAS)
ax2.set_ylabel("speed (m/s)", color=MODEL)
ax2.grid(False)
if ev.get("braking"):
    xb = dt(ev["braking"])[0]
    ax.scatter([xb], [ev["ispaceBrakingAltKm"]], marker="x", s=80, color=FG, zorder=6)
    ax.annotate("ispace: braking\nfrom ~20 km", (xb, ev["ispaceBrakingAltKm"]), xytext=(xb, ev["ispaceBrakingAltKm"] + 30),
                ha="center", color=FG, fontsize=10, arrowprops={"arrowstyle": "-", "color": DIM})
tel = ev["telemetry"]
xt = dt(tel["unix"])[0]
ax2.scatter([xt], [tel["speedMs"]], marker="x", s=80, color=FG, zorder=6)
ax2.annotate("ispace last telemetry:\n192 m, 42 m/s", (xt, tel["speedMs"]), xytext=(xt, 700),
             ha="right", color=FG, fontsize=10, arrowprops={"arrowstyle": "-", "color": DIM})
ax.set_title("What happened: coast to ~26 km, braking from ~19:03, impact 19:15:34")
decorate(ax)
ax.set_xlim(dt(t0)[0], dt(ev["los"] + 60)[0])
save(fig, "06-descent.png")
