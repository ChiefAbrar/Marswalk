import test from "node:test";
import assert from "node:assert/strict";
import { createTerrain, TerrainError, cellAt, cellCentre, elevationAt, localToLatLon, latLonToLocal, getSkyView } from "../public/js/terrain.js";
import { grid, DEG } from "./helpers.js";

const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("slope of a tilted plane uses real cell spacing (anisotropic cells, borders included)", () => {
  const t = grid(12, 9, 7, 3, x => Math.tan(10 * DEG) * x);
  for (const s of t.slope) near(s, 10, 1e-3);
});

test("slope of a plane tilted along y", () => {
  const t = grid(9, 12, 5, 8, (x, y) => Math.tan(20 * DEG) * y);
  for (const s of t.slope) near(s, 20, 1e-3);
});

test("slope of a diagonal plane combines both gradients", () => {
  const gx = 0.1, gy = 0.2, t = grid(10, 10, 4, 4, (x, y) => gx * x + gy * y);
  const expect = Math.atan(Math.hypot(gx, gy)) / DEG;
  for (const s of t.slope) near(s, expect, 1e-3);
});

test("same elevations on a coarser grid give a gentler slope (scale is physical, not per pixel)", () => {
  const z = Float32Array.from({ length: 36 }, (_, k) => (k % 6) * 2);
  const a = createTerrain({ width: 6, height: 6, cellX: 2, cellY: 2, z });
  const b = createTerrain({ width: 6, height: 6, cellX: 4, cellY: 4, z });
  near(Math.tan(a.slope[14] * DEG), 1, 1e-4);
  near(Math.tan(b.slope[14] * DEG), 0.5, 1e-4);
});

test("known pit: 45 degree slope on a cone flank", () => {
  const t = grid(21, 21, 1, 1, (x, y) => Math.hypot(x - 10.5, y - 10.5));
  near(t.slope[10 * 21 + 16], 45, 0.5);
});

test("NaN and Infinity are treated as no-data and excluded from the range", () => {
  const z = new Float32Array(25).fill(100); z[12] = NaN; z[6] = Infinity; z[7] = 90;
  const t = createTerrain({ width: 5, height: 5, cellX: 10, cellY: 10, z });
  assert.equal(t.invalidCount, 2);
  assert.equal(t.min, 90); assert.equal(t.max, 100);
});

test("importer-style no-data (NaN) keeps range sane and slopes finite around holes", () => {
  const z = new Float32Array(49); for (let k = 0; k < 49; k++) z[k] = (k % 7) * 1.0; z[24] = NaN;
  const t = createTerrain({ width: 7, height: 7, cellX: 1, cellY: 1, z });
  assert.equal(t.min, 0); assert.equal(t.max, 6); assert.equal(t.invalidCount, 1);
  assert.ok(Number.isNaN(t.slope[24]));
  assert.ok(Number.isFinite(t.slope[23]) && Number.isFinite(t.slope[25]));
  near(t.slope[23], 45, 1e-3); // plane z = i, spacing 1 → 45°
});

test("all no-data raster is rejected with a clear error", () => {
  assert.throws(() => createTerrain({ width: 4, height: 4, cellX: 1, z: new Float32Array(16).fill(NaN) }), e => e instanceof TerrainError && e.code === "no-data");
});

test("invalid dimensions, spacing and array length are rejected", () => {
  const z = new Float32Array(16);
  assert.throws(() => createTerrain({ width: 2, height: 8, cellX: 1, z: new Float32Array(16) }), /3 × 3/);
  assert.throws(() => createTerrain({ width: 4, height: 4, cellX: 0, z }), /spacing/);
  assert.throws(() => createTerrain({ width: 4, height: 4, cellX: 1, z: new Float32Array(15) }), /expected/);
});

test("cell <-> local metres round trip and footprint", () => {
  const t = grid(10, 8, 25, 25, () => 0);
  assert.equal(t.widthM, 250); assert.equal(t.heightM, 200);
  const c = cellCentre(t, 3 * 10 + 4);
  assert.deepEqual(c, { x: 4.5 * 25, y: 3.5 * 25 });
  assert.equal(cellAt(t, c.x, c.y), 34);
  assert.equal(cellAt(t, -1, 5), -1); assert.equal(cellAt(t, 251, 5), -1);
});

test("bilinear elevation matches a plane and returns null over holes", () => {
  const t = grid(10, 10, 10, 10, (x, y) => 0.5 * x + 0.25 * y);
  near(elevationAt(t, 37.3, 52.9), 0.5 * 37.3 + 0.25 * 52.9, 1e-3);
  const z = new Float32Array(25).fill(1); z[12] = NaN;
  const h = createTerrain({ width: 5, height: 5, cellX: 1, z });
  assert.equal(elevationAt(h, 2.5, 2.5), null);
});

test("equirectangular georeference converts both ways", () => {
  const geo = { radiusM: 3396190, centerLatDeg: 18.4, centerLonDeg: 77.4, originXM: -500, originYM: 800 };
  const t = createTerrain({ width: 4, height: 4, cellX: 10, z: new Float32Array(16), geo });
  const ll = localToLatLon(t, 120, 340);
  const back = latLonToLocal(t, ll.lat, ll.lon);
  near(back.x, 120, 1e-6); near(back.y, 340, 1e-6);
  // 100 m south moves latitude by 100/R radians
  const a = localToLatLon(t, 0, 0), b = localToLatLon(t, 0, 100);
  near((a.lat - b.lat) * DEG * 3396190, 100, 1e-6);
  assert.equal(localToLatLon(grid(4, 4, 1, 1, () => 0), 1, 1), null);
});

test("sky view is 1 on flat ground and lower in a pit", () => {
  const flat = grid(15, 15, 10, 10, () => 0);
  near(getSkyView(flat)[7 * 15 + 7], 1, 1e-9);
  const pit = grid(15, 15, 10, 10, (x, y) => 40 * Math.min(1, Math.hypot(x - 75, y - 75) / 60));
  const sv = getSkyView(pit);
  assert.ok(sv[7 * 15 + 7] < 0.9, `centre sky view ${sv[7 * 15 + 7]}`);
  assert.ok(sv[7 * 15 + 7] < sv[0]);
});
