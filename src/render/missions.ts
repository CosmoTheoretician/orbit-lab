import * as THREE from "three";
import { BODIES, type Vec3 } from "../core/bodies";
import { precessionRotor } from "../core/precession";
import { Epoch } from "../core/time";
import { MISSIONS } from "../missions/catalog";
import { indexAt, sampleTrack, type Track } from "../missions/track";
import type { Mission, Outcome } from "../missions/types";
import type { MoonOverride } from "./solarSystem";

const DEG = Math.PI / 180;

export const OUTCOME: Record<Outcome, { color: number; text: string }> = {
  landed: { color: 0x4cd964, text: "Landed" },
  "landed-anomaly": { color: 0xffcc00, text: "Landed with an anomaly" },
  crashed: { color: 0xff453a, text: "Crashed" },
  lost: { color: 0xff9f0a, text: "Lost before reaching the Moon" },
  returned: { color: 0x64d2ff, text: "Returned to Earth" },
  orbiting: { color: 0xbf5af2, text: "In lunar orbit" },
  planned: { color: 0xffffff, text: "Planned" },
};

interface TrackFile {
  source: string;
  horizonsId: string | null;
  modeled?: boolean;
  /** "scene" for reconstructions (already in the scene frame); Horizons files are ICRF. */
  frame?: string;
  t: number[];
  r: number[];
  v: number[];
  moon: { t: number[]; r: number[]; v: number[] } | null;
  report?: Record<string, string | number | boolean>;
  notes?: string[];
}

/** Horizons ICRF (J2000 axes) → scene frame (equator and equinox of date); precession is constant over a mission. */
function toSceneTrack(t: number[], r: number[], v: number[]): Track {
  const P = precessionRotor(Epoch.fromTT((t[0] + t[t.length - 1]) / 2));
  const rr = new Float64Array(r.length);
  const vv = new Float64Array(v.length);
  for (let i = 0; i < t.length; i++) {
    rr.set(P.apply([r[3 * i], r[3 * i + 1], r[3 * i + 2]]), 3 * i);
    vv.set(P.apply([v[3 * i], v[3 * i + 1], v[3 * i + 2]]), 3 * i);
  }
  return { t: Float64Array.from(t), r: rr, v: vv };
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const fmt = (tt: number) => Epoch.fromTT(tt).toDate().toISOString().replace("T", " ").slice(0, 16) + " UTC";

export interface MissionDeps {
  world: THREE.Group;
  moon: THREE.Mesh;
  camera: THREE.Camera;
  base: string;
  setMoonOverride(f: MoonOverride): void;
  /** Set the clock: TT seconds since J2000, and a time warp. */
  jump(tt: number, warp: number): void;
  view(kind: "earth-moon" | "moon"): void;
  onSelect?(m: Mission): void;
}

export function createMissions(d: MissionDeps) {
  // ---------- all landing, impact and target sites on the Moon ----------
  const R = BODIES.moon.equatorialRadius + 2; // just above the surface, km
  const siteXYZ = (lat: number, lon: number): Vec3 => [
    R * Math.cos(lat * DEG) * Math.cos(lon * DEG),
    R * Math.cos(lat * DEG) * Math.sin(lon * DEG),
    R * Math.sin(lat * DEG),
  ];
  const withSite = MISSIONS.filter((m) => m.site);
  const sitePos = new Float32Array(withSite.length * 3);
  const siteCol = new Float32Array(withSite.length * 3);
  withSite.forEach((m, k) => {
    sitePos.set(siteXYZ(m.site!.lat, m.site!.lon), 3 * k);
    const c = new THREE.Color(OUTCOME[m.outcome].color);
    siteCol.set([c.r, c.g, c.b], 3 * k);
  });
  const siteGeom = new THREE.BufferGeometry();
  siteGeom.setAttribute("position", new THREE.BufferAttribute(sitePos, 3));
  siteGeom.setAttribute("color", new THREE.BufferAttribute(siteCol, 3));
  const sites = new THREE.Points(siteGeom, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true }));
  sites.frustumCulled = false;
  d.moon.add(sites); // body-fixed: rotates with the Moon

  const highlightAttr = new THREE.BufferAttribute(new Float32Array(3), 3);
  const highlightGeom = new THREE.BufferGeometry();
  highlightGeom.setAttribute("position", highlightAttr);
  const highlight = new THREE.Points(highlightGeom, new THREE.PointsMaterial({ color: 0xffffff, size: 12, sizeAttenuation: false }));
  highlight.frustumCulled = false;
  highlight.visible = false;
  d.moon.add(highlight);

  // ---------- trajectory of the selected mission, km in the world group ----------
  const trackGroup = new THREE.Group();
  d.world.add(trackGroup);
  let track: Track | null = null;
  let progressLine: THREE.Line | null = null;

  const craftAttr = new THREE.BufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage);
  const craftGeom = new THREE.BufferGeometry();
  craftGeom.setAttribute("position", craftAttr);
  const craft = new THREE.Points(craftGeom, new THREE.PointsMaterial({ color: 0xffffff, size: 8, sizeAttenuation: false }));
  craft.frustumCulled = false;
  craft.visible = false;
  d.world.add(craft);

  function clearTrack() {
    for (const child of [...trackGroup.children]) {
      trackGroup.remove(child);
      ((child as THREE.Line).geometry as THREE.BufferGeometry).dispose();
    }
    track = null;
    progressLine = null;
    craft.visible = false;
    d.setMoonOverride(null);
  }

  function showTrack(m: Mission, tr: Track) {
    const color = OUTCOME[m.outcome].color;
    const pos = new Float32Array(tr.r); // float32 is ~0.03 km precise at lunar distance
    const attr = new THREE.BufferAttribute(pos, 3);

    const fullGeom = new THREE.BufferGeometry();
    fullGeom.setAttribute("position", attr);
    const full = new THREE.Line(fullGeom, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 }));

    const progGeom = new THREE.BufferGeometry();
    progGeom.setAttribute("position", attr);
    progressLine = new THREE.Line(progGeom, new THREE.LineBasicMaterial({ color }));

    const endGeom = new THREE.BufferGeometry();
    endGeom.setAttribute("position", new THREE.BufferAttribute(pos.slice(pos.length - 3), 3));
    const end = new THREE.Points(endGeom, new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false }));

    for (const o of [full, progressLine, end]) {
      o.frustumCulled = false;
      trackGroup.add(o);
    }
    track = tr;
  }

  // ---------- panel ----------
  const button = document.createElement("button");
  button.textContent = "☾ Lunar missions [l]";
  Object.assign(button.style, {
    position: "fixed", left: "10px", bottom: "8px", font: "12px ui-monospace, monospace", color: "#cfe3ff",
    background: "rgba(0,0,0,.65)", border: "1px solid #3a4a60", borderRadius: "6px", padding: "4px 10px", cursor: "pointer",
  });
  document.body.appendChild(button);

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed", left: "10px", bottom: "40px", width: "380px", maxHeight: "62vh", overflowY: "auto",
    background: "rgba(0,0,0,.72)", color: "#cfe3ff", font: "12px/1.45 ui-monospace, monospace",
    padding: "8px 10px", borderRadius: "6px", display: "none",
  });
  const list = document.createElement("div");
  const details = document.createElement("div");
  details.style.marginTop = "8px";
  panel.append(list, details);
  document.body.appendChild(panel);

  const toggle = () => (panel.style.display = panel.style.display === "none" ? "block" : "none");
  button.onclick = toggle;
  addEventListener("keydown", (e) => {
    if (e.key === "l") toggle();
  });

  let selected: Mission | null = null;

  function renderList() {
    list.innerHTML = "";
    for (const sector of ["government", "commercial"] as const) {
      for (const flown of [true, false]) {
        const ms = MISSIONS.filter((m) => m.sector === sector && (m.outcome !== "planned") === flown);
        if (ms.length === 0) continue;
        const header = document.createElement("div");
        header.textContent = `${sector === "government" ? "Government" : "Commercial"} · ${flown ? "flown" : "planned"}`;
        Object.assign(header.style, { color: "#8fa6c4", marginTop: "6px", borderBottom: "1px solid #2c3a4d" });
        list.appendChild(header);
        for (const m of ms) {
          const row = document.createElement("div");
          row.innerHTML =
            `<span style="color:${hex(OUTCOME[m.outcome].color)}">●</span> ${m.name} ` +
            `<span style="color:#7f93ad">${m.launch.slice(0, 4)} · ${m.operator}</span>`;
          Object.assign(row.style, {
            cursor: "pointer", padding: "1px 4px", borderRadius: "3px",
            background: selected?.id === m.id ? "rgba(100,160,255,.18)" : "transparent",
          });
          row.onclick = () => void select(m);
          list.appendChild(row);
        }
      }
    }
  }

  function renderDetails(m: Mission, status: string) {
    const site = m.site
      ? `${Math.abs(m.site.lat).toFixed(3)}°${m.site.lat >= 0 ? "N" : "S"}, ${Math.abs(m.site.lon).toFixed(3)}°${m.site.lon >= 0 ? "E" : "W"}${m.site.approx ? " (approx.)" : ""}`
      : "";
    details.innerHTML =
      `<div style="color:#fff;font-size:13px">${m.name}</div>` +
      `<div>${m.operator} · ${m.country}</div>` +
      `<div><span style="color:${hex(OUTCOME[m.outcome].color)}">●</span> ${OUTCOME[m.outcome].text} · launch ${m.launch}</div>` +
      `<div style="margin-top:4px">${m.summary}</div>` +
      (m.site ? `<div style="margin-top:4px">${m.site.label}: ${site}</div>` : "") +
      `<div style="margin-top:4px">${m.timeline.map((e) => `<div>${e.date} · ${e.text}</div>`).join("")}</div>` +
      `<div style="margin-top:6px;color:#8fa6c4">${status}</div>` +
      `<div id="mission-buttons" style="margin-top:6px;display:flex;gap:6px"></div>`;
  }

  function addButton(label: string, onClick: () => void) {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      font: "12px ui-monospace, monospace", color: "#cfe3ff", background: "#1c2836",
      border: "1px solid #3a4a60", borderRadius: "4px", padding: "2px 8px", cursor: "pointer",
    });
    b.onclick = onClick;
    details.querySelector("#mission-buttons")!.appendChild(b);
  }

  async function select(m: Mission) {
    selected = m;
    d.onSelect?.(m);
    renderList();
    clearTrack();

    if (m.site) {
      highlightAttr.set(siteXYZ(m.site.lat, m.site.lon));
      highlightAttr.needsUpdate = true;
      highlight.visible = true;
    } else {
      highlight.visible = false;
    }

    if (m.outcome === "planned") {
      renderDetails(m, "Planned mission: no trajectory yet. Dates as reported in September 2026.");
      if (m.site) addButton("◎ Show target", () => d.view("moon"));
      return;
    }

    renderDetails(m, "Loading trajectory…");
    let file: TrackFile | null = null;
    try {
      const res = await fetch(`${d.base}missions/${m.id}.json`);
      if (res.ok) file = await res.json();
    } catch {
      file = null;
    }
    if (selected !== m) return; // another mission was chosen meanwhile

    if (!file) {
      renderDetails(m, "No public trajectory in JPL Horizons: site and timeline only.");
      if (m.site) addButton("◎ Show site", () => d.view("moon"));
      return;
    }

    const tr: Track =
      file.frame === "scene"
        ? { t: Float64Array.from(file.t), r: Float64Array.from(file.r), v: Float64Array.from(file.v) }
        : toSceneTrack(file.t, file.r, file.v);
    showTrack(m, tr);
    if (file.moon) {
      const moonTrack = toSceneTrack(file.moon.t, file.moon.r, file.moon.v);
      d.setMoonOverride((epoch) => sampleTrack(moonTrack, epoch.tt, [0, 0, 0]));
    }
    const t0 = tr.t[0];
    const t1 = tr.t[tr.t.length - 1];
    if (file.modeled && file.report) {
      const r = file.report;
      renderDetails(
        m,
        `<b>Modeled reconstruction, not tracking data.</b><br>` +
          `TLI ${r.tli} · perigee ${r.perigeeAltKm} km · transfer ${r.transferDays} d, ${Number(r.transferPathKm).toLocaleString("en")} km<br>` +
          `LOI ${r.loi} · Δv ${r.loiDeltaVms} m/s · v∞ ${r.vInfinityKms} km/s<br>` +
          `DOI ${r.doi} · PDI ${r.pdi}${r.converged ? "" : "<br>⚠ transfer solver did not fully converge"}`,
      );
    } else {
      renderDetails(m, `Trajectory: JPL Horizons (${file.horizonsId}), ${fmt(t0)} → ${fmt(t1)}, ${tr.t.length} states`);
    }
    addButton("▶ From launch", () => {
      d.jump(t0, 4096);
      d.view("earth-moon");
    });
    addButton("◎ Arrival", () => {
      d.jump(Math.max(t0, t1 - 3 * 3600), 32);
      d.view("moon");
    });
  }

  renderList();
  const tmp: Vec3 = [0, 0, 0];

  function update(epoch: Epoch) {
    if (!track || !progressLine) return;
    const k = indexAt(track, epoch.tt);
    progressLine.geometry.setDrawRange(0, Math.max(0, k + 1));
    const p = sampleTrack(track, epoch.tt, tmp);
    craft.visible = p !== null;
    if (p) {
      craftAttr.set(p);
      craftAttr.needsUpdate = true;
    }
  }

  return { update };
}
