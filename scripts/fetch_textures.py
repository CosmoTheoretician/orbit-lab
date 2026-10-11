"""
Downloads Solar System Scope textures (CC BY 4.0, www.solarsystemscope.com/textures)
and writes two variants per texture into public/textures/:
  lo/  2048 px wide, loaded for every body at startup
  hi/  full resolution (up to 8192 px), loaded only for the focused body
Usage: python scripts/fetch_textures.py [--local DIR]   (DIR = folder with manually downloaded files)
"""
import io
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
BASE = "https://www.solarsystemscope.com/textures/download/"
OUT = Path("public/textures")
LO_WIDTH, HI_MAX = 2048, 8192

# output name -> candidate source files, best first
SOURCES = {
    "sun": ["8k_sun.jpg", "2k_sun.jpg"],
    "mercury": ["8k_mercury.jpg", "2k_mercury.jpg"],
    "venus_atmosphere": ["4k_venus_atmosphere.jpg", "2k_venus_atmosphere.jpg"],
    "earth_day": ["8k_earth_daymap.jpg", "2k_earth_daymap.jpg"],
    "earth_night": ["8k_earth_nightmap.jpg", "2k_earth_nightmap.jpg"],
    "earth_clouds": ["8k_earth_clouds.jpg", "2k_earth_clouds.jpg"],
    "earth_specular": ["8k_earth_specular_map.tif", "2k_earth_specular_map.tif"],
    "earth_normal": ["8k_earth_normal_map.tif", "2k_earth_normal_map.tif"],
    "moon": ["8k_moon.jpg", "2k_moon.jpg"],
    "mars": ["8k_mars.jpg", "2k_mars.jpg"],
    "jupiter": ["8k_jupiter.jpg", "2k_jupiter.jpg"],
    "saturn": ["8k_saturn.jpg", "2k_saturn.jpg"],
    "saturn_ring": ["8k_saturn_ring_alpha.png", "2k_saturn_ring_alpha.png"],
    "uranus": ["2k_uranus.jpg"],
    "neptune": ["2k_neptune.jpg"],
}

local = Path(sys.argv[sys.argv.index("--local") + 1]) if "--local" in sys.argv else None


def read(name: str) -> bytes:
    if local and (local / name).exists():
        return (local / name).read_bytes()
    req = urllib.request.Request(BASE + name, headers={"User-Agent": "Mozilla/5.0 (orbit-lab texture fetch)"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def to_8bit(img: Image.Image) -> Image.Image:
    """16-bit and float TIFFs (masks, normal maps) -> 8 bit."""
    if img.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
        a = np.asarray(img, dtype=np.float64)
        return Image.fromarray((255 * a / max(a.max(), 1)).astype(np.uint8), "L")
    return img


failed = []
for out, candidates in SOURCES.items():
    for cand in candidates:
        try:
            img = to_8bit(Image.open(io.BytesIO(read(cand))))
            img.load()
        except Exception as e:
            print(f"  {cand}: {e}")
            continue
        ext = ".png" if out == "saturn_ring" else ".jpg"
        for variant, width in (("hi", min(img.width, HI_MAX)), ("lo", min(img.width, LO_WIDTH))):
            d = OUT / variant
            d.mkdir(parents=True, exist_ok=True)
            im = img if width == img.width else img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
            if ext == ".png":
                im.save(d / f"{out}{ext}")
            else:
                im.convert("RGB").save(d / f"{out}{ext}", quality=90)
        print(f"{out:18s} <- {cand} ({img.width}x{img.height}, {img.mode})")
        break
    else:
        failed.append(out)

if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
