"""
Converts the NASA SVS Deep Star Maps 2020 Milky Way background (OpenEXR, linear HDR,
ICRF/J2000 plate carrée) into an 8-bit sky texture for the browser.
Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio.
"""
import sys
from pathlib import Path

import numpy as np
import OpenEXR
from PIL import Image

src, dst = Path(sys.argv[1]), Path(sys.argv[2])

with OpenEXR.File(str(src)) as f:
    ch = f.channels()
    if "RGB" in ch:
        rgb = np.asarray(ch["RGB"].pixels, dtype=np.float32)
    else:
        rgb = np.stack([np.asarray(ch[c].pixels, dtype=np.float32) for c in ("R", "G", "B")], axis=-1)

rgb = np.clip(rgb, 0, None)
white = np.percentile(rgb.mean(axis=-1), 99.7)  # white point: keep the bright galactic core from clipping
img = np.clip(rgb / white, 0, 1) ** (1 / 2.2)   # linear light to display gamma

dst.parent.mkdir(parents=True, exist_ok=True)
Image.fromarray((img * 255 + 0.5).astype(np.uint8)).save(dst, quality=88)
print(f"{src.name}: {rgb.shape[1]}x{rgb.shape[0]}, white point {white:.4g} -> {dst}")
