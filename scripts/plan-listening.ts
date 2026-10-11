import { mkdir, writeFile } from "node:fs/promises";
import { MISSIONS } from "../src/missions/catalog";
import { listeningWindows, planRow, type LunarSite } from "../src/ground/planner";
import { SES_BETZDORF } from "../src/ground/station";

/**
 * Listening-window planner for a lunar surface site, seen from SES HQ Betzdorf.
 * Usage: npx tsx scripts/plan-listening.ts [missionId] [days] [freqMHz] [minElDeg]
 * The frequency is a placeholder until the mission's downlink is known from its filings.
 */
const [id = "im-3", days = "30", freq = "2200", minEl = "15"] = process.argv.slice(2);
const mission = MISSIONS.find((m) => m.id === id);
if (!mission?.site) throw new Error(`no mission with a site: ${id}`);
const site: LunarSite = { name: mission.site.label, latDeg: mission.site.lat, lonDeg: mission.site.lon };

const start = new Date();
start.setUTCMinutes(0, 0, 0);
const rows = [];
for (let t = start.getTime(); t < start.getTime() + Number(days) * 86400_000; t += 5 * 60_000) {
  rows.push(planRow(SES_BETZDORF, site, new Date(t), Number(freq)));
}
const windows = listeningWindows(rows, Number(minEl));

const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
console.log(`Station: ${SES_BETZDORF.name}`);
console.log(`Site:    ${site.name} (${site.latDeg}°, ${site.lonDeg}°)  downlink ${freq} MHz (placeholder)`);
console.log(`Period:  ${fmt(start)} UTC + ${days} days, Moon elevation ≥ ${minEl}°\n`);

const earthEl = rows.map((r) => r.earthElAtSiteDeg);
console.log(`Earth elevation seen from the site: ${Math.min(...earthEl).toFixed(1)}° to ${Math.max(...earthEl).toFixed(1)}°`);
console.log(`Sun above the site's horizon: ${((100 * rows.filter((r) => r.sunElAtSiteDeg > 0).length) / rows.length).toFixed(0)}% of the time\n`);

console.log("start (UTC)        end (UTC)          max el   Doppler range (kHz)    max rate   site sunlit");
for (const w of windows) {
  console.log(
    `${fmt(w.start)}   ${fmt(w.end)}   ${w.maxElDeg.toFixed(1).padStart(5)}°   ` +
      `${(w.dopplerMinHz / 1000).toFixed(1).padStart(7)} … ${(w.dopplerMaxHz / 1000).toFixed(1).padStart(6)}   ` +
      `${w.maxDopplerRateHzS.toFixed(2).padStart(5)} Hz/s   ${w.sunlit ? "yes" : "no"}`,
  );
}
const hours = windows.reduce((s, w) => s + (w.end.getTime() - w.start.getTime()) / 3600_000, 0);
console.log(`\n${windows.length} windows, ${hours.toFixed(0)} h in total`);

await mkdir("validation/out", { recursive: true });
const csv = [
  "time_utc,az_deg,el_deg,range_km,range_rate_kms,doppler_hz,earth_el_at_site_deg,sun_el_at_site_deg",
  ...rows.map((r) =>
    [r.time.toISOString(), r.azDeg.toFixed(3), r.elDeg.toFixed(3), r.rangeKm.toFixed(1), r.rangeRateKms.toFixed(6),
      r.dopplerHz.toFixed(1), r.earthElAtSiteDeg.toFixed(3), r.sunElAtSiteDeg.toFixed(3)].join(","),
  ),
].join("\n");
await writeFile(`validation/out/plan-${id}.csv`, csv);
console.log(`full table: validation/out/plan-${id}.csv`);
