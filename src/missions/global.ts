import { createJointProblem, type JointSpec, type Res, type State, type Targets } from "./joint";

const DEG = Math.PI / 180;
const DAY = 86400;

export interface GlobalSpec extends JointSpec {
  /** Forward flyby legs must get at least this far from Earth before the DSM window ends. */
  apogeeMinKm: number;
  /** Flybys (best post-flyby fit first) kept for pairing with departure orbits. */
  keepFlybys: number;
}

/** Position mismatch / 20,000 km + velocity mismatch / 0.2 km/s, without allocations (called ~10^8 times). */
function gap(A: State, B: State): number {
  const dx = A.r[0] - B.r[0];
  const dy = A.r[1] - B.r[1];
  const dz = A.r[2] - B.r[2];
  const du = A.v[0] - B.v[0];
  const dv = A.v[1] - B.v[1];
  const dw = A.v[2] - B.v[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / 20_000 + Math.sqrt(du * du + dv * dv + dw * dw) / 0.2;
}

/**
 * Global search over flybys, paired on both sides: with departure orbits before the flyby
 * and with arrival legs after it. The best combinations are refined with the joint solver.
 */
export function reconstructGlobal(spec: GlobalSpec, log: (s: string) => void = () => {}) {
  const P = createJointProblem(spec);
  const { tDep, tM1, tFb, tLoi, apoBy } = P.times;
  const dM1 = spec.firstManeuver.distanceKm;
  const apoKm = spec.apogee.distanceKm;
  const K1 = 8;
  const K2 = 6;
  const s1 = Array.from({ length: K1 }, (_, k) => k / (K1 - 1));
  const s2 = Array.from({ length: K2 }, (_, k) => k / (K2 - 1));
  const preTimes = s1.map(P.tCorrOf);
  const postTimes = s2.map(P.tDsmOf);
  const t0 = Date.now();
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

  // 1. Arrival legs: backward from the LOI perilune, states at the DSM checkpoints
  const arr: Array<{ xb: number[]; st: State[] }> = [];
  for (let th = 0; th < 36; th++) {
    for (let j = 0; j <= 10; j++) {
      const xb = [th * 10 * DEG, 2.33 + 0.03 * j];
      const st = P.runTo(P.arrivalState(xb[0], xb[1]), tLoi, [...postTimes].reverse());
      if (st) arr.push({ xb, st: st.reverse() }); // index k matches postTimes[k]
    }
  }
  log(`  ${arr.length} arrival legs (${secs()})`);

  // 2. Flybys forward, paired with their best arrival leg (published apogee included)
  interface Fly {
    xf: number[];
    post: number;
    ib: number;
    k2: number;
    pre: number;
    idep: number;
    k1: number;
  }
  const fly: Fly[] = [];
  let count = 0;
  for (let aDeg = 0; aDeg < 360; aDeg += 15) {
    for (let dDeg = -75; dDeg <= 75; dDeg += 15) {
      for (let bDeg = 0; bDeg < 360; bDeg += 45) {
        for (const v of [1.25, 1.35, 1.45, 1.55, 1.65, 1.75, 1.85]) {
          const xf = [aDeg * DEG, dDeg * DEG, bDeg * DEG, v];
          if (++count % 2000 === 0) log(`  flybys ${count} (${secs()})`);
          const st = P.runTo(P.flyState(xf[0], xf[1], xf[2], xf[3]), tFb, postTimes);
          if (!st || st[K2 - 1].maxEarthKm < spec.apogeeMinKm) continue;
          let best = { s: Infinity, ib: -1, k: 0 };
          for (let ib = 0; ib < arr.length; ib++) {
            for (let k = 0; k < K2; k++) {
              const A = st[k];
              const B = arr[ib].st[k];
              const far = A.maxEarthKm >= B.maxEarthKm;
              const apKm = far ? A.maxEarthKm : B.maxEarthKm;
              const apT = far ? A.tMaxEarth : B.tMaxEarth;
              const s = gap(A, B) + Math.abs(apKm - apoKm) / 200_000 + Math.max(0, apT - apoBy) / (10 * DAY);
              if (s < best.s) best = { s, ib, k };
            }
          }
          fly.push({ xf, post: best.s, ib: best.ib, k2: best.k, pre: Infinity, idep: -1, k1: 0 });
        }
      }
    }
  }
  log(`  ${count} flybys, ${fly.length} go beyond ${spec.apogeeMinKm.toLocaleString("en")} km (${secs()})`);
  if (fly.length === 0) throw new Error("no flyby reaches the minimum apogee");
  fly.sort((p, q) => p.post - q.post);
  const kept = fly.slice(0, spec.keepFlybys);

  // 3. Departure orbits: states at the first maneuver and at the correction checkpoints
  const deps: Array<{ xd: number[]; m1: number; st: State[] }> = [];
  for (const raKm of [400_000, 600_000, 800_000, 1_100_000, 1_500_000]) {
    for (const iDeg of [30, 40, 50, 60]) {
      for (let oDeg = 0; oDeg < 360; oDeg += 15) {
        for (let wDeg = 0; wDeg < 360; wDeg += 20) {
          const xd = [raKm / 1e5, iDeg * DEG, oDeg * DEG, wDeg * DEG, 30];
          const st = P.runTo(P.deployState(xd[0], xd[1], xd[2], xd[3], xd[4]), tDep, [tM1, ...preTimes]);
          if (!st) continue;
          const r = st[0].r;
          deps.push({ xd, m1: Math.abs(Math.hypot(r[0], r[1], r[2]) - dM1) / 50_000, st: st.slice(1) });
        }
      }
    }
  }
  log(`  ${deps.length} departure orbits (${secs()})`);

  // 4. Kept flybys backward to the correction checkpoints, paired with their best departure orbit
  for (const f of kept) {
    const st = P.runTo(P.flyState(f.xf[0], f.xf[1], f.xf[2], f.xf[3]), tFb, [...preTimes].reverse());
    if (!st) continue;
    const B = st.reverse(); // index k matches preTimes[k]
    for (let id = 0; id < deps.length; id++) {
      const D = deps[id];
      for (let k = 0; k < K1; k++) {
        const s = gap(D.st[k], B[k]) + D.m1;
        if (s < f.pre) {
          f.pre = s;
          f.idep = id;
          f.k1 = k;
        }
      }
    }
  }
  const ranked = kept.filter((f) => f.idep >= 0).sort((p, q) => p.pre + p.post - (q.pre + q.post));
  if (ranked.length === 0) throw new Error("no kept flyby could be paired with a departure orbit");
  log(`  ${ranked.length} flybys paired on both sides, best score ${(ranked[0].pre + ranked[0].post).toFixed(3)} (${secs()})`);

  // 5. Joint refinement of the best combinations; both maneuvers weighted equally
  const tg: Targets = { m1: dM1, apo: apoKm, cap: Infinity, dv1Scale: 0.02 };
  const score = (r: Res) =>
    (r.dv1 + r.dv2) * 1000 + Math.abs(r.m1 - dM1) / 10_000 + Math.max(0, apoKm - r.apoKm) / 10_000 + Math.max(0, r.apoT - apoBy) / DAY;
  let sol: { x: number[]; cur: Res } | null = null;
  for (const [i, f] of ranked.slice(0, 10).entries()) {
    const D = deps[f.idep];
    const A = arr[f.ib];
    const x0 = [...D.xd, s1[f.k1], ...f.xf, ...A.xb, s2[f.k2]];
    const r1 = P.lm(x0, 1000, 40, tg);
    const r2 = r1 ? P.lm(r1.x, 1, 40, tg) : null;
    if (!r2) {
      log(`  start ${i + 1}: failed (a leg hit a body or escaped)`);
      continue;
    }
    log(`  start ${i + 1}: ${P.line(r2.cur, r2.x)}`);
    const ok = r2.cur.mis1 < 1 && r2.cur.mis2 < 1;
    const solOk = sol ? sol.cur.mis1 < 1 && sol.cur.mis2 < 1 : false;
    if (!sol || (ok && !solOk) || (ok === solOk && score(r2.cur) < score(sol.cur))) sol = r2;
  }
  if (!sol) throw new Error("no combination could be refined");

  const samples = P.trajectory(sol.x);
  return {
    report: P.report(sol.x, sol.cur, samples, {
      search: `${count} flybys, ${fly.length} beyond ${spec.apogeeMinKm / 1000}k km, ${ranked.length} paired, 10 refined`,
    }),
    samples,
    x: sol.x,
  };
}
