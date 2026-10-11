import { propagate, twoline2satrec } from "satellite.js";
import type { CatalogEntry } from "../catalog/types";

type InMsg =
  | { type: "init"; entries: CatalogEntry[] }
  | { type: "propagate"; unixMs: number };

let recs: ReturnType<typeof twoline2satrec>[] = [];

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;

  if (msg.type === "init") {
    recs = msg.entries.map((e) => twoline2satrec(e.line1, e.line2));
    return;
  }

  // Output: TEME positions in km. Failed objects (decayed, bad elements) stay at the origin.
  const t0 = performance.now();
  const date = new Date(msg.unixMs);
  const out = new Float32Array(recs.length * 3);
  let failed = 0;

  for (let i = 0; i < recs.length; i++) {
    const pv = propagate(recs[i], date);
    const p = pv ? pv.position : null;
    if (p && typeof p === "object") {
      out[3 * i] = p.x;
      out[3 * i + 1] = p.y;
      out[3 * i + 2] = p.z;
    } else {
      failed++;
    }
  }

  self.postMessage(
    { unixMs: msg.unixMs, buffer: out.buffer, ms: performance.now() - t0, failed },
    { transfer: [out.buffer] },
  );
};