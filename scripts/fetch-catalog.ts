import { mkdir, writeFile } from "node:fs/promises";
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

const url = (group: string) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const byNorad = new Map<number, CatalogEntry>();

  for (const [operator, group] of SOURCES) {
    const res = await fetch(url(group));
    if (!res.ok) {
      console.warn(`skip ${group}: HTTP ${res.status}`);
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
    console.log(`${group.padEnd(10)} -> ${operator.padEnd(10)} +${added}`);
    await sleep(1000); // be polite; CelesTrak rate-limits repeated downloads
  }

  const file: CatalogFile = { fetchedAt: new Date().toISOString(), entries: [...byNorad.values()] };
  if (byNorad.size < 1000) {
    console.error(`only ${byNorad.size} objects fetched; refusing to write a degraded catalog`);
    process.exit(1);
  }
  await mkdir("public/data", { recursive: true });
  await writeFile("public/data/catalog.json", JSON.stringify(file));
  console.log(`wrote ${file.entries.length} objects`);
}

main();