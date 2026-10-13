import { mkdir, readFile, writeFile } from "node:fs/promises";
import { MISSIONS } from "../src/missions/catalog";
import { reconstruct } from "../src/missions/reconstruct";
import { lunarOps } from "../src/missions/lunarOps";
import { arrivalDirection } from "../src/missions/lowEnergy";
import type { Sample } from "../src/missions/horizons";

type Report = Record<string, unknown>;

const pack = (s: Sample[]) => ({
  t: s.map((x) => +x.t.toFixed(3)),
  r: s.flatMap((x) => x.r.map((c) => +c.toFixed(3))),
  v: s.flatMap((x) => x.v.map((c) => +c.toFixed(6))),
});

async function write(id: string, source: string, samples: Sample[], report: object, notes: string[]) {
  await writeFile(
    `public/missions/${id}.json`,
    JSON.stringify({ source, modeled: true, frame: "scene", horizonsId: null, ...pack(samples), moon: null, report, notes }),
  );
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The best saved transfer for a mission: joint solve, else departure + low-energy, else low-energy alone. */
async function loadTransfer(id: string) {
  const joint = await readJson<{ report: Report; samples: Sample[]; x: number[] }>(`validation/out/${id}-joint.json`);
  if (joint) {
    const { converged: _c, ...rest } = joint.report;
    return {
      samples: joint.samples,
      theta: joint.x[10],
      phase: "deployment → correction → flyby → deep space (one maneuver) → LOI → impact, solved jointly",
      report: rest,
    };
  }
  const le = await readJson<{ report: Report; post: Sample[]; x: number[] }>(`validation/out/${id}-low-energy.json`);
  if (!le) return null;
  const dep = await readJson<{ report: Report; samples: Sample[] }>(`validation/out/${id}-departure.json`);
  const tFlyby = le.post[0].t;
  const tr = le.report;
  return {
    samples: [...(dep ? dep.samples.filter((s) => s.t < tFlyby) : []), ...le.post],
    theta: le.x[4],
    phase: dep
      ? "deployment → correction → flyby → deep space (one maneuver) → LOI → impact"
      : "flyby → deep space (one maneuver) → LOI → impact; pre-flyby phase not yet reconstructed",
    report: {
      ...(dep
        ? {
            departureOrbitKm: dep.report.departureOrbitKm,
            distanceAtFirstManeuverKm: dep.report.distanceAtFirstManeuverKm,
            correctionManeuverMs: dep.report.correctionManeuverMs,
            correctionAt: dep.report.correctionAt,
          }
        : {}),
      deepSpaceManeuverMs: tr.deepSpaceManeuverMs,
      maneuverAt: tr.maneuverAt,
      maxEarthDistanceKm: tr.maxEarthDistanceKm,
      maxEarthDistanceAt: tr.maxEarthDistanceAt,
      publishedMaxDistance: tr.publishedMaxDistance,
      flybyVInfinityKms: tr.flybyVInfinityKms,
      loiDeltaVToCaptureMs: tr.loiDeltaVToCaptureMs,
    },
  };
}

async function main() {
  await mkdir("public/missions", { recursive: true });
  for (const m of MISSIONS) {
    if (!m.site) continue;
    const t0 = Date.now();
    let result: { samples: Sample[]; report: Report } | null = null;

    if (m.reconstruction) {
      console.log(`${m.name}: solving transfer and lunar phase…`);
      result = reconstruct(m.reconstruction, m.site.lat, m.site.lon);
      await write(m.id, "Reconstruction from published milestones (Earth–Moon–Sun model)", result.samples, result.report, m.reconstruction.notes);
    } else if (m.lunarOps) {
      const transfer = await loadTransfer(m.id);
      if (transfer) {
        console.log(`${m.name}: joining the transfer (${transfer.phase.split(",")[0]}) to the lunar operations…`);
        const base = lunarOps(m.lunarOps, m.site.lat, m.site.lon);
        const ops = lunarOps(m.lunarOps, m.site.lat, m.site.lon, { loiDir: arrivalDirection(base.normal, transfer.theta) });
        const tLoi = ops.times.tLoi;
        const before = transfer.samples.filter((s) => s.t < tLoi);
        const atLoi = transfer.samples.reduce((p, q) => (Math.abs(q.t - tLoi) < Math.abs(p.t - tLoi) ? q : p));
        const s0 = ops.samples[0];
        const gapKm = Math.hypot(atLoi.r[0] - s0.r[0], atLoi.r[1] - s0.r[1], atLoi.r[2] - s0.r[2]);
        const opsReport: Report = { ...ops.report };
        delete opsReport.modeledPhase;
        result = {
          samples: [...before, ...ops.samples],
          report: { modeledPhase: transfer.phase, ...transfer.report, junctionGapKm: +gapKm.toFixed(3), ...opsReport },
        };
        await write(m.id, "Transfer and lunar operations modeled from published milestones", result.samples, result.report, m.lunarOps.notes);
      } else {
        console.log(`${m.name}: modeling lunar operations…`);
        result = lunarOps(m.lunarOps, m.site.lat, m.site.lon);
        await write(m.id, "Lunar operations modeled from published milestones", result.samples, result.report, m.lunarOps.notes);
      }
    }

    if (result) {
      console.log(`  ${result.samples.length} states in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      for (const [key, value] of Object.entries(result.report)) console.log(`  ${key.padEnd(26)} ${value}`);
    }
  }
}

main();
