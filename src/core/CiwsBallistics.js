// CiwsBallistics. A mount is calibrated so a reference engagement matches the
// authored MissileInterceptChance, then each tick draws Poisson hits from the
// dispersion at the range the rounds actually meet the target.
import { clamp } from './Units.js';

const BIAS_PRED = Math.sqrt(6);
const BIAS_HW = Math.sqrt(2);

const fcOf = (mode) => {
  const m = mode || 'Director';
  return { mode: m, gain: 1, spot: 1, tracks: m === 'ClosedLoop', manual: m === 'Manual' };
};

const penOf = (name) => {
  if (name === 'Always' || name === '3') return Infinity;
  if (name === 'Heavy' || name === '2') return 2;
  if (name === 'Moderate' || name === '1') return 0.75;
  return 0.1;
};

/** PredictionBiasFactor. Closed-loop mounts settle; a fresh track is still biased. */
function predictionBias(age, settle, stress, fc) {
  const tau = settle / Math.max(fc.gain, 0.3);
  let f = tau > 0.01 ? Math.exp(-Math.max(0, age) / tau) : 0;
  const floor = clamp(Math.max(0, stress - 1) * 0.5, 0, 1);
  if (f < floor) f = floor;
  if (fc.manual && f < 0.35) f = 0.35;
  return f;
}

/** FallOfShotNullFactor. A director does not walk its fire. */
function fallNull(seen, disp, bias, stress, fc) {
  if (fc.mode === 'Director') return 1;
  if (seen < 1) return 1;
  const memory = fc.tracks ? 25 : 250 * fc.spot;
  let num = Math.exp(-seen / Math.max(memory, 1));
  let floor = bias > 0.0001 ? disp / Math.sqrt(seen) / bias : 0;
  floor = Math.max(floor, Math.max(0, stress - 1) * (fc.tracks ? 0.15 : 0.6));
  if (fc.manual) floor = Math.max(floor, 0.45 * fc.spot);
  if (num < floor) num = floor;
  return clamp(num, 0, 1);
}

/** SigmaTotalMrad. */
export function sigmaTotal(p, age, seen) {
  const fcs = p.sigmaFcs * p.error;
  const stress = Math.max(1, p.stress);
  let pred = fcs * BIAS_PRED * stress * predictionBias(age, p.settle, stress, p.fc);
  const hw = fcs * BIAS_HW;
  let bias = Math.hypot(pred, hw);
  bias *= fallNull(seen, p.disp, bias, stress, p.fc);
  return Math.hypot(p.disp, Math.hypot(fcs, bias));
}

/** TimeOfFlightS. Drag stretches the flight out to 1.4× at the quoted maximum range. */
export function timeOfFlight(p, range) {
  if (!(p.speed > 1) || !(p.maxRange > 1)) return 0;
  const r = Math.max(range, 10);
  return r / (p.speed * (1 - 0.4 * clamp(r / p.maxRange, 0, 1)));
}

function evasionSigma(accel, tof) {
  if (!(accel > 0) || !(tof > 0)) return 0;
  return 0.5 * accel * tof * Math.min(tof, 3);
}

/** RoundHitProbability. A miss cloud tighter than 5 cm is a certain hit. */
function roundHit(area, sigma) {
  if (!(area > 0)) return 0;
  if (sigma < 0.05) return 1;
  return clamp(1 - Math.exp(-area / (2 * Math.PI * sigma * sigma)), 0, 1);
}

/** ExpectedHitsForBurst. */
export function expectedHits(p, range, age, seen, rounds) {
  const r = Math.max(range, 10);
  const ang = sigmaTotal(p, age, seen) * 0.001 * r;
  const tof = timeOfFlight(p, r);
  let pred = Math.max(2, 0.01 * p.targetSpeed) / Math.sqrt(Math.max(p.fc.gain, 0.3)) * tof;
  pred *= fallNull(seen, p.disp, (pred / r) * 1000, p.stress, p.fc);
  const sigma = Math.hypot(ang, pred, evasionSigma(p.evadeAccel || 0, tof));
  const area = 0.0812 * (p.area / 0.0812) ** 0.65;
  return rounds * roundHit(area, sigma) * (p.hitRate || 1);
}

function expectedWindow(p, range0, closing, dur, age0, seen0, rounds, meetK, t0 = 0, firstHit = -Infinity) {
  let sum = 0;
  const slice = rounds / 6;
  for (let i = 0; i < 6; i++) {
    const at = dur * (i + 0.5) / 6;
    if (t0 + at < firstHit) continue;
    const range = Math.max(30, range0 - closing * at);
    sum += expectedHits(p, range * meetK, age0 + at, seen0 + slice * i, slice);
  }
  return sum;
}

/** SamplePoisson. Knuth under 30, a normal draw above that. */
export function samplePoisson(lambda, rnd) {
  if (!(lambda > 0)) return 0;
  if (lambda < 30) {
    const limit = Math.exp(-lambda);
    let n = 0;
    let p = 1;
    do {
      n++;
      p *= rnd();
    } while (p > limit && n < 500);
    return n - 1;
  }
  const u = Math.max(1e-12, 1 - rnd());
  const v = rnd();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}

function hitsNeededF(health, damage) {
  if (!(damage > 0)) return Infinity;
  return clamp(health / damage, 1, 1000);
}

function poissonTail(lambda, need) {
  if (need === Infinity) return 0;
  const n = Math.trunc(need);
  if (n <= 0) return 1;
  if (!(lambda > 0)) return 0;
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i < n; i++) {
    term *= lambda / i;
    sum += term;
    if (sum > 1) { sum = 1; break; }
  }
  return clamp(1 - sum, 0, 1);
}

/** KillChance. A vital component on any of the hits that land also counts. */
function killChance(lambda, need, vital) {
  if (!(vital > 0)) return poissonTail(lambda, need);
  const n = need === Infinity ? 200 : Math.trunc(need);
  if (n <= 0) return 1;
  if (!(lambda > 0)) return 0;
  const missVital = 1 - vital;
  let term = Math.exp(-lambda);
  let sum = term;
  let survive = 1;
  for (let i = 1; i < n; i++) {
    term *= lambda / i;
    survive *= missVital;
    sum += term * survive;
    if (!Number.isFinite(sum)) break;
  }
  return clamp(1 - sum, 0, 1);
}

/** StopChance. Late hits only count once the wreck has been shredded. */
function stopChance(early, late, need, shred, vital) {
  if (late <= 0.0001 || shred === Infinity) return killChance(early, need, vital);
  const hits = need === Infinity ? 200 : Math.trunc(need);
  if (hits <= 0) return 1;
  const e = Math.max(0, early);
  const missVital = 1 - clamp(vital, 0, 1);
  let term = Math.exp(-e);
  let survive = 1;
  let doomed = 0;
  const shredN = shred === Infinity ? Infinity : Math.trunc(shred);
  for (let i = 0; i < hits; i++) {
    if (i > 0) {
      term *= e / i;
      survive *= missVital;
    }
    const rest = shredN > i ? shredN - i : 0;
    doomed += term * survive * (1 - poissonTail(late, rest));
  }
  return clamp(1 - doomed, 0, 1);
}

/** SimulateEngagement. Withholds fire until a burst is worth taking. */
export function simulateEngagement(p) {
  const closing = Math.max(p.closing, 1);
  let left = p.roundsAvailable > 0 ? p.roundsAvailable : Infinity;
  const lateM = closing * 0.4;
  const end = Math.max(p.endRange, lateM);
  const meetK = p.speed > 1 ? p.speed / (p.speed + closing) : 1;
  const shred = p.shred > 1;
  const shredM = shred ? Math.max(p.endRange, Math.max(closing * 0.2 / Math.max(meetK, 0.1), 30)) : end;
  const span = (p.startRange - shredM) / closing;
  let t = 0, early = 0, late = 0, bursts = 0, seen = 0;
  let opened = false;
  let firstHit = (p.seen0 || 0) > 0 ? -Infinity : 0;
  let waiting = !((p.seen0 || 0) > 0);
  const perBurst = p.rps * p.burst;
  for (let guard = 0; guard < 400 && left > 0 && t < span; guard++) {
    const dur = Math.min(p.burst, span - t);
    if (dur < 0.05) break;
    const mid = t + dur * 0.5;
    const rangeMid = p.startRange - closing * mid;
    const rangeStart = p.startRange - closing * t;
    const observed = Math.max(0, (p.seen0 || 0) + seen - p.rps * timeOfFlight(p, rangeMid * meetK));
    if (!opened) {
      const far = rangeMid * meetK > end * 1.5;
      if (!p.fireNow && expectedWindow(p, rangeStart, closing, p.burst, (p.track0 || 0) + t, observed, perBurst, meetK) < 0.1 && far) {
        t += p.burst + (p.pause || 0);
        continue;
      }
      opened = true;
      if (waiting) {
        firstHit = t + timeOfFlight(p, rangeMid * meetK);
        waiting = false;
      }
    }
    const fired = Math.min(p.rps * dur, left);
    left -= fired;
    const lateStart = lateM / Math.max(meetK, 0.1);
    const rangeEnd = rangeStart - closing * dur;
    const age = (p.track0 || 0) + t;
    if (!shred || rangeEnd >= lateStart) {
      early += expectedWindow(p, rangeStart, closing, dur, age, observed, fired, meetK, t, firstHit);
    } else if (rangeStart <= lateStart) {
      late += expectedWindow(p, rangeStart, closing, dur, age, observed, fired, meetK, t, firstHit);
    } else {
      const split = (rangeStart - lateStart) / closing;
      const rest = dur - split;
      early += expectedWindow(p, rangeStart, closing, split, age, observed, fired * (split / dur), meetK, t, firstHit);
      late += expectedWindow(p, lateStart, closing, rest, age + split, observed, fired * (rest / dur), meetK, t + split, firstHit);
    }
    seen += fired;
    bursts++;
    t += p.burst + (p.pause || 0);
  }
  const need = hitsNeededF(p.health, p.damage);
  const shredNeed = shred ? hitsNeededF(p.health * p.shred, p.damage) : Infinity;
  return { early, late, bursts, kill: stopChance(early, late, need, shredNeed, p.vital) };
}

/** CalibrateSigmaFcs. The widest fire-control error that still makes the authored chance. */
function calibrateSigma(pct, reference) {
  const want = clamp(pct, 0.5, 98) / 100;
  if (!(reference.damage > 0)) return 80;
  const trial = (sigma) => simulateEngagement({ ...reference, sigmaFcs: sigma }).kill;
  if (trial(0.02) < want) return 0.02;
  let lo = 0.02, hi = 80;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) * 0.5;
    if (trial(mid) >= want) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

function terminalFactor(ammo, headOn, speed) {
  // 20 mm APDS is WarheadType None, so the round does not rake the body.
  const ap = ammo.warhead === '3' || ammo.warhead === 'ArmorPiercing';
  let rake = 0;
  if (ap) {
    const pen = penOf(ammo.pen);
    const len = 3.6;
    rake = pen === Infinity ? len : Math.max(0, Math.min(pen, len));
  }
  let along = 1 + (5 / 18) * headOn * headOn * rake;
  if (along > 3) along = 3;
  let speedK = 1 + 0.25 * Math.max(0, speed - 300) / 300;
  if (speedK > 2) speedK = 2;
  return along * speedK;
}

/**
 * EnsureCalibrated. Dispersion comes from the round's CEP. Two reference runs,
 * a 280 m/s missile and a 200 m/s aircraft, set the two fire-control sigmas.
 */
export function calibrateCiws(gun, ammo) {
  const fc = fcOf(gun.fcMode);
  const maxRange = ammo.maxRangeM || gun.maxRangeNm * 1852 || 2000;
  const cepM = ammo.cep ?? 2.4;
  const disp = clamp(cepM / Math.max(maxRange, 100) * 1000 / 1.1774, 0.3, 10);
  const speed = ammo.muzzle || 800;
  const rps = (gun.fireRate || 0) / 60;
  const burst = Math.max(0.2, gun.burstS || 1);
  const rounds = gun.volleyMax > 0 ? gun.volleyMax : 10000;
  const base = {
    fc, disp, error: 1, stress: 1, hitRate: 1, settle: 3, track0: 0, seen0: 0,
    rps, burst, pause: 0, speed, maxRange, evadeAccel: 0, fireNow: false,
  };
  const missileStart = Math.max(maxRange, maxRange * (speed + 280) / speed);
  const missile = {
    ...base,
    startRange: missileStart,
    endRange: 0,
    shred: 1.5,
    closing: 280,
    targetSpeed: 280,
    area: 0.0812,
    health: 2,
    damage: (ammo.power || 0) * (gun.dmgMult || 1) * terminalFactor(ammo, 1, 280),
    roundsAvailable: rounds,
    track0: Math.max(0, (2 * maxRange - missileStart) / 280),
  };
  missile.vital = clamp(0.3 * missile.damage / missile.health, 0, 1);
  const airStart = Math.max(Math.max(maxRange, 500), maxRange * (speed + 200) / speed);
  const air = {
    ...base,
    startRange: airStart,
    endRange: 300,
    shred: 0,
    closing: 200,
    targetSpeed: 200,
    area: 8,
    health: 4,
    damage: (ammo.power || 0) * (gun.dmgMult || 1),
    roundsAvailable: rounds,
    track0: Math.max(0, (2 * maxRange - airStart) / 200),
  };
  air.vital = clamp(0.3 * air.damage / air.health, 0, 1);
  return {
    disp,
    sigmaMissile: calibrateSigma((gun.pk || 0) * 100, missile),
    sigmaAir: calibrateSigma(gun.pkAir || 0, air),
  };
}

/** HoldFireMeetingRangeM, then the ship-side lead correction in HoldFireTargetRangeUnity. */
export function holdFireRange(p, roundsAvail) {
  const perBurst = p.rps * p.burst;
  let meet = 450;
  if (perBurst >= 1) {
    const age = p.settle * 4;
    let hi = Math.max(p.maxRange * 2, 500);
    if (expectedHits(p, hi, age, p.seen0 || 0, perBurst) < 0.1) {
      let lo = 50;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) * 0.5;
        if (expectedHits(p, mid, age, p.seen0 || 0, perBurst) >= 0.1) lo = mid;
        else hi = mid;
      }
      meet = (lo + hi) * 0.5;
    } else meet = hi;
    meet = Math.max(meet, 450);
  }
  const k = p.speed > 1 ? p.speed / (p.speed + Math.max(0, p.closing)) : 1;
  let range = meet / k;
  if (p.closing > 5 && p.rps > 0.1 && roundsAvail > 0) {
    const fly = 300 / k;
    range = Math.min(range, Math.max(fly + p.closing * (roundsAvail / p.rps), fly * 1.5));
  }
  return range * k;
}

/** VariedHitDamage. */
export function variedHit(damage, unit) {
  return damage * (0.5 + unit);
}

/**
 * GetPresentedAreaM2. Head-on blends side into frontal, then the line of sight
 * blends that into the planform. A body with no areas falls back to its RCS.
 */
export function presentedBody(spec, headOn, up) {
  const f = spec.frontalM2 || 0;
  const s = spec.sideM2 || 0;
  const h = clamp(headOn, 0, 1);
  const lift = Math.min(1, Math.abs(up) || 0);
  if (f > 0 && s > 0) {
    const a = s + (f - s) * h;
    const b = spec.bottomM2 > 0 ? spec.bottomM2 : s;
    return clamp(a + (b - a) * lift, 0.03, 60);
  }
  const rcs = spec.rcs || 0;
  if (!(rcs > 0)) return 8;
  const min = spec.rcsMin >= 0 ? spec.rcsMin : rcs * 0.3;
  return clamp(rcs + (min - rcs) * h, 0.03, 60);
}

/** Presented area (m²) for a head-on fraction in 0..1, level flight. */
export function presentedArea(ammo, headOn) {
  const f = ammo.frontalM2 || 0;
  const s = ammo.sideM2 || 0;
  if (f > 0 && s > 0) return clamp(s + (f - s) * clamp(headOn, 0, 1), 0.03, 60);
  let mass = ammo.massKg || 0;
  if (mass < 50) mass = 500;
  const base = 0.0047 * mass ** (2 / 3);
  const t = clamp(headOn, 0, 1);
  return clamp(base * 3.5 + (base - base * 3.5) * t, 0.03, 60);
}
