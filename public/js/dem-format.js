import { createTerrain, TerrainError } from "./terrain.js";

export const LIMITS = { maxTileBytes: 50 * 1024 * 1024, maxTileCells: 4_000_000, maxPlannerCells: 250_000 };

export class ImportError extends TerrainError {
  constructor(message, code = "import") { super(message, code); this.name = "ImportError"; }
}

/** Parse a "mars-survival-tile" JSON document into a terrain. Elevation is stored as integers: z·z_scale + z_offset, null = no data. */
export function parseTile(text, { sizeBytes = text.length } = {}) {
  if (sizeBytes > LIMITS.maxTileBytes) throw new ImportError(`File is ${(sizeBytes / 1048576).toFixed(0)} MB; the limit for a terrain tile is ${LIMITS.maxTileBytes / 1048576} MB. Create a smaller tile with tools/pds_to_tile.py.`, "too-large");
  let d;
  try { d = JSON.parse(text); } catch { throw new ImportError("The file is not valid JSON.", "malformed"); }
  if (!d || d.format !== "mars-survival-tile") throw new ImportError('Not a Mars Survival terrain tile (missing "format": "mars-survival-tile").', "format");
  if (d.version !== 1) throw new ImportError(`Unsupported tile version ${d.version}.`, "version");
  if (d.elevation_unit !== "m") throw new ImportError(`Elevation unit must be "m", got ${JSON.stringify(d.elevation_unit)}.`, "units");
  const { width, height } = d;
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new ImportError("Tile width and height must be integers.", "dimensions");
  if (width * height > LIMITS.maxTileCells) throw new ImportError(`Tile has ${width * height} cells; the limit is ${LIMITS.maxTileCells}.`, "too-large");
  if (!(d.cell_x_m > 0) || !(d.cell_y_m > 0)) throw new ImportError("Tile must give positive cell_x_m and cell_y_m in metres.", "spacing");
  if (!Array.isArray(d.z) || d.z.length !== width * height) throw new ImportError(`z has ${Array.isArray(d.z) ? d.z.length : "no"} values; ${width} × ${height} = ${width * height} expected.`, "length");
  const scale = d.z_scale ?? 1, offset = d.z_offset ?? 0;
  if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(offset)) throw new ImportError("z_scale and z_offset must be finite numbers (z_scale ≠ 0).", "scaling");
  const nodata = d.nodata ?? null;
  const z = new Float32Array(d.z.length);
  for (let i = 0; i < z.length; i++) {
    const raw = d.z[i];
    z[i] = raw === null || (nodata !== null && raw === nodata) || typeof raw !== "number" || !Number.isFinite(raw) ? NaN : raw * scale + offset;
  }
  let geo = null;
  if (d.geo) {
    const g = d.geo;
    if (g.type !== "equirectangular" || ![g.radius_m, g.center_lat_deg, g.center_lon_deg, g.origin_x_m, g.origin_y_m].every(Number.isFinite))
      throw new ImportError("geo must be an equirectangular block with radius_m, center_lat_deg, center_lon_deg, origin_x_m and origin_y_m.", "geo");
    geo = { radiusM: g.radius_m, centerLatDeg: g.center_lat_deg, centerLonDeg: g.center_lon_deg, originXM: g.origin_x_m, originYM: g.origin_y_m };
  }
  const terrain = createTerrain({ width, height, cellX: d.cell_x_m, cellY: d.cell_y_m, z, geo,
    meta: { name: d.name || "Unnamed tile", kind: d.kind || "unknown", source: d.source || null, notes: d.notes || [] } });
  const targets = [];
  for (const t of d.targets || []) {
    if (!t.name || !Number.isFinite(t.x_m) || !Number.isFinite(t.y_m)) throw new ImportError("Each target needs name, x_m and y_m.", "targets");
    targets.push({ name: t.name, x: t.x_m, y: t.y_m, radiusM: t.radius_m, note: t.note || "", source: t.source || "" });
  }
  terrain.meta.targets = targets;
  const dr = d.default_route;
  terrain.meta.defaultRoute = dr && Number.isFinite(dr.start?.x_m) && Number.isFinite(dr.start?.y_m) && Number.isFinite(dr.destination?.x_m) && Number.isFinite(dr.destination?.y_m)
    ? { start: { x: dr.start.x_m, y: dr.start.y_m }, goal: { x: dr.destination.x_m, y: dr.destination.y_m } } : null;
  return terrain;
}

// ---------- PDS3 (HiRISE DTM) -------------------------------------------------------------

const keyRe = k => new RegExp("^\\s*" + k.replace(/\^/g, "\\^") + "\\s*=\\s*(.+?)\\s*$", "mi");
function labelValue(text, key) { const m = text.match(keyRe(key)); return m ? m[1].replace(/\/\*.*?\*\//g, "").trim() : null; }
function labelNumber(text, key) {
  const v = labelValue(text, key); if (v === null) return null;
  const hex = v.match(/^16#([0-9A-Fa-f]{8})#/);
  if (hex) { const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, parseInt(hex[1], 16)); return dv.getFloat32(0); }
  const n = parseFloat(v.replace(/<.*$/, "")); return Number.isFinite(n) ? n : null;
}

export function parsePdsLabel(text) {
  const end = text.search(/^\s*END\s*$/m);
  if (end < 0) throw new ImportError("PDS label END statement not found. Select the matching .LBL file together with the .IMG file.", "label");
  const t = text.slice(0, end);
  const lines = labelNumber(t, "LINES"), samples = labelNumber(t, "LINE_SAMPLES");
  if (!lines || !samples) throw new ImportError("PDS label does not give LINES and LINE_SAMPLES.", "label");
  const bits = labelNumber(t, "SAMPLE_BITS") ?? 32;
  const type = (labelValue(t, "SAMPLE_TYPE") || "PC_REAL").replace(/["<>]/g, "");
  if (bits !== 32 || !/REAL/i.test(type)) throw new ImportError(`Unsupported sample format (${bits}-bit ${type}). Only 32-bit floating-point elevation rasters are supported.`, "format");
  const scale = labelNumber(t, "MAP_SCALE");
  if (!(scale > 0)) throw new ImportError("PDS label has no MAP_SCALE (metres per pixel), so physical distances cannot be defined.", "scale");
  const ptr = labelValue(t, "^IMAGE") || "";
  const ptrNum = ptr.match(/^\(?[^()]*?,\s*(\d+)\s*\)?$/) || ptr.match(/^(\d+)$/);
  const radiusKm = labelNumber(t, "A_AXIS_RADIUS");
  const proj = (labelValue(t, "MAP_PROJECTION_TYPE") || "").replace(/["']/g, "").toUpperCase();
  const meta = {
    lines, samples, mapScaleM: scale,
    littleEndian: /^(PC_|LSB_|VAX)/i.test(type),
    recordBytes: labelNumber(t, "RECORD_BYTES") || 0,
    imageRecord: ptrNum ? +ptrNum[1] : null,
    scalingFactor: labelNumber(t, "SCALING_FACTOR") ?? 1,
    offset: labelNumber(t, "OFFSET") ?? 0,
    missing: labelNumber(t, "MISSING_CONSTANT"),
    projection: proj,
    centerLat: labelNumber(t, "CENTER_LATITUDE"), centerLon: labelNumber(t, "CENTER_LONGITUDE"),
    lineOffset: labelNumber(t, "LINE_PROJECTION_OFFSET"), sampleOffset: labelNumber(t, "SAMPLE_PROJECTION_OFFSET"),
    radiusM: radiusKm ? radiusKm * 1000 : null
  };
  // Georeference (equirectangular). Pixel centres are 1-based: x = (sample − 1 − SAMPLE_PROJECTION_OFFSET)·scale,
  // y = (LINE_PROJECTION_OFFSET + 1 − line)·scale. Uncertainty from this convention is at most one pixel.
  meta.geo = proj.startsWith("EQUIRECT") && [meta.centerLat, meta.centerLon, meta.lineOffset, meta.sampleOffset, meta.radiusM].every(Number.isFinite)
    ? { radiusM: meta.radiusM, centerLatDeg: meta.centerLat, centerLonDeg: meta.centerLon,
        originXM: -(meta.sampleOffset + .5) * scale, originYM: (meta.lineOffset + .5) * scale }
    : null;
  return meta;
}

/**
 * Read a 32-bit float PDS raster in strips of `factor` rows and block-average it down to at most maxCells cells.
 * Only one strip is in memory at a time. A block is no-data when fewer than half of its pixels are valid.
 * @param {Blob} img the .IMG file; @param {object} meta from parsePdsLabel; @param {boolean} detached true if the label is a separate file
 */
export async function readPdsDownsampled(img, meta, { detached = true, maxCells = LIMITS.maxPlannerCells, onProgress = () => {} } = {}) {
  const { lines, samples } = meta;
  const base = detached ? (meta.imageRecord && meta.recordBytes ? (meta.imageRecord - 1) * meta.recordBytes : 0) : (meta.recordBytes * ((meta.imageRecord || 1) - 1));
  if (img.size < base + lines * samples * 4) throw new ImportError(`The .IMG file is ${img.size} bytes but the label describes ${base + lines * samples * 4}. It may be truncated or the label may belong to another file.`, "truncated");
  const factor = Math.max(1, Math.ceil(Math.sqrt((lines * samples) / maxCells)));
  const w = Math.floor(samples / factor), h = Math.floor(lines / factor);
  if (w < 3 || h < 3) throw new ImportError("Raster is too small after downsampling.", "dimensions");
  const out = new Float32Array(w * h);
  const sum = new Float64Array(w), cnt = new Uint32Array(w);
  for (let j = 0; j < h; j++) {
    sum.fill(0); cnt.fill(0);
    const buf = await img.slice(base + j * factor * samples * 4, base + (j + 1) * factor * samples * 4).arrayBuffer();
    const dv = new DataView(buf);
    for (let r = 0; r < factor; r++) for (let s = 0; s < w * factor; s++) {
      const raw = dv.getFloat32((r * samples + s) * 4, meta.littleEndian);
      if (!Number.isFinite(raw) || raw < -1e30 || (meta.missing !== null && raw === meta.missing)) continue;
      const i = (s / factor) | 0; sum[i] += raw * meta.scalingFactor + meta.offset; cnt[i]++;
    }
    for (let i = 0; i < w; i++) out[j * w + i] = cnt[i] >= (factor * factor) / 2 ? sum[i] / cnt[i] : NaN;
    if (j % 16 === 0) { onProgress(j / h); await new Promise(r => setTimeout(r)); }
  }
  const geo = meta.geo ? { ...meta.geo } : null; // origin stays at the north-west corner of the retained area
  return createTerrain({ width: w, height: h, cellX: meta.mapScaleM * factor, cellY: meta.mapScaleM * factor, z: out, geo,
    meta: { name: "HiRISE DTM (downsampled in browser)", kind: "derived-from-nasa", downsampleFactor: factor, nativeWidth: samples, nativeHeight: lines, nativeCellM: meta.mapScaleM, source: null, notes: [`Block-averaged ${factor} × ${factor}; blocks with under half valid pixels are no-data.`], targets: [] } });
}

/** Load one or more user-selected files. Returns { terrain, description }. */
export async function loadDemFiles(files, { onProgress } = {}) {
  files = [...files];
  if (!files.length) throw new ImportError("No file selected.", "none");
  const img = files.find(f => /\.img$/i.test(f.name)), lbl = files.find(f => /\.lbl$/i.test(f.name));
  if (img) {
    let labelText, detached = true;
    if (lbl) labelText = await lbl.text();
    else {
      labelText = new TextDecoder("ascii").decode(new Uint8Array(await img.slice(0, 262144).arrayBuffer()));
      detached = false;
      if (!/^\s*LINES\s*=/m.test(labelText)) throw new ImportError("This .IMG has no embedded label. Select the matching .LBL file together with the .IMG.", "label");
    }
    const meta = parsePdsLabel(labelText);
    const terrain = await readPdsDownsampled(img, meta, { detached, onProgress });
    terrain.meta.name = img.name;
    return { terrain };
  }
  const f = files[0];
  if (/\.json$/i.test(f.name)) return { terrain: parseTile(await f.text(), { sizeBytes: f.size }) };
  throw new ImportError(`Unsupported file type "${f.name}". Use a Mars Survival tile (.json) or a PDS .IMG with its .LBL. GeoTIFF and CSV are not accepted because they do not carry pixel spacing and units reliably; convert them with tools/pds_to_tile.py.`, "unsupported");
}
