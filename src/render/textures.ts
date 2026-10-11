import * as THREE from "three";

export type Variant = "lo" | "hi";

const loader = new THREE.TextureLoader();

/** Loads public/textures/<variant>/<name>. Colour maps are sRGB; data maps (normals, masks) stay linear. */
export async function loadTexture(base: string, variant: Variant, name: string, color = true): Promise<THREE.Texture> {
  const ext = name === "saturn_ring" ? "png" : "jpg";
  const tex = await loader.loadAsync(`${base}textures/${variant}/${name}.${ext}`);
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export interface Slot {
  name: string;
  color: boolean;
  apply(t: THREE.Texture): void;
}

/**
 * Switches a body's maps between resolutions. Full-resolution maps are loaded on demand and
 * disposed when no longer needed, so only the focused body occupies 8k graphics memory.
 */
export function makeDetailSwitch(base: string, slots: Slot[], lo: THREE.Texture[]) {
  let current: Variant = "lo";
  let requested: Variant = "lo";
  let hi: THREE.Texture[] = [];

  return async (v: Variant): Promise<void> => {
    requested = v;
    if (v === current) return;
    if (v === "lo") {
      slots.forEach((s, k) => s.apply(lo[k]));
      hi.forEach((t) => t.dispose());
      hi = [];
      current = "lo";
      return;
    }
    const loaded = await Promise.all(slots.map((s) => loadTexture(base, "hi", s.name, s.color)));
    if (requested !== "hi" || current === "hi") {
      loaded.forEach((t) => t.dispose()); // focus moved on while loading
      return;
    }
    slots.forEach((s, k) => s.apply(loaded[k]));
    hi = loaded;
    current = "hi";
  };
}
