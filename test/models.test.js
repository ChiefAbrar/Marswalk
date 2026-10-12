import test from "node:test";
import assert from "node:assert/strict";
import { walkSpeedMS, doseRate, environment, marsClock, consumableUse, assessSurvival, PARAMS, SOL_HOURS, DUST } from "../public/js/models.js";

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const okRoute = hours => ({ ok: true, metrics: { timeS: hours * 3600, maxEdgeSlopeDeg: 10 } });

test("walking speed: flat value, monotone decrease with slope, symmetric in sign", () => {
  near(walkSpeedMS(0), 2.5 / 3.6);
  near(walkSpeedMS(16), (2.5 / 3.6) * Math.exp(-1));
  assert.ok(walkSpeedMS(5) > walkSpeedMS(10) && walkSpeedMS(10) > walkSpeedMS(20));
  near(walkSpeedMS(-12), walkSpeedMS(12));
  near(walkSpeedMS(10, { walkSpeedFlatKmh: 5 }), 2 * walkSpeedMS(10));
});

test("dose rate = reference × sky view × multiplier, in mSv/day", () => {
  near(doseRate(1, 1), 0.64);
  near(doseRate(0.8, 1.5), 0.64 * 0.8 * 1.5);
  assert.equal(PARAMS.baselineDoseMSvPerDay.unit, "mSv/day");
  assert.equal(PARAMS.baselineDoseMSvPerDay.kind, "reference");
});

test("environment scenario: dust damps the daily swing; peak is in the afternoon; units are defined", () => {
  const clear = environment({ localHour: 14, dust: "nominal" }), storm = environment({ localHour: 14, dust: "regional" });
  assert.ok(storm.tempC < clear.tempC);
  assert.ok(storm.tempAmplitudeC < clear.tempAmplitudeC);
  near(clear.tempC, -55 + clear.tempAmplitudeC, 1e-9);
  const night = environment({ localHour: 14 + SOL_HOURS / 2, dust: "nominal" });
  near(night.tempC, -55 - clear.tempAmplitudeC, 1e-9);
  assert.equal(clear.tau, DUST.nominal.tau);
  assert.equal(environment({ localHour: 3, dust: "bogus" }).tau, DUST.nominal.tau);
  assert.equal(clear.pressurePa, 700);
});

test("Mars clock: hour is in range, advances 24 h per 1.0275 days, shifts 1 h per 15° of longitude", () => {
  const d = new Date("2026-10-10T00:00:00Z");
  const a = marsClock(d, 77.4), b = marsClock(d, 77.4 + 15);
  assert.ok(a.localHour >= 0 && a.localHour < 24);
  near(((b.localHour - a.localHour) + 24) % 24, 1, 1e-9);
  const later = marsClock(new Date(d.getTime() + 1.0274912517 * 86400000), 77.4);
  near(later.msd - a.msd, 1, 1e-6); near(later.localHour, a.localHour, 1e-6);
});

test("consumable use is hours / endurance", () => {
  const u = consumableUse(4, { power: 8, o2: 8, water: 10 });
  near(u.power, 50); near(u.water, 40);
});

test("survival assessment: GO with ample reserves, NO GO when reserves are lowered, with reasons that show the arithmetic", () => {
  const go = assessSurvival({ route: okRoute(1), reserves: { power: 90, o2: 90, water: 90 } });
  assert.equal(go.verdict, "GO"); near(go.roundTripHours, 2);
  assert.ok(go.checks.every(c => c.ok));
  // 2 h round trip on 8 h endurance = 25 %; 50 − 25 = 25 < 30 required
  const low = assessSurvival({ route: okRoute(1), reserves: { power: 50, o2: 90, water: 90 } });
  assert.equal(low.verdict, "NO GO");
  const failed = low.checks.filter(c => !c.ok); assert.equal(failed.length, 1); assert.equal(failed[0].id, "power");
  assert.match(failed[0].text, /50 % start − 25 % round trip/);
});

test("the required end reserve changes the verdict at the boundary", () => {
  const args = { route: okRoute(1), reserves: { power: 55, o2: 55, water: 55 } };
  assert.equal(assessSurvival({ ...args, requiredEndReservePct: 30 }).verdict, "GO");   // 55 − 25 = 30
  assert.equal(assessSurvival({ ...args, requiredEndReservePct: 31 }).verdict, "NO GO");
});

test("endurance assumptions change the outcome", () => {
  const args = { route: okRoute(2), reserves: { power: 100, o2: 100, water: 100 } };
  assert.equal(assessSurvival({ ...args, enduranceH: { power: 20, o2: 20, water: 20 } }).verdict, "GO");
  assert.equal(assessSurvival({ ...args, enduranceH: { power: 5, o2: 20, water: 20 } }).verdict, "NO GO");
});

test("regional dust scenario and over-limit slope each force NO GO and say why", () => {
  const dust = assessSurvival({ route: okRoute(0.5), reserves: { power: 100, o2: 100, water: 100 }, dust: "regional" });
  assert.equal(dust.verdict, "NO GO"); assert.ok(dust.checks.some(c => c.id === "dust" && !c.ok));
  const steep = assessSurvival({ route: { ok: true, metrics: { timeS: 1800, maxEdgeSlopeDeg: 30 } }, reserves: { power: 100, o2: 100, water: 100 }, maxSlopeDeg: 25 });
  assert.equal(steep.verdict, "NO GO"); assert.ok(steep.checks.some(c => c.id === "slope" && !c.ok));
});

test("no valid route gives NO GO with the route message", () => {
  const r = assessSurvival({ route: { ok: false, message: "Destination unreachable." }, reserves: { power: 100, o2: 100, water: 100 } });
  assert.equal(r.verdict, "NO GO"); assert.match(r.checks[0].text, /unreachable/);
});

test("every parameter declares a unit-bearing kind of assumed or reference", () => {
  for (const [k, p] of Object.entries(PARAMS)) { assert.ok(["assumed", "reference"].includes(p.kind), k); assert.ok(p.note.length > 20, k); }
});
