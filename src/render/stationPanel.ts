import * as THREE from "three";
import { listeningWindows, planRow, siteState, type LunarSite } from "../ground/planner";
import { SES_BETZDORF, stationInertial, type GroundStation } from "../ground/station";
import type { Mission } from "../missions/types";

const MIN_EL_DEG = 15;

const utc = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return d > 0 ? `${d} d ${h} h` : `${h} h ${String(m).padStart(2, "0")} min`;
}
const signed = (x: number, digits: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toLocaleString("en", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const dim = (s: string) => `<span style="color:#7f93ad">${s}</span>`;
const head = (s: string) => `<span style="color:#ffffff">${s}</span>`;

/**
 * Live pointing, Doppler and listening-window status from a ground station to the selected lunar site,
 * at the displayed time. Station marker and line of sight are drawn in the world group (km).
 */
export function createStationPanel(world: THREE.Group, station: GroundStation = SES_BETZDORF) {
  let site: LunarSite | null = null;
  let freqMHz = 2200;
  let next: { start: Date; end: Date } | null = null;
  let searchedAt = Number.NaN;
  let lastPanel = 0;

  // ---------- station marker and line of sight ----------
  const markerAttr = new THREE.BufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage);
  const markerGeom = new THREE.BufferGeometry();
  markerGeom.setAttribute("position", markerAttr);
  const marker = new THREE.Points(markerGeom, new THREE.PointsMaterial({ color: 0xffd60a, size: 7, sizeAttenuation: false }));
  marker.frustumCulled = false;
  world.add(marker);

  const linkAttr = new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage);
  const linkGeom = new THREE.BufferGeometry();
  linkGeom.setAttribute("position", linkAttr);
  const linkMat = new THREE.LineBasicMaterial({ color: 0x30d158, transparent: true, opacity: 0.7 });
  const link = new THREE.Line(linkGeom, linkMat);
  link.frustumCulled = false;
  link.visible = false;
  world.add(link);

  // ---------- panel ----------
  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed", right: "10px", bottom: "30px", width: "460px", maxWidth: "calc(100vw - 20px)",
    background: "rgba(0,0,0,.75)", color: "#cfe3ff", font: "11px/1.5 ui-monospace, monospace",
    padding: "8px 10px", borderRadius: "6px", display: "none",
  });
  const text = document.createElement("div");
  text.style.whiteSpace = "pre-wrap";

  const freqRow = document.createElement("label");
  freqRow.textContent = "Downlink frequency ";
  Object.assign(freqRow.style, { display: "block", marginTop: "6px" });
  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.001";
  input.value = String(freqMHz);
  Object.assign(input.style, {
    width: "110px", font: "11px ui-monospace, monospace", color: "#cfe3ff", background: "#1c2836",
    border: "1px solid #3a4a60", borderRadius: "4px", padding: "1px 4px",
  });
  input.addEventListener("keydown", (e) => e.stopPropagation()); // typing digits must not toggle layers
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (v > 0) freqMHz = v;
    lastPanel = 0;
  });
  freqRow.append(input, document.createTextNode(" MHz"));

  const note = document.createElement("div");
  note.textContent = "Placeholder until the mission's filed downlink frequency is known. [b] hides this panel.";
  Object.assign(note.style, { color: "#7f93ad", fontSize: "10px" });

  panel.append(text, freqRow, note);
  document.body.appendChild(panel);
  addEventListener("keydown", (e) => {
    if (e.key === "b") panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  function setMission(m: Mission) {
    site = m.site ? { name: m.site.label, latDeg: m.site.lat, lonDeg: m.site.lon } : null;
    next = null;
    searchedAt = Number.NaN;
    lastPanel = 0;
    if (site) panel.style.display = "block";
  }

  /** First listening window within 3 days of `fromMs` (the current one if a window is open). */
  function searchNext(fromMs: number) {
    const rows = [];
    for (let t = fromMs; t < fromMs + 3 * 86400_000; t += 10 * 60_000) rows.push(planRow(station, site!, new Date(t), freqMHz));
    const w = listeningWindows(rows, MIN_EL_DEG);
    next = w.length > 0 ? { start: w[0].start, end: w[0].end } : null;
    searchedAt = fromMs;
  }

  /** Call every frame with the displayed time (UTC ms). */
  function update(simMs: number) {
    const date = new Date(simMs);
    const st = stationInertial(station, date);
    markerAttr.set(st);
    markerAttr.needsUpdate = true;

    if (!site) {
      link.visible = false;
      text.innerHTML = `${head("Ground station")}   ${station.name}\n${dim("Select a mission with a lunar site in the missions panel ([l]).")}`;
      return;
    }
    const sp = siteState(site, date).pos;
    linkAttr.set([...st, ...sp]);
    linkAttr.needsUpdate = true;
    link.visible = true;

    const now = performance.now();
    if (now - lastPanel < 250) return;
    lastPanel = now;

    const row = planRow(station, site, date, freqMHz);
    const later = planRow(station, site, new Date(simMs + 10_000), freqMHz);
    const rate = (later.dopplerHz - row.dopplerHz) / 10;
    const moonUp = row.elDeg >= MIN_EL_DEG;
    const earthUp = row.earthElAtSiteDeg > 0;
    const open = moonUp && earthUp;
    linkMat.color.setHex(open ? 0x30d158 : 0xff453a);

    const stale = next
      ? simMs > next.end.getTime() || simMs < searchedAt - 60_000
      : Number.isNaN(searchedAt) || Math.abs(simMs - searchedAt) > 3600_000;
    if (stale) searchNext(simMs);

    const earthLine = earthUp
      ? `${row.earthElAtSiteDeg.toFixed(1)}° above the horizon: the site can see Earth`
      : `${Math.abs(row.earthElAtSiteDeg).toFixed(1)}° below the horizon: no direct line to Earth`;
    const sunLine = row.sunElAtSiteDeg > 0
      ? `${row.sunElAtSiteDeg.toFixed(1)}° above the horizon: lunar day, solar power available`
      : `${Math.abs(row.sunElAtSiteDeg).toFixed(1)}° below the horizon: lunar night, no solar power`;

    let windowBlock: string;
    if (open) {
      windowBlock =
        `${head("Listening window:")} <span style="color:#30d158">OPEN</span>\n` +
        (next ? `  closes      ${utc(next.end)} ${dim(`(in ${duration(next.end.getTime() - simMs)})`)}` : "");
    } else {
      const reason = !moonUp
        ? row.elDeg < 0
          ? "the Moon is below Betzdorf's horizon"
          : `the Moon is only ${row.elDeg.toFixed(1)}° above Betzdorf's horizon (needs ${MIN_EL_DEG}°)`
        : "Earth is below the site's horizon, so no station on Earth can reach it";
      windowBlock =
        `${head("Listening window:")} <span style="color:#ff453a">CLOSED</span>\n` +
        `  reason      ${reason}\n` +
        (next
          ? `  next        opens  ${utc(next.start)} ${dim(`(in ${duration(next.start.getTime() - simMs)})`)}\n` +
            `              closes ${utc(next.end)} ${dim(`(open ${duration(next.end.getTime() - next.start.getTime())})`)}`
          : `  next        none in the next 3 days`);
    }

    text.innerHTML =
      `${head("Ground station")}   ${station.name}\n` +
      `${head("Lunar site")}       ${site.name}\n\n` +
      `${head("Pointing from Betzdorf")}\n` +
      `  azimuth     ${row.azDeg.toFixed(2).padStart(7)}°  ${dim("compass direction (0° north, 90° east)")}\n` +
      `  elevation   ${row.elDeg.toFixed(2).padStart(7)}°  ${dim(`above the horizon (listening needs ≥ ${MIN_EL_DEG}°)`)}\n\n` +
      `${head("Radio link")}\n` +
      `  distance    ${Math.round(row.rangeKm).toLocaleString("en")} km\n` +
      `  range rate  ${signed(row.rangeRateKms * 1000, 1)} m/s ${dim(row.rangeRateKms >= 0 ? "(moving away)" : "(approaching)")}\n` +
      `  Doppler     ${signed(row.dopplerHz, 1)} Hz, changing by ${rate.toFixed(3)} Hz/s\n` +
      `  tune to     ${(freqMHz + row.dopplerHz / 1e6).toFixed(6)} MHz\n\n` +
      `${head("At the lunar site")}\n` +
      `  Earth       ${earthLine}\n` +
      `  Sun         ${sunLine}\n\n` +
      windowBlock;
  }

  return { update, setMission };
}
