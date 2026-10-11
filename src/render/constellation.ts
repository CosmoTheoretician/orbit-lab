import * as THREE from "three";
import type { Epoch } from "../core/time";
import { J2SecularPropagator } from "../orbit/j2secular";
import { walkerDelta, type WalkerConfig } from "../orbit/walker";

export const MEOSPHERE_COLOR = 0xff4fd8;

export interface ConstellationLayer {
  group: THREE.Group;
  count: number;
  update(epoch: Epoch): void;
}

/** Points along one full orbit, using the same rotor that places the satellites. */
function orbitPath(prop: J2SecularPropagator, dt: number, segments: number): Float32Array {
  const R = prop.orientationAt(dt);
  const { a, e } = prop.el;
  const q = Math.sqrt(1 - e * e);
  const out = new Float32Array((segments + 1) * 3);
  for (let j = 0; j <= segments; j++) {
    const E = (2 * Math.PI * j) / segments;
    out.set(R.apply([a * (Math.cos(E) - e), a * q * Math.sin(E), 0]), 3 * j);
  }
  return out;
}

/** A simulated Walker constellation: satellites plus one ring per orbital plane. Units: km. */
export function createConstellationLayer(
  config: WalkerConfig,
  elementEpoch: Epoch,
  color = MEOSPHERE_COLOR,
): ConstellationLayer {
  const props = walkerDelta(config).map((el) => new J2SecularPropagator(el));
  const group = new THREE.Group();

  const positions = new Float32Array(props.length * 3);
  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("position", posAttr);
  const points = new THREE.Points(geom, new THREE.PointsMaterial({ color, size: 6, sizeAttenuation: false }));
  points.frustumCulled = false;
  group.add(points);

  const SEGMENTS = 180;
  const perPlane = config.total / config.planes;
  const rings = Array.from({ length: config.planes }, (_, p) => {
    const g = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", attr);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
    line.frustumCulled = false;
    group.add(line);
    return { prop: props[p * perPlane], attr };
  });

  function update(epoch: Epoch) {
    const dt = epoch.tt - elementEpoch.tt;
    props.forEach((prop, k) => {
      const { r } = prop.stateAt(dt);
      positions[3 * k] = r[0];
      positions[3 * k + 1] = r[1];
      positions[3 * k + 2] = r[2];
    });
    posAttr.needsUpdate = true;

    for (const ring of rings) {
      (ring.attr.array as Float32Array).set(orbitPath(ring.prop, dt, SEGMENTS));
      ring.attr.needsUpdate = true;
    }
  }

  return { group, count: props.length, update };
}