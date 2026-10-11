import { BODIES, type Vec3 } from "../core/bodies";
import { moonGeocentric } from "../core/ephemeris";
import { bodyOrientation } from "../core/rotation";
import { sunGeocentric } from "../core/sun";
import { Epoch } from "../core/time";
import { lookAngles, type GroundStation } from "./station";

const R_M = BODIES.moon.equatorialRadius;
const C_KMS = 299792.458;
const DEG = Math.PI / 180;

export interface LunarSite {
  name: string;
  latDeg: number;
  lonDeg: number;
}

const unit = (v: Vec3): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Site position (geocentric, scene axes, km) and its local vertical. */
export function siteState(site: LunarSite, date: Date) {
  const ep = Epoch.fromUnixMs(date.getTime());
  const lat = site.latDeg * DEG;
  const lon = site.lonDeg * DEG;
  const up = bodyOrientation("moon", ep).apply([Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]);
  const m = moonGeocentric(ep);
  return { pos: [m[0] + R_M * up[0], m[1] + R_M * up[1], m[2] + R_M * up[2]] as Vec3, up, ep };
}

export interface PlanRow {
  time: Date;
  azDeg: number;
  elDeg: number;
  rangeKm: number;
  rangeRateKms: number;
  dopplerHz: number;
  earthElAtSiteDeg: number;
  sunElAtSiteDeg: number;
}

/** Pointing, Doppler and visibility from a ground station to a lunar surface site. */
export function planRow(station: GroundStation, site: LunarSite, date: Date, freqMHz: number): PlanRow {
  const s = siteState(site, date);
  const look = lookAngles(station, date, s.pos);

  // Range rate by central difference (both Earth rotation and lunar motion included)
  const range = (dtS: number) => {
    const d = new Date(date.getTime() + dtS * 1000);
    return lookAngles(station, d, siteState(site, d).pos).rangeKm;
  };
  const rangeRate = (range(1) - range(-1)) / 2;

  // Earth and Sun elevation as seen from the site (Earth at the origin of the scene frame)
  const toEarth = unit([-s.pos[0], -s.pos[1], -s.pos[2]]);
  const sun = sunGeocentric(s.ep);
  const toSun = unit([sun[0] - s.pos[0], sun[1] - s.pos[1], sun[2] - s.pos[2]]);

  return {
    time: date,
    azDeg: look.azDeg,
    elDeg: look.elDeg,
    rangeKm: look.rangeKm,
    rangeRateKms: rangeRate,
    dopplerHz: (-freqMHz * 1e6 * rangeRate) / C_KMS, // first order: approaching → higher frequency
    earthElAtSiteDeg: Math.asin(dot(s.up, toEarth)) / DEG,
    sunElAtSiteDeg: Math.asin(dot(s.up, toSun)) / DEG,
  };
}

export interface Window {
  start: Date;
  end: Date;
  maxElDeg: number;
  dopplerMinHz: number;
  dopplerMaxHz: number;
  maxDopplerRateHzS: number;
  sunlit: boolean;
}

/** Contiguous periods where the Moon is above `minElDeg` at the station and Earth is above the site's horizon. */
export function listeningWindows(rows: PlanRow[], minElDeg: number): Window[] {
  const out: Window[] = [];
  let cur: PlanRow[] = [];
  const flush = () => {
    if (cur.length > 1) {
      let rate = 0;
      for (let i = 1; i < cur.length; i++) {
        const dt = (cur[i].time.getTime() - cur[i - 1].time.getTime()) / 1000;
        rate = Math.max(rate, Math.abs(cur[i].dopplerHz - cur[i - 1].dopplerHz) / dt);
      }
      out.push({
        start: cur[0].time,
        end: cur[cur.length - 1].time,
        maxElDeg: Math.max(...cur.map((r) => r.elDeg)),
        dopplerMinHz: Math.min(...cur.map((r) => r.dopplerHz)),
        dopplerMaxHz: Math.max(...cur.map((r) => r.dopplerHz)),
        maxDopplerRateHzS: rate,
        sunlit: cur.some((r) => r.sunElAtSiteDeg > 0),
      });
    }
    cur = [];
  };
  for (const r of rows) {
    if (r.elDeg >= minElDeg && r.earthElAtSiteDeg > 0) cur.push(r);
    else flush();
  }
  flush();
  return out;
}
