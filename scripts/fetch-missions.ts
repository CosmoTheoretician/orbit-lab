import { mkdir, writeFile } from "node:fs/promises";
import { MISSIONS } from "../src/missions/catalog";
import { parseCoverage, parseHorizonsVectors, type Sample } from "../src/missions/horizons";

/**
 * Downloads lunar mission trajectories from JPL Horizons: geocentric ICRF states for each spacecraft
 * (10-minute steps, plus 1-minute steps over the final 3 hours), and the Moon over the same window.
 */
const API = "https://ssd.jpl.nasa.gov/api/horizons.api";
const LOOKUP = "https://ssd.jpl.nasa.gov/api/horizons_lookup.api";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hz = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

async function lookup(names: string[]): Promise<string | null> {
  for (const name of names) {
    const res = await fetch(`${LOOKUP}?sstr=${encodeURIComponent(name)}&group=sct`);
    await sleep(500);
    if (!res.ok) continue;
    const j = (await res.json()) as { result?: Array<{ name: string; spkid: string }> };
    if (j.result && j.result.length > 0) {
      console.log(`  lookup "${name}": ${j.result.map((x) => `${x.name} [${x.spkid}]`).join("; ")}`);
      return String(j.result[0].spkid);
    }
  }
  return null;
}

async function vectors(command: string, start: Date, stop: Date, step: string) {
  let a = start;
  let b = stop;
  for (let attempt = 0; attempt < 3; attempt++) {
    const params = new URLSearchParams({
      format: "json", COMMAND: `'${command}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'VECTORS'",
      CENTER: "'500@399'", REF_PLANE: "'FRAME'", REF_SYSTEM: "'ICRF'", VEC_TABLE: "'2'", VEC_CORR: "'NONE'",
      OUT_UNITS: "'KM-S'", CSV_FORMAT: "'YES'", START_TIME: `'${hz(a)}'`, STOP_TIME: `'${hz(b)}'`, STEP_SIZE: `'${step}'`,
    });
    const res = await fetch(`${API}?${params}`);
    await sleep(1500); // be polite to JPL
    const j = (await res.json()) as { result?: string; error?: string };
    const text = j.result ?? j.error ?? "";
    const samples = parseHorizonsVectors(text);
    if (samples.length > 0) return { samples, start: a, stop: b };

    // Outside the available data: Horizons states its coverage; shrink the window and retry.
    const cov = parseCoverage(text);
    if (!cov.earliest && !cov.latest) {
      console.warn(`  Horizons: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
      return null;
    }
    if (cov.earliest && cov.earliest > a) a = new Date(cov.earliest.getTime() + 120_000);
    if (cov.latest && cov.latest < b) b = new Date(cov.latest.getTime() - 60_000);
    console.log(`  adjusting window to ${hz(a)} – ${hz(b)}`);
  }
  return null;
}

function merge(coarse: Sample[], fine: Sample[]): Sample[] {
  const byTime = new Map<number, Sample>();
  for (const s of [...coarse, ...fine]) byTime.set(Math.round(s.t * 1000), s);
  return [...byTime.values()].sort((x, y) => x.t - y.t);
}

const pack = (s: Sample[]) => ({
  t: s.map((x) => +x.t.toFixed(3)),
  r: s.flatMap((x) => x.r.map((c) => +c.toFixed(3))),
  v: s.flatMap((x) => x.v.map((c) => +c.toFixed(6))),
});

async function main() {
  await mkdir("public/missions", { recursive: true });
  const missing: string[] = [];

  for (const m of MISSIONS) {
    if (!m.horizons) continue;
    console.log(`${m.name}:`);
    const id = await lookup(m.horizons.lookup);
    if (!id) {
      console.warn("  not found in Horizons; the app will show the site and timeline only");
      missing.push(m.name);
      continue;
    }

    const coarse = await vectors(id, new Date(m.horizons.start), new Date(m.horizons.stop), "10 m");
    if (!coarse) {
      missing.push(m.name);
      continue;
    }
    const fineStart = new Date(Math.max(coarse.start.getTime(), coarse.stop.getTime() - 3 * 3600_000));
    const fine = await vectors(id, fineStart, coarse.stop, "1 m");
    const sc = merge(coarse.samples, fine?.samples ?? []);
    const moon = await vectors("301", coarse.start, coarse.stop, "30 m");

    await writeFile(
      `public/missions/${m.id}.json`,
      JSON.stringify({
        source: "JPL Horizons", horizonsId: id, center: "Earth (500@399)", frame: "ICRF", timeScale: "TDB seconds since J2000",
        ...pack(sc), moon: moon ? pack(moon.samples) : null,
      }),
    );
    const days = (sc[sc.length - 1].t - sc[0].t) / 86400;
    console.log(`  wrote ${sc.length} states over ${days.toFixed(1)} days`);
  }

  if (missing.length > 0) console.log(`\nno trajectory for: ${missing.join(", ")}`);
}

main();
