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
      current = { id: n > 1 ? `${satnum}#${n}` : String(satnum), satnum, line1, line2, rows: [] };
      cases.push(current);
      continue;
    }
    if (!current) continue;

    // rows may carry extra columns (osculating elements, date); only the first 7 are the state
    const nums = raw.trim().split(/\s+/).slice(0, 7).map(Number);
    if (nums.length === 7 && nums.every(Number.isFinite)) {
      current.rows.push({
        tsince: nums[0],
        r: [nums[1], nums[2], nums[3]],
        v: [nums[4], nums[5], nums[6]],
      });
    }
  }
  return cases;
}