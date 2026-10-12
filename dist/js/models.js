// Planning models. Every constant here is either a cited reference value or an explicit assumption.
// Nothing in this file is a measurement taken at the study area.

export const SOL_HOURS = 24.6598; // mean length of a Mars solar day in hours

/** Each entry: value, unit, kind ("assumed" | "reference"), and what it is based on. */
export const PARAMS = {
  walkSpeedFlatKmh: { value: 2.5, unit: "km/h", kind: "assumed", note: "Walking speed on level ground. Assumed for this demonstration; not derived from suited-walking data." },
  slopeSpeedScaleDeg: { value: 16, unit: "°", kind: "assumed", note: "Speed = v₀ · exp(−(s/16°)²) where s is the slope along the direction of travel. Assumed shape, not fitted." },
  maxSlopeDeg: { value: 25, unit: "°", kind: "assumed", note: "Cells steeper than this are treated as prohibited. Configurable. No operational basis is claimed for 25°." },
  baselineDoseMSvPerDay: { value: 0.64, unit: "mSv/day", kind: "reference", note: "Galactic cosmic ray dose equivalent rate measured on the surface of Gale Crater by Curiosity RAD (Hassler et al. 2014, Science 343, 1244797; value quoted from the paper, to be re-checked). Gale is not Jezero; it is used here only as a reference scale." },
  skyViewSearchM: { value: 2000, unit: "m", kind: "assumed", note: "Maximum distance searched for horizon obstruction." },
  riskSlopeRefDeg: { value: 10, unit: "°", kind: "assumed", note: "Lower-risk route cost per metre: 1 + (s/10°)² + w·SVF, with s the slope of the step and SVF the sky-view factor (proportional to modeled dose). Weights are assumptions; \"risk\" here means slope and modeled radiation only." },
  riskDoseWeight: { value: 3, unit: "", kind: "assumed", note: "Weight w on modeled radiation exposure (sky-view factor) in the lower-risk objective." },
  scienceReward: { value: 0.6, unit: "", kind: "assumed", note: "Science route: travel-time cost is reduced by up to 60 % when passing through a target's influence radius." },
  scienceRadiusM: { value: 250, unit: "m", kind: "assumed", note: "Default influence radius of a science target, also used to decide whether a route 'visits' it." },
  enduranceHours: { value: { power: 8, o2: 8, water: 10 }, unit: "h", kind: "assumed", note: "Hours of EVA that 100 % of each consumable would last. Placeholder values, not suit specifications." },
  requiredEndReservePct: { value: 30, unit: "%", kind: "assumed", note: "Reserve that must remain after a round trip. Configurable." },
  pressurePa: { value: 700, unit: "Pa", kind: "assumed", note: "Order-of-magnitude surface pressure for Mars (roughly 600–900 Pa). Held constant; not a Jezero measurement." }
};

export const DUST = {
  nominal: { label: "Nominal (τ ≈ 0.5)", tau: 0.5 },
  local: { label: "Local dust storm (τ ≈ 1.6)", tau: 1.6 },
  regional: { label: "Regional dust storm (τ ≈ 3.2)", tau: 3.2 }
};
export const RADIATION_SCENARIOS = {
  nominal: { label: "Nominal (×1.0)", multiplier: 1.0 },
  elevated: { label: "Elevated particle flux (×1.5)", multiplier: 1.5 }
};

/** Walking speed in m/s for an along-track slope in degrees. */
export function walkSpeedMS(slopeDeg, p = {}) {
  const v0 = (p.walkSpeedFlatKmh ?? PARAMS.walkSpeedFlatKmh.value) / 3.6;
  const sc = p.slopeSpeedScaleDeg ?? PARAMS.slopeSpeedScaleDeg.value;
  return v0 * Math.exp(-((Math.abs(slopeDeg) / sc) ** 2));
}

/** Illustrative dose-equivalent rate (mSv/day): reference rate × sky-view factor × scenario multiplier. */
export function doseRate(skyView, multiplier = 1, p = {}) {
  const base = p.baselineDoseMSvPerDay ?? PARAMS.baselineDoseMSvPerDay.value;
  return base * skyView * multiplier;
}

/**
 * Environmental scenario at a given local solar hour (0–24 h on a 24.66 h Mars clock).
 * T(h) = −55 °C + A·cos(2π(h − 14)/24.66), A = 28 °C · (1 − 0.4·min(τ/3, 1)).
 * All numbers are illustrative; the shape (warm afternoon, damped swing under dust) is qualitative.
 */
export function environment({ localHour = 12, dust = "nominal" } = {}) {
  const tau = DUST[dust]?.tau ?? DUST.nominal.tau;
  const amp = 28 * (1 - 0.4 * Math.min(tau / 3, 1));
  const tempC = -55 + amp * Math.cos(2 * Math.PI * (localHour - 14) / SOL_HOURS);
  return { tau, tempC, tempAmplitudeC: amp, pressurePa: PARAMS.pressurePa.value, localHour, dust };
}

/** Local mean solar time at longitude (east), from a Date. Mars24-style MSD without the small TT−UT term. */
export function marsClock(date, lonEastDeg) {
  const jdUT = date.getTime() / 86400000 + 2440587.5;
  const msd = (jdUT - 2405522.0028779) / 1.0274912517;
  const mtc = (((msd % 1) + 1) % 1) * 24;
  return { msd, sol: Math.floor(msd), localHour: (mtc + lonEastDeg / 15 + 24) % 24 };
}

/** Consumable use as a percentage of capacity: hours / endurance × 100. */
export function consumableUse(hours, enduranceH) {
  return Object.fromEntries(Object.entries(enduranceH).map(([k, e]) => [k, (hours / e) * 100]));
}

/**
 * Planning-logic assessment (NOT an operational safety decision).
 * Round trip = 2 × route time (return along the same path). A consumable passes when
 * reserve − use ≥ requiredEndReservePct.
 */
export function assessSurvival({ route, reserves, enduranceH = PARAMS.enduranceHours.value, requiredEndReservePct = PARAMS.requiredEndReservePct.value, dust = "nominal", maxSlopeDeg = PARAMS.maxSlopeDeg.value }) {
  const checks = [];
  if (!route || !route.ok) {
    return { verdict: "NO GO", checks: [{ id: "route", ok: false, text: route?.message || "No valid route is selected." }], roundTripHours: null, use: null };
  }
  const roundTripHours = (2 * route.metrics.timeS) / 3600;
  const use = consumableUse(roundTripHours, enduranceH);
  const names = { power: "Suit power", o2: "Oxygen", water: "Water" };
  for (const k of Object.keys(enduranceH)) {
    const left = reserves[k] - use[k];
    checks.push({ id: k, ok: left >= requiredEndReservePct, text: `${names[k]}: ${reserves[k]} % start − ${use[k].toFixed(0)} % round trip (${roundTripHours.toFixed(1)} h of ${enduranceH[k]} h endurance) = ${left.toFixed(0)} % left; ${requiredEndReservePct} % required.` });
  }
  checks.push({ id: "slope", ok: route.metrics.maxEdgeSlopeDeg <= maxSlopeDeg, text: `Steepest step ${route.metrics.maxEdgeSlopeDeg.toFixed(1)}° against a ${maxSlopeDeg}° limit.` });
  checks.push({ id: "dust", ok: dust !== "regional", text: dust === "regional" ? "Regional dust-storm scenario: this demonstration rule always returns NO GO." : "No regional dust-storm scenario selected." });
  const failed = checks.filter(c => !c.ok);
  return { verdict: failed.length ? "NO GO" : "GO", checks, roundTripHours, use };
}
