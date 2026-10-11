import type { Vec3 } from "../core/bodies";

/** One state from Horizons. t: seconds since J2000 in TDB (≈ TT to 2 ms). Units: km, km/s. */
export interface Sample {
  t: number;
  r: Vec3;
  v: Vec3;
}

const J2000_JD = 2451545.0;

/** Parses VECTORS output (VEC_TABLE=2, CSV_FORMAT=YES) between $$SOE and $$EOE. */
export function parseHorizonsVectors(text: string): Sample[] {
  const a = text.indexOf("$$SOE");
  const b = text.indexOf("$$EOE");
  if (a < 0 || b < 0) return [];
  const out: Sample[] = [];
  for (const line of text.slice(a + 5, b).split(/\r?\n/)) {
    const f = line.split(",").map((s) => s.trim());
    if (f.length < 8) continue;
    const jd = Number(f[0]);
    const x = f.slice(2, 8).map(Number);
    if (!Number.isFinite(jd) || !x.every(Number.isFinite)) continue;
    out.push({ t: (jd - J2000_JD) * 86400, r: [x[0], x[1], x[2]], v: [x[3], x[4], x[5]] });
  }
  return out;
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function parseAD(s: string): Date | undefined {
  const m = s.match(/(\d{4})-([A-Z]{3})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m || !(m[2] in MONTHS)) return undefined;
  return new Date(Date.UTC(+m[1], MONTHS[m[2]], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0));
}

/** Reads the coverage limits Horizons reports when a requested window is outside its data. */
export function parseCoverage(text: string): { earliest?: Date; latest?: Date } {
  const prior = text.match(/prior to A\.D\. ([0-9A-Z: -]+)/);
  const after = text.match(/after A\.D\. ([0-9A-Z: -]+)/);
  return { earliest: prior ? parseAD(prior[1]) : undefined, latest: after ? parseAD(after[1]) : undefined };
}
