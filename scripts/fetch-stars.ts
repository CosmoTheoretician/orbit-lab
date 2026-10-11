import { mkdir, writeFile } from "node:fs/promises";

/** Yale Bright Star Catalogue, 5th ed. (VizieR V/50): J2000 positions, V magnitude, B−V colour. */
const URL_BSC =
  "https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=V/50/catalog&-out.max=unlimited" +
  "&-out.add=_RAJ,_DEJ&-out=Vmag&-out=B-V";

async function main() {
  const res = await fetch(URL_BSC);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/);

  const h = lines.findIndex((l) => l.includes("_RAJ2000") && l.includes("Vmag"));
  if (h < 0) {
    console.error(lines.slice(0, 40).join("\n"));
    throw new Error("column header not found in VizieR response");
  }
  const cols = lines[h].split("\t").map((s) => s.trim());
  const iRa = cols.indexOf("_RAJ2000");
  const iDe = cols.indexOf("_DEJ2000");
  const iV = cols.indexOf("Vmag");
  const iBV = cols.indexOf("B-V");

  const data: number[] = [];
  for (const line of lines.slice(h + 3)) { // skip units and dashes lines
    if (!line.trim() || line.startsWith("#")) continue;
    const f = line.split("\t");
    const ra = parseFloat(f[iRa]);
    const de = parseFloat(f[iDe]);
    const v = parseFloat(f[iV]);
    if (![ra, de, v].every(Number.isFinite)) continue;
    const bv = parseFloat(f[iBV]);
    data.push(+ra.toFixed(4), +de.toFixed(4), +v.toFixed(2), Number.isFinite(bv) ? +bv.toFixed(2) : 0.6);
  }

  await mkdir("public/sky", { recursive: true });
  await writeFile(
    "public/sky/stars.json",
    JSON.stringify({
      source: "Yale Bright Star Catalogue, 5th ed. (Hoffleit & Warren 1991), CDS VizieR V/50",
      epoch: "J2000",
      fields: ["raDeg", "decDeg", "vmag", "bv"],
      data,
    }),
  );
  console.log(`wrote ${data.length / 4} stars`);
}

main();