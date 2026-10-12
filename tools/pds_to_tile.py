#!/usr/bin/env python3
"""Convert a PDS3 32-bit float elevation product (for example a HiRISE DTM) into a Mars Survival tile.

Needs numpy (tools/requirements.txt). The raster is read with a memory map, optionally cropped, then
block-averaged by an integer factor. Blocks with fewer than half valid pixels become no-data.
Metadata (projection, scale, source identifiers, processing steps) is written into the tile.

Example (the files are NOT in this repository; download them from the HiRISE site first):
    python3 tools/pds_to_tile.py --img DTEEC_045994_1985_046060_1985_U01.IMG \
        --lbl DTEEC_045994_1985_046060_1985_U01.LBL --max-cells 250000 \
        --product-id DTEEC_045994_1985_046060_1985_U01 \
        --out public/data/jezero-hirise-tile.json
"""
import argparse, json, math, re, struct, sys, pathlib
import numpy as np

def kv(text, key):
    m = re.search(r"^\s*" + re.escape(key) + r"\s*=\s*(.+?)\s*$", text, re.M | re.I)
    return re.sub(r"/\*.*?\*/", "", m.group(1)).strip() if m else None

def num(text, key):
    v = kv(text, key)
    if v is None: return None
    h = re.match(r"16#([0-9A-Fa-f]{8})#", v)
    if h: return struct.unpack(">f", bytes.fromhex(h.group(1)))[0]
    try: return float(re.sub(r"<.*$", "", v).strip())
    except ValueError: return None

def parse_label(text):
    m = re.search(r"^\s*END\s*$", text, re.M)
    if not m: sys.exit("label: END statement not found")
    t = text[:m.start()]
    meta = dict(lines=int(num(t, "LINES") or 0), samples=int(num(t, "LINE_SAMPLES") or 0),
                bits=int(num(t, "SAMPLE_BITS") or 32), type=(kv(t, "SAMPLE_TYPE") or "PC_REAL").strip('"<> '),
                scale=num(t, "MAP_SCALE"), scaling=num(t, "SCALING_FACTOR") if num(t, "SCALING_FACTOR") is not None else 1.0,
                offset=num(t, "OFFSET") or 0.0, missing=num(t, "MISSING_CONSTANT"),
                proj=(kv(t, "MAP_PROJECTION_TYPE") or "").strip('"\' ').upper(),
                clat=num(t, "CENTER_LATITUDE"), clon=num(t, "CENTER_LONGITUDE"),
                lpo=num(t, "LINE_PROJECTION_OFFSET"), spo=num(t, "SAMPLE_PROJECTION_OFFSET"),
                radius_km=num(t, "A_AXIS_RADIUS"))
    if not meta["lines"] or not meta["samples"]: sys.exit("label: LINES / LINE_SAMPLES missing")
    if meta["bits"] != 32 or "REAL" not in meta["type"].upper(): sys.exit("only 32-bit float rasters are supported")
    if not meta["scale"] or meta["scale"] <= 0: sys.exit("label: MAP_SCALE missing; cannot define physical distances")
    meta["little"] = bool(re.match(r"(PC_|LSB_|VAX)", meta["type"], re.I))
    return meta

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--img", required=True); ap.add_argument("--lbl", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-cells", type=int, default=250000)
    ap.add_argument("--crop", nargs=4, type=int, metavar=("COL0", "ROW0", "COLS", "ROWS"), help="crop window in native pixels before downsampling")
    ap.add_argument("--product-id"); ap.add_argument("--url"); ap.add_argument("--name")
    ap.add_argument("--targets", help="JSON list of {name,x_m,y_m,radius_m,note,source} in tile-local metres (x east, y south from NW corner)")
    a = ap.parse_args()

    m = parse_label(pathlib.Path(a.lbl).read_text(errors="replace"))
    dt = np.dtype("<f4" if m["little"] else ">f4")
    raw = np.memmap(a.img, dtype=dt, mode="r")
    if raw.size < m["lines"] * m["samples"]: sys.exit("IMG is shorter than the label describes")
    arr = raw[: m["lines"] * m["samples"]].reshape(m["lines"], m["samples"])
    c0, r0, cw, rh = a.crop if a.crop else (0, 0, m["samples"], m["lines"])
    if c0 < 0 or r0 < 0 or c0 + cw > m["samples"] or r0 + rh > m["lines"]: sys.exit("crop window outside raster")
    f = max(1, math.ceil(math.sqrt(cw * rh / a.max_cells)))
    w, h = cw // f, rh // f
    out = np.full((h, w), np.nan)
    for j in range(h):
        strip = np.asarray(arr[r0 + j * f: r0 + (j + 1) * f, c0: c0 + w * f], dtype=np.float64)
        bad = ~np.isfinite(strip) | (strip < -1e30)
        if m["missing"] is not None: bad |= strip == m["missing"]
        strip = strip * m["scaling"] + m["offset"]
        strip[bad] = 0
        good = (~bad).reshape(f, w, f).sum(axis=(0, 2))
        tot = strip.reshape(f, w, f).sum(axis=(0, 2))
        row = np.where(good >= (f * f) / 2, tot / np.maximum(good, 1), np.nan)
        out[j] = row
    valid = np.isfinite(out)
    if not valid.any(): sys.exit("no valid elevation values")
    z_scale = 0.01
    ints = np.where(valid, np.round(out / z_scale), -2147483648).astype(np.int64)
    cell = m["scale"] * f
    geo = None
    if m["proj"].startswith("EQUIRECT") and None not in (m["clat"], m["clon"], m["lpo"], m["spo"], m["radius_km"]):
        # pixel centres are 1-based: x = (sample-1-SPO)*scale, y = (LPO+1-line)*scale (<= 1 px uncertainty)
        ox = -(m["spo"] + .5) * m["scale"] + c0 * m["scale"]
        oy = (m["lpo"] + .5) * m["scale"] - r0 * m["scale"]
        geo = dict(type="equirectangular", radius_m=m["radius_km"] * 1000, center_lat_deg=m["clat"], center_lon_deg=m["clon"], origin_x_m=ox, origin_y_m=oy)
    steps = [f"Read {pathlib.Path(a.img).name} with label {pathlib.Path(a.lbl).name} ({m['samples']} x {m['lines']} px, {m['scale']} m/px).",
             f"Cropped to columns {c0}..{c0+cw-1}, rows {r0}..{r0+rh-1}." if a.crop else "No crop.",
             f"Block-averaged {f} x {f}; blocks with under half valid pixels set to no-data.",
             f"Elevations stored as integers in units of {z_scale} m (z_scale); no-data = -2147483648."]
    tile = {"format": "mars-survival-tile", "version": 1, "name": a.name or (a.product_id or "Converted PDS terrain"),
            "kind": "derived-from-nasa", "width": w, "height": h, "cell_x_m": cell, "cell_y_m": cell,
            "elevation_unit": "m", "z_scale": z_scale, "z_offset": 0, "nodata": -2147483648,
            "z": ints.flatten().tolist(), "geo": geo,
            "source": {"product_id": a.product_id, "mission": "Mars Reconnaissance Orbiter" if a.product_id and a.product_id.startswith("DTEEC") else None,
                       "instrument": "HiRISE" if a.product_id and a.product_id.startswith("DTEEC") else None, "url": a.url,
                       "credit": "Derived from the source product named here. Credit the data producer named in its label (HiRISE: NASA/JPL-Caltech/University of Arizona).",
                       "processing": steps},
            "notes": [], "targets": json.loads(pathlib.Path(a.targets).read_text()) if a.targets else []}
    if not geo: tile.pop("geo")
    pathlib.Path(a.out).write_text(json.dumps(tile, separators=(",", ":")))
    print(f"wrote {a.out}: {w} x {h} cells, {cell:.2f} m/cell, footprint {w*cell/1000:.2f} x {h*cell/1000:.2f} km, valid {valid.mean()*100:.1f} %")

if __name__ == "__main__":
    main()
