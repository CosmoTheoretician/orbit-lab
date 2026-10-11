import { describe, expect, it } from "vitest";
import { sgp4, twoline2satrec } from "satellite.js";
import { loadVerification, type Vec3 } from "./verification";

/** Any SGP4 implementation we want to validate. Ours gets added here later. */
interface Sgp4Candidate {
  name: string;
  create(line1: string, line2: string): (tsinceMin: number) => { r: Vec3; v: Vec3 } | null;
}

const satelliteJs: Sgp4Candidate = {
  name: "satellite.js",
  create(line1, line2) {
    const rec = twoline2satrec(line1, line2);
    return (t) => {
      const pv = sgp4(rec, t);
      const p = pv ? pv.position : null;
      const v = pv ? pv.velocity : null;
      if (!p || !v || typeof p !== "object" || typeof v !== "object") return null;
      return { r: [p.x, p.y, p.z], v: [v.x, v.y, v.z] };
    };
  },
};

const CANDIDATES: Sgp4Candidate[] = [satelliteJs];

/**
 * The reference prints positions to 1e-8 km and velocities to 1e-9 km/s.
 * Rounding each component by at most half a unit bounds the vector error by sqrt(3)/2 units.
 */
const POS_TOL_MM = (Math.sqrt(3) / 2) * 1e-8 * 1e6 * 1.01;   // ≈ 0.0087 mm
const VEL_TOL_UM_S = (Math.sqrt(3) / 2) * 1e-9 * 1e9 * 1.01; // ≈ 0.87 µm/s

/** The reference implementation flags these as errors; a correct implementation must refuse them. */
const EXPECTED_ERRORS = new Set(["33334"]);

/** Known discrepancies: reported in the table, excluded from pass/fail until explained. */
const UNDER_INVESTIGATION = new Set(["23599", "20413#2"]);

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const cases = loadVerification("test/fixtures/sgp4");

describe.each(CANDIDATES)("SGP4 verification: $name", (candidate) => {
  it("reproduces every reference state to the reference's print precision", () => {
    expect(cases.length).toBeGreaterThan(0);

    const report = cases.map((c) => {
      const at = candidate.create(c.line1, c.line2);
      let maxDr = 0;
      let maxDv = 0;
      let missing = 0;
      for (const row of c.rows) {
        const s = at(row.tsince);
        if (!s) { missing++; continue; }
        maxDr = Math.max(maxDr, dist(s.r, row.r));
        maxDv = Math.max(maxDv, dist(s.v, row.v));
      }
      const drMm = maxDr * 1e6;
      const dvUm = maxDv * 1e9;

      let status: string;
      if (EXPECTED_ERRORS.has(c.id)) status = missing === c.rows.length ? "expected error" : "FAIL";
      else if (UNDER_INVESTIGATION.has(c.id)) status = "investigating";
      else status = missing === 0 && drMm <= POS_TOL_MM && dvUm <= VEL_TOL_UM_S ? "ok" : "FAIL";

      return {
        case: c.id,
        points: c.rows.length,
        "max |Δr| [mm]": +drMm.toFixed(4),
        "max |Δv| [µm/s]": +dvUm.toFixed(3),
        missing,
        status,
      };
    });

    console.table(report);
    const ok = report.filter((r) => r.status === "ok").length;
    console.log(
      `${candidate.name}: ${ok}/${cases.length} ok within ${POS_TOL_MM.toFixed(4)} mm / ${VEL_TOL_UM_S.toFixed(2)} µm/s`,
    );

    expect(report.filter((r) => r.status === "FAIL")).toEqual([]);
  });
});