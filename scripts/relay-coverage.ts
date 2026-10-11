import { MISSIONS } from "../src/missions/catalog";
import { LUNAR_ORBITERS } from "../src/lunar/orbiters";
import { constellation } from "../src/lunar/kepler";
import { relayCoverage, type RelaySat } from "../src/lunar/coverage";

/**
 * Compares direct-to-Earth contact with relay constellations for a lunar surface site.
 * Usage: npx tsx scripts/relay-coverage.ts [missionId] [days] [minElDeg]
 */
const [id = "im-2", days = "30", minEl = "10"] = process.argv.slice(2);
const m = MISSIONS.find((x) => x.id === id);
if (!m?.site) throw new Error(`no mission with a site: ${id}`);
const site = { name: m.site.label, latDeg: m.site.lat, lonDeg: m.site.lon };

const sats = (orbiterId: string): RelaySat[] => constellation(LUNAR_ORBITERS.find((o) => o.id === orbiterId)!.model!);
const configs: Array<[string, RelaySat[]]> = [
  ["direct to Earth only", []],
  ["Lunar Pathfinder (1)", sats("lunar-pathfinder")],
  ["Queqiao-2 (1)", sats("queqiao-2")],
  ["IM Lunar Data Network (5)", sats("im-ldn")],
  ["Moonlight (5)", sats("moonlight")],
  ["IM + Moonlight (10)", [...sats("im-ldn"), ...sats("moonlight")]],
];

const start = Date.now();
console.log(`Site: ${site.name} (${site.latDeg}°, ${site.lonDeg}°), ${days} days, relay elevation ≥ ${minEl}°, flat horizon`);
console.log("Planned constellations on representative orbits; Queqiao-2 on its published orbit with assumed orientation.\n");
console.log("network                      direct   relay  combined   no-direct hours  filled by relay  longest gap  relays in view");
for (const [name, list] of configs) {
  const r = relayCoverage(site, list, start, Number(days), 300, Number(minEl));
  console.log(
    `${name.padEnd(27)} ${r.directPct.toFixed(1).padStart(6)}% ${r.relayPct.toFixed(1).padStart(6)}% ${r.combinedPct.toFixed(1).padStart(8)}%` +
      `   ${r.blackoutHours.toFixed(0).padStart(15)}  ${(list.length ? r.blackoutFilledPct.toFixed(1) + "%" : "—").padStart(15)}` +
      `  ${r.longestGapHours.toFixed(1).padStart(9)} h  ${r.meanRelaysInView.toFixed(2).padStart(14)}`,
  );
}
