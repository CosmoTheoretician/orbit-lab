import { propagate, twoline2satrec } from "satellite.js";
import { BODIES } from "../core/bodies";
import { OPERATORS, type CatalogEntry } from "../catalog/types";
import { ORBIT_TRACE_SAMPLES, type SelectableSource } from "./selection";

const RE = BODIES.earth.equatorialRadius;

/** Element epoch from TLE line 1 (columns 19-32: YYDDD.DDDDDDDD), as UTC ms. */
function tleEpochMs(line1: string): number {
  const yy = parseInt(line1.slice(18, 20), 10);
  const doy = parseFloat(line1.slice(20, 32));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, 0, 1) + (doy - 1) * 86_400_000;
}

/** Mean elements straight from TLE line 2. */
function tleElements(line2: string) {
  const incDeg = parseFloat(line2.slice(8, 16));
  const ecc = parseFloat(`0.${line2.slice(26, 33).trim()}`);
  const revPerDay = parseFloat(line2.slice(52, 63));
  const n = (revPerDay * 2 * Math.PI) / 86400;
  const a = Math.cbrt(BODIES.earth.gm / (n * n));
  return { incDeg, ecc, periodMin: 1440 / revPerDay, perigeeKm: a * (1 - ecc) - RE, apogeeKm: a * (1 + ecc) - RE };
}

function formatAge(hours: number): string {
  const sign = hours < 0 ? "−" : "";
  const h = Math.abs(hours);
  return h < 48 ? `${sign}${h.toFixed(1)} h` : `${sign}${(h / 24).toFixed(1)} d`;
}

/** The real catalog as a selectable source, propagated with SGP4. */
export function createCatalogSource(
  entries: CatalogEntry[],
  positions: Float32Array,
  isVisible: (i: number) => boolean,
): SelectableSource {
  type Info = { satrec: ReturnType<typeof twoline2satrec>; epochMs: number; el: ReturnType<typeof tleElements> };
  const cache = new Map<number, Info>();
  const info = (i: number): Info => {
    let c = cache.get(i);
    if (!c) {
      const e = entries[i];
      c = { satrec: twoline2satrec(e.line1, e.line2), epochMs: tleEpochMs(e.line1), el: tleElements(e.line2) };
      cache.set(i, c);
    }
    return c;
  };

  return {
    count: entries.length,
    positions,
    isVisible,
    color: (i) => OPERATORS[entries[i].operator].color,
    traceValidityMs: (i) => (info(i).el.periodMin * 60_000) / 8,

    traceOrbit(i, shownMs, out) {
      const { satrec, el } = info(i);
      const span = el.periodMin * 60_000;
      for (let k = 0; k <= ORBIT_TRACE_SAMPLES; k++) {
        const pv = propagate(satrec, new Date(shownMs + (k / ORBIT_TRACE_SAMPLES) * span));
        const p = pv ? pv.position : null;
        if (p && typeof p === "object") out.set([p.x, p.y, p.z], 3 * k);
        else if (k > 0) out.copyWithin(3 * k, 3 * (k - 1), 3 * k);
      }
    },

    describe(i, shownMs) {
      const e = entries[i];
      const { epochMs, el } = info(i);
      const alt = Math.hypot(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]) - RE;
      return (
        `${e.name}\n` +
        `NORAD ${e.norad} · ${OPERATORS[e.operator].label}\n\n` +
        `altitude now      ${alt.toFixed(0)} km\n` +
        `perigee/apogee    ${el.perigeeKm.toFixed(0)} / ${el.apogeeKm.toFixed(0)} km\n` +
        `inclination       ${el.incDeg.toFixed(2)}°\n` +
        `eccentricity      ${el.ecc.toFixed(5)}\n` +
        `period            ${el.periodMin.toFixed(1)} min\n\n` +
        `element epoch     ${new Date(epochMs).toISOString().replace("T", " ").slice(0, 16)} UTC\n` +
        `age at shown time ${formatAge((shownMs - epochMs) / 3_600_000)}\n` +
        `propagator: SGP4 (public elements)`
      );
    },
  };
}