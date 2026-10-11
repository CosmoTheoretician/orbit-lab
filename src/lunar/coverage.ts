import { BODIES, type Vec3 } from "../core/bodies";
import { moonGeocentric } from "../core/ephemeris";
import { siteState, type LunarSite } from "../ground/planner";

const R_M = BODIES.moon.equatorialRadius;
const DEG = Math.PI / 180;

/** Anything that can relay: a Moon-centred position (scene axes, km) at TT seconds since J2000. */
export interface RelaySat {
  rel(tt: number): Vec3;
}

export interface CoverageResult {
  directPct: number;
  relayPct: number;
  combinedPct: number;
  blackoutHours: number;
  blackoutFilledPct: number;
  longestDirectGapHours: number;
  longestGapHours: number;
  meanRelaysInView: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** True if the straight segment a→b passes through the Moon (centred at the origin). */
export function moonBlocks(a: Vec3, b: Vec3): boolean {
  const d = sub(b, a);
  const t = Math.min(1, Math.max(0, -dot(a, d) / dot(d, d)));
  return norm([a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]]) < R_M;
}

/**
 * Link availability for a lunar surface site over a period:
 * direct to Earth = Earth above the site's (flat) horizon; via relay = a satellite at least minElDeg
 * above the site's horizon that itself has an unobstructed view of Earth.
 */
export function relayCoverage(
  site: LunarSite,
  sats: RelaySat[],
  startMs: number,
  days: number,
  stepS = 300,
  minElDeg = 10,
): CoverageResult {
  let total = 0;
  let direct = 0;
  let relay = 0;
  let combined = 0;
  let blackout = 0;
  let blackoutFilled = 0;
  let relaysInView = 0;
  let gap = 0;
  let longestGap = 0;
  let directGap = 0;
  let longestDirectGap = 0;
  const sinMin = Math.sin(minElDeg * DEG);

  for (let ms = startMs; ms < startMs + days * 86400_000; ms += stepS * 1000) {
    const s = siteState(site, new Date(ms));
    const moon = moonGeocentric(s.ep);
    const siteRel = sub(s.pos, moon);
    const earthRel: Vec3 = [-moon[0], -moon[1], -moon[2]];

    const toEarth = sub(earthRel, siteRel);
    const hasDirect = dot(s.up, toEarth) / norm(toEarth) > 0;

    let inView = 0;
    for (const sat of sats) {
      const r = sat.rel(s.ep.tt);
      const d = sub(r, siteRel);
      if (dot(s.up, d) / norm(d) >= sinMin && !moonBlocks(r, earthRel)) inView++;
    }
    const hasRelay = inView > 0;

    total++;
    relaysInView += inView;
    if (hasDirect) direct++;
    if (hasRelay) relay++;
    if (hasDirect || hasRelay) combined++;
    if (!hasDirect) {
      blackout++;
      if (hasRelay) blackoutFilled++;
    }

    directGap = hasDirect ? 0 : directGap + 1;
    longestDirectGap = Math.max(longestDirectGap, directGap);
    gap = hasDirect || hasRelay ? 0 : gap + 1;
    longestGap = Math.max(longestGap, gap);
  }

  const hours = stepS / 3600;
  return {
    directPct: (100 * direct) / total,
    relayPct: (100 * relay) / total,
    combinedPct: (100 * combined) / total,
    blackoutHours: blackout * hours,
    blackoutFilledPct: blackout > 0 ? (100 * blackoutFilled) / blackout : 100,
    longestDirectGapHours: longestDirectGap * hours,
    longestGapHours: longestGap * hours,
    meanRelaysInView: relaysInView / total,
  };
}
