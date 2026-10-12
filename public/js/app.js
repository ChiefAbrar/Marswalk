import { cellAt, cellCentre, cellOf, getSkyView, localToLatLon, TerrainError } from "./terrain.js";
import { parseTile, loadDemFiles, LIMITS } from "./dem-format.js";
import { planRoute, OBJECTIVES } from "./routing.js";
import { PARAMS, DUST, RADIATION_SCENARIOS, doseRate, environment, marsClock, assessSurvival, walkSpeedMS } from "./models.js";

const JEZERO_LON_E = 77.4;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtLen = m => (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`);
const fmtTime = s => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };

const DATASETS = [
  { name: "HiRISE digital terrain model DTEEC_045994_1985_046060_1985_U01", mission: "Mars Reconnaissance Orbiter / HiRISE", status: "Supported input, not bundled", use: "Elevation and slope when you convert it to a tile (tools/pds_to_tile.py) or open the .IMG + .LBL directly.", limits: "About 380 MB. Product ID and page address were carried over from the original project and have not been re-checked. Local coverage only.", href: "https://www.uahirise.org/dtm/dtm.php?ID=ESP_045994_1985" },
  { name: "Curiosity RAD surface dose rate (0.64 mSv/day)", mission: "Mars Science Laboratory / RAD, Gale Crater", status: "Reference value", use: "Scale factor for the modeled radiation layer, reduced by terrain horizon blocking.", limits: "Measured at Gale, not Jezero. The sky-view scaling is a simplification. Citation: Hassler et al. 2014, Science 343, 1244797 (to be re-checked against the paper).", href: "https://doi.org/10.1126/science.1244797" },
  { name: "Mars24 time algorithm (Allison and McEwen 2000)", mission: "NASA GISS", status: "Calculation", use: "Local solar time at Jezero's longitude from your computer clock.", limits: "Omits the small TT−UT term; no accuracy figure is claimed here.", href: "https://www.giss.nasa.gov/tools/mars24/" },
  { name: "Perseverance MEDA weather data", mission: "Mars 2020 / MEDA", status: "Not integrated", use: "Nothing. Temperature, pressure and dust values are scenarios.", limits: "No MEDA file is read by this version. Adding observed daily temperature and pressure summaries is the next planned step.", href: "https://pds-geosciences.wustl.edu/missions/mars2020/meda.htm" },
  { name: "MOLA, CTX, CRISM, THEMIS, GRS, REMS", mission: "Various", status: "Not integrated", use: "Nothing. They were listed in the original interface without being used, and have been removed from it.", limits: "No mineralogy layer exists. Science targets must come with the terrain tile, with a source.", href: "" }
];
const PARAM_LABELS = { walkSpeedFlatKmh: "Flat walking speed", slopeSpeedScaleDeg: "Slope speed scale", maxSlopeDeg: "Slope limit", baselineDoseMSvPerDay: "Reference dose rate", skyViewSearchM: "Horizon search distance", riskSlopeRefDeg: "Risk slope reference", riskDoseWeight: "Risk radiation weight", scienceReward: "Science reward", scienceRadiusM: "Science target radius", enduranceHours: "Consumable endurance", requiredEndReservePct: "Required end reserve", pressurePa: "Surface pressure" };
const ROUTE_DASH = { shortest: [10, 5], fastest: [], lowrisk: [3, 4], science: [14, 4, 2, 4] };

const state = { terrain: null, layer: "elevation", pointMode: "start", start: -1, goal: -1, selected: "fastest", routes: {}, cursor: -1, layerCache: null, hover: -1 };

// ---------- inputs ----------
function settings() {
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  return {
    maxSlope: clamp(num("max-slope", 25), 1, 60), speed: clamp(num("walk-speed", 2.5), .5, 8),
    hour: num("local-hour", 12), dust: $("dust").value, radiation: $("radiation").value,
    reserves: { power: num("res-power", 90), o2: num("res-o2", 90), water: num("res-water", 90) },
    endurance: { power: Math.max(1, num("end-power", 8)), o2: Math.max(1, num("end-o2", 8)), water: Math.max(1, num("end-water", 10)) },
    requiredReserve: clamp(num("req-reserve", 30), 0, 90)
  };
}
const params = s => ({ walkSpeedFlatKmh: s.speed });
const multiplier = s => RADIATION_SCENARIOS[s.radiation].multiplier;
const passable = (t, i, maxSlope) => i >= 0 && Number.isFinite(t.z[i]) && Number.isFinite(t.slope[i]) && t.slope[i] <= maxSlope;

function nearestPassable(t, x, y, maxSlope) {
  const c = cellAt(t, clamp(x, 0, t.widthM - 1e-6), clamp(y, 0, t.heightM - 1e-6)), [ci, cj] = cellOf(t, c);
  for (let r = 0; r < Math.max(t.width, t.height); r++)
    for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
      if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || i < 0 || j < 0 || i >= t.width || j >= t.height) continue;
      if (passable(t, j * t.width + i, maxSlope)) return j * t.width + i;
    }
  return c;
}

// ---------- terrain loading ----------
function useTerrain(t) {
  state.terrain = t; state.layerCache = null;
  const s = settings(), d = t.meta.defaultRoute;
  state.start = nearestPassable(t, d ? d.start.x : t.widthM * .15, d ? d.start.y : t.heightM * .3, s.maxSlope);
  state.goal = nearestPassable(t, d ? d.goal.x : t.widthM * .85, d ? d.goal.y : t.heightM * .3, s.maxSlope);
  if (state.goal === state.start) state.goal = nearestPassable(t, t.widthM * .8, t.heightM * .7, s.maxSlope);
  state.cursor = state.start; state.selected = "fastest";
  renderTerrainInfo(); renderSources(); renderTargets(); renderParams(); recompute(); sizeCanvases();
}
function showError(msg) { $("dem-error").textContent = msg || ""; }
async function runImport(fn, label) {
  const root = document.body; root.setAttribute("aria-busy", "true"); showError(""); $("map-message").textContent = label;
  try { const t = await fn(); useTerrain(t); $("map-message").textContent = ""; return true; }
  catch (err) {
    const msg = err instanceof TerrainError ? err.message : `Could not load the terrain: ${err.message || err}`;
    showError(`${msg} The previous terrain is still loaded.`); $("map-message").textContent = ""; return false;
  } finally { root.removeAttribute("aria-busy"); }
}
async function fetchTile(url, notFoundHelp) {
  let r;
  try { r = await fetch(url); } catch { throw new TerrainError("The download failed (network error or blocked request).", "network"); }
  if (!r.ok) throw new TerrainError(r.status === 404 ? notFoundHelp : `The server answered ${r.status} for ${url}.`, "http");
  const len = +r.headers.get("content-length"); if (len > LIMITS.maxTileBytes) throw new TerrainError(`File is ${(len / 1048576).toFixed(0)} MB; the limit is ${LIMITS.maxTileBytes / 1048576} MB.`, "too-large");
  const text = await r.text(); return parseTile(text, { sizeBytes: text.length });
}

// ---------- routes ----------
function recompute() {
  const t = state.terrain, s = settings();
  if (!t) return;
  if (!passable(t, state.start, s.maxSlope) || !passable(t, state.goal, s.maxSlope)) { /* planRoute reports which end is blocked */ }
  state.routes = {};
  for (const o of Object.keys(OBJECTIVES))
    state.routes[o] = planRoute(t, state.start, state.goal, { objective: o, maxSlopeDeg: s.maxSlope, targets: t.meta.targets || [], params: params(s), doseMultiplier: multiplier(s) });
  renderPoints(); renderAll();
}
function renderAll() { renderRouteList(); drawMap(); drawProfile(); renderWarnings(); renderSurvival(); renderConditions(); renderLegend(); }

function renderPoints() {
  const t = state.terrain, a = cellCentre(t, state.start), b = cellCentre(t, state.goal);
  $("start-x").value = a.x.toFixed(1); $("start-y").value = a.y.toFixed(1); $("goal-x").value = b.x.toFixed(1); $("goal-y").value = b.y.toFixed(1);
}

function renderRouteList() {
  const R = state.routes, ok = Object.entries(R).filter(([, r]) => r.ok);
  const best = (f, cmp) => { if (ok.length < 2) return null; const v = ok.map(([, r]) => f(r.metrics)); const m = cmp(...v); return v.filter(x => Math.abs(x - m) < 1e-9).length === v.length ? null : m; };
  const minL = best(m => m.lengthM, Math.min), minT = best(m => m.timeS, Math.min), minD = best(m => m.doseOneWayMSv, Math.min), maxS = best(m => m.scienceStops.length, Math.max);
  $("route-list").innerHTML = Object.entries(OBJECTIVES).map(([o, def]) => {
    const r = R[o], tags = [];
    if (r.ok) {
      const m = r.metrics;
      if (minL !== null && Math.abs(m.lengthM - minL) < 1e-9) tags.push("shortest here");
      if (minT !== null && Math.abs(m.timeS - minT) < 1e-9) tags.push("fastest here");
      if (minD !== null && Math.abs(m.doseOneWayMSv - minD) < 1e-9) tags.push("lowest modeled dose");
      if (maxS !== null && maxS > 0 && m.scienceStops.length === maxS) tags.push("most science stops");
    }
    const body = r.ok ? `<dl><dt>Distance</dt><dd>${fmtLen(r.metrics.lengthM)} along the ground</dd><dt>Est. walking time</dt><dd>${fmtTime(r.metrics.timeS)} (assumed speed)</dd><dt>Elevation</dt><dd>+${r.metrics.ascentM.toFixed(0)} m / −${r.metrics.descentM.toFixed(0)} m, net ${r.metrics.netElevationM >= 0 ? "+" : "−"}${Math.abs(r.metrics.netElevationM).toFixed(0)} m</dd><dt>Steepest step</dt><dd>${r.metrics.maxEdgeSlopeDeg.toFixed(1)}°</dd><dt>Modeled dose, one way</dt><dd>${(r.metrics.doseOneWayMSv * 1000).toFixed(1)} µSv</dd>${(state.terrain.meta.targets || []).length ? `<dt>Science stops</dt><dd>${r.metrics.scienceStops.length}</dd>` : ""}</dl>` : `<p class="fail">${esc(r.message)}</p>`;
    return `<label class="route"><span class="head"><span><input type="radio" name="route" value="${o}" ${o === state.selected ? "checked" : ""}> ${esc(def.label)}</span><span class="tag">${tags.join(", ")}</span></span><p class="help">${esc(def.help)}</p>${body}</label>`;
  }).join("");
  document.querySelectorAll('input[name="route"]').forEach(el => el.addEventListener("change", () => { state.selected = el.value; drawMap(); drawProfile(); renderWarnings(); renderSurvival(); renderConditions(); }));
}

function renderWarnings() {
  const t = state.terrain, s = settings(), r = state.routes[state.selected], out = [];
  const add = (level, text, why) => out.push(`<li class="${level}">${esc(text)}${why ? `<span class="why">${esc(why)}</span>` : ""}</li>`);
  if (t.meta.kind === "synthetic-test") add("warn", "These routes cross synthetic terrain, not Martian ground.", "The loaded model is a test fixture generated by tools/make_test_dem.py.");
  if (!r.ok) add("danger", r.message, r.code === "unreachable" ? "Every step must lie on valid cells with slope at or below the limit, and the limit is currently " + s.maxSlope + "°." : "");
  else {
    const m = r.metrics, slow = walkSpeedMS(m.maxEdgeSlopeDeg, params(s)) / walkSpeedMS(0, params(s));
    if (m.maxEdgeSlopeDeg > 10) add(m.maxEdgeSlopeDeg > 18 ? "danger" : "warn", `Steepest step is ${m.maxEdgeSlopeDeg.toFixed(1)}° (limit ${s.maxSlope}°).`, `On this step the assumed walking speed falls to ${(slow * 100).toFixed(0)} % of the flat-ground speed. Warning levels (above 10° and above 18°) are display thresholds, not safety limits.`);
    else add("ok", `All steps are at or below 10° (steepest ${m.maxEdgeSlopeDeg.toFixed(1)}°).`, "");
    add("warn", `Round trip ≈ ${fmtTime(2 * m.timeS)} if you return the same way.`, "Time is length divided by an assumed slope-dependent speed. It is not a measured walking rate.");
    add("warn", `Modeled round-trip dose ≈ ${(2 * m.doseOneWayMSv * 1000).toFixed(1)} µSv.`, "Illustrative: a Gale Crater reference rate scaled by terrain sky view and the radiation scenario. It is not a Jezero measurement.");
  }
  if (s.dust !== "nominal") add("warn", `${DUST[s.dust].label} is selected.`, "Dust scenarios change the temperature model and the survival check. They are not forecasts.");
  if (t.invalidCount) add("warn", `${t.invalidCount} cells (${(100 * t.invalidCount / (t.width * t.height)).toFixed(1)} %) have no elevation data.`, "Routes treat these cells as impassable.");
  $("warnings").innerHTML = out.join("");
}

function renderSurvival() {
  const s = settings(), r = state.routes[state.selected];
  for (const k of ["power", "o2", "water"]) $(`res-${k}-out`).textContent = s.reserves[k];
  const a = assessSurvival({ route: r, reserves: s.reserves, enduranceH: s.endurance, requiredEndReservePct: s.requiredReserve, dust: s.dust, maxSlopeDeg: s.maxSlope });
  $("survival").innerHTML = `<p class="verdict ${a.verdict === "GO" ? "go" : "nogo"}">Planning-logic result for the ${esc(OBJECTIVES[state.selected].label.toLowerCase())} route: ${a.verdict}</p><ul class="checks">${a.checks.map(c => `<li class="${c.ok ? "" : "bad"}">${c.ok ? "Pass" : "Fail"}: ${esc(c.text)}</li>`).join("")}</ul><p class="fine">Assumptions: the return follows the same path; consumables are used in proportion to time; endurance figures are placeholders you can edit above. Nothing here accounts for suit failure, injury, communications, or real-world safety margins.</p>`;
}

function renderConditions() {
  const s = settings(), t = state.terrain, e = environment({ localHour: s.hour, dust: s.dust }), r = state.routes[state.selected];
  const sv = getSkyView(t)[state.start], rows = [
    ["Local solar time", `${s.hour.toFixed(2)} h`, "Scenario", "Chosen with the slider; 24.66 h per sol."],
    ["Air temperature", `${e.tempC.toFixed(0)} °C`, "Scenario", "−55 °C + A·cos(2π(h − 14)/24.66), A shrinks with dust. Illustrative, not fitted to MEDA."],
    ["Dust opacity τ", `${e.tau.toFixed(1)} (dimensionless)`, "Scenario", "Set by the dust selector."],
    ["Surface pressure", `${e.pressurePa} Pa`, "Assumed constant", "Order of magnitude only."],
    ["Modeled dose rate at start", `${doseRate(sv, multiplier(s)).toFixed(2)} mSv/day`, "Modeled", `0.64 mSv/day reference × sky view ${sv.toFixed(2)} × ${multiplier(s)}.`],
    ["Modeled round-trip dose", r.ok ? `${(2 * r.metrics.doseOneWayMSv * 1000).toFixed(1)} µSv` : "n/a", "Modeled", "Integrated along the selected route, doubled."]
  ];
  $("conditions").innerHTML = "<tr><th>Quantity</th><th>Value</th><th>Status</th><th>Basis</th></tr>" + rows.map(x => `<tr><td>${x[0]}</td><td>${x[1]}</td><td><span class="chip">${x[2]}</span></td><td>${x[3]}</td></tr>`).join("");
}

function renderParams() {
  const s = settings();
  $("params").innerHTML = "<tr><th>Parameter</th><th>Default</th><th>Type</th><th>Basis</th></tr>" + Object.entries(PARAMS).map(([k, p]) =>
    `<tr><td>${PARAM_LABELS[k] || k}</td><td>${typeof p.value === "object" ? Object.entries(p.value).map(([a, b]) => `${a} ${b}`).join(", ") : p.value} ${p.unit}</td><td><span class="chip">${p.kind}</span></td><td>${esc(p.note)}</td></tr>`).join("");
  void s;
}
function renderSources() {
  $("sources").innerHTML = "<tr><th>Dataset</th><th>Status here</th><th>How it is used</th><th>Limitations</th></tr>" + DATASETS.map(d =>
    `<tr><td>${d.href ? `<a href="${d.href}" rel="noopener noreferrer">${esc(d.name)}</a>` : esc(d.name)}<br><span class="fine">${esc(d.mission)}</span></td><td><span class="chip">${d.status}</span></td><td>${esc(d.use)}</td><td>${esc(d.limits)}</td></tr>`).join("");
}
function renderTargets() {
  const t = state.terrain, list = t.meta.targets || [];
  $("targets").innerHTML = list.length
    ? `<p class="fine">Targets are supplied by the loaded tile${t.meta.kind === "synthetic-test" ? " and are fictional here" : ""}. The science route reduces its cost near them; it does not judge scientific value.</p><table><tr><th>Name</th><th>Position (m east, m south)</th><th>Radius</th><th>Note / source</th></tr>${list.map(x => `<tr><td>${esc(x.name)}</td><td>${x.x.toFixed(0)}, ${x.y.toFixed(0)}</td><td>${(x.radiusM || PARAMS.scienceRadiusM.value)} m</td><td>${esc(x.note || x.source || "")}</td></tr>`).join("")}</table>`
    : "<p>This terrain tile contains no science targets, so the science route is unavailable. No mineralogy layer (for example CRISM) is integrated in this version. Targets can be added to a tile with a source for each.</p>";
}
function renderTerrainInfo() {
  const t = state.terrain, m = t.meta, src = m.source || {}, ll = t.geo ? localToLatLon(t, t.widthM / 2, t.heightM / 2) : null;
  const rows = [
    ["Name", m.name], ["Provenance", m.kind === "synthetic-test" ? "Synthetic test terrain (not Mars)" : m.kind === "derived-from-nasa" ? "Derived from NASA data" : "User-supplied; as declared in the file"],
    ["Source product", src.product_id || "none declared"], ["Mission / instrument", [src.mission, src.instrument].filter(Boolean).join(" / ") || "none declared"],
    ["Footprint", `${(t.widthM / 1000).toFixed(2)} km east–west × ${(t.heightM / 1000).toFixed(2)} km north–south`],
    ["Grid", `${t.width} × ${t.height} cells at ${t.cellX} × ${t.cellY} m`],
    ["Elevation (valid cells)", `${t.min.toFixed(1)} to ${t.max.toFixed(1)} m`], ["No-data cells", `${t.invalidCount}`],
    ["Georeference", ll ? `Equirectangular; centre ≈ ${ll.lat.toFixed(4)}° N, ${ll.lon.toFixed(4)}° E` : "None: local metres only; latitude and longitude are not shown"],
    ["Processing", (src.processing || m.notes || []).join(" ") || "none declared"], ["Credit", src.credit || "none declared"]
  ];
  if (m.downsampleFactor) rows.splice(5, 0, ["Resampling", `Block average ${m.downsampleFactor} × ${m.downsampleFactor} from ${m.nativeWidth} × ${m.nativeHeight} cells at ${m.nativeCellM} m`]);
  $("terrain-info").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  const b = $("terrain-banner");
  b.className = "banner " + (m.kind === "synthetic-test" ? "synthetic" : m.kind === "derived-from-nasa" ? "nasa" : "");
  b.textContent = m.kind === "synthetic-test" ? "Showing synthetic test terrain, not Mars. Distances are real metres on this artificial surface. Open “Terrain model and data sources” to load NASA-derived terrain."
    : m.kind === "derived-from-nasa" ? `Terrain derived from NASA data${src.product_id ? ` (${src.product_id})` : ""}. Elevation and slope come from that product; radiation, temperature and dust remain modeled scenarios.`
      : "User-supplied terrain. Its provenance is whatever the file declares.";
}

// ---------- map drawing ----------
const RAMPS = {
  elevation: [[58, 56, 52], [128, 122, 112], [226, 219, 204]],
  slope: [[240, 234, 224], [214, 150, 112], [160, 72, 42]],
  dose: [[236, 240, 244], [150, 170, 196], [44, 70, 120]]
};
const ramp = (stops, t) => { t = clamp(t, 0, 1) * (stops.length - 1); const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i; return stops[i].map((v, k) => v + (stops[i + 1][k] - v) * f); };
const css = c => `rgb(${c.map(Math.round).join(",")})`;

function layerImage() {
  const t = state.terrain, s = settings(), key = `${state.layer}|${s.maxSlope}|${s.radiation}`;
  if (state.layerCache?.key === key) return state.layerCache;
  const N = t.width * t.height, img = new ImageData(t.width, t.height);
  let lo = 0, hi = 1, values = null;
  if (state.layer === "elevation") { lo = t.min; hi = t.max; values = t.z; }
  else if (state.layer === "slope") { lo = 0; hi = s.maxSlope; values = t.slope; }
  else { const sv = getSkyView(t); values = Float32Array.from(sv, v => doseRate(v, multiplier(s))); lo = Infinity; hi = -Infinity; for (const v of values) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  const span = hi - lo || 1, w = t.width, h = t.height, L = Math.PI / 4, az = 315 * Math.PI / 180, zen = Math.PI / 4;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, o = k * 4, v = values[k];
    let c;
    if (!Number.isFinite(t.z[k])) c = [150, 150, 150];
    else if (state.layer === "slope" && t.slope[k] > s.maxSlope) c = [38, 38, 38];
    else {
      c = ramp(RAMPS[state.layer], (v - lo) / span);
      if (state.layer === "elevation") { // hillshade from physical gradients
        const zz = (a, b) => { const q = t.z[clamp(b, 0, h - 1) * w + clamp(a, 0, w - 1)]; return Number.isFinite(q) ? q : t.z[k]; };
        const dx = (zz(i + 1, j) - zz(i - 1, j)) / (2 * t.cellX), dy = (zz(i, j + 1) - zz(i, j - 1)) / (2 * t.cellY);
        const sl = Math.atan(Math.hypot(dx, dy)), asp = Math.atan2(dy, -dx);
        const shade = clamp(Math.cos(zen) * Math.cos(sl) + Math.sin(zen) * Math.sin(sl) * Math.cos(az - asp), 0, 1);
        const f = .55 + .6 * shade; c = c.map(q => clamp(q * f, 0, 255));
      }
    }
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  const off = document.createElement("canvas"); off.width = w; off.height = h; off.getContext("2d").putImageData(img, 0, 0);
  void N; void L;
  return (state.layerCache = { key, canvas: off, lo, hi });
}

const map = $("map"), mctx = map.getContext("2d"), prof = $("profile"), pctx = prof.getContext("2d");
function sizeCanvases() {
  const t = state.terrain; if (!t) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), wCss = Math.max(280, $("map").parentElement.clientWidth);
  map.width = Math.round(wCss * dpr); map.height = Math.round(wCss * (t.heightM / t.widthM) * dpr);
  prof.width = Math.round(Math.max(280, prof.parentElement.clientWidth - 32) * dpr); prof.height = Math.round(prof.width * (window.innerWidth < 600 ? .6 : .3));
  drawMap(); drawProfile();
}
const pxPerM = () => map.width / state.terrain.widthM;
const toPx = (x, y) => [x * pxPerM(), y * pxPerM()];

function niceLength(m) { const p = 10 ** Math.floor(Math.log10(m)), f = m / p; return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p; }
function drawMap() {
  const t = state.terrain; if (!t || !map.width) return;
  const L = layerImage(), u = map.width / 900, ctx = mctx;
  ctx.imageSmoothingEnabled = true; ctx.drawImage(L.canvas, 0, 0, map.width, map.height);
  // routes
  const order = Object.keys(OBJECTIVES).filter(o => o !== state.selected).concat(state.selected);
  for (const o of order) {
    const r = state.routes[o]; if (!r?.ok) continue;
    const sel = o === state.selected; ctx.beginPath();
    r.path.forEach((c, k) => { const q = cellCentre(t, c), [x, y] = toPx(q.x, q.y); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.lineJoin = "round";
    if (sel) { ctx.setLineDash([]); ctx.strokeStyle = "#fff"; ctx.lineWidth = 7 * u; ctx.stroke(); }
    ctx.setLineDash(ROUTE_DASH[o].map(d => d * u)); ctx.strokeStyle = sel ? "#a0482a" : "#111"; ctx.lineWidth = (sel ? 3.5 : 2) * u; ctx.stroke();
  }
  ctx.setLineDash([]);
  // science targets
  for (const g of t.meta.targets || []) {
    const [x, y] = toPx(g.x, g.y), r = 6 * u; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
    ctx.fillStyle = "#fff"; ctx.fill(); ctx.lineWidth = 2 * u; ctx.strokeStyle = "#111"; ctx.stroke();
  }
  // markers
  const mark = (idx, letter, square) => {
    const q = cellCentre(t, idx), [x, y] = toPx(q.x, q.y), r = 11 * u; ctx.beginPath();
    square ? ctx.rect(x - r, y - r, 2 * r, 2 * r) : ctx.arc(x, y, r, 0, 7);
    ctx.fillStyle = "#111"; ctx.fill(); ctx.lineWidth = 2.5 * u; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = `bold ${13 * u}px system-ui,sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(letter, x, y + .5 * u);
  };
  mark(state.start, "S", false); mark(state.goal, "D", true);
  if (state.cursor >= 0 && document.activeElement === map) { const q = cellCentre(t, state.cursor), [x, y] = toPx(q.x, q.y); ctx.strokeStyle = "#1b5fb4"; ctx.lineWidth = 2 * u; ctx.strokeRect(x - 9 * u, y - 9 * u, 18 * u, 18 * u); }
  // scale bar
  const barM = niceLength(t.widthM * .2), barPx = barM * pxPerM(), bx = 14 * u, by = map.height - 18 * u;
  ctx.fillStyle = "rgba(255,255,255,.88)"; ctx.fillRect(bx - 6 * u, by - 24 * u, barPx + 12 * u, 36 * u);
  ctx.fillStyle = "#111"; ctx.fillRect(bx, by, barPx, 4 * u); ctx.fillRect(bx, by - 5 * u, 2 * u, 9 * u); ctx.fillRect(bx + barPx - 2 * u, by - 5 * u, 2 * u, 9 * u);
  ctx.font = `${12 * u}px system-ui,sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText(fmtLen(barM), bx, by - 7 * u);
  // north arrow (raster is north-up)
  const nx = map.width - 26 * u, ny = 22 * u;
  ctx.fillStyle = "rgba(255,255,255,.88)"; ctx.fillRect(nx - 18 * u, ny - 16 * u, 36 * u, 56 * u);
  ctx.fillStyle = "#111"; ctx.beginPath(); ctx.moveTo(nx, ny - 8 * u); ctx.lineTo(nx + 7 * u, ny + 14 * u); ctx.lineTo(nx, ny + 9 * u); ctx.lineTo(nx - 7 * u, ny + 14 * u); ctx.closePath(); ctx.fill();
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.font = `bold ${13 * u}px system-ui,sans-serif`; ctx.fillText("N", nx, ny + 18 * u);
  map.setAttribute("aria-label", `Terrain map, ${state.layer} layer, ${fmtLen(t.widthM)} wide. Start at ${fmtXY(state.start)}, destination at ${fmtXY(state.goal)}. Arrow keys move the cursor, S sets the start, D sets the destination.`);
}
const fmtXY = i => { const c = cellCentre(state.terrain, i); return `${c.x.toFixed(0)} m east, ${c.y.toFixed(0)} m south`; };

function renderLegend() {
  const t = state.terrain, L = layerImage(), s = settings();
  const grad = stops => `linear-gradient(90deg,${[0, .5, 1].map((p, i) => css(stops[i]) + " " + p * 100 + "%").join(",")})`;
  const title = { elevation: `Elevation (m), ${t.meta.kind === "synthetic-test" ? "synthetic" : "from the loaded model"}, shaded from the north-west`, slope: "Slope (°) from elevation and real cell spacing", dose: "Modeled dose rate (mSv/day), illustrative, not measured at this site" }[state.layer];
  let h = `<span>${title}: ${L.lo.toFixed(state.layer === "dose" ? 2 : 0)} <span class="ramp" style="background:${grad(RAMPS[state.layer])}"></span> ${L.hi.toFixed(state.layer === "dose" ? 2 : 0)}</span>`;
  if (state.layer === "slope") h += `<span><span class="ramp" style="width:14px;background:#262626"></span> above ${s.maxSlope}° (prohibited)</span>`;
  if (t.invalidCount) h += `<span><span class="ramp" style="width:14px;background:#969696"></span> no data</span>`;
  const sw = (o, label) => `<span><svg width="40" height="8" aria-hidden="true"><line x1="0" y1="4" x2="40" y2="4" stroke="${o === state.selected ? "#a0482a" : "#111"}" stroke-width="3" stroke-dasharray="${ROUTE_DASH[o].join(" ")}"/></svg> ${label}</span>`;
  h += Object.entries(OBJECTIVES).map(([o, d]) => sw(o, d.label)).join("");
  h += `<span>● S start &nbsp; ■ D destination${(t.meta.targets || []).length ? " &nbsp; ◇ science target" : ""}</span>`;
  $("legend").innerHTML = h;
}

function drawProfile() {
  const r = state.routes[state.selected], ctx = pctx, W = prof.width, H = prof.height, u = W / 900;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  if (!r?.ok) { ctx.fillStyle = "#55524d"; ctx.font = `${14 * u}px system-ui`; ctx.fillText("No route to show.", 16 * u, 30 * u); $("profile-summary").textContent = r?.message || ""; prof.setAttribute("aria-label", "No elevation profile: no valid route."); return; }
  const p = r.metrics.profile, zs = p.map(q => q.z), lo = Math.min(...zs), hi = Math.max(...zs), pad = Math.max(2, (hi - lo) * .1);
  const x0 = 64 * u, x1 = W - 14 * u, y0 = 14 * u, y1 = H - 40 * u, S = r.metrics.lengthM || 1;
  const X = s => x0 + s / S * (x1 - x0), Y = z => y1 - (z - (lo - pad)) / ((hi + pad) - (lo - pad)) * (y1 - y0);
  ctx.strokeStyle = "#d4d0c8"; ctx.fillStyle = "#55524d"; ctx.font = `${12 * u}px system-ui`; ctx.lineWidth = 1 * u; ctx.textBaseline = "middle"; ctx.textAlign = "right";
  for (let k = 0; k <= 4; k++) { const z = lo - pad + k / 4 * (hi - lo + 2 * pad), y = Y(z); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.fillText(`${z.toFixed(0)} m`, x0 - 6 * u, y); }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let k = 0; k <= 4; k++) { ctx.textAlign = k === 0 ? "left" : k === 4 ? "right" : "center"; ctx.fillText(fmtLen(S * k / 4), X(S * k / 4), y1 + 6 * u); }
  ctx.textAlign = "center";
  ctx.fillText("Distance along the route", (x0 + x1) / 2, y1 + 22 * u);
  ctx.beginPath(); p.forEach((q, k) => k ? ctx.lineTo(X(q.s), Y(q.z)) : ctx.moveTo(X(q.s), Y(q.z)));
  ctx.lineTo(X(S), y1); ctx.lineTo(X(0), y1); ctx.closePath(); ctx.fillStyle = "rgba(160,72,42,.12)"; ctx.fill();
  ctx.beginPath(); p.forEach((q, k) => k ? ctx.lineTo(X(q.s), Y(q.z)) : ctx.moveTo(X(q.s), Y(q.z))); ctx.strokeStyle = "#a0482a"; ctx.lineWidth = 2.5 * u; ctx.stroke();
  for (const sct of r.metrics.scienceStops) { const q = p.reduce((a, b) => Math.abs(b.s - sct.alongM) < Math.abs(a.s - sct.alongM) ? b : a); ctx.beginPath(); const x = X(q.s), y = Y(q.z); ctx.moveTo(x, y - 7 * u); ctx.lineTo(x + 6 * u, y); ctx.lineTo(x, y + 7 * u); ctx.lineTo(x - 6 * u, y); ctx.closePath(); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#111"; ctx.lineWidth = 2 * u; ctx.stroke(); }
  const m = r.metrics, txt = `${OBJECTIVES[state.selected].label}: ${fmtLen(m.lengthM)}, elevation from ${zs[0].toFixed(0)} m to ${zs[zs.length - 1].toFixed(0)} m (range ${lo.toFixed(0)} to ${hi.toFixed(0)} m), steepest step ${m.maxEdgeSlopeDeg.toFixed(1)}°.${m.scienceStops.length ? " Passes " + m.scienceStops.map(q => q.name).join(", ") + "." : ""}`;
  $("profile-summary").textContent = txt; prof.setAttribute("aria-label", "Elevation profile. " + txt);
}

// ---------- map interaction ----------
function cellFromEvent(e) {
  const t = state.terrain, b = map.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * t.widthM, y = (e.clientY - b.top) / b.height * t.heightM;
  return cellAt(t, x, y);
}
function describeCell(i) {
  const t = state.terrain, s = settings(), c = cellCentre(t, i), ll = localToLatLon(t, c.x, c.y);
  const z = t.z[i], sl = t.slope[i], dose = doseRate(getSkyView(t)[i], multiplier(s));
  return `x ${c.x.toFixed(0)} m, y ${c.y.toFixed(0)} m` + (ll ? ` · ${ll.lat.toFixed(4)}° N, ${ll.lon.toFixed(4)}° E` : " · no georeference") + (Number.isFinite(z) ? ` · elevation ${z.toFixed(1)} m · slope ${sl.toFixed(1)}°${sl > s.maxSlope ? " (above limit)" : ""} · modeled dose ${dose.toFixed(2)} mSv/day` : " · no data");
}
function setPoint(kind, i) {
  const s = settings(), t = state.terrain;
  if (i < 0) return;
  if (!passable(t, i, s.maxSlope)) { $("map-message").textContent = `That cell has no data or is steeper than ${s.maxSlope}°, so it cannot be a ${kind === "start" ? "start" : "destination"}. Choose another.`; return; }
  $("map-message").textContent = "";
  if (kind === "start") state.start = i; else state.goal = i;
  recompute();
}
map.addEventListener("pointermove", e => { const i = cellFromEvent(e); if (i >= 0) $("coord-readout").textContent = describeCell(i); });
map.addEventListener("pointerleave", () => { if (state.cursor >= 0) $("coord-readout").textContent = describeCell(state.cursor); });
map.addEventListener("click", e => { const i = cellFromEvent(e); state.cursor = i; setPoint(state.pointMode, i); });
map.addEventListener("focus", () => { drawMap(); $("coord-readout").textContent = describeCell(state.cursor); });
map.addEventListener("blur", drawMap);
map.addEventListener("keydown", e => {
  const t = state.terrain, [ci, cj] = cellOf(t, state.cursor), k = e.shiftKey ? 10 : 1;
  const mv = { ArrowLeft: [-k, 0], ArrowRight: [k, 0], ArrowUp: [0, -k], ArrowDown: [0, k] }[e.key];
  if (mv) { e.preventDefault(); state.cursor = clamp(cj + mv[1], 0, t.height - 1) * t.width + clamp(ci + mv[0], 0, t.width - 1); drawMap(); $("coord-readout").textContent = describeCell(state.cursor); }
  else if (e.key === "s" || e.key === "S") setPoint("start", state.cursor);
  else if (e.key === "d" || e.key === "D") setPoint("goal", state.cursor);
});

// ---------- wiring ----------
document.querySelectorAll('input[name="layer"]').forEach(el => el.addEventListener("change", () => { state.layer = el.value; drawMap(); renderLegend(); }));
document.querySelectorAll('input[name="pointmode"]').forEach(el => el.addEventListener("change", () => { state.pointMode = el.value; }));
$("apply-points").addEventListener("click", () => {
  const t = state.terrain, s = settings(), v = id => parseFloat($(id).value);
  const a = cellAt(t, v("start-x"), v("start-y")), b = cellAt(t, v("goal-x"), v("goal-y"));
  if (a < 0 || b < 0) { $("map-message").textContent = `Coordinates must lie inside the terrain: x 0 to ${t.widthM.toFixed(0)} m, y 0 to ${t.heightM.toFixed(0)} m.`; return; }
  if (!passable(t, a, s.maxSlope) || !passable(t, b, s.maxSlope)) { $("map-message").textContent = `A point has no data or is steeper than ${s.maxSlope}°. Choose other coordinates.`; return; }
  $("map-message").textContent = ""; state.start = a; state.goal = b; recompute();
});
["max-slope", "walk-speed"].forEach(id => $(id).addEventListener("change", () => { state.layerCache = null; recompute(); }));
$("radiation").addEventListener("change", () => { state.layerCache = null; recompute(); });
$("dust").addEventListener("change", () => { renderWarnings(); renderSurvival(); renderConditions(); });
$("local-hour").addEventListener("input", () => { $("local-hour-out").textContent = (+$("local-hour").value).toFixed(2); renderConditions(); });
$("use-now").addEventListener("click", () => { const c = marsClock(new Date(), JEZERO_LON_E); $("local-hour").value = (Math.round(c.localHour * 4) / 4).toString(); $("local-hour-out").textContent = (+$("local-hour").value).toFixed(2); renderConditions(); });
["res-power", "res-o2", "res-water"].forEach(id => $(id).addEventListener("input", renderSurvival));
["req-reserve", "end-power", "end-o2", "end-water"].forEach(id => $(id).addEventListener("change", renderSurvival));
$("load-test").addEventListener("click", () => runImport(() => fetchTile("data/test-terrain.json", "The bundled test tile data/test-terrain.json was not found."), "Loading test terrain…"));
$("load-jezero").addEventListener("click", () => runImport(() => fetchTile("data/jezero-hirise-tile.json", "No Jezero tile is included in this repository. Create one from the NASA HiRISE DTM with tools/pds_to_tile.py (see README), place it at public/data/jezero-hirise-tile.json, or open a .IMG + .LBL pair directly."), "Loading Jezero tile…"));
$("dem-file").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = "";
  await runImport(() => loadDemFiles(files, { onProgress: p => { $("map-message").textContent = `Reading terrain… ${(p * 100).toFixed(0)} %`; } }).then(r => r.terrain), "Reading terrain…");
});
for (const [k, v] of Object.entries(DUST)) $("dust").insertAdjacentHTML("beforeend", `<option value="${k}">${v.label}</option>`);
for (const [k, v] of Object.entries(RADIATION_SCENARIOS)) $("radiation").insertAdjacentHTML("beforeend", `<option value="${k}">${v.label}</option>`);
new ResizeObserver(() => { if (state.terrain) sizeCanvases(); }).observe($("map").parentElement);

renderSources(); renderParams();
runImport(() => fetchTile("data/test-terrain.json", "The bundled test tile was not found."), "Loading test terrain…");
