import * as THREE from "three";
import { BODIES, type Vec3 } from "../core/bodies";
import { moonGeocentric } from "../core/ephemeris";
import { precessionRotor } from "../core/precession";
import { Epoch } from "../core/time";
import { MISSIONS } from "../missions/catalog";
import { indexAt, sampleTrack, type Track } from "../missions/track";
import type { Mission, Outcome } from "../missions/types";
import type { MoonOverride } from "./solarSystem";

const DEG = Math.PI / 180;
/** Within this distance of the Moon (roughly its sphere of influence), trajectories are drawn Moon-relative. */
const NEAR_MOON_KM = 60_000;

/** Mission phases shown under the title (for Resilience, ispace's own names from its Mission 2 graphic). */
const PHASES: Record<string, Array<{ from: string; name: string }>> = {
  resilience: [
    { from: "2025-01-15T06:11:39Z", name: "Earth orbiting phase" },
    { from: "2025-02-14T22:43:00Z", name: "Low-energy transfer" },
    { from: "2025-05-06T20:41:00Z", name: "Lunar orbiting phase" },
    { from: "2025-06-05T19:17:00Z", name: "After impact" },
  ],
};
const ttOf = (iso: string) => Epoch.fromUnixMs(Date.parse(iso)).tt;

function phaseAt(id: string, tt: number): string {
  const phases = PHASES[id];
  if (!phases) return "";
  if (tt < ttOf(phases[0].from)) return "Before launch";
  let name = phases[0].name;
  for (const p of phases) if (tt >= ttOf(p.from)) name = p.name;
  return name;
}

const kmText = (v: unknown) => `${Number(v).toLocaleString("en")} km`;
const dateText = (v: unknown) => String(v).slice(0, 10);

/** Readable summary of a trajectory report; the raw solver output stays available, folded away. */
function reportHtml(r: Record<string, unknown>): string {
  const has = (...keys: string[]) => keys.every((k) => r[k] !== undefined);
  const rows: Array<[string, string]> = [];
  if (has("departureOrbitKm")) {
    const inc = has("departureInclinationDeg") ? `, ${r.departureInclinationDeg}° inclination` : "";
    rows.push(["Departure orbit", `${r.departureOrbitKm} km${inc}`]);
  }
  if (has("distanceAtFirstManeuverKm")) {
    const pub = has("publishedFirstManeuver") ? ` (published: ${String(r.publishedFirstManeuver).split(" (")[0]})` : "";
    rows.push(["At first maneuver", `${kmText(r.distanceAtFirstManeuverKm)} from Earth${pub}`]);
  }
  if (has("correctionManeuverMs", "correctionAt")) rows.push(["Correction", `${r.correctionManeuverMs} m/s on ${dateText(r.correctionAt)}`]);
  if (has("lunarPasses")) rows.push(["Lunar passes", String(r.lunarPasses)]);
  if (has("flybyVInfinityKms")) rows.push(["Flyby speed (v∞)", `${r.flybyVInfinityKms} km/s`]);
  if (has("maxEarthDistanceKm", "maxEarthDistanceAt")) {
    const pub = has("publishedMaxDistance") ? ` (published: ${r.publishedMaxDistance})` : "";
    rows.push(["Farthest point", `${kmText(r.maxEarthDistanceKm)} on ${dateText(r.maxEarthDistanceAt)}${pub}`]);
  }
  if (has("deepSpaceManeuverMs", "maneuverAt")) rows.push(["Deep-space maneuver", `${r.deepSpaceManeuverMs} m/s on ${dateText(r.maneuverAt)}`]);
  if (has("totalTransferDvMs")) rows.push(["Transfer Δv", `${r.totalTransferDvMs} m/s in total`]);
  if (has("loiDeltaVToCaptureMs")) rows.push(["Orbit insertion Δv", `${r.loiDeltaVToCaptureMs} m/s`]);
  if (has("arrivalInclinationDeg")) rows.push(["Lunar orbit inclination", `${r.arrivalInclinationDeg}°`]);
  const line = (k: string, v: unknown, sep: string) => `<div><span style="color:#7f93ad">${k}${sep}</span> ${v}</div>`;
  const summary = rows.map(([k, v]) => line(k, v, ":")).join("");
  const raw = Object.entries(r).map(([k, v]) => line(k, v, "")).join("");
  return `${summary}<details style="margin-top:6px"><summary style="cursor:pointer;color:#8fa6c4">Solver details</summary>${raw}</details>`;
}

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
  /** "scene" for models (already in the scene frame); Horizons files are ICRF. */
  frame?: string;
  t: number[];
  r: number[];
  v: number[];
  moon: { t: number[]; r: number[]; v: number[] } | null;
  report?: Record<string, unknown>;
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

const rawTrack = (t: number[], r: number[], v: number[]): Track => ({
  t: Float64Array.from(t),
  r: Float64Array.from(r),
  v: Float64Array.from(v),
});

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const fmt = (tt: number) => Epoch.fromTT(tt).toDate().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const day = (tt: number) =>
  Epoch.fromTT(tt).toDate().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export interface MissionDeps {
  world: THREE.Group;
  moon: THREE.Mesh;
  /** The rendered Moon's geocentric position (km), updated every frame. */
  moonKm: THREE.Vector3;
  camera: THREE.Camera;
  base: string;
  setMoonOverride(f: MoonOverride): void;
  /** Set the clock: TT seconds since J2000, and a time warp. */
  jump(tt: number, warp: number): void;
  /** Move the camera; for the Earth–Moon view, an optional distance in render units. */
  view(kind: "earth-moon" | "moon", distance?: number): void;
  /** A mission was opened (mission mode on). */
  onSelect?(m: Mission): void;
  /** Back to the list (mission mode off). */
  onExit?(): void;
  /** Clock state for the title: time warp and pause. */
  status?(): { warp: number; paused: boolean };
}

interface Segment {
  start: number;
  len: number;
  near: boolean;
  t0: number;
  t1: number;
  group: THREE.Group;
  progress: THREE.Line | null;
  /** For near-Moon segments: where the Moon was where they connect to the geocentric arcs. */
  anchors: Array<{ t: number; pos: Vec3 }>;
  /** For near-Moon segments between two geocentric arcs (flybys): the same path geocentric, shown outside its time. */
  geoGroup: THREE.Group | null;
  geoProgress: THREE.Line | null;
  /** Marker for the Moon's position at this segment's date, shown when the segment isn't following the Moon. */
  ghost: THREE.Points | null;
  ghostLabel: HTMLDivElement | null;
}

/** Dim full path plus a bright "flown so far" line sharing the same points; returns the bright one. */
function addLines(group: THREE.Group, pts: Float32Array, color: number): THREE.Line | null {
  if (pts.length < 6) return null;
  const attr = new THREE.BufferAttribute(pts, 3);
  const fullGeom = new THREE.BufferGeometry();
  fullGeom.setAttribute("position", attr);
  const full = new THREE.Line(fullGeom, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
  const progGeom = new THREE.BufferGeometry();
  progGeom.setAttribute("position", attr);
  const progress = new THREE.Line(progGeom, new THREE.LineBasicMaterial({ color }));
  full.frustumCulled = false;
  progress.frustumCulled = false;
  group.add(full, progress);
  return progress;
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

  // ---------- trajectory: one group per segment (geocentric, or Moon-relative near the Moon) ----------
  let track: Track | null = null;
  let nearFlags: boolean[] = [];
  let trackMoon: ((tt: number) => Vec3) | null = null;
  let segments: Segment[] = [];

  const craftAttr = new THREE.BufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage);
  const craftGeom = new THREE.BufferGeometry();
  craftGeom.setAttribute("position", craftAttr);
  const craft = new THREE.Points(craftGeom, new THREE.PointsMaterial({ color: 0xffffff, size: 9, sizeAttenuation: false }));
  craft.frustumCulled = false;
  craft.visible = false;
  d.world.add(craft);

  const ghostMaterial = new THREE.PointsMaterial({ color: 0x8e8e93, size: 10, sizeAttenuation: false, transparent: true, opacity: 0.75 });

  function removeGroup(g: THREE.Object3D | null) {
    if (!g) return;
    d.world.remove(g);
    g.traverse((o) => {
      const geom = (o as THREE.Line).geometry as THREE.BufferGeometry | undefined;
      geom?.dispose();
    });
  }

  function clearTrack() {
    for (const seg of segments) {
      removeGroup(seg.group);
      removeGroup(seg.geoGroup);
      removeGroup(seg.ghost);
      seg.ghostLabel?.remove();
    }
    track = null;
    nearFlags = [];
    trackMoon = null;
    segments = [];
    craft.visible = false;
    d.setMoonOverride(null);
  }

  /** Draws a trajectory as alternating geocentric and Moon-relative segments. */
  function showTrack(m: Mission, tr: Track, moonFn: (tt: number) => Vec3) {
    const color = OUTCOME[m.outcome].color;
    const n = tr.t.length;
    const geo = new Float32Array(tr.r); // float32 is ~0.03 km precise at lunar distance
    const rel = new Float32Array(3 * n);
    const near: boolean[] = new Array(n);
    let maxGeoKm = 0;
    for (let i = 0; i < n; i++) {
      const mp = moonFn(tr.t[i]);
      const dx = tr.r[3 * i] - mp[0];
      const dy = tr.r[3 * i + 1] - mp[1];
      const dz = tr.r[3 * i + 2] - mp[2];
      rel.set([dx, dy, dz], 3 * i);
      near[i] = Math.hypot(dx, dy, dz) < NEAR_MOON_KM;
      maxGeoKm = Math.max(maxGeoKm, Math.hypot(tr.r[3 * i], tr.r[3 * i + 1], tr.r[3 * i + 2]));
    }

    const spans: Array<{ start: number; len: number }> = [];
    let s = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || near[i] !== near[s]) {
        spans.push({ start: s, len: i - s });
        s = i;
      }
    }

    spans.forEach(({ start, len }, idx) => {
      const isNear = near[start];
      const end = start + len;
      const group = new THREE.Group();
      d.world.add(group);
      const progress = addLines(group, (isNear ? rel : geo).slice(3 * start, 3 * end), color);

      const anchors: Array<{ t: number; pos: Vec3 }> = [];
      if (isNear && idx > 0) anchors.push({ t: tr.t[start], pos: moonFn(tr.t[start]) });
      if (isNear && idx < spans.length - 1) anchors.push({ t: tr.t[end - 1], pos: moonFn(tr.t[end - 1]) });

      let geoGroup: THREE.Group | null = null;
      let geoProgress: THREE.Line | null = null;
      let ghost: THREE.Points | null = null;
      let ghostLabel: HTMLDivElement | null = null;
      if (anchors.length > 0) {
        // Flyby: geocentric copy, and the ghost Moon at closest approach. Arrival: ghost where it connects.
        let tGhost = anchors[0].t;
        if (anchors.length === 2) {
          geoGroup = new THREE.Group();
          geoGroup.visible = false;
          d.world.add(geoGroup);
          geoProgress = addLines(geoGroup, geo.slice(3 * start, 3 * end), color);
          let best = Infinity;
          for (let i = start; i < end; i++) {
            const dist = Math.hypot(rel[3 * i], rel[3 * i + 1], rel[3 * i + 2]);
            if (dist < best) {
              best = dist;
              tGhost = tr.t[i];
            }
          }
        }
        const gGeom = new THREE.BufferGeometry();
        gGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
        ghost = new THREE.Points(gGeom, ghostMaterial);
        ghost.frustumCulled = false;
        ghost.visible = false;
        const gp = moonFn(tGhost);
        ghost.position.set(gp[0], gp[1], gp[2]);
        d.world.add(ghost);
        ghostLabel = document.createElement("div");
        ghostLabel.textContent = `Moon · ${day(tGhost)}`;
        Object.assign(ghostLabel.style, {
          position: "fixed", color: "#8fa6c4", font: "11px ui-monospace, monospace",
          pointerEvents: "none", display: "none", transform: "translate(14px, -50%)",
        });
        document.body.appendChild(ghostLabel);
      }
      segments.push({
        start, len, near: isNear, t0: tr.t[start], t1: tr.t[end - 1],
        group, progress, anchors, geoGroup, geoProgress, ghost, ghostLabel,
      });
    });

    // End marker, in the group of the last segment
    const last = n - 1;
    const endGeom = new THREE.BufferGeometry();
    endGeom.setAttribute("position", new THREE.BufferAttribute((near[last] ? rel : geo).slice(3 * last, 3 * last + 3), 3));
    const endMark = new THREE.Points(endGeom, new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false }));
    endMark.frustumCulled = false;
    segments[segments.length - 1].group.add(endMark);

    track = tr;
    nearFlags = near;
    trackMoon = moonFn;
    return { startsNearMoon: near[0], hasGeo: near.some((x) => !x), maxGeoKm };
  }

  // ---------- panel: mission list, or one mission's tab ----------
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
  const tab = document.createElement("div");
  tab.style.display = "none";
  const back = document.createElement("button");
  back.textContent = "← Back to list";
  Object.assign(back.style, {
    font: "12px ui-monospace, monospace", color: "#cfe3ff", background: "#1c2836",
    border: "1px solid #3a4a60", borderRadius: "4px", padding: "2px 8px", cursor: "pointer",
  });
  const details = document.createElement("div");
  details.style.marginTop = "8px";
  const timeHint = document.createElement("div");
  Object.assign(timeHint.style, { marginTop: "6px", color: "#ffd60a" });
  tab.append(back, details, timeHint);
  panel.append(list, tab);
  document.body.appendChild(panel);

  // ---------- title at the top center while a mission is open ----------
  const title = document.createElement("div");
  Object.assign(title.style, {
    position: "fixed", top: "8px", left: "50%", transform: "translateX(-50%)", textAlign: "center",
    background: "rgba(0,0,0,.6)", padding: "4px 14px", borderRadius: "6px", pointerEvents: "none", display: "none",
  });
  const titleName = document.createElement("div");
  Object.assign(titleName.style, { color: "#fff", font: "14px/1.4 ui-monospace, monospace" });
  const titleSub = document.createElement("div");
  Object.assign(titleSub.style, { color: "#8fa6c4", font: "11px/1.4 ui-monospace, monospace" });
  const titlePhase = document.createElement("div");
  Object.assign(titlePhase.style, { color: "#ffd60a", font: "12px/1.4 ui-monospace, monospace", display: "none" });
  const titleKeys = document.createElement("div");
  Object.assign(titleKeys.style, { color: "#5f7390", font: "10px/1.4 ui-monospace, monospace" });
  titleKeys.textContent = "← → speed · space pause";
  title.append(titleName, titlePhase, titleSub, titleKeys);
  document.body.appendChild(title);

  const toggle = () => (panel.style.display = panel.style.display === "none" ? "block" : "none");
  button.onclick = toggle;
  addEventListener("keydown", (e) => {
    if (e.key === "l") toggle();
  });

  let selected: Mission | null = null;
  let startCurrent: (() => void) | null = null;

  function showTab(open: boolean) {
    list.style.display = open ? "none" : "block";
    tab.style.display = open ? "block" : "none";
    title.style.display = open ? "block" : "none";
    panel.scrollTop = 0;
  }

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
          Object.assign(row.style, { cursor: "pointer", padding: "1px 4px", borderRadius: "3px" });
          row.onmouseenter = () => (row.style.background = "rgba(100,160,255,.18)");
          row.onmouseleave = () => (row.style.background = "transparent");
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
      `<div id="mission-buttons" style="margin-top:6px;display:flex;gap:6px"></div>` +
      `<div style="margin-top:6px">${m.summary}</div>` +
      (m.site ? `<div style="margin-top:4px">${m.site.label}: ${site}</div>` : "") +
      `<div style="margin-top:4px">${m.timeline.map((e) => `<div>${e.date} · ${e.text}</div>`).join("")}</div>` +
      `<div style="margin-top:6px;color:#8fa6c4">${status}</div>`;
    addShare(m);
  }

  function addShare(m: Mission) {
    const link = document.createElement("div");
    link.textContent = "🔗 Copy link to this mission";
    Object.assign(link.style, { marginTop: "6px", color: "#64d2ff", cursor: "pointer" });
    link.onclick = async () => {
      const url = `${location.origin}${location.pathname}?mission=${m.id}`;
      try {
        await navigator.clipboard.writeText(url);
        link.textContent = "✓ Link copied";
      } catch {
        link.textContent = url;
      }
    };
    details.appendChild(link);
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

  function closeMission() {
    selected = null;
    startCurrent = null;
    clearTrack();
    highlight.visible = false;
    timeHint.textContent = "";
    history.replaceState(null, "", location.pathname);
    showTab(false);
    d.onExit?.();
  }
  back.onclick = closeMission;

  async function select(m: Mission) {
    selected = m;
    startCurrent = null;
    clearTrack();
    timeHint.textContent = "";
    history.replaceState(null, "", `?mission=${m.id}`);
    titleName.innerHTML = `<span style="color:${hex(OUTCOME[m.outcome].color)}">●</span> ${m.name}`;
    titleSub.textContent = m.operator;
    titlePhase.style.display = "none";
    showTab(true);
    d.onSelect?.(m);

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

    if (!file || file.t.length < 2) {
      renderDetails(m, "No trajectory available: site and timeline only.");
      if (m.site) addButton("◎ Show site", () => d.view("moon"));
      return;
    }

    const tr = file.frame === "scene" ? rawTrack(file.t, file.r, file.v) : toSceneTrack(file.t, file.r, file.v);

    // The Moon used to build each trajectory: Horizons' own Moon for Horizons data, the analytical Moon for models
    let moonFn = (tt: number): Vec3 => moonGeocentric(Epoch.fromTT(tt));
    if (file.moon) {
      const moonTrack = toSceneTrack(file.moon.t, file.moon.r, file.moon.v);
      d.setMoonOverride((epoch) => sampleTrack(moonTrack, epoch.tt, [0, 0, 0]));
      const analytic = moonFn;
      moonFn = (tt) => sampleTrack(moonTrack, tt, [0, 0, 0]) ?? analytic(tt);
    }
    const { startsNearMoon, hasGeo, maxGeoKm } = showTrack(m, tr, moonFn);
    const t0 = tr.t[0];
    const t1 = tr.t[tr.t.length - 1];

    const kind = file.modeled
      ? "<b>Modeled from published milestones, not tracking data.</b>"
      : `Trajectory: JPL Horizons (${file.horizonsId})`;
    const rows = file.report ? reportHtml(file.report) : "";
    renderDetails(m, `${kind}<div>${fmt(t0)} → ${fmt(t1)} · ${tr.t.length} states</div>${rows}`);

    // Earth–Moon view sized to the whole trajectory (render units: 1 = 1000 km)
    const viewDistance = Math.max(750, maxGeoKm * 1e-3 * 2.2);
    const start = () => {
      d.jump(t0, hasGeo ? 4096 : 512);
      if (hasGeo) d.view("earth-moon", viewDistance);
      else d.view("moon");
    };
    startCurrent = start;
    addButton(!hasGeo ? "▶ From LOI" : startsNearMoon ? "▶ From flyby" : "▶ From launch", start);
    addButton("◎ Arrival", () => {
      d.jump(Math.max(t0, t1 - 3 * 3600), 32);
      d.view("moon");
    });
  }

  renderList();
  const tmp: Vec3 = [0, 0, 0];
  const proj = new THREE.Vector3();

  function placeLabel(seg: Segment) {
    if (!seg.ghost || !seg.ghostLabel) return;
    if (!seg.ghost.visible) {
      seg.ghostLabel.style.display = "none";
      return;
    }
    seg.ghost.getWorldPosition(proj).project(d.camera);
    if (proj.z > 1 || Math.abs(proj.x) > 1.1 || Math.abs(proj.y) > 1.1) {
      seg.ghostLabel.style.display = "none";
      return;
    }
    seg.ghostLabel.style.display = "block";
    seg.ghostLabel.style.left = `${((proj.x + 1) / 2) * innerWidth}px`;
    seg.ghostLabel.style.top = `${((1 - proj.y) / 2) * innerHeight}px`;
  }

  /** Places all ghost-Moon labels, nudging them apart vertically when they would overlap. */
  function layoutLabels() {
    const shown: Array<{ el: HTMLDivElement; x: number; y: number }> = [];
    for (const seg of segments) {
      placeLabel(seg);
      const el = seg.ghostLabel;
      if (el && el.style.display === "block") shown.push({ el, x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    }
    shown.sort((a, b) => a.y - b.y);
    for (let i = 1; i < shown.length; i++) {
      for (let j = 0; j < i; j++) {
        if (Math.abs(shown[i].x - shown[j].x) < 160 && shown[i].y - shown[j].y < 14) shown[i].y = shown[j].y + 14;
      }
      shown[i].el.style.top = `${shown[i].y}px`;
    }
  }

  function update(epoch: Epoch) {
    if (selected) {
      const st = d.status?.();
      const speed = !st ? "" : st.paused ? " · paused" : ` · ×${st.warp >= 1 ? st.warp : `1/${Math.round(1 / st.warp)}`}`;
      titleSub.textContent = `${selected.operator} · ${fmt(epoch.tt)}${speed}`;
      const phase = phaseAt(selected.id, epoch.tt);
      titlePhase.textContent = phase;
      titlePhase.style.display = phase ? "block" : "none";
    }
    if (!track) return;
    const t = epoch.tt;

    // Near-Moon segments follow the Moon while the displayed time is inside them. Outside it, flybys are
    // shown geocentric (joining both neighbouring arcs), and arrivals sit where the Moon was when they connect.
    for (const seg of segments) {
      if (!seg.near) continue;
      const anchored = seg.anchors.length > 0 && (t < seg.t0 || t > seg.t1);
      if (seg.geoGroup) {
        seg.group.visible = !anchored;
        seg.geoGroup.visible = anchored;
        seg.group.position.copy(d.moonKm);
      } else if (anchored) {
        const a = seg.anchors.reduce((p, q) => (Math.abs(q.t - t) < Math.abs(p.t - t) ? q : p));
        seg.group.position.set(a.pos[0], a.pos[1], a.pos[2]);
      } else {
        seg.group.position.copy(d.moonKm);
      }
      if (seg.ghost) seg.ghost.visible = anchored;
    }
    layoutLabels();

    const k = indexAt(track, t);
    for (const seg of segments) {
      const count = Math.min(seg.len, Math.max(0, k - seg.start + 1));
      seg.progress?.geometry.setDrawRange(0, count);
      seg.geoProgress?.geometry.setDrawRange(0, count);
    }

    const p = sampleTrack(track, t, tmp);
    craft.visible = p !== null;
    if (p) {
      if (nearFlags[Math.max(0, k)] && trackMoon) {
        const mp = trackMoon(t);
        craftAttr.set([d.moonKm.x + p[0] - mp[0], d.moonKm.y + p[1] - mp[1], d.moonKm.z + p[2] - mp[2]]);
      } else {
        craftAttr.set(p);
      }
      craftAttr.needsUpdate = true;
    }

    const t0 = track.t[0];
    const t1 = track.t[track.t.length - 1];
    timeHint.textContent =
      t < t0 ? "Shown time is before this trajectory: press ▶ to start it." : t > t1 ? "Shown time is after this trajectory (full path shown dim)." : "";
  }

  /** Deep link: ?mission=<id> opens the panel, selects the mission and starts it; &play=0 only selects it. */
  async function openFromUrl() {
    const params = new URLSearchParams(location.search);
    const m = MISSIONS.find((x) => x.id === params.get("mission"));
    if (!m) return;
    panel.style.display = "block";
    await select(m);
    if (params.get("play") === "0") return;
    if (startCurrent) startCurrent();
    else if (m.site) d.view("moon");
  }

  return { update, openFromUrl };
}
