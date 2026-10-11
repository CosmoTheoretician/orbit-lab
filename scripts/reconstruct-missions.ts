import { mkdir, writeFile } from "node:fs/promises";
import { MISSIONS } from "../src/missions/catalog";
import { reconstruct } from "../src/missions/reconstruct";
import { lunarOps } from "../src/missions/lunarOps";
import type { Sample } from "../src/missions/horizons";

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

async function main() {
  await mkdir("public/missions", { recursive: true });
  for (const m of MISSIONS) {
    if (!m.site) continue;
    const t0 = Date.now();
    let result: { samples: Sample[]; report: Record<string, unknown> } | null = null;

    if (m.reconstruction) {
      console.log(`${m.name}: solving transfer and lunar phase…`);
      result = reconstruct(m.reconstruction, m.site.lat, m.site.lon);
      await write(m.id, "Reconstruction from published milestones (Earth–Moon–Sun model)", result.samples, result.report, m.reconstruction.notes);
    } else if (m.lunarOps) {
      console.log(`${m.name}: modeling lunar operations…`);
      result = lunarOps(m.lunarOps, m.site.lat, m.site.lon);
      await write(m.id, "Lunar operations modeled from published milestones", result.samples, result.report, m.lunarOps.notes);
    }

    if (result) {
      console.log(`  ${result.samples.length} states in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      for (const [key, value] of Object.entries(result.report)) console.log(`  ${key.padEnd(22)} ${value}`);
    }
  }
}

main();
