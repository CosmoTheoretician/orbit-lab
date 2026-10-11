import { access, mkdir, writeFile } from "node:fs/promises";
import type { CatalogEntry, CatalogFile, Operator } from "../src/catalog/types";

/** Order matters: the first group that contains an object claims it. */
const SOURCES: Array<[Operator, string]> = [
  ["ses", "ses"],
  ["ses", "intelsat"],
  ["starlink", "starlink"],
  ["oneweb", "oneweb"],
  ["amazonLeo", "kuiper"],
  ["other", "active"],
];

const OUT_DIR = "public/data";
const OUT_FILE = `${OUT_DIR}/catalog.json`;
const MIN_OBJECTS = 1000;
/** Last deployed catalog, used when CelesTrak is unreachable (set in CI). */
const FALLBACK_URL = process.env.CATALOG_FALLBACK_URL;

const url = (group: string) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries only server errors (5xx) and network failures.
 * A 4xx (e.g. 403 rate limit) is final: retrying it would only count as more downloads.
 */
async function fetchWithRetry(u: string, attempts = 3): Promise<Response | null> {
  for (let k = 1; k <= attempts; k++) {
    try {
      const res = await fetch(u);
      if (res.ok) return res;
      console.warn(`  HTTP ${res.status} (attempt ${k}/${attempts})`);
      if (res.status < 500) return null;
    } catch (err) {
      console.warn(`  ${(err as Error).message} (attempt ${k}/${attempts})`);
    }
    if (k < attempts) await sleep(5000 * k);
  }
  return null;
}

async function fromCelesTrak(): Promise<{ file: CatalogFile; failed: string[] }> {
  const byNorad = new Map<number, CatalogEntry>();
  const failed: string[] = [];

  for (const [operator, group] of SOURCES) {
    console.log(`${group}:`);
    const res = await fetchWithRetry(url(group));
    if (!res) {
      failed.push(group);
      continue;
    }

    const lines = (await res.text())
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);

    let added = 0;
    let i = 0;
    while (i + 2 < lines.length) {
      const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
      if (l1.startsWith("1 ") && l2.startsWith("2 ")) {
        const norad = parseInt(l1.slice(2, 7), 10);
        if (!byNorad.has(norad)) {
          byNorad.set(norad, { name: name.trim(), norad, operator, line1: l1, line2: l2 });
          added++;
        }
        i += 3;
      } else {
        i += 1;
      }
    }
    console.log(`  -> ${operator} +${added}`);
    await sleep(1000); // be polite; CelesTrak rate-limits repeated downloads
  }

  return { file: { fetchedAt: new Date().toISOString(), entries: [...byNorad.values()] }, failed };
}

async function fromFallback(): Promise<CatalogFile | null> {
  if (!FALLBACK_URL) return null;
  console.warn(`trying last deployed catalog at ${FALLBACK_URL}`);
  const res = await fetchWithRetry(FALLBACK_URL, 2);
  if (!res) return null;
  const file = (await res.json()) as CatalogFile;
  return file.entries && file.entries.length >= MIN_OBJECTS ? file : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function write(file: CatalogFile) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(file));
  console.log(`wrote ${file.entries.length} objects (fetched ${file.fetchedAt})`);
}

async function main() {
  const { file, failed } = await fromCelesTrak();
  if (failed.length === 0 && file.entries.length >= MIN_OBJECTS) return write(file);
  console.warn(
    failed.length > 0
      ? `incomplete download (failed: ${failed.join(", ")}); not writing a partial catalog`
      : `only ${file.entries.length} objects from CelesTrak`,
  );

  const fallback = await fromFallback();
  if (fallback) {
    console.warn("redeploying the previous catalog");
    return write(fallback);
  }

  if (await exists(OUT_FILE)) {
    console.warn(`keeping existing ${OUT_FILE}`);
    return;
  }

  console.error("no usable catalog source; refusing to build without data");
  process.exit(1);
}

main();