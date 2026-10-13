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
  view(kind: "earth-moon" | "moon"): void;
  onSelect?(m: Mission): void;
}

interface Segment {
  start: number;
  len: number;
  progress: THREE.Line | null;
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

  // ---------- trajectory: geocentric part in the world group, near-Moon part in a group that follows the Moon ----------
  const geoGroup = new THREE.Group();
  const moonGroup = new THREE.Group();
  d.world.add(geoGroup, moonGroup);

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

  function clearTrack() {
    for (const g of [geoGroup, moonGroup]) {
      for (const child of [...g.children]) {
        g.remove(child);
        ((child as THREE.Line).geometry as THREE.BufferGeometry).dispose();
      }
    }
    track = null;
    nearFlags = [];
    trackMoon = null;
    segments = [];
    craft.visible = false;
    d.setMoonOverride(null);
  }

  /** Draws a trajectory, splitting it into geocentric and Moon-relative segments. Returns whether it starts near the Moon. */
  function showTrack(m: Mission, tr: Track, moonFn: (tt: number) => Vec3): boolean {
    const color = OUTCOME[m.outcome].color;
    const n = tr.t.length;
    const geo = new Float32Array(tr.r); // float32 is ~0.03 km precise at lunar distance
    const rel = new Float32Array(3 * n);
    const near: boolean[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const mp = moonFn(tr.t[i]);
      const dx = tr.r[3 * i] - mp[0];
      const dy = tr.r[3 * i + 1] - mp[1];
      const dz = tr.r[3 * i + 2] - mp[2];
      rel.set([dx, dy, dz], 3 * i);
      near[i] = Math.hypot(dx, dy, dz) < NEAR_MOON_KM;
    }

    const addSegment = (start: number, len: number) => {
      const isNear = near[start];
      const group = isNear ? moonGroup : geoGroup;
      const pts = (isNear ? rel : geo).slice(3 * start, 3 * (start + len));
      const seg: Segment = { start, len, progress: null };
      if (len >= 2) {
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
        seg.progress = progress;
      }
      segments.push(seg);
    };

    let s = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || near[i] !== near[s]) {
        addSegment(s, i - s);
        s = i;
      }
    }

    // End marker in the frame of the last sample
    const last = n - 1;
    const endGeom = new THREE.BufferGeometry();
    endGeom.setAttribute("position", new THREE.BufferAttribute((near[last] ? rel : geo).slice(3 * last, 3 * last + 3), 3));
    const end = new THREE.Points(endGeom, new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false }));
    end.frustumCulled = false;
    (near[last] ? moonGroup : geoGroup).add(end);

    track = tr;
    nearFlags = near;
    trackMoon = moonFn;
    return near[0];
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
  const timeHint = document.createElement("div");
  Object.assign(timeHint.style, { marginTop: "6px", color: "#ffd60a" });
  panel.append(list, details, timeHint);
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
    timeHint.textContent = "";

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
    const startsNearMoon = showTrack(m, tr, moonFn);
    const t0 = tr.t[0];
    const t1 = tr.t[tr.t.length - 1];

    const kind = file.modeled
      ? "<b>Modeled from published milestones, not tracking data.</b>"
      : `Trajectory: JPL Horizons (${file.horizonsId})`;
    const rows = file.report
      ? Object.entries(file.report).map(([k, v]) => `<div><span style="color:#7f93ad">${k}</span> ${v}</div>`).join("")
      : "";
    renderDetails(m, `${kind}<div>${fmt(t0)} → ${fmt(t1)} · ${tr.t.length} states</div>${rows}`);

    addButton(startsNearMoon ? "▶ From LOI" : "▶ From launch", () => {
      d.jump(t0, startsNearMoon ? 512 : 4096);
      d.view(startsNearMoon ? "moon" : "earth-moon");
    });
    addButton("◎ Arrival", () => {
      d.jump(Math.max(t0, t1 - 3 * 3600), 32);
      d.view("moon");
    });
  }

  renderList();
  const tmp: Vec3 = [0, 0, 0];

  function update(epoch: Epoch) {
    moonGroup.position.copy(d.moonKm); // Moon-relative segments travel with the rendered Moon
    if (!track) return;
    const t = epoch.tt;
    const t0 = track.t[0];
    const t1 = track.t[track.t.length - 1];
    const k = indexAt(track, t);
    for (const seg of segments) {
      seg.progress?.geometry.setDrawRange(0, Math.min(seg.len, Math.max(0, k - seg.start + 1)));
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

    timeHint.textContent =
      t < t0
        ? "Shown time is before this trajectory: press ▶ to start it."
        : t > t1
          ? "Shown time is after this trajectory (full path shown dim)."
          : "";
  }

  return { update };
}
