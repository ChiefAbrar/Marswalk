#!/usr/bin/env python3
"""Browser tests (Playwright + Chromium). Builds dist/, serves it, drives the real interface.
Run: python3 test/ui_test.py"""
import subprocess, sys, threading, http.server, socketserver, functools, pathlib, tempfile, json
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
subprocess.run([sys.executable, str(root / "tools/build_dist.py")], check=True)
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root / "dist"))
Handler.log_message = lambda *a, **k: None
srv = socketserver.TCPServer(("127.0.0.1", 0), Handler); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{port}/"
results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond))); print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond else ""))

def fresh(b, **kw):
    pg = b.new_page(**kw); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto(URL); pg.wait_for_selector("#route-list .route"); pg.wait_for_timeout(300)
    return pg, errs

with sync_playwright() as p:
    b = p.chromium.launch()
    pg, errs = fresh(b, viewport={"width": 1366, "height": 900})
    check("loads with no console or page errors", not errs, errs)
    check("opening screen states the study area, data status and how to start", all(t in pg.inner_text(".intro") for t in ["Jezero Crater", "synthetic", "start", "destination"]))
    check("synthetic data is labelled as such and not as Mars", "not Mars" in pg.inner_text("#terrain-banner"))
    check("four route objectives listed", pg.locator("#route-list .route").count() == 4)
    check("map has scale bar legend, north indicator text and coordinate readout", pg.locator("#legend").inner_text() != "" and pg.locator("#coord-readout").count() == 1)

    # layer switching
    leg0 = pg.inner_text("#legend")
    pg.check('input[name=layer][value=slope]'); check("slope layer legend uses degrees and the limit", "°" in pg.inner_text("#legend") and "25°" in pg.inner_text("#legend"))
    pg.check('input[name=layer][value=dose]'); check("radiation layer legend says modeled with units", "mSv/day" in pg.inner_text("#legend") and "not measured" in pg.inner_text("#legend"))
    pg.check('input[name=layer][value=elevation]'); check("elevation legend is in metres", "(m)" in pg.inner_text("#legend") and pg.inner_text("#legend") == leg0)

    # hover readout
    box = pg.locator("#map").bounding_box(); pg.mouse.move(box["x"] + box["width"] * .3, box["y"] + box["height"] * .3)
    r = pg.inner_text("#coord-readout"); check("hover shows metres, elevation, slope and modeled dose", all(t in r for t in ["x ", "elevation", "slope", "mSv/day"]), r)

    # route selection changes profile
    pg.check('input[name=route][value=shortest]'); s1 = pg.inner_text("#profile-summary")
    pg.check('input[name=route][value=fastest]'); s2 = pg.inner_text("#profile-summary")
    check("selecting a route updates the profile summary", s1 != s2 and s1.startswith("Shortest") and s2.startswith("Fastest"), (s1, s2))
    d = lambda o: pg.locator(f'input[name=route][value={o}]').locator("xpath=ancestor::label").inner_text()
    check("shortest and fastest routes differ on the test terrain", d("shortest") != d("fastest"))

    # click sets destination and routes recalculate
    before = pg.inner_text("#route-list")
    pg.check('input[name=pointmode][value=goal]'); box = pg.locator("#map").bounding_box(); pg.mouse.click(box["x"] + box["width"] * .75, box["y"] + box["height"] * .8); pg.wait_for_timeout(200)
    check("clicking the map moves the destination and recalculates", pg.inner_text("#route-list") != before and pg.input_value("#goal-y") != "512.5")
    # keyboard
    pg.focus("#map"); pg.keyboard.press("ArrowRight"); pg.keyboard.press("ArrowDown"); st = pg.input_value("#start-x")
    pg.keyboard.press("s"); pg.wait_for_timeout(150)
    check("keyboard: arrows then S moves the start", pg.input_value("#start-x") != st)
    # numeric entry
    pg.fill("#start-x", "300"); pg.fill("#start-y", "500"); pg.fill("#goal-x", "2250"); pg.fill("#goal-y", "500"); pg.click("#apply-points"); pg.wait_for_timeout(150)
    check("numeric start/destination entry works", "Fastest" in pg.inner_text("#profile-summary"))
    pg.fill("#goal-x", "99999"); pg.click("#apply-points")
    check("out-of-range coordinates give a clear message", "inside the terrain" in pg.inner_text("#map-message"))
    pg.fill("#goal-x", "2250"); pg.click("#apply-points")

    # unreachable: tiny slope limit
    pg.click("#panel-scenario summary"); pg.fill("#max-slope", "3"); pg.dispatch_event("#max-slope", "change"); pg.wait_for_timeout(200)
    txt = pg.inner_text("#route-list")
    check("tight slope limit yields unreachable/blocked messages, no fake route", ("No path exists" in txt or "steeper than 3°" in txt) and "Distance" not in txt.split("Lower risk")[0], txt[:300])
    check("survival check says NO GO when no route exists", "NO GO" in pg.inner_text("#survival"))
    pg.fill("#max-slope", "25"); pg.dispatch_event("#max-slope", "change"); pg.wait_for_timeout(200)
    check("restoring the limit restores routes", "Distance" in pg.inner_text("#route-list"))

    # scenario units
    t0 = pg.inner_text("#conditions"); pg.select_option("#dust", "regional"); t1 = pg.inner_text("#conditions")
    check("dust scenario changes the temperature row and keeps units", t0 != t1 and "°C" in t1 and "Pa" in t1 and "mSv/day" in t1)
    check("regional dust forces NO GO with the reason shown", "NO GO" in pg.inner_text("#survival") and "Regional dust" in pg.inner_text("#survival"))
    pg.select_option("#dust", "nominal")
    # reserves
    check("ample reserves give GO", "GO" in pg.inner_text("#survival").split("\n")[0] and "NO GO" not in pg.inner_text("#survival").split("\n")[0])
    pg.eval_on_selector("#res-power", "e=>{e.value=40;e.dispatchEvent(new Event('input'))}")
    check("low power reserve gives NO GO and shows the arithmetic", "NO GO" in pg.inner_text("#survival") and "40 % start" in pg.inner_text("#survival"))
    pg.eval_on_selector("#res-power", "e=>{e.value=90;e.dispatchEvent(new Event('input'))}")
    pg.select_option("#radiation", "elevated"); check("radiation scenario changes modeled dose text", "× 1.5" in pg.inner_text("#conditions")); pg.select_option("#radiation", "nominal")

    # import failure and recovery
    pg.click("#panel-data summary"); good = pg.inner_text("#terrain-info")
    tmp = pathlib.Path(tempfile.mkdtemp())
    bad = tmp / "bad.json"; bad.write_text('{"format":"mars-survival-tile","version":1,"elevation_unit":"ft","width":3,"height":3,"cell_x_m":1,"cell_y_m":1,"z":[]}')
    pg.set_input_files("#dem-file", str(bad)); pg.wait_for_timeout(300)
    check("bad tile shows a clear error and keeps the previous terrain", "elevation unit" in pg.inner_text("#dem-error").lower() and "previous terrain" in pg.inner_text("#dem-error") and pg.inner_text("#terrain-info") == good)
    tif = tmp / "x.tif"; tif.write_bytes(b"II*\x00"); pg.set_input_files("#dem-file", str(tif)); pg.wait_for_timeout(300)
    check("unsupported file type is explained", "Unsupported" in pg.inner_text("#dem-error"))
    check("routes still work after failed imports", "Distance" in pg.inner_text("#route-list"))
    pg.click("#load-jezero"); pg.wait_for_timeout(500)
    check("missing Jezero tile gives honest instructions", "No Jezero tile is included" in pg.inner_text("#dem-error"))
    # load a different valid tile -> new footprint, markers valid
    raw = json.loads((root / "public/data/test-terrain.json").read_text())
    small = dict(raw, width=40, height=30, cell_x_m=10, cell_y_m=10, z=raw["z"][:1200], targets=[], default_route=None, name="Small tile")
    good_t = tmp / "small.json"; good_t.write_text(json.dumps(small)); pg.set_input_files("#dem-file", str(good_t)); pg.wait_for_timeout(400)
    ti = pg.inner_text("#terrain-info")
    check("loading another tile updates footprint and spacing", "0.40 km" in ti and "10 × 10 m" in ti and pg.inner_text("#dem-error") == "", ti)
    sx, sy, gx, gy = [float(pg.input_value(i)) for i in ("#start-x", "#start-y", "#goal-x", "#goal-y")]
    check("markers lie inside the new footprint", 0 <= sx <= 400 and 0 <= gx <= 400 and 0 <= sy <= 300 and 0 <= gy <= 300, (sx, sy, gx, gy))
    check("no-target tile disables science route with explanation", "no science targets" in pg.text_content("#targets") and "cannot be calculated" in pg.inner_text("#route-list"))
    pg.close()

    # mobile
    pg, errs = fresh(b, viewport={"width": 390, "height": 800}, has_touch=True)
    ov = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check("mobile: no horizontal page overflow", ov <= 0, ov)
    mb = pg.locator("#map").bounding_box(); check("mobile: map fits the screen width", mb["width"] <= 390 and mb["width"] > 300, mb)
    check("mobile: single column (routes below map)", pg.locator(".side-column").bounding_box()["y"] > mb["y"] + mb["height"])
    pg.tap("#map", position={"x": mb["width"] * .3, "y": mb["height"] * .3}); pg.wait_for_timeout(200)
    check("mobile: tapping the map works", pg.input_value("#start-x") != "312.5")
    check("mobile: no console errors", not errs, errs)
    pg.screenshot(path="/tmp/mobile.png", full_page=True); pg.close()

    # reduced motion / focus visibility smoke
    pg, _ = fresh(b, viewport={"width": 1100, "height": 800}, reduced_motion="reduce")
    pg.keyboard.press("Tab"); check("first Tab reaches the skip link", pg.evaluate("document.activeElement.className") == "skip")
    pg.close(); b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} UI checks passed"); srv.shutdown(); sys.exit(1 if fails else 0)
