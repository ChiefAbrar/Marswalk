import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planRoute, OBJECTIVES, pathMetrics } from "../public/js/routing.js";
import { parseTile } from "../public/js/dem-format.js";
import { cellAt, createTerrain } from "../public/js/terrain.js";
import { walkSpeedMS } from "../public/js/models.js";
import { grid, idx, DEG } from "./helpers.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const V0 = 2.5 / 3.6;
const testTile = () => parseTile(readFileSync(new URL("../public/data/test-terrain.json", import.meta.url), "utf8"));

test("flat ground: distance and time follow the real pixel spacing", () => {
  const t = grid(21, 11, 10, 10, () => 0);
  const r = planRoute(t, idx(t, 0, 5), idx(t, 20, 5), { objective: "shortest" });
  assert.ok(r.ok);
  near(r.metrics.lengthM, 200); near(r.metrics.horizontalM, 200);
  near(r.metrics.timeS, 200 / V0, 1e-6);
  assert.equal(r.metrics.ascentM, 0); assert.equal(r.metrics.maxEdgeSlopeDeg, 0);
  near(r.metrics.profile.at(-1).s, r.metrics.lengthM);
});

test("anisotropic cells: east-west and north-south legs use their own spacing", () => {
  const t = grid(11, 11, 10, 30, () => 0);
  const r = planRoute(t, idx(t, 0, 0), idx(t, 10, 10), { objective: "shortest" });
  near(r.metrics.lengthM, Math.hypot(100, 300), 1e-6); // ten identical diagonal steps of hypot(10 m, 30 m)
});

test("a uniform 10° climb: length is 3-D, ascent is the height gained, time uses the slope speed", () => {
  const t = grid(21, 5, 10, 10, x => Math.tan(10 * DEG) * x);
  const r = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "fastest" });
  assert.ok(r.ok); const m = r.metrics;
  near(m.horizontalM, 200); near(m.lengthM, 200 / Math.cos(10 * DEG), 1e-3);
  near(m.ascentM, 200 * Math.tan(10 * DEG), 1e-3); near(m.descentM, 0); near(m.netElevationM, m.ascentM, 1e-3);
  near(m.maxEdgeSlopeDeg, 10, 1e-3);
  near(m.timeS, m.lengthM / walkSpeedMS(10), 1e-3);
  assert.ok(m.timeS > 200 / V0);
});

test("descent and ascent are tracked separately", () => {
  const t = grid(21, 5, 10, 10, x => 20 * Math.sin(Math.PI * x / 200));
  const r = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "shortest" });
  assert.ok(r.metrics.ascentM > 15 && r.metrics.descentM > 15);
  near(r.metrics.netElevationM, t.z[idx(t, 20, 2)] - t.z[idx(t, 0, 2)], 1e-4);
});

test("a wall with no gap makes the destination unreachable and returns no path", () => {
  const t = grid(21, 11, 10, 10, x => (x > 95 && x < 115 ? 500 : 0));
  const r = planRoute(t, idx(t, 2, 5), idx(t, 18, 5), { objective: "fastest" });
  assert.equal(r.ok, false); assert.equal(r.code, "unreachable"); assert.equal(r.path, undefined);
  assert.match(r.message, /No path exists/);
});

test("a gap in the wall is found, and raising the slope limit opens the direct line", () => {
  const wall = (x, y) => (x > 95 && x < 115 && (y < 20 || y > 40) ? 30 : 0);
  const t = grid(21, 11, 10, 10, wall);
  const detour = planRoute(t, idx(t, 2, 0), idx(t, 18, 0), { objective: "shortest", maxSlopeDeg: 25 });
  assert.equal(detour.ok, false); // start is on the northern segment, wall is 30 m high over 10 m: blocked all along y<20
  const t2 = grid(21, 11, 10, 10, (x, y) => (x > 95 && x < 115 && (y < 20 || y > 60) ? 30 : 0));
  const d = planRoute(t2, idx(t2, 2, 5), idx(t2, 18, 5), { objective: "shortest", maxSlopeDeg: 25 });
  assert.ok(d.ok);
  assert.ok(d.metrics.lengthM >= 160 - 1e-6);
});

test("slope limit is configurable and its rejection explains itself", () => {
  const t = grid(21, 5, 10, 10, x => Math.tan(30 * DEG) * x);
  const strict = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "fastest", maxSlopeDeg: 25 });
  assert.equal(strict.ok, false); assert.match(strict.message, /25°/);
  const loose = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "fastest", maxSlopeDeg: 35 });
  assert.ok(loose.ok);
});

test("start or destination on prohibited or no-data ground is rejected, not drawn as a one-point route", () => {
  const z = new Float32Array(81).fill(0); z[40] = NaN;
  const t = createTerrain({ width: 9, height: 9, cellX: 5, cellY: 5, z });
  assert.equal(planRoute(t, 40, 0, { objective: "fastest" }).code, "start-blocked");
  assert.equal(planRoute(t, 0, 40, { objective: "fastest" }).code, "goal-blocked");
  assert.equal(planRoute(t, 4, 4, { objective: "fastest" }).code, "same-cell");
});

test("routes never cross no-data cells", () => {
  const z = new Float32Array(15 * 7).fill(0); for (let j = 0; j < 6; j++) z[j * 15 + 7] = NaN;
  const t = createTerrain({ width: 15, height: 7, cellX: 5, cellY: 5, z });
  const r = planRoute(t, 3 * 15, 3 * 15 + 14, { objective: "shortest" });
  assert.ok(r.ok); assert.ok(r.path.every(c => Number.isFinite(t.z[c])));
  assert.ok(r.metrics.lengthM > 70);
});

test("objectives are distinct: shortest is never longer, fastest is never slower, lower risk is never steeper on average", () => {
  const t = testTile();
  const s = cellAt(t, 312, 512), g = cellAt(t, 2262, 512);
  const out = Object.fromEntries(["shortest", "fastest", "lowrisk"].map(o => [o, planRoute(t, s, g, { objective: o })]));
  for (const r of Object.values(out)) assert.ok(r.ok, r.message);
  assert.ok(out.shortest.metrics.lengthM <= out.fastest.metrics.lengthM + 1e-6);
  assert.ok(out.shortest.metrics.lengthM <= out.lowrisk.metrics.lengthM + 1e-6);
  assert.ok(out.fastest.metrics.timeS <= out.shortest.metrics.timeS + 1e-6);
  assert.ok(out.fastest.metrics.timeS <= out.lowrisk.metrics.timeS + 1e-6);
  // the escarpment forces every route through the pass (y = 1250–1700 m)
  for (const r of Object.values(out)) assert.ok(r.metrics.lengthM > 2000, `length ${r.metrics.lengthM}`);
});

test("on the test tile the pass makes the route much longer than the straight line (physical distance, not cells)", () => {
  const t = testTile();
  const r = planRoute(t, cellAt(t, 312, 512), cellAt(t, 2262, 512), { objective: "shortest" });
  assert.ok(r.metrics.horizontalM > 2300 && r.metrics.horizontalM < 3500, `${r.metrics.horizontalM}`); // straight line is 1950 m
});

test("science objective needs targets, passes closer to them, and is never faster than the fastest route", () => {
  const t = grid(41, 21, 10, 10, () => 0);
  const s = idx(t, 1, 10), g = idx(t, 39, 10);
  const none = planRoute(t, s, g, { objective: "science", targets: [] });
  assert.equal(none.ok, false); assert.equal(none.code, "no-targets");
  const targets = [{ name: "T", x: 205, y: 185, radiusM: 100 }]; // 80 m off the straight line
  const f = planRoute(t, s, g, { objective: "fastest", targets });
  const sc = planRoute(t, s, g, { objective: "science", targets });
  assert.ok(f.ok && sc.ok);
  assert.equal(f.metrics.scienceStops.length, 1); assert.equal(sc.metrics.scienceStops.length, 1);
  assert.ok(sc.metrics.scienceStops[0].offsetM < f.metrics.scienceStops[0].offsetM - 10, "science route should pass clearly closer");
  assert.ok(sc.metrics.timeS >= f.metrics.timeS - 1e-6);
  assert.ok(sc.metrics.lengthM > f.metrics.lengthM);
});

test("recalculation: changing start, destination or terrain changes the result", () => {
  const t = testTile(), g = cellAt(t, 2262, 512);
  const a = planRoute(t, cellAt(t, 312, 512), g, { objective: "fastest" });
  const b = planRoute(t, cellAt(t, 312, 1200), g, { objective: "fastest" });
  const c = planRoute(t, cellAt(t, 312, 512), cellAt(t, 2262, 1500), { objective: "fastest" });
  assert.notEqual(a.metrics.lengthM, b.metrics.lengthM);
  assert.notEqual(a.metrics.lengthM, c.metrics.lengthM);
  const flat = grid(100, 80, 25, 25, () => 0);
  const d = planRoute(flat, cellAt(flat, 312, 512), g, { objective: "fastest" });
  assert.ok(d.metrics.lengthM < a.metrics.lengthM);
});

test("route dose uses a longer exposure for a slower route and scales with the scenario multiplier", () => {
  const t = grid(21, 5, 10, 10, () => 0);
  const base = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "shortest", doseMultiplier: 1 });
  const high = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "shortest", doseMultiplier: 1.5 });
  near(high.metrics.doseOneWayMSv / base.metrics.doseOneWayMSv, 1.5, 1e-9);
  near(base.metrics.doseOneWayMSv, 0.64 * (base.metrics.timeS / 86400), 0.64 * base.metrics.timeS / 86400 * 0.01); // sky view ≈ 1 on flat ground
});

test("unknown objective is reported", () => {
  const t = grid(5, 5, 1, 1, () => 0);
  assert.equal(planRoute(t, 0, 24, { objective: "teleport" }).code, "objective");
  assert.deepEqual(Object.keys(OBJECTIVES), ["shortest", "fastest", "lowrisk", "science"]);
});
