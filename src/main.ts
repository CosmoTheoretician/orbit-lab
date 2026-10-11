import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { gstime } from "satellite.js";
import { Epoch } from "./core/time";
import { BODIES } from "./core/bodies";
import { sunDirection } from "./core/sun";
import { createEarth } from "./render/earth";
import { createConstellationLayer, MEOSPHERE_COLOR } from "./render/constellation";
import { MEOSPHERE_PHASE1 } from "./orbit/walker";
import { OPERATORS, type CatalogFile, type Operator } from "./catalog/types";

// ---------- renderer & scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 1e6);
camera.up.set(0, 0, 1); // inertial Z = north; must be set before OrbitControls
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
world.scale.setScalar(1e-3);
scene.add(world);

scene.add(new THREE.AmbientLight(0xffffff, 0.25));
const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
scene.add(sunLight, sunLight.target);

const earth = createEarth(BODIES.earth.equatorialRadius);
world.add(earth);

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

const catalog: CatalogFile = await (await fetch(`${import.meta.env.BASE_URL}data/catalog.json`)).json();
// Sort once so each operator occupies a contiguous slice of the buffer (the worker gets the same order).
catalog.entries.sort((a, b) => OPERATOR_ORDER.indexOf(a.operator) - OPERATOR_ORDER.indexOf(b.operator));
const n = catalog.entries.length;

const positions = new Float32Array(n * 3);
const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);

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
  world.add(pts);

  counts[op] = count;
  layers[op] = pts;
  start += count;
}

// ---------- simulated meoSphere (J2 secular, own propagator) ----------
const meo = createConstellationLayer(MEOSPHERE_PHASE1, Epoch.now());
world.add(meo.group);

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

// ---------- clock & controls ----------
let epoch = Epoch.now();
let warp = 1;
let paused = false;

addEventListener("keydown", (e) => {
  if (e.key === " ") paused = !paused;
  if (e.key === "]") warp = Math.min(warp * 2, 65536);
  if (e.key === "[") warp = Math.max(warp / 2, 1 / 64);
  if (e.key === "r") { epoch = Epoch.now(); warp = 1; }
  if (e.key === "m") meo.group.visible = !meo.group.visible;
  for (const op of OPERATOR_ORDER) {
    if (e.key === STYLE[op].key) layers[op].visible = !layers[op].visible;
  }
});

// ---------- HUD ----------
const hud = document.getElementById("hud")!;
const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const legendLine = (key: string, color: number, label: string, visible: boolean) =>
  `<span style="opacity:${visible ? 1 : 0.35}">[${key}] <span style="color:${hex(color)}">●</span> ${label}</span>`;

function legend(): string {
  const ops = OPERATOR_ORDER.map((op) =>
    legendLine(STYLE[op].key, OPERATORS[op].color, `${OPERATORS[op].label} (${counts[op]})`, layers[op].visible),
  );
  ops.push(legendLine("m", MEOSPHERE_COLOR, `meoSphere phase 1, simulated (${meo.count})`, meo.group.visible));
  return ops.join("\n");
}

let fps = 60;
let lastHud = 0;

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
  earth.rotation.z = gstime(new Date(displayedMs));
  const s = sunDirection(shown);
  sunLight.position.set(s[0] * 100, s[1] * 100, s[2] * 100);
  meo.update(shown);

  controls.update();
  renderer.render(scene, camera);

  if (now - lastHud > 250) {
    lastHud = now;
    hud.innerHTML =
      `${new Date(displayedMs).toISOString().replace("T", " ").slice(0, 19)} UTC   warp ×${warp}${paused ? "  [paused]" : ""}\n` +
      `render ${fps.toFixed(0)} fps   sgp4 ${propMs.toFixed(1)} ms / ${n} objects   failed ${failed}\n` +
      `catalog fetched ${catalog.fetchedAt.replace("T", " ").slice(0, 16)} UTC\n\n` +
      `${legend()}\n\n[space] pause  [ / ] warp  [r] now  [1-5, m] toggle layers`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);