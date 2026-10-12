import { createTerrain } from "../public/js/terrain.js";
export const DEG = Math.PI / 180;
/** Build a terrain from a function z(x, y) in metres, sampled at cell centres. */
export function grid(w, h, cellX, cellY, fn) {
  const z = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) z[j * w + i] = fn((i + .5) * cellX, (j + .5) * cellY, i, j);
  return createTerrain({ width: w, height: h, cellX, cellY, z });
}
export const idx = (t, i, j) => j * t.width + i;
