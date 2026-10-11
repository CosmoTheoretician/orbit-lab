import * as THREE from "three";
import { BODIES } from "../core/bodies";
import { Epoch } from "../core/time";
import { J2SecularPropagator } from "../orbit/j2secular";
import { walkerDelta, type WalkerConfig } from "../orbit/walker";
import { ORBIT_TRACE_SAMPLES, type SelectableSource } from "./selection";

export const MEOSPHERE_COLOR = 0xff4fd8;

const RE = BODIES.earth.equatorialRadius;
const RAD2DEG = 180 / Math.PI;
const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;

export interface ConstellationLayer {
  group: THREE.Group;
  count: number;
  source: SelectableSource;
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
  const perPlane = config.total / config.planes;
  const group = new THREE.Group();

  const positions = new Float32Array(props.length * 3);
  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("position", posAttr);
  const points = new THREE.Points(geom, new THREE.PointsMaterial({ color, size: 6, sizeAttenuation: false }));
  points.frustumCulled = false;
  group.add(points);

  const SEGMENTS = 180;
  const rings = Array.from({ length: config.planes }, (_, p) => {
    const g = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", attr);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
    line.frustumCulled = false;
    group.add(line);
    return { prop: props[p * perPlane], attr };
  });

  const dtOf = (shownMs: number) => Epoch.fromUnixMs(shownMs).tt - elementEpoch.tt;

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

  const source: SelectableSource = {
    count: props.length,
    positions,
    isVisible: () => group.visible,
    color: () => color,
    traceValidityMs: (i) => (((2 * Math.PI) / props[i].rates.n) * 1000) / 8,

    traceOrbit(i, shownMs, out) {
      const prop = props[i];
      const dt0 = dtOf(shownMs);
      const period = (2 * Math.PI) / prop.rates.n;
      for (let k = 0; k <= ORBIT_TRACE_SAMPLES; k++) {
        out.set(prop.stateAt(dt0 + (k / ORBIT_TRACE_SAMPLES) * period).r, 3 * k);
      }
    },

    describe(i, shownMs) {
      const prop = props[i];
      const { el, rates } = prop;
      const dt = dtOf(shownMs);
      const alt = Math.hypot(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]) - RE;
      const raan = wrap360((el.raan + rates.raanDot * dt) * RAD2DEG);
      const argLat = wrap360((el.argp + el.M + (rates.argpDot + rates.mDot) * dt) * RAD2DEG);
      return (
        `meoSphere P${Math.floor(i / perPlane) + 1}-S${(i % perPlane) + 1}  (simulated)\n` +
        `Walker ${config.inclinationDeg}°: ${config.total}/${config.planes}/${config.phasing}\n\n` +
        `altitude now      ${alt.toFixed(0)} km\n` +
        `inclination       ${(el.i * RAD2DEG).toFixed(2)}°\n` +
        `period            ${((2 * Math.PI) / rates.n / 60).toFixed(1)} min\n` +
        `node (RAAN)       ${raan.toFixed(2)}°\n` +
        `arg. of latitude  ${argLat.toFixed(1)}°\n` +
        `J2 nodal drift    ${(rates.raanDot * 86400 * RAD2DEG).toFixed(3)}°/day\n\n` +
        `propagator: own J2 secular model (rotors)\n` +
        `assumed: inclination and phasing (not published by SES)`
      );
    },
  };

  return { group, count: props.length, source, update };
}