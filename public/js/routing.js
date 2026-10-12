import { cellOf, cellCentre, getSkyView } from "./terrain.js";
import { PARAMS, walkSpeedMS, doseRate } from "./models.js";

export const OBJECTIVES = {
  shortest: { label: "Shortest distance", help: "Minimises 3-D path length." },
  fastest: { label: "Fastest", help: "Minimises estimated walking time (slope-dependent speed)." },
  lowrisk: { label: "Lower risk", help: "Minimises length weighted by slope and by modeled radiation exposure (more open sky costs more)." },
  science: { label: "Science", help: "Fastest cost, reduced near science targets supplied with the dataset." }
};

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const { k, v } = this; let i = k.length; k.push(key); v.push(val);
    while (i) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop() {
    const { k, v } = this, key = k[0], val = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv; let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[i] <= k[c]) break;
        [k[i], k[c]] = [k[c], k[i]]; [v[i], v[c]] = [v[c], v[i]]; i = c;
      }
    }
    return [key, val];
  }
}

const result = (code, message) => ({ ok: false, code, message });

/**
 * Plan a route on the 8-connected grid.
 * @param terrain  from createTerrain()
 * @param startIdx goal cell indices
 * @param opts { objective, maxSlopeDeg, targets:[{name,x,y,radiusM}], params, doseMultiplier }
 */
export function planRoute(terrain, startIdx, goalIdx, opts = {}) {
  const objective = opts.objective || "fastest";
  const maxSlope = opts.maxSlopeDeg ?? PARAMS.maxSlopeDeg.value;
  const p = opts.params || {};
  const targets = opts.targets || [];
  const { width: w, height: h, cellX, cellY, z, slope } = terrain;
  const N = w * h;
  if (!(objective in OBJECTIVES)) return result("objective", `Unknown route objective "${objective}".`);
  if (objective === "science" && !targets.length) return result("no-targets", "This dataset has no science targets, so a science route cannot be calculated.");
  if (startIdx === goalIdx) return result("same-cell", "Start and destination are the same cell.");
  const blocked = i => !Number.isFinite(z[i]) || !Number.isFinite(slope[i]) || slope[i] > maxSlope;
  if (blocked(startIdx)) return result("start-blocked", `The start cell is no-data or steeper than ${maxSlope}°.`);
  if (blocked(goalIdx)) return result("goal-blocked", `The destination cell is no-data or steeper than ${maxSlope}°.`);
  const sv = objective === "lowrisk" ? getSkyView(terrain) : null;
  const rWeight = p.riskDoseWeight ?? PARAMS.riskDoseWeight.value, rRef = p.riskSlopeRefDeg ?? PARAMS.riskSlopeRefDeg.value;
  const reward = p.scienceReward ?? PARAMS.scienceReward.value;
  // proximity (0..1) of every cell to its nearest science target
  let prox = null;
  if (objective === "science") {
    prox = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const c = cellCentre(terrain, i); let m = 0;
      for (const t of targets) { const r = t.radiusM || PARAMS.scienceRadiusM.value; m = Math.max(m, Math.exp(-((Math.hypot(c.x - t.x, c.y - t.y) / r) ** 2))); }
      prox[i] = m;
    }
  }
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  const heap = new MinHeap(); dist[startIdx] = 0; heap.push(0, startIdx);
  const edge = (u, v, dx, dy) => {
    const horiz = Math.hypot(dx * cellX, dy * cellY), dz = z[v] - z[u];
    const len = Math.hypot(horiz, dz), sdeg = Math.atan2(Math.abs(dz), horiz) * 180 / Math.PI;
    return { len, sdeg };
  };
  while (heap.size) {
    const [d, u] = heap.pop();
    if (u === goalIdx) break;
    if (d > dist[u]) continue;
    const ux = u % w, uy = (u / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = ux + dx, y = uy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const v = y * w + x;
      if (blocked(v)) continue;
      if (dx && dy && (blocked(uy * w + x) || blocked(y * w + ux))) continue; // no corner cutting
      const { len, sdeg } = edge(u, v, dx, dy);
      if (sdeg > maxSlope) continue;
      let c;
      if (objective === "shortest") c = len;
      else if (objective === "lowrisk") c = len * (1 + (sdeg / rRef) ** 2 + rWeight * 0.5 * (sv[u] + sv[v])); // sky-view factor is proportional to modeled dose
      else { c = len / walkSpeedMS(sdeg, p); if (objective === "science") c *= 1 - reward * 0.5 * (prox[u] + prox[v]); }
      if (d + c < dist[v]) { dist[v] = d + c; prev[v] = u; heap.push(dist[v], v); }
    }
  }
  if (!Number.isFinite(dist[goalIdx]))
    return result("unreachable", `No path exists between these cells where every step is valid ground with slope ≤ ${maxSlope}°. Raise the slope limit or choose another destination.`);
  const path = []; for (let v = goalIdx; v !== -1; v = prev[v]) path.push(v); path.reverse();
  return { ok: true, objective, path, metrics: pathMetrics(terrain, path, { params: p, targets, doseMultiplier: opts.doseMultiplier ?? 1 }) };
}

/** Distance, time, elevation change, slope, dose and elevation profile for a list of cell indices. */
export function pathMetrics(terrain, path, { params = {}, targets = [], doseMultiplier = 1 } = {}) {
  const { width: w, cellX, cellY, z, slope } = terrain, sv = getSkyView(terrain);
  let horizM = 0, lenM = 0, timeS = 0, up = 0, down = 0, maxEdge = 0, maxCell = 0, doseMSv = 0;
  const profile = [{ s: 0, z: z[path[0]], slope: slope[path[0]] }];
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const dx = (b % w) - (a % w), dy = ((b / w) | 0) - ((a / w) | 0);
    const horiz = Math.hypot(dx * cellX, dy * cellY), dz = z[b] - z[a], len = Math.hypot(horiz, dz);
    const sdeg = Math.atan2(Math.abs(dz), horiz) * 180 / Math.PI, dt = len / walkSpeedMS(sdeg, params);
    horizM += horiz; lenM += len; timeS += dt;
    if (dz > 0) up += dz; else down -= dz;
    maxEdge = Math.max(maxEdge, sdeg); maxCell = Math.max(maxCell, slope[b]);
    doseMSv += doseRate(0.5 * (sv[a] + sv[b]), doseMultiplier, params) * dt / 86400;
    profile.push({ s: lenM, z: z[b], slope: sdeg });
  }
  maxCell = Math.max(maxCell, slope[path[0]]);
  const stops = [];
  for (const t of targets) {
    const r = t.radiusM || PARAMS.scienceRadiusM.value; let best = Infinity, at = 0;
    path.forEach((c, k) => { const q = cellCentre(terrain, c), d = Math.hypot(q.x - t.x, q.y - t.y); if (d < best) { best = d; at = profile[k].s; } });
    if (best <= r) stops.push({ name: t.name, offsetM: best, alongM: at });
  }
  return {
    lengthM: lenM, horizontalM: horizM, timeS, ascentM: up, descentM: down,
    netElevationM: z[path[path.length - 1]] - z[path[0]], maxEdgeSlopeDeg: maxEdge, maxCellSlopeDeg: maxCell,
    doseOneWayMSv: doseMSv, profile, scienceStops: stops
  };
}
