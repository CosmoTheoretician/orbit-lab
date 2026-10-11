import { mkdir, writeFile } from "node:fs/promises";
import { LUNAR_ORBITERS } from "../src/lunar/orbiters";
import { parseCoverage, parseHorizonsVectors, type Sample } from "../src/missions/horizons";

/**
 * Moon-centred ephemerides of lunar orbiters from JPL Horizons, from 2 days ago to 10 days ahead
 * (or as far as Horizons has data), 5-minute steps.
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

async function vectors(command: string, start: Date, stop: Date) {
  let a = start;
  let b = stop;
  for (let attempt = 0; attempt < 3; attempt++) {
    const params = new URLSearchParams({
      format: "json", COMMAND: `'${command}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'VECTORS'",
      CENTER: "'500@301'", REF_PLANE: "'FRAME'", REF_SYSTEM: "'ICRF'", VEC_TABLE: "'2'", VEC_CORR: "'NONE'",
      OUT_UNITS: "'KM-S'", CSV_FORMAT: "'YES'", START_TIME: `'${hz(a)}'`, STOP_TIME: `'${hz(b)}'`, STEP_SIZE: "'5 m'",
    });
    const res = await fetch(`${API}?${params}`);
    await sleep(1500);
    const j = (await res.json()) as { result?: string; error?: string };
    const text = j.result ?? j.error ?? "";
    const samples = parseHorizonsVectors(text);
    if (samples.length > 0) return samples;
    const cov = parseCoverage(text);
    if (!cov.earliest && !cov.latest) {
      console.warn(`  Horizons: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
      return null;
    }
    if (cov.earliest && cov.earliest > a) a = new Date(cov.earliest.getTime() + 120_000);
    if (cov.latest && cov.latest < b) b = new Date(cov.latest.getTime() - 60_000);
    if (b <= a) {
      console.warn("  no ephemeris coverage near the current date");
      return null;
    }
    console.log(`  adjusting window to ${hz(a)} – ${hz(b)}`);
  }
  return null;
}

const pack = (s: Sample[]) => ({
  t: s.map((x) => +x.t.toFixed(3)),
  r: s.flatMap((x) => x.r.map((c) => +c.toFixed(3))),
  v: s.flatMap((x) => x.v.map((c) => +c.toFixed(6))),
});

async function main() {
  await mkdir("public/orbiters", { recursive: true });
  const now = Date.now();
  for (const o of LUNAR_ORBITERS) {
    if (!o.horizons) continue;
    console.log(`${o.name}:`);
    const id = await lookup(o.horizons.lookup);
    if (!id) {
      console.warn("  not found in Horizons");
      continue;
    }
    const s = await vectors(id, new Date(now - 2 * 86400_000), new Date(now + 10 * 86400_000));
    if (!s) continue;
    await writeFile(
      `public/orbiters/${o.id}.json`,
      JSON.stringify({ source: "JPL Horizons", horizonsId: id, center: "Moon (500@301)", frame: "ICRF", timeScale: "TDB seconds since J2000", ...pack(s) }),
    );
    console.log(`  wrote ${s.length} states, ${((s[s.length - 1].t - s[0].t) / 86400).toFixed(1)} days`);
  }
}

main();
