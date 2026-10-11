import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { gstime } from "satellite.js";
import { Epoch } from "./core/time";
import { BODIES, type BodyId } from "./core/bodies";
import { AU_KM } from "./core/ephemeris";
import { precessionRotor } from "./core/precession";
import { createEarth } from "./render/earth";
import { createSolarSystem } from "./render/solarSystem";
import { createMissions, OUTCOME } from "./render/missions";
import { createStationPanel } from "./render/stationPanel";
import { createLunarOrbiters } from "./render/lunarOrbiters";
import { createConstellationLayer, MEOSPHERE_COLOR } from "./render/constellation";
import { createSelection } from "./render/selection";
import { createCatalogSource } from "./render/catalogSource";
import { createStarfield, type StarFile } from "./render/stars";
import { createSkyBackground } from "./render/sky";
import { MEOSPHERE_PHASE1 } from "./orbit/walker";
import { OPERATORS, type CatalogFile, type Operator } from "./catalog/types";

const KM_TO_UNITS = 1e-3;
const BASE = import.meta.env.BASE_URL;
const DAY_MS = 86_400_000;

// ---------- renderer & scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 1e8); // far enough for Neptune
camera.up.set(0, 0, 1); // scene Z = north celestial pole of date; must be set before OrbitControls
camera.position.set(40, 40, 20);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/** Physics lives in km; only this group scales to render units (1 unit = 1000 km). */
const world = new THREE.Group();
world.scale.setScalar(KM_TO_UNITS);
scene.add(world);

scene.add(new THREE.AmbientLight(0xffffff, 0.12));
// The Sun as a point light at its true position: every body is lit from the right direction.
const sunLight = new THREE.PointLight(0xffffff, 2.2, 0, 0);
scene.add(sunLight);

// ---------- sky at infinity: Milky Way background + catalog stars, both J2000 precessed to date ----------
const j2000ToScene = precessionRotor(Epoch.now()); // ~50"/year change: once per session is ample

async function loadSky(): Promise<THREE.Mesh | null> {
  try {
    const texture = await new THREE.TextureLoader().loadAsync(`${BASE}sky/milkyway.jpg`);
    return createSkyBackground(texture, j2000ToScene);
  } catch (err) {
    console.warn("Milky Way texture not loaded (see scripts/make_milkyway.py)", err);
    return null;
  }
}

async function loadStars(): Promise<THREE.Group | null> {
  try {
    const res = await fetch(`${BASE}sky/stars.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file: StarFile = await res.json();
    return createStarfield(file, j2000ToScene);
  } catch (err) {
    console.warn("star catalog not loaded (run: npm run fetch-stars)", err);
    return null;
  }
}

const [sky, stars] = await Promise.all([loadSky(), loadStars()]);
if (sky) scene.add(sky);
if (stars) scene.add(stars);

// ---------- Earth and the rest of the solar system ----------
const earth = await createEarth(BASE);
world.add(earth.group);
const solar = await createSolarSystem(world, BASE, earth);

// ---------- catalog: one layer per operator, sharing one position buffer ----------
const OPERATOR_ORDER: Operator[] = ["ses", "starlink", "oneweb", "amazonLeo", "other"];

/** SES in front; dense competitor shells faded so Earth and the SES fleet stay readable. */
const STYLE: Record<Operator, { key: string; size: number; opacity: number }> = {
  ses:       { key: "1", size: 4,   opacity: 1 },
  starlink:  { key: "2", size: 1.5, opacity: 0.3 },
  oneweb:    { key: "3", size: 2,   opacity: 0.7 },
  amazonLeo: { key: "4", size: 2,   opacity: 0.8 },
  other:     { key: "5", size: 1.5, opacity: 0.45 },
};

const catalog: CatalogFile = await (await fetch(`${BASE}data/catalog.json`)).json();
const catalogMs = Date.parse(catalog.fetchedAt);
// Sort once so each operator occupies a contiguous slice of the buffer (the worker gets the same order).
catalog.entries.sort((a, b) => OPERATOR_ORDER.indexOf(a.operator) - OPERATOR_ORDER.indexOf(b.operator));
const n = catalog.entries.length;

const positions = new Float32Array(n * 3);
const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);

/** Hidden when the displayed time is far from the catalog date: SGP4 elements are meaningless there. */
const catalogGroup = new THREE.Group();
world.add(catalogGroup);

const counts = {} as Record<Operator, number>;
const layers = {} as Record<Operator, THREE.Points>;
let start = 0;
for (const op of OPERATOR_ORDER) {
  const count = catalog.entries.filter((e) => e.operator === op).length;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", posAttr);
  geom.setDrawRange(start, count);

  const st = STYLE[op];
  const pts = new THREE.Points(
    geom,
    new THREE.PointsMaterial({
      color: OPERATORS[op].color,
      size: st.size,
      sizeAttenuation: false,
      transparent: st.opacity < 1,
      opacity: st.opacity,
      depthWrite: st.opacity >= 1,
    }),
  );
  pts.frustumCulled = false;
  catalogGroup.add(pts);

  counts[op] = count;
  layers[op] = pts;
  start += count;
}

// ---------- simulated meoSphere (J2 secular, own propagator) ----------
const meo = createConstellationLayer(MEOSPHERE_PHASE1, Epoch.now());
world.add(meo.group);

// ---------- lunar orbiters and planned constellations ----------
const orbiters = await createLunarOrbiters(world, BASE, solar.km.moon);

// ---------- selection: real catalog (SGP4), simulated meoSphere (J2), lunar orbiters ----------
const catalogSource = createCatalogSource(
  catalog.entries,
  positions,
  (i) => catalogGroup.visible && layers[catalog.entries[i].operator].visible,
);
const selection = createSelection({
  camera,
  canvas: renderer.domElement,
  world,
  sources: [catalogSource, meo.source, orbiters.source],
});

// ---------- propagation worker ----------
const worker = new Worker(new URL("./propagation/sgp4.worker.ts", import.meta.url), { type: "module" });
worker.postMessage({ type: "init", entries: catalog.entries });

let inFlight = false;
let displayedMs = Date.now();
let propMs = 0;
let failed = 0;

worker.onmessage = (ev: MessageEvent<{ unixMs: number; buffer: ArrayBuffer; ms: number; failed: number }>) => {
  positions.set(new Float32Array(ev.data.buffer));
  posAttr.needsUpdate = true;
  displayedMs = ev.data.unixMs;
  propMs = ev.data.ms;
  failed = ev.data.failed;
  inFlight = false;
};

// ---------- camera focus: step through the bodies with two keys, follow the focused one ----------
const FOCUS_ORDER: BodyId[] = ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune"];
let focusIndex = FOCUS_ORDER.indexOf("earth");
const lastFocus = new THREE.Vector3(); // focused body position in render units

function viewDistance(id: BodyId): number {
  if (id === "earth") return 50; // wide enough to see the satellite shells
  return BODIES[id].equatorialRadius * KM_TO_UNITS * (id === "saturn" ? 7 : 4.5);
}

function focusPosition(id: BodyId, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(solar.km[id]).multiplyScalar(KM_TO_UNITS); // Earth stays at the origin
}

function setFocus(index: number, distance?: number) {
  focusIndex = (index + FOCUS_ORDER.length) % FOCUS_ORDER.length;
  const id = FOCUS_ORDER[focusIndex];
  const target = focusPosition(id, new THREE.Vector3());
  const offset = camera.position.clone().sub(controls.target).normalize().multiplyScalar(distance ?? viewDistance(id));
  controls.target.copy(target);
  camera.position.copy(target).add(offset);
  lastFocus.copy(target);
  solar.setDetail(id).catch((err) => console.warn("high-resolution textures not loaded", err));
}
solar.setDetail("earth").catch((err) => console.warn("high-resolution textures not loaded", err));

// ---------- clock ----------
let epoch = Epoch.now();
let warp = 1;
let paused = false;

// ---------- ground station and lunar missions ----------
const stationPanel = createStationPanel(world); // live pointing and Doppler from SES HQ Betzdorf

const missions = createMissions({
  world,
  moon: solar.moon,
  camera,
  base: BASE,
  onSelect: (m) => stationPanel.setMission(m),
  setMoonOverride: solar.setMoonOverride,
  jump: (tt, w) => {
    epoch = Epoch.fromTT(tt);
    warp = w;
    paused = false;
  },
  view: (kind) => {
    if (kind === "moon") setFocus(FOCUS_ORDER.indexOf("moon"), 6);
    else setFocus(FOCUS_ORDER.indexOf("earth"), 750); // whole Earth–Moon system
  },
});

// ---------- keys ----------
let showHelp = false;

addEventListener("keydown", (e) => {
  if (e.key === " ") paused = !paused;
  if (e.key === "]") warp = Math.min(warp * 2, 65536);
  if (e.key === "[") warp = Math.max(warp / 2, 1 / 64);
  if (e.key === "r") { epoch = Epoch.now(); warp = 1; }
  if (e.key === "m") meo.group.visible = !meo.group.visible;
  if (e.key === ",") setFocus(focusIndex - 1);
  if (e.key === ".") setFocus(focusIndex + 1);
  if (e.key === "e") setFocus(FOCUS_ORDER.indexOf("earth"));
  if (e.key === "o") setFocus(FOCUS_ORDER.indexOf("moon"));
  if (e.key === "g") earth.grid.visible = !earth.grid.visible;
  if (e.key === "h") showHelp = !showHelp;
  for (const op of OPERATOR_ORDER) {
    if (e.key === STYLE[op].key) layers[op].visible = !layers[op].visible;
  }
});

// ---------- HUD: compact status line, context for the focused body, optional help ----------
const hud = document.getElementById("hud")!;
hud.style.fontSize = "11px";
const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const dot = (color: number) => `<span style="color:${hex(color)}">●</span>`;
const dim = (s: string) => `<span style="color:#7f93ad">${s}</span>`;
const line = (key: string, color: number, label: string, on: boolean) =>
  `<span style="opacity:${on ? 1 : 0.4}">${dim(`[${key}]`)} ${dot(color)} ${label}</span>`;

function earthContext(catalogValid: boolean): string {
  const ops = OPERATOR_ORDER.map((op) => line(STYLE[op].key, OPERATORS[op].color, `${OPERATORS[op].label} ${dim(String(counts[op]))}`, layers[op].visible));
  ops.push(line("m", MEOSPHERE_COLOR, `meoSphere phase 1, simulated ${dim(String(meo.count))}`, meo.group.visible));
  const status = catalogValid
    ? dim(`catalog ${catalog.fetchedAt.slice(0, 16).replace("T", " ")} UTC · sgp4 ${propMs.toFixed(1)} ms · ${n} objects`)
    : dim("catalog hidden: shown time is >30 days from the catalog date");
  return `${ops.join("\n")}\n${status}`;
}

function moonContext(): string {
  const orbits = [
    `${dim("[n]")} lunar orbiters ${orbiters.group.visible ? "" : dim("(hidden)")}`,
    `  ${dot(0x64d2ff)} operating  ${dot(0xf5f5f5)} planned (representative orbits)  ${dot(0x8e8e93)} ended / unverified`,
  ];
  const sites = [
    `${dim("[l]")} lunar missions: landing and impact sites`,
    `  ${(["landed", "landed-anomaly", "crashed", "returned", "planned"] as const).map((o) => `${dot(OUTCOME[o].color)} ${OUTCOME[o].text.toLowerCase()}`).join("  ")}`,
  ];
  return [...orbits, ...sites, `${dim("[b]")} ground station · Betzdorf`].join("\n");
}

function bodyContext(id: BodyId): string {
  const d = solar.km[id].length();
  const b = BODIES[id];
  const dist = id === "moon" ? `${Math.round(d).toLocaleString("en")} km` : `${(d / AU_KM).toFixed(3)} AU`;
  const flat = b.flattening > 0 ? ` · flattening ${(b.flattening * 100).toFixed(1)}%` : "";
  return dim(`distance ${dist} · radius ${Math.round(b.equatorialRadius).toLocaleString("en")} km${flat}`);
}

const HELP = [
  "time      [space] pause  [ / ] warp  [r] now",
  "bodies    [,] [.] previous / next  [e] Earth  [o] Moon",
  "Earth     [1–5] operators  [m] meoSphere  [g] grid",
  "Moon      [n] orbiters  [l] missions  [b] ground station",
  "select    [click] satellite or orbiter  [esc] clear",
].join("\n");

function hudHtml(focusId: BodyId, catalogValid: boolean): string {
  const time = new Date(displayedMs).toISOString().replace("T", " ").slice(0, 19);
  const head =
    `${time} UTC · ×${warp}${paused ? " · paused" : ""} · ${fps.toFixed(0)} fps · ` +
    `<b>${BODIES[focusId].name}</b> ${dim("[,] [.]")} · ${dim("[h] help")}`;
  const context =
    focusId === "earth" ? earthContext(catalogValid) : focusId === "moon" ? moonContext() : bodyContext(focusId);
  return `${head}\n\n${context}${showHelp ? `\n\n${dim(HELP)}` : ""}`;
}

const credits = document.createElement("div");
Object.assign(credits.style, {
  position: "fixed", right: "10px", bottom: "8px", color: "#7f93ad", font: "10px ui-monospace, monospace", pointerEvents: "none",
});
credits.textContent =
  "Planet textures: Solar System Scope (CC BY 4.0) · Milky Way: NASA/GSFC SVS · Stars: Yale BSC · Trajectories: JPL Horizons";
document.body.appendChild(credits);

let fps = 60;
let lastHud = 0;
const tmp = new THREE.Vector3();
const sunDir = new THREE.Vector3();

// ---------- loop ----------
let last = performance.now();
function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  if (!paused) epoch = epoch.plus(dt * warp);
  if (dt > 0) fps = fps * 0.95 + (1 / dt) * 0.05;

  if (!inFlight) {
    inFlight = true;
    worker.postMessage({ type: "propagate", unixMs: epoch.toUnixMs() });
  }

  // Everything is drawn at the epoch of the catalog positions on screen, so all layers stay consistent.
  const shown = Epoch.fromUnixMs(displayedMs);
  const focusId = FOCUS_ORDER[focusIndex];
  const catalogValid = Math.abs(displayedMs - catalogMs) < 30 * DAY_MS;
  catalogGroup.visible = catalogValid;

  meo.update(shown);
  solar.update(shown, camera, focusId);
  missions.update(shown);
  orbiters.update(shown);
  sunDir.copy(solar.km.sun).normalize();
  earth.update(gstime(new Date(displayedMs)), sunDir);
  stationPanel.update(displayedMs);
  sunLight.position.copy(solar.km.sun).multiplyScalar(KM_TO_UNITS);

  // Follow the focused body as it moves.
  focusPosition(focusId, tmp);
  camera.position.add(tmp.clone().sub(lastFocus));
  controls.target.add(tmp.clone().sub(lastFocus));
  lastFocus.copy(tmp);

  selection.update(displayedMs);
  controls.update();
  // Sky layers at infinity: centred on the camera, so they never show parallax.
  sky?.position.copy(camera.position);
  stars?.position.copy(camera.position);
  renderer.render(scene, camera);

  if (now - lastHud > 250) {
    lastHud = now;
    hud.innerHTML = hudHtml(focusId, catalogValid);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
