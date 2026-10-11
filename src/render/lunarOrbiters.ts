import * as THREE from "three";
import { BODIES, type Vec3 } from "../core/bodies";
import { precessionRotor } from "../core/precession";
import { moonEquatorRotor } from "../core/rotation";
import { Epoch } from "../core/time";
import { keplerSat } from "../lunar/kepler";
import { LUNAR_ORBITERS, type LunarOrbiter } from "../lunar/orbiters";
import { sampleTrack, type Track } from "../missions/track";
import { ORBIT_TRACE_SAMPLES, type SelectableSource } from "./selection";

const MU_M = BODIES.moon.gm;
const R_M = BODIES.moon.equatorialRadius;
const COLOR = { operating: 0x64d2ff, concluded: 0x8e8e93, planned: 0xf5f5f5, unverified: 0x8e8e93 };

interface Sat {
  orbiter: LunarOrbiter;
  k: number; // index within a constellation
  rel(tt: number): Vec3 | null; // Moon-centred, scene axes, km
  periodS: number;
  live: boolean;
}

interface OrbiterFile {
  horizonsId: string;
  t: number[];
  r: number[];
  v: number[];
}

/** Lunar orbiters: live Horizons ephemerides (Moon-relative) and modeled constellations, drawn around the rendered Moon. */
export async function createLunarOrbiters(world: THREE.Group, base: string, moonKm: THREE.Vector3) {
  const group = new THREE.Group();
  world.add(group);
  const ringGroup = new THREE.Group(); // positioned at the Moon each frame
  group.add(ringGroup);

  const axes = moonEquatorRotor(Epoch.now()); // lunar equatorial → scene axes, for drawing the rings
  const sats: Sat[] = [];

  for (const o of LUNAR_ORBITERS) {
    if (o.horizons) {
      try {
        const res = await fetch(`${base}orbiters/${o.id}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const f: OrbiterFile = await res.json();
        const P = precessionRotor(Epoch.fromTT((f.t[0] + f.t[f.t.length - 1]) / 2)); // ICRF → scene axes
        const r = new Float64Array(f.r.length);
        const v = new Float64Array(f.v.length);
        for (let i = 0; i < f.t.length; i++) {
          r.set(P.apply([f.r[3 * i], f.r[3 * i + 1], f.r[3 * i + 2]]), 3 * i);
          v.set(P.apply([f.v[3 * i], f.v[3 * i + 1], f.v[3 * i + 2]]), 3 * i);
        }
        const track: Track = { t: Float64Array.from(f.t), r, v };
        const r0 = Math.hypot(f.r[0], f.r[1], f.r[2]);
        const v0 = Math.hypot(f.v[0], f.v[1], f.v[2]);
        const a = 1 / (2 / r0 - (v0 * v0) / MU_M);
        sats.push({
          orbiter: o, k: 0, live: true,
          rel: (tt) => sampleTrack(track, tt, [0, 0, 0]),
          periodS: a > 0 ? 2 * Math.PI * Math.sqrt(a ** 3 / MU_M) : 86400,
        });
      } catch {
        console.warn(`no ephemeris for ${o.name} (run: npm run fetch-orbiters)`);
      }
    } else if (o.model) {
      for (let k = 0; k < o.model.count; k++) {
        const ks = keplerSat(o.model, k);
        sats.push({ orbiter: o, k, live: false, periodS: ks.periodS, rel: ks.rel });
        const ringGeom = new THREE.BufferGeometry().setFromPoints(ks.ring(180).map((p) => new THREE.Vector3(...axes.apply(p))));
        const ring = new THREE.Line(ringGeom, new THREE.LineBasicMaterial({ color: COLOR[o.status], transparent: true, opacity: 0.25 }));
        ring.frustumCulled = false;
        ringGroup.add(ring);
      }
    }
  }

  // ---------- points ----------
  const positions = new Float32Array(sats.length * 3);
  const colors = new Float32Array(sats.length * 3);
  sats.forEach((s, i) => {
    const c = new THREE.Color(COLOR[s.orbiter.status]);
    colors.set([c.r, c.g, c.b], 3 * i);
  });
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", posAttr);
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(geom, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true }));
  points.frustumCulled = false;
  group.add(points);

  const visible = new Array<boolean>(sats.length).fill(false);
  addEventListener("keydown", (e) => {
    if (e.key === "n") group.visible = !group.visible;
  });

  function update(epoch: Epoch) {
    ringGroup.position.copy(moonKm);
    sats.forEach((s, i) => {
      const rel = s.rel(epoch.tt);
      visible[i] = rel !== null;
      // Outside a live ephemeris window, park the point inside the Moon (hidden) and make it unselectable
      const p = rel ? [moonKm.x + rel[0], moonKm.y + rel[1], moonKm.z + rel[2]] : [moonKm.x, moonKm.y, moonKm.z];
      positions.set(p, 3 * i);
    });
    posAttr.needsUpdate = true;
  }

  const source: SelectableSource = {
    count: sats.length,
    positions,
    isVisible: (i) => group.visible && visible[i],
    color: (i) => COLOR[sats[i].orbiter.status],
    traceValidityMs: (i) => (sats[i].periodS * 1000) / 8,
    traceOrbit(i, shownMs, out) {
      const tt = Epoch.fromUnixMs(shownMs).tt;
      for (let k = 0; k <= ORBIT_TRACE_SAMPLES; k++) {
        const rel = sats[i].rel(tt + (k / ORBIT_TRACE_SAMPLES) * sats[i].periodS) ?? sats[i].rel(tt) ?? [0, 0, 0];
        out.set([moonKm.x + rel[0], moonKm.y + rel[1], moonKm.z + rel[2]], 3 * k);
      }
    },
    describe(i, shownMs) {
      const s = sats[i];
      const o = s.orbiter;
      const rel = s.rel(Epoch.fromUnixMs(shownMs).tt);
      const alt = rel ? Math.hypot(rel[0], rel[1], rel[2]) - R_M : NaN;
      const member = o.model && o.model.count > 1 ? ` (satellite ${s.k + 1} of ${o.model.count})` : "";
      return (
        `${o.name}${member}\n` +
        `${o.operator} · ${o.country} · ${o.sector}\n` +
        `${o.status}: ${o.statusNote}\n` +
        `role: ${o.role}\n\n` +
        `altitude now      ${Number.isFinite(alt) ? Math.round(alt).toLocaleString("en") + " km" : "n/a"}\n` +
        `period            ${(s.periodS / 3600).toFixed(2)} h\n\n` +
        (s.live ? "position: JPL Horizons ephemeris (Moon-centred)\n" : `orbit: ${o.model!.basis}\n`) +
        o.notes.join("\n")
      );
    },
  };

  return { group, update, source };
}
