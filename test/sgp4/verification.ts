import { readFileSync } from "node:fs";

export type Vec3 = [number, number, number];

export interface ReferenceRow {
  tsince: number; // minutes since TLE epoch
  r: Vec3;        // km, TEME
  v: Vec3;        // km/s, TEME
}

export interface VerificationCase {
  id: string; // satnum, with "#2", "#3"... for repeated element sets
  satnum: number;
  line1: string;
  line2: string;
  rows: ReferenceRow[];
  /** Malformed reference lines skipped in this block (reported, never silently dropped). */
  skipped: number;
}

/**
 * Pairs the SGP4-VER.TLE element sets with the reference states in
 * tmatverDec2015.out (AIAA 2006-6753 distribution, CelesTrak).
 * Pairing is in file order because satellite numbers can repeat.
 */
export function loadVerification(dir: string): VerificationCase[] {
  const tles: Array<{ satnum: number; line1: string; line2: string }> = [];
  const tleLines = readFileSync(`${dir}/SGP4-VER.TLE`, "utf8").split(/\r?\n/);
  for (let i = 0; i < tleLines.length - 1; i++) {
    const l1 = tleLines[i];
    const l2 = tleLines[i + 1];
    if (l1.startsWith("1 ") && l2.startsWith("2 ")) {
      // line 2 carries extra start/stop/step columns after col 69; drop them
      tles.push({ satnum: parseInt(l1.slice(2, 7), 10), line1: l1.slice(0, 69), line2: l2.slice(0, 69) });
      i++;
    }
  }

  const cases: VerificationCase[] = [];
  const seen = new Map<number, number>();
  let current: VerificationCase | null = null;
  let next = 0; // index of the next unused element set

  for (const raw of readFileSync(`${dir}/tmatverDec2015.out`, "utf8").split(/\r?\n/)) {
    const header = raw.match(/^\s*(\d+)\s+xx\s*$/);
    if (header) {
      const satnum = parseInt(header[1], 10);
      while (next < tles.length && tles[next].satnum !== satnum) next++;
      if (next >= tles.length) throw new Error(`reference block for ${satnum} has no matching element set`);
      const { line1, line2 } = tles[next++];

      const n = (seen.get(satnum) ?? 0) + 1;
      seen.set(satnum, n);
      current = { id: n > 1 ? `${satnum}#${n}` : String(satnum), satnum, line1, line2, rows: [], skipped: 0 };
      cases.push(current);
      continue;
    }
    if (!current) continue;

    const tokens = raw.trim().split(/\s+/);
    if (tokens.length < 7) continue;
    const nums = tokens.map(Number);

    // More than 7 tokens, all numeric: several states concatenated on one line
    // (a formatting artifact in the reference output). Not reliably attributable, so skip it.
    if (tokens.length > 7 && nums.every(Number.isFinite)) {
      current.skipped++;
      continue;
    }

    // Normal row: the state, optionally followed by osculating elements and a date
    const s = nums.slice(0, 7);
    if (s.every(Number.isFinite)) {
      current.rows.push({ tsince: s[0], r: [s[1], s[2], s[3]], v: [s[4], s[5], s[6]] });
    }
  }
  return cases;
}