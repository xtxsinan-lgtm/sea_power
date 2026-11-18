// ============================================================================
// SimWorld — deterministic tactical simulation kernel (no rendering, no DOM).
// Frame: x east / y north / z up (m). Ship movement follows the original's
// telegraph model (n·Vmax/5, reverse = MaxBackwardVelocity). Detection, missile
// flight and damage are our own reimplementation driven by the game's INI data;
// tuning constants live in TUNING.
// ============================================================================
import { NM, KT, FT, D2R, R2D, wrap360, wrap180, dist2, dist3, bearing, clamp, hdgVec, mulberry32, radioHorizon, visualHorizon } from './Units.js';
import { applyInterference, bandGainReduction, passiveReading, sonarExcess, oceanNoiseDB, cavitationIntensity, activePing, OPEN_OCEAN_LAYER_FT } from './SonarAcoustics.js';
import { calibrateCiws, expectedHits, samplePoisson, holdFireRange, variedHit, presentedArea, presentedBody, timeOfFlight } from './CiwsBallistics.js';

// environment.ini [Night]..[Zenith]. Moon modifier at night is 0.15 * 0.05 / 0.15.
const SUN_BANDS = [[-60, -12, 0, 0.05], [-12, -6, 0.001, 0], [-6, 2, 0.25, 0], [2, 5, 0.5, 0], [5, 15, 1.1, 0], [15, 35, 1.1, 0], [35, 90, 1.1, 0]];

function sunBand(alt) {
  let pick = SUN_BANDS[0];
  for (const b of SUN_BANDS) if (alt >= b[0] && alt < b[1]) pick = b;
  return [pick[2], pick[3]];
}

/** 0 at the day band (altitude ≥ 5°) and 1 at astronomical night (≤ −12°). */
export function skyNight(alt) {
  if (alt >= 5) return 0;
  if (alt <= -12) return 1;
  return (5 - alt) / 17;
}

function solarState(date, hour, lat, lon) {
  const y = +date[0] || 1985, m = +date[1] || 6, d = +date[2] || 21;
  const n = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
  const decl = 23.45 * Math.sin((2 * Math.PI / 365) * (284 + n));
  const hourAngle = ((hour + lon / 15) - 12) * 15;
  const s = Math.sin(lat * D2R) * Math.sin(decl * D2R) + Math.cos(lat * D2R) * Math.cos(decl * D2R) * Math.cos(hourAngle * D2R);
  return { alt: Math.asin(clamp(s, -1, 1)) * R2D, hourAngle };
}

export const TUNING = {
  turnRateScale: 1.0,      // × RudderTurnRate × RudderForce (deg/s at full speed)
  radarHeightShip: 18,     // m antenna height
  damagePerPower: 1.0,
  gunHitScale: 1.0,
  detectInterval: 1.0,
};

// Globals._waveLengthsForFrequencyBands, metres. ESM threshold is the RCS ini default.
const BAND_M = {
  'vhf-band': 1.4989623, 'uhf-band': 0.46121916, 'l-band': 0.19986163, 's-band': 0.099930815,
  'c-band': 0.049965408, 'x-band': 0.033310276, 'ku-band': 0.019986162, 'k-band': 0.011991698,
  'ka-band': 0.0085654985, undefined: 0.029979244,
};
const FOUR_PI_SQ = 157.9136792061263;
const FOUR_PI_CUBE = (4 * Math.PI) ** 3;
const ESM_SMIN = 4e-10;
const RADAR_SMIN = 2e-14;

/** BaseMaxDetectionRangeMeter. Gain is dB. The result is metres. */
function radarPhysicsM(sensor, rcs) {
  const wl = BAND_M[String(sensor?.frequency || '').toLowerCase()] ?? BAND_M.undefined;
  const gain = 10 ** ((sensor?.gain || 0) / 10);
  const num = (sensor?.peakPower || 0) * gain * gain * wl * wl * Math.max(rcs, 1e-8);
  return (num / (RADAR_SMIN * FOUR_PI_CUBE)) ** 0.25;
}

/** Map and contact-list marks: (R) radar, (E) emissions, (V) visual, (S) sonar, (M) magnetic. */
export function trackMarks(sources) {
  return [['r', 'R'], ['e', 'E'], ['v', 'V'], ['s', 'S'], ['m', 'M']].filter(([k]) => sources?.[k]).map(([, letter]) => `(${letter})`).join('');
}

const UNITY_PER_FT = 0.00453571;
const FT_PER_UNITY = 220.47266;
const UNITY_M = 1852 / 27.559496;

/** Unity Mathf.SmoothStep. The third argument is already scaled by dt and then clamped. */
function smoothToward(from, to, rate) {
  let t = rate;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  t = t * t * (3 - 2 * t);
  return from * (1 - t) + to * t;
}
const G_UNITY = 0.145982;
const _dragFit = new Map();
// Constants.WAVE_HEIGHTS, Unity metres. Sea state 0 through 12.
const WAVE_HEIGHTS = [0, 7.457e-5, 0.00526, 0.012613, 0.028104, 0.04283, 0.063818, 0.115456, 0.135546, 0.163883, 0.214445, 0.28, 0.340563];

/** Ballistics.rangeToGravity at 45° with no start height is v² / range. */
function rangeToGravity(speed, range, initialHeight, angleDeg) {
  const angle = angleDeg * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return 2 * (c * c * initialHeight * speed * speed + c * s * speed * speed * range) / (range * range);
}

function integrateShot(v0, elevation, gravity, dragK) {
  let vx = v0 * Math.cos(elevation);
  let vy = v0 * Math.sin(elevation);
  let x = 0;
  let y = 0;
  for (let i = 0; i < 20000; i++) {
    const sp = Math.hypot(vx, vy);
    vx -= dragK * sp * vx * 0.05;
    vy -= (gravity + dragK * sp * vy) * 0.05;
    const px = x;
    const py = y;
    x += vx * 0.05;
    y += vy * 0.05;
    if (y < 0 && vy < 0) {
      const f = py / Math.max(py - y, 1e-6);
      return px + (x - px) * f;
    }
  }
  return -1;
}

function maxRangeForDrag(v0, gravity, dragK) {
  let best = 0;
  let bestA = 45;
  for (let a = 10; a <= 55; a += 5) {
    const range = integrateShot(v0, a * Math.PI / 180, gravity, dragK);
    if (range > best) { best = range; bestA = a; }
  }
  for (let a = bestA - 4; a <= bestA + 4; a++) {
    const range = integrateShot(v0, a * Math.PI / 180, gravity, dragK);
    if (range > best) best = range;
  }
  return best;
}

function solveDrag(v0, gravity, targetRange) {
  let lo = 0;
  let hi = 0.0001;
  for (let i = 0; i < 40; i++) {
    if (!(maxRangeForDrag(v0, gravity, hi) > targetRange)) break;
    hi *= 2;
  }
  for (let j = 0; j < 24; j++) {
    const mid = 0.5 * (lo + hi);
    if (maxRangeForDrag(v0, gravity, mid) > targetRange) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function slantTof(muzzle, dragK, slant) {
  if (muzzle <= 1e-5 || slant <= 0) return -1;
  if (dragK <= 1e-9) return slant / muzzle;
  const num = dragK * slant;
  if (num > 8) return -1;
  return (Math.exp(num) - 1) / (dragK * muzzle);
}

function superElevation(muzzle, gravity, dragK, x, y) {
  const slant = Math.hypot(x, y);
  const tof = slantTof(muzzle, dragK, slant);
  if (tof <= 0) return -1;
  return Math.atan2(0.5 * gravity * tof * tof, Math.max(slant, 0.0001));
}

/** GunBallistics.GetDirectFireModel. The drag fit is cached; fitting integrates thousands of steps. */
function directFireModel(ammo) {
  const key = `${ammo.muzzle}|${ammo.maxRangeM}|${ammo.grav}`;
  const hit = _dragFit.get(key);
  if (hit) return hit;
  const v = ammo.muzzle / UNITY_M;
  const maxU = ammo.maxRangeM / UNITY_M;
  const fitted = rangeToGravity(v, maxU * (ammo.grav > 0 ? ammo.grav : 1), 0, 45);
  const reach = Math.max(maxU, (v * v) / fitted);
  let g = G_UNITY;
  let k = 0;
  if ((v * v) / g <= reach * 1.02) g = fitted;
  else k = solveDrag(v, g, reach);
  const model = { v, g, k, maxU };
  _dragFit.set(key, model);
  return model;
}

/** SubmarineLoader displacement bands. Sea state above 3 subtracts (sea − 3) times this. */
export function seaDragCoeff(disp) {
  if (disp < 100) return 5;
  if (disp < 1000) return 4;
  if (disp < 6000) return 3;
  if (disp < 11000) return 2;
  if (disp < 25000) return 1;
  if (disp < 50000) return 0.5;
  return 0.25;
}

/** Context-menu depth orders. cyclePresetDepth still jumps 2 → 5 and 5 → 2. */
export const SUB_DEPTHS = [[0, 'Surface'], [1, 'Periscope'], [2, 'Shallow'], [3, 'Above layer'], [4, 'Below layer'], [5, 'Deep'], [6, 'Very deep']];

/**
 * GetPresetDepthFeet. Shallow is the cavitation depth of telegraph index 3, Deep of index 6.
 * Very deep is 80% of crush depth. Open ocean uses the 350 ft layer stand-in.
 */
export function presetDepthFt(spec, preset, layerFt = OPEN_OCEAN_LAYER_FT) {
  const dive = spec?.dive;
  if (!dive) return 0;
  const peri = Math.trunc((spec.periscopeM / FT) * UNITY_PER_FT * FT_PER_UNITY);
  const cap = Math.round(0.8 * dive.crushFt * UNITY_PER_FT * FT_PER_UNITY / 10 - 0.5) * 10;
  const tel = spec.telegraph || [];
  const rated = spec.noise?.cavRated || 0;
  const cavFt = (kt) => {
    if (!(rated > 0.001)) return 0;
    const n = (kt || 0) / rated;
    return Math.max(0, 110 * n * n - 10) * 3.28084;
  };
  const layerU = layerFt * UNITY_PER_FT;
  let num = 0;
  if (preset === 1) num = peri;
  else if (preset === 2) {
    num = Math.round(cavFt(tel[3]) / 10 + 0.5) * 10 + 10;
    if (num < 100) num = 100;
    const below = Math.round(layerU * FT_PER_UNITY / 10 + 0.5) * 10 - 30;
    if (num > below) num = below;
    if (num < peri) num = peri;
  } else if (preset === 3) {
    // Above the layer by 30 ft. With no layer, cavitation depth of the fourth bell.
    if (layerFt > 0) num = Math.round(layerU * FT_PER_UNITY / 10 - 0.5) * 10 - 30;
    else num = Math.round(cavFt(tel[4]) / 10 + 0.5) * 10 + 10;
  } else if (preset === 4) {
    if (layerFt > 0) num = 30 + Math.round(layerU * FT_PER_UNITY / 10 + 0.5) * 10;
    else num = 10 + Math.round(cavFt(tel[5]) / 10 + 0.5) * 10;
  } else if (preset === 5) {
    num = Math.round(cavFt(tel[6]) / 10 + 0.5) * 10 + 10;
    const under = Math.round(layerU * FT_PER_UNITY / 10 + 0.5) * 10 + 30;
    if (num < under) num = under;
  } else if (preset === 6) num = cap;
  if (num >= cap) num = cap;
  return num;
}

/** A live contact whose only sensor is MAD. The hull stays hidden; the plot is the noisy fix. */
export function madOnlyContact(ct) {
  const s = ct?.sources;
  return !!(ct?.live && ct.level < 2 && s?.m && !s.r && !s.e && !s.v && !s.s);
}

/**
 * Passive sonar range error is kilometres, so the plotted point is not the hull.
 * An active echo (0.1 m) or a radar/visual fix is tight enough to show the hull.
 */
export function sonarUncertain(ct) {
  const s = ct?.sources;
  return !!(ct?.live && ct.sonarErr && ct.sonarErr.rngM > 1 && ct.level < 2 && s?.s && !s.r && !s.v);
}

/**
 * CheckEMCON drives the nav-light meshes: off when the hull is immobile or EMCON,
 * left alone for a neutral taskforce, and hidden once a submarine is under.
 */
export function navLightsOn(u) {
  if (!u?.alive || u._crippled) return false;
  if (u.kind !== 'ship' && u.kind !== 'sub' && u.kind !== 'air') return false;
  if (u.kind === 'sub' && -(u.z || 0) > 2) return false;
  if (u.team === TEAM_NEUTRAL) return true;
  return !u.emcon;
}

let _uid = 1;
export const TEAM_NEUTRAL = 0;

// UnitFormation.FormationPattern, excluding None, Convoy and Battlegroup (those are not in the ship menu).
// UnitFormation.FormationSpacing: Parade 0.05, Tight 0.1, Spread 0.5, Loose 1 nautical mile.
export const FORM_PATTERNS = [['loose', 'Loose'], ['lineAbreast', 'Line abreast'], ['lineAstern', 'Line astern'], ['vic', 'Vic'], ['echelon', 'Echelon'], ['box', 'Box'], ['circle', 'Circle']];
export const FORM_SPACING = [['parade', 0.05, 'Parade'], ['tight', 0.1, 'Tight'], ['spread', 0.5, 'Spread'], ['loose', 1, 'Loose']];

/**
 * Station offset in nautical miles, leader-local: starboard positive, forward positive.
 * Index 0 is the leader. The formulas are UnitFormation.GetNewStationPositionIn*Formation.
 */
export function formationOffsetNm(pattern, spacing, index) {
  if (index <= 0) return { stbd: 0, fwd: 0 };
  const s = spacing;
  if (pattern === 'lineAbreast') {
    const k = index - 1;
    const rank = Math.floor(k / 2) + 1;
    return { stbd: (k % 2 === 0 ? -1 : 1) * s * rank, fwd: 0 };
  }
  if (pattern === 'lineAstern') return { stbd: 0, fwd: -s * index };
  if (pattern === 'echelon') return { stbd: s * index, fwd: -s * index };
  if (pattern === 'vic') {
    const m = Math.floor((index - 1) / 2) + 1;
    return { stbd: (index % 2 === 0 ? -1 : 1) * s * m, fwd: -s * m / 2 };
  }
  if (pattern === 'box') {
    const m = Math.floor((index - 1) / 3) + 1;
    let stbd = s * m;
    if (index % 3 === 0) stbd = -stbd;
    else if (index % 2 === 0) stbd = 0;
    return { stbd, fwd: -s * m };
  }
  if (pattern === 'circle') {
    const ring = Math.floor((index - 1) / 8) + 1;
    let ang = index * 45;
    if (ang > 360) ang = (index % 8) * 45;
    const r = s * ring;
    const a = ang * D2R;
    return { stbd: r * Math.cos(a), fwd: r * Math.sin(a) };
  }
  return null;
}

export class SimWorld {
  constructor({ seed = 1, catalog = null } = {}) {
    this.t = 0;
    this.rng = mulberry32(seed);
    this.catalog = catalog;
    /** @type {Map<number, any>} */ this.units = new Map();
    this.events = [];
    this.contacts = { 1: new Map(), 2: new Map() }; // team -> unitId -> contact
    // Taskforce missile and torpedo brackets: team, target, family -> { launch, hit }.
    this._brackets = new Map();
    this.playerTeam = 1;
    this._playerSpoofed = 0; // fourth successful player-missile spoof is thrown out
    this.revealAll = false;
    this.noEnemyAi = false;
    this.timeScale = 1; // GameTime compression. Flight-deck work is capped at 30×.
    this.over = null;
    this._detectT = 0;
    this._listeners = new Set();
    this.triggers = [];
    this.clouds = []; // chaff blooms and noisemakers. Not units, so they are not contacts.
    // Daylight, clear. MissionLoader.setWeather replaces this from the mission Environment block.
    this.weather = { clouds: 'clear', rain: false, snow: false, fog: false, sea: 0, sun: 1, moon: 0, sunAlt: 40, hourAngle: 0 };
    this._trackSeq = { 1: 1, 2: 1 };
    // Ships start Loose at 1 nm. Line abreast and line astern rotate with the leader; the others freeze.
    this._form = { pattern: 'loose', spacing: 1, spacingKey: 'loose' };
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  /** environment.ini sun bands, picked from a solar altitude for the mission date and place. */
  setWeather(env = {}) {
    const clouds = String(env.Clouds || 'clear').toLowerCase();
    const wx = String(env.Weather || '').toLowerCase();
    const time = String(env.Time || '12,0').split(',');
    const date = String(env.Date || '1985,6,21').split(',');
    const hour = (+time[0] || 0) + ((+time[1] || 0) / 60);
    const lat = +env.MapCenterLatitude || 0;
    const lon = /true/i.test(env.ConvertTimeToLocal || '') ? 0 : (+env.MapCenterLongitude || 0);
    const { alt, hourAngle } = solarState(date, hour, lat, lon);
    const [sun, moon] = sunBand(alt);
    this.weather = {
      clouds, rain: /rain|thunder/.test(wx), snow: /snow/.test(wx), fog: /fog/.test(wx),
      sea: +env.SeaState || 0, sun, moon, sunAlt: alt, hourAngle,
    };
  }
  emit(type, data = {}) { const e = { t: this.t, type, ...data }; this.events.push(e); if (this.events.length > 400) this.events.shift(); for (const l of this._listeners) l(e); }

  // ------------------------------------------------------------------ units --
  addUnit({ spec, team, x, y, z = 0, heading = 0, telegraph = 0, name, hull, waypoints = [], active = true, ai = true, alt = null }) {
    const u = {
      id: _uid++, spec, kind: spec.kind, team, name: name || spec.name, hull: hull || spec.hullNo || '',
      x, y, z, heading, course: heading, pitch: 0, roll: 0, telegraph, speed: 0, // m/s
      hp: spec.hp, maxHp: spec.hp, alive: true, active, ai, waypoints: waypoints.slice(), wpIdx: 0,
      // Vessel._setRudderAngle / _currentRudderAngle. helm means the player has the rudder (command override).
      rudderSet: 0, rudderNow: 0, turnRate: 0, helm: false,
      ammo: { ...spec.ammo }, cooldown: 0, aiCooldown: 0, targetId: null, ordAlt: alt,
      // Ships start with search radars on. A submarine's periscope, search radar, ESM and snorkel
      // are SetDisabled at creation and stay down until ordered.
      airSearchOn: spec.kind !== 'sub', surfSearchOn: spec.kind !== 'sub', emcon: false, activeSonarOn: false, sensorsOn: spec.kind !== 'sub',
      periscopeUp: false, esmUp: false, snorkelUp: false,
      // ObjectBase.WeaponStatus defaults to Tight (enum 0). threats = units/weapons shooting at us.
      roe: 'tight', threats: new Set(),
    };
    const def = spec.defense;
    if (def) {
      u.chaff = (def.chaff || []).map((c) => ({ ...c, left: c.count, cool: 0 }));
      u.ciws = (def.ciws || []).map((c) => {
        // The drum is already inside the magazine count, same as a gun's ready rack.
        const cap = c.ready > 0 ? c.ready : 0;
        const have = u.ammo[c.ammoId] || 0;
        return {
          ...c, cool: 0, arm: 0, lock: 0, fired: 0, tick: 0, seen: 0, hitAt: null, firing: false, coast: 0,
          readyCap: cap, ready: cap > 0 ? Math.min(cap, have) : have, reload: 0,
        };
      });
      u.noise = (def.noise || []).map((c) => ({ ...c, cool: 0 }));
      u.decoy = (def.decoy || []).map((c) => ({ ...c, wanted: false, on: false }));
      u.ecm = (def.ecm || []).map((c) => ({ ...c }));
    }
    if (spec.kind === 'air') {
      u.z = z; u.ordAlt = alt ?? z; u.speed = this.speedForTelegraph(u) * KT;
      u.fuelNm = spec.maxRangeNm || 0; u.homeId = null; u.rtb = false;
    }
    else if (spec.kind === 'ship' || spec.kind === 'sub') u.speed = this.speedForTelegraph(u) * KT;
    this.units.set(u.id, u);
    return u;
  }

  /** Sail still out of the water: IsSubmerged is false, so the surfaced telegraph applies. */
  _subSurfaced(u) {
    return u?.kind === 'sub' && -(u.z || 0) < (u.spec?.sailUnderM || 0);
  }

  /**
   * TelegraphSpeed.SetSubmarineSpeed. Submerged uses the authored ladder. Surfaced multiplies
   * by MaxForwardVelocitySurfaced / MaxForwardVelocity, except reverse, which is the surfaced
   * backward maximum. In sea state above 3 that surfaced speed is reduced further.
   */
  speedForTelegraph(u) {
    const s = u.spec;
    if (u.kind === 'air') return [0, s.cruiseKt * 0.55, s.cruiseKt * 0.8, s.cruiseKt, (s.cruiseKt + s.maxKt) / 2, s.maxKt][clamp(u.telegraph + 1, 0, 5)] ?? s.cruiseKt;
    const t = clamp(u.telegraph, -1, 5);
    if (t < 0 && this._clipOn(u)) return 0;
    const base = s.telegraph[t + 1] ?? 0;
    if (!(u.kind === 'sub' && s.surfKt > 0 && this._subSurfaced(u))) return base;
    let kt = t === -1 ? -(s.surfBackKt ?? 3) : base * (s.surfKt / (s.vmaxKt || s.surfKt));
    const sea = this.weather?.sea || 0;
    if (sea > 3) {
      const c = seaDragCoeff(s.disp || 0);
      if (kt > 0) {
        const cap = s.surfKt - (sea - 3) * c;
        if (kt > cap) kt = cap > 5 ? cap : 5;
      } else if (kt < 0) {
        const cap = -(s.surfBackKt ?? 3) + (sea - 3) * c;
        if (kt < cap) kt = cap < -2 ? cap : -2;
      }
    }
    return kt;
  }

  get(id) { return this.units.get(id); }
  *all() { for (const u of this.units.values()) if (u.alive) yield u; }
  isHostile(a, b) { return a.team !== b.team && a.team !== 0 && b.team !== 0; }

  // --------------------------------------------------------------- commands --
  /** A fitted clip-on array, damaged or not streamed, still counts. HasClipOnArray does not check speed. */
  _clipOn(u) {
    return (u?.spec?.sensors || []).some((s) => s.tow?.clipOn);
  }

  orderTelegraph(u, n) {
    if (u.rtb) return;
    this.releaseVid(u);
    this.releaseWingman(u);
    let t = clamp(Math.round(n), -1, 5);
    // setTelegraph and TelegraphSpeed both refuse astern while a clip-on array is fitted.
    if (t < 0 && this._clipOn(u)) {
      t = 0;
      u.orderText = 'Clip-on array — cannot go astern';
    }
    u.telegraph = t;
  }

  /** setPresetDepth. The keel depth is GetPresetDepthFeet for that preset. */
  orderDepth(u, preset) {
    if (!u || u.kind !== 'sub' || !u.spec?.dive) return false;
    const known = SUB_DEPTHS.some(([n]) => n === preset);
    if (!known) return false;
    u.depthPreset = preset;
    u.ordDepthM = presetDepthFt(u.spec, preset) * FT;
    const label = SUB_DEPTHS.find(([n]) => n === preset)?.[1] || '';
    u.orderText = `Make my depth ${label.toLowerCase()}, ${Math.round(u.ordDepthM / FT)} ft`;
    return true;
  }

  cycleDepth(u, step) {
    // cyclePresetDepth. Stepping onto the layer pair from outside jumps over both of them.
    if (!u || u.kind !== 'sub') return false;
    let n = (u.depthPreset ?? 0) + step;
    if (n < 0) n = 0;
    else if (n > 6) n = 6;
    else if (step > 0 && n === 3) n = 5;
    else if (step < 0 && n === 4) n = 2;
    return this.orderDepth(u, n);
  }
  orderCourse(u, deg) { if (u.rtb) return; this.releaseVid(u); this.releaseWingman(u); u.course = wrap360(deg); u.waypoints = []; u.wpIdx = 0; u.helm = false; }
  /** Vessel.turnRudderLeft / turnRudderRight. Opposite rudder returns to amidships, then steps 5°, clamped to ±25. */
  turnRudder(u, dir) {
    if (!u || u.rtb || u.kind === 'air') return;
    this.releaseVid(u);
    u.helm = true;
    if (dir < 0) u.rudderSet = u.rudderSet > 0 ? 0 : Math.max(-25, u.rudderSet - 5);
    else u.rudderSet = u.rudderSet < 0 ? 0 : Math.min(25, u.rudderSet + 5);
  }
  orderWaypoints(u, pts) { if (u.rtb) return; this.releaseVid(u); this.releaseWingman(u); u.waypoints = pts; u.wpIdx = 0; }
  orderAltitude(u, m) { if (u.rtb) return; u.ordAlt = m; }

  /** VesselStates.VisualIdentify. Ahead Full, rudder toward the contact, until it is identified. */
  orderIdentify(u, target) {
    if (!u || u.rtb || !u.alive || !target || !target.alive || u.id === target.id) return false;
    if (u.kind !== 'ship' && u.kind !== 'air') return false;
    const ct = this.contacts[u.team]?.get(target.id);
    if (!ct || ct.level >= 2) return false;
    const track = ct.track ?? target.id;
    if (u.kind === 'air' && u.fuelNm > 0 && dist2(u, target) / NM > u.fuelNm * 0.9) {
      this.emit('order', { id: u.id, msg: `${u.name}: Unable to VID Track ${track} - out of fuel range.` });
      return false;
    }
    this.releaseWingman(u);
    u.vidId = target.id;
    u.waypoints = [];
    u.wpIdx = 0;
    u.orderText = `Identifying Track ${track}`;
    this.emit('order', { id: u.id, msg: `${u.name}: VID Track ${track}, roger out.` });
    return true;
  }

  releaseVid(u) {
    if (!u?.vidId) return;
    u.vidId = null;
    if (String(u.orderText || '').startsWith('Identifying')) u.orderText = '';
    u.helm = false;
  }

  _steerVid(u) {
    const t = this.units.get(u.vidId);
    const ct = this.contacts[u.team]?.get(u.vidId);
    const track = ct?.track ?? u.vidId;
    if (!t || !t.alive || !ct || ct.level >= 2) { this.releaseVid(u); return; }
    if (u.kind === 'air' && u.fuelNm > 0 && dist2(u, t) / NM > u.fuelNm * 0.9) {
      this.emit('order', { id: u.id, msg: `${u.name}: Unable to VID Track ${track} - out of fuel range.` });
      this.releaseVid(u);
      return;
    }
    u.orderText = `Identifying Track ${track}`;
    if (u.kind === 'ship') {
      u.telegraph = 4;
      const yaw = wrap180(bearing(u, t) - u.heading);
      let rudder = clamp(yaw, -25, 25);
      const a = Math.abs(rudder);
      if (a > 0.25 && a < 1) rudder = Math.sign(rudder);
      u.rudderSet = rudder;
      u.helm = true;
    } else if (u.kind === 'air') {
      // HelicopterStates.VisualIdentify: current speed must be able to reach the contact's velocity.
      const aim = this._intercept(u, ct || t);
      if (!aim) {
        this.emit('order', { id: u.id, msg: `${u.name}: Unable to VID Track ${track} - unable to intercept.` });
        this.releaseVid(u);
        return;
      }
      u.course = bearing(u, aim);
      if ((u.ordAlt || 0) < 1000 * FT) u.ordAlt = 1000 * FT;
    }
  }

  /** Utils.CalculateInterceptPosition. Positions and speeds are converted to Unity so the 0.01 speed gate matches. */
  _intercept(ob, tgt) {
    const U = 1852 / 27.559496;
    const vx = (ob.speed || 0) / U;
    const ix = ob.x / U, iy = ob.y / U;
    const tx = tgt.x / U, ty = tgt.y / U;
    const h = (tgt.heading || 0) * D2R;
    const sp = (tgt.speed || 0) / U;
    const vtx = Math.sin(h) * sp, vty = Math.cos(h) * sp;
    const relx = tx - ix, rely = ty - iy;
    const cross = relx * vty - rely * vtx;
    const num2 = vx * vx * (relx * relx + rely * rely) - cross * cross;
    if (num2 <= 0) return null;
    const num4 = vx * vx - (vtx * vtx + vty * vty);
    if (Math.abs(num4) <= 0.01) return null;
    const time = (Math.sqrt(num2) + relx * vtx + rely * vty) / num4;
    if (time <= 0) return null;
    return { x: (tx + time * vtx) * U, y: (ty + time * vty) * U };
  }

  /** Hangar from the vessel AirGroup. Specs are loaded once; counts change as aircraft launch and recover. */
  async fitDeck(u, year = 1985) {
    if (!u || u.deck || !u.spec.airGroup?.length || !this.catalog) return;
    const bins = [];
    for (const g of u.spec.airGroup) {
      if (!g.count) continue;
      const names = await this.catalog.loadoutChoices(g.id, g.loadout);
      const options = [];
      for (const name of names) options.push({ name, spec: await this.catalog.aircraft(g.id, { loadout: name, year }) });
      const pick = Math.max(0, options.findIndex((o) => o.name === g.loadout));
      bins.push({ id: g.id, loadout: options[pick].name, count: g.count, spec: options[pick].spec, options, pick });
    }
    u.deck = {
      bins, jobs: [],
      launchDelay: u.spec.flightDeck?.launchDelay ?? 50,
      crew: u.spec.flightDeck?.crew ?? 1,
    };
  }

  requestLaunch(ship, binIndex = 0) {
    const deck = ship?.deck; if (!deck) return false;
    const bin = deck.bins[binIndex];
    if (!bin || bin.count < 1) return false;
    if (deck.jobs.some((j) => j.phase === 'ready' || j.phase === 'launch')) return false;
    const opt = bin.options?.[bin.pick] || { name: bin.loadout, spec: bin.spec };
    bin.count--;
    deck.jobs.push({ spec: opt.spec, typeId: bin.id, loadout: opt.name, phase: 'ready', left: (opt.spec.readyUpMin || 15) * 60 });
    this.emit('deck', { msg: `Preparing ${opt.spec.name} (${opt.name})` });
    return true;
  }

  returnToBase(u, reason = 'order') {
    if (!u || u.kind !== 'air' || !u.alive || u.rtb || !u.homeId) return false;
    u.rtb = true;
    u.waypoints = [];
    u.wpIdx = 0;
    // AircraftStates.BingoFuel / Winchester. Bingo also locks the controls, which rtb already does.
    const text = reason === 'bingo' ? 'Return To Base - Bingo Fuel'
      : reason === 'winchester' ? 'Return To Base - Winchester'
        : 'Return to base';
    u.orderText = text;
    u.layBuoys = false;
    u.layRun = null;
    u.layKt = 0;
    if (reason === 'winchester' && u.team === this.playerTeam && u.roe === 'free') u.roe = 'tight';
    this.emit('deck', { id: u.id, msg: `${u.name}: ${text}` });
    return true;
  }

  /**
   * LaySonobouys drops a line of sonobuoys abeam, 31.75 Unity apart.
   * Launch altitude is the ini band (SSQ-53/62: 200–1000 ft). Outside that band the
   * helicopter descends to the midpoint and drops on the next step that is inside it.
   * Passive buoys are used first, matching the patrol state's passiveSonobouyReference.
   */
  dropSonobuoys(u) {
    if (!u || u.kind !== 'air' || !u.alive || u.rtb) return false;
    const id = this._passiveBuoyId(u);
    if (!id) return false;
    const a = u.spec.ammoSpecs[id];
    u.layBuoys = true;
    u.ordAlt = ((a.minAltFt + a.maxAltFt) / 2) * FT;
    u.orderText = 'Laying sonobuoys';
    this._laySonobuoySalvo(u);
    return true;
  }

  _passiveBuoyId(u) {
    const ids = Object.keys(u.ammo || {}).filter((id) => (u.ammo[id] || 0) > 0 && u.spec.ammoSpecs[id]?.type === 'Sonobuoy');
    return ids.find((id) => !u.spec.ammoSpecs[id].activeOnly) || ids[0] || null;
  }

  _laySonobuoySalvo(u) {
    if (!u.layBuoys) return;
    const id = this._passiveBuoyId(u);
    if (!id) { u.layBuoys = false; u.orderText = ''; return; }
    const a = u.spec.ammoSpecs[id];
    const lo = a.minAltFt * FT, hi = a.maxAltFt * FT;
    if (u.z < lo || u.z > hi) return;
    const have = u.ammo[id];
    const salvo = have <= 3 ? have : 3 + Math.floor(this.rng() * (Math.min(6, have) - 3));
    const spacing = 31.749971 * (NM / 27.559496);
    const beam = hdgVec(wrap360(u.heading + 90));
    let off = -0.5 * spacing * salvo;
    for (let i = 0; i < salvo; i++) {
      this._spawnBuoy(u, a, u.x + beam.x * off, u.y + beam.y * off);
      off += spacing;
    }
    u.ammo[id] -= salvo;
    u.layBuoys = false;
    u.orderText = '';
    u.buoyAt = this.t;
    this.emit('launch', { by: u.id, ammo: a.name, msg: `${u.name} lays ${salvo} ${a.short || a.name}` });
  }

  /**
   * AircraftStates.MaritimePatrol lays a passive barrier on the active waypoint once per buoy life.
   * The run is at 150 kt. The line is abeam, 31.75 Unity apart, and the aircraft joins it
   * 29.76 Unity before the first buoy. Helicopters are not wired to this state.
   */
  _stepPatrolBuoys(u) {
    if (u.spec.helo || u.rtb || u.vidId) {
      if (u.layRun) { u.layRun = null; u.layKt = 0; }
      return false;
    }
    const id = this._passiveBuoyId(u);
    if (!id) return false;
    const life = u.spec.ammoSpecs[id].lifeS || 0;
    if (!(life > 0)) return false;
    if (u.buoyAt == null) u.buoyAt = -life;
    if (!u.layRun) {
      if (u.layBuoys || !u.waypoints.length || u.wpIdx >= u.waypoints.length) return false;
      if (this.t - u.buoyAt < life) return false;
      this._beginBuoyRun(u, id);
    }
    if (!u.layRun) return false;
    this._steerBuoyRun(u);
    return true;
  }

  _beginBuoyRun(u, id) {
    const a = u.spec.ammoSpecs[id];
    const have = u.ammo[id] || 0;
    if (have <= 0) return;
    const salvo = have <= 3 ? have : 3 + Math.floor(this.rng() * (Math.min(6, have) - 3));
    const spacing = 31.749971 * (NM / 27.559496);
    const lead = 29.761875 * (NM / 27.559496);
    const wp = u.waypoints[u.wpIdx];
    const beam = hdgVec(wrap360(u.heading + 90));
    const points = [];
    let off = -0.5 * spacing * salvo;
    for (let i = 0; i < salvo; i++) {
      points.push({ x: wp.x + beam.x * off, y: wp.y + beam.y * off });
      off += spacing;
    }
    const back = lead + 0.5 * spacing * salvo;
    u.layRun = { id, points, ip: { x: wp.x - beam.x * back, y: wp.y - beam.y * back }, phase: 'ip' };
    u.ordAlt = ((a.minAltFt + a.maxAltFt) / 2) * FT;
    u.layKt = 150;
    u.orderText = 'Laying sonobuoys';
  }

  _steerBuoyRun(u) {
    const run = u.layRun;
    const dest = run.phase === 'ip' ? run.ip : run.points[0];
    if (!dest) { this._endBuoyRun(u); return; }
    u.course = bearing(u, dest);
    if (dist2(u, dest) >= 400) return;
    if (run.phase === 'ip') { run.phase = 'drop'; return; }
    const a = u.spec.ammoSpecs[run.id];
    const lo = a.minAltFt * FT, hi = a.maxAltFt * FT;
    if (u.z < lo || u.z > hi) return;
    if ((u.ammo[run.id] || 0) > 0) {
      this._spawnBuoy(u, a, dest.x, dest.y);
      u.ammo[run.id]--;
    }
    run.points.shift();
    if (!run.points.length) this._endBuoyRun(u);
  }

  _endBuoyRun(u) {
    u.buoyAt = this.t;
    u.layRun = null;
    u.layKt = 0;
    if (!u.layBuoys) u.orderText = '';
  }

  _spawnBuoy(owner, a, x, y) {
    const air = owner.kind === 'air' && owner.z > 0;
    const b = {
      id: _uid++, kind: 'buoy', team: owner.team, name: a.short || a.name, owner: owner.id,
      alive: true, active: true, x, y, z: air ? owner.z : 0, heading: owner.heading || 0, speed: 0, hp: 1, maxHp: 1,
      spec: { kind: 'buoy', length: 1, rcs: a.rcs || 0.1, sensors: [] },
      passiveKm: a.passiveKm || 0, activeKm: a.activeKm || 0, linkNm: a.linkNm || 30,
      sonar: a.sonar || null, activeOnly: !!a.activeOnly,
      lifeS: a.lifeS || 3600, age: 0, hydroM: (a.sonarFt || 0) * FT,
      falling: air, chute: false, fallT: 0, chuteKt: a.chuteKt || 100, chuteSlow: a.chuteSlow || 0.99, chuteDelay: a.chuteDelay || 0,
      vx: air ? Math.sin((owner.heading || 0) * D2R) * owner.speed : 0,
      vy: air ? Math.cos((owner.heading || 0) * D2R) * owner.speed : 0,
      vz: 0,
    };
    this.units.set(b.id, b);
    return b;
  }

  /** Bomb fall for a sonobuoy. It listens only after the float is in the water; the hydrophone hangs at SonarDepth. */
  _stepBuoy(b, dt) {
    if (b.falling) {
      b.fallT += dt;
      b.vz -= 9.81 * dt;
      if (b.fallT > (b.chuteDelay || 0)) b.chute = true;
      let { vx, vy, vz } = b;
      const end = (b.chuteKt || 100) * KT;
      if (b.chute && Math.hypot(vx, vy, vz) > end) {
        const damp = Math.pow(b.chuteSlow || 0.99, dt / 0.02);
        vx *= damp; vy *= damp; vz *= damp;
      }
      b.vx = vx; b.vy = vy; b.vz = vz;
      b.x += vx * dt; b.y += vy * dt; b.z += vz * dt;
      if (b.z < -0.02 * (1852 / 27.559496)) { b.falling = false; b.z = 0; b.age = 0; }
      return;
    }
    b.age += dt;
    if (b.age >= (b.lifeS || 0)) { b.alive = false; b.active = false; }
  }

  /** A sonobuoy reports a submarine only while a friendly unit is inside TransmitterRange. */
  _buoyHears(team, tgt) {
    if (tgt.kind !== 'sub' && tgt.kind !== 'torpedo') return null;
    let best = null;
    for (const b of this.units.values()) {
      if (!b.alive || b.kind !== 'buoy' || b.team !== team || b.falling || !b.sonar) continue;
      const ear = { x: b.x, y: b.y, z: -(b.hydroM || 0), heading: b.heading || 0, speed: 0, spec: {} };
      const hit = this._sonarHit(b, b.sonar, tgt, ear);
      if (!hit) continue;
      const link = (b.linkNm || 30) * NM;
      let linked = false;
      for (const u of this.units.values()) {
        if (!u.alive || !u.active || u.team !== team || u.kind === 'buoy') continue;
        if (dist2(u, b) <= link) { linked = true; break; }
      }
      if (linked) best = this._tighterSonar(best, this._sonarLoc(b.sonar, tgt, hit));
    }
    return best;
  }

  /** Ammo ids a unit can fire right now at `target` (range/type checked). */
  firableAmmo(u, target) {
    const out = [];
    for (const [id, n] of Object.entries(u.ammo)) {
      if (n <= 0) continue;
      const a = u.spec.ammoSpecs[id]; if (!a) continue;
      if (!this._ammoCanEngage(a, u, target)) continue;
      out.push({ id, spec: a, count: n });
    }
    return out;
  }

  _roleHits(role, target) {
    if (role === 'AAW') return target.kind === 'air' || target.kind === 'missile';
    if (role === 'ASuW') return target.kind === 'ship' || target.kind === 'land';
    if (role === 'ASW') return target.kind === 'sub';
    return false;
  }

  _ammoCanEngage(a, u, target) {
    if (a.type !== 'Missile' && a.type !== 'Projectile' && a.type !== 'Torpedo') return false;
    const primary = this._roleHits(a.target, target);
    const secondary = this._roleHits(a.secondary, target);
    if (!primary && !secondary) return false;
    if (a.type === 'Projectile' && a.cep > 0 && (target.kind === 'air' || target.kind === 'missile') && a.target !== 'AAW' && a.secondary !== 'AAW') return false;
    let maxNm = a.type === 'Projectile' && a.maxRangeM > 0 ? a.maxRangeM / NM : a.maxRangeNm;
    // CalculateHorizon caps a shell or a semi-active missile at the director's radar horizon.
    const horizonNm = this._launchHorizonNm(a, u, target);
    if (horizonNm > 0) maxNm = Math.min(maxNm, horizonNm);
    const air = target.kind === 'air' || target.kind === 'missile';
    let d = dist2(u, target) / NM;
    // AlignTurret caps an aircraft at DirectFireRange × 1.15 and compares the slant range.
    if (a.type === 'Projectile' && air) {
      const alt = (target.z || 0) - 8;
      maxNm = Math.min(maxNm, (this._directFireM(a, alt) * 1.15) / NM);
      d = Math.hypot(dist2(u, target), alt) / NM;
    }
    if (d < a.minRangeNm || d > maxNm) return false;
    if (!this._inRearAspect(u, target, a)) return false;
    const wpn = (u.spec?.weapons || []).find((w) => w.arcSet && (w.ammo || []).some((x) => x.id === a.id));
    return !wpn || this._inFiringArc(u, wpn.arcs, target);
  }

  /**
   * GunBallistics.DirectFireRangeUnity, in metres of horizontal range.
   * An authored MaxAARange replaces the 10° super-elevation search.
   */
  _directFireM(ammo, altM) {
    const maxM = ammo?.maxRangeM || 0;
    if (!(ammo?.grav > 0) || !(ammo?.muzzle > 0) || !(maxM > 0)) return 0;
    if (ammo.maxAaM > 0) return Math.min(ammo.maxAaM, maxM);
    const model = directFireModel(ammo);
    const limit = 10 * Math.PI / 180;
    const altU = altM / UNITY_M;
    const atMax = superElevation(model.v, model.g, model.k, model.maxU, altU);
    if (atMax >= 0 && atMax <= limit) return maxM;
    let lo = 0;
    let hi = model.maxU;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) * 0.5;
      const elev = superElevation(model.v, model.g, model.k, mid, altU);
      if (elev >= 0 && elev <= limit) lo = mid;
      else hi = mid;
    }
    return lo * UNITY_M;
  }

  /**
   * RelativeBearingInFiringArcs. An arc written 40,-40 wraps through the stern,
   * so the bow sector between those bearings is blocked. 0,0 is the whole circle.
   */
  _inFiringArc(u, arcs, target) {
    if (!arcs || arcs.length < 2) return true;
    const x = arcs[0], y = arcs[1];
    if (x === 0 && y === 0) return true;
    const rel = wrap180(bearing(u, target) - (u.heading || 0));
    if (x < y) return rel > x && rel < y;
    return rel <= y || rel >= x;
  }

  /**
   * The launcher's last associated sensor is the director that remains. Its mount height
   * and the target's VisibleAltitude are the two ends of getRadarHorizon. Active-radar
   * missiles are not in that path.
   */
  _launchHorizonNm(a, u, target) {
    const semi = a?.guidance === 2;
    const shell = a?.type === 'Projectile';
    if (!semi && !shell) return 0;
    const wpn = (u?.spec?.weapons || []).find((w) => (w.directors || []).length && (w.ammo || []).some((x) => x.id === a.id));
    if (!wpn) return 0;
    const idx = wpn.directors[wpn.directors.length - 1];
    const sensor = (u.spec.sensors || []).find((s) => s.idx === idx);
    if (!sensor) return 0;
    return radioHorizon(this._antennaM(u, sensor), this._visibleHeightM(target)) / NM;
  }

  /** ObjectBase.CeaseFire clears the attack order. Weapons already in flight are left alone. */
  ceaseFire(u, report = true) {
    if (!u || (u.kind !== 'ship' && u.kind !== 'sub' && u.kind !== 'air')) return false;
    u.targetId = null;
    u.engage = null;
    if (report) this.emit('order', { id: u.id, msg: `${u.name}: Cease fire, roger, out.` });
    return true;
  }

  /**
   * InputHandler cease-fire count. The first press in a real-time second stops the selected unit.
   * The second stops every ship still in its formation. The third also sends wingmen back to station.
   */
  noteCease(u, nowMs) {
    if (nowMs - (this._ceaseAt ?? -1e9) > 1000) { this._ceaseAt = nowMs; this._ceaseN = 0; }
    if (this._ceaseN === 0) {
      this.ceaseFire(u, true);
      this._ceaseN = 1;
      return 'unit';
    }
    if (this._ceaseN < 3 && u.formation && nowMs - this._ceaseAt < 1000) {
      const recall = this._ceaseN === 2;
      this.ceaseFormation(u, recall);
      this._ceaseN++;
      return recall ? 'recall' : 'formation';
    }
    return 'none';
  }

  ceaseFormation(u, recall) {
    const members = [...this.units.values()].filter((m) => m.formation && m.alive && m.team === u.team && (m.kind === 'ship' || m.kind === 'sub'));
    for (const m of members) {
      this.ceaseFire(m, false);
      if (recall && m.formation.index !== 0) {
        m.waypoints = [];
        m.wpIdx = 0;
        m.helm = false;
        m.rudderSet = 0;
        this.releaseVid(m);
      }
    }
    this.emit('order', { id: u.id, msg: recall ? 'Formation 1: All disengage and return!' : 'Formation 1: All Cease fire!' });
  }

  fire(u, ammoId, target, source = 'order') {
    if (!u.alive || !target?.alive || u.cooldown > 0) return false;
    // Weapons Hold blocks a direct order. Automatic release still follows canAutoEngage.
    if (source === 'order' && u.roe === 'hold') return false;
    if (source === 'auto' && !this.canAutoEngage(u, target)) return false;
    const a = u.spec.ammoSpecs[ammoId];
    if (!a || (u.ammo[ammoId] || 0) <= 0 || !this._ammoCanEngage(a, u, target)) return false;
    // A rotatable rail or tube accepts the order, then launches once it is aimed.
    if (source !== 'mount' && (a.type === 'Missile' || a.type === 'Torpedo')) {
      const aim = this._aimWeapon(u, a, target);
      const training = aim?.mountRot && !this._launcherReady(u, a, target, 0);
      if (training || this._sharedBlocks(u, aim)) return this._queueEngage(u, ammoId, target, 1, source);
    }
    const weapon = u.spec.weapons.find((w) => w.ammo.some((x) => x.id === ammoId));
    const interval = a.type === 'Projectile'
      ? 60 / Math.max(weapon?.fireRate || 20, 1)
      : this._launchInterval(u, a, weapon);
    // A gun mount slews at HorizontalDegreesPerSecond and does not fire until it is within 2°.
    if (a.type === 'Projectile' && weapon?.kind === 'Gun' && weapon.train > 0) {
      if (!this._queueGun(u, weapon, ammoId, target)) return false;
      u.cooldown = interval;
      if (target.threats) target.threats.add(u.id);
      return true;
    }
    // A semi-active round, or a shell that is not waiting on the mount, takes a director channel now.
    let director = null;
    if (weapon?.directors?.length && (a.guidance === 2 || a.type === 'Projectile')) {
      director = this._openDirector(u, weapon, target);
      if (!director) return false;
    }
    u.ammo[ammoId]--;
    u.cooldown = interval;
    if (a.type === 'Projectile') {
      const shell = this._fireShell(u, a, target);
      if (director) this._claimGuide(u, director, shell, target);
      const extra = Math.max(0, this._gunVolley(weapon) - 1);
      for (let i = 0; i < extra && (u.ammo[ammoId] || 0) > 0; i++) {
        u.ammo[ammoId]--;
        this._cloneShell(shell);
      }
    } else if (a.type === 'Torpedo') {
      this._launchTorpedo(u, a, target);
      this._stampShared(u, weapon);
    } else {
      const missile = this._launchMissile(u, a, target);
      if (director) this._claimGuide(u, director, missile, target);
      this._stampShared(u, weapon);
    }
    if (target.threats) target.threats.add(u.id);
    return true;
  }

  /** One engage task can hold several shots. The mount releases them after it is aimed. */
  _queueEngage(u, ammoId, target, count, source) {
    if (source === 'order' && u.roe === 'hold') return false;
    if (source === 'auto' && !this.canAutoEngage(u, target)) return false;
    const a = u.spec?.ammoSpecs?.[ammoId];
    if (!a || !this._ammoCanEngage(a, u, target)) return false;
    const same = u.engage?.left > 0 && u.engage.ammoId === ammoId && u.engage.targetId === target.id;
    if (u.engage?.left > 0 && !same) return false;
    const queued = same ? u.engage.left : 0;
    const add = Math.min(count, (u.ammo[ammoId] || 0) - queued);
    if (add <= 0) return false;
    if (!same) this._openEngage(u, ammoId, target, 0, source);
    u.engage.left += add;
    if (target.threats) target.threats.add(u.id);
    return true;
  }

  /** HandleEngageTasks opens one task. MaxReactiontime is a random wait before the mount trains. */
  _openEngage(u, ammoId, target, left, source) {
    const a = u.spec?.ammoSpecs?.[ammoId];
    const weapon = a ? this._aimWeapon(u, a, target) : null;
    const react = this._reactionDelay(weapon);
    u.engage = {
      ammoId, targetId: target.id, left, nextAt: this.t + Math.max(0, u.cooldown),
      aimedAt: this.t, readyAt: this.t + react, react, burst: 0, source,
    };
  }

  _reactionDelay(weapon) {
    const max = weapon?.maxReaction || 0;
    if (!(max > 0)) return 0;
    const roll = this._reactionRoll ? this._reactionRoll() : this.rng();
    return max * Math.min(1, Math.max(0, roll));
  }

  /** Player salvo. Missiles and torpedoes stay on one task so the launcher can pace them. */
  orderSalvo(u, ammoId, target, count = 1) {
    const a = u.spec?.ammoSpecs?.[ammoId];
    if (a?.type === 'Missile' || a?.type === 'Torpedo') {
      const prev = u.engage?.left > 0 && u.engage.ammoId === ammoId && u.engage.targetId === target.id ? u.engage.left : 0;
      if (!this._queueEngage(u, ammoId, target, count, 'order')) return 0;
      const accepted = u.engage.left - prev;
      this._releaseEngage(u);
      return accepted;
    }
    let n = 0;
    for (let i = 0; i < count; i++) { u.cooldown = 0; if (!this.fire(u, ammoId, target)) break; n++; }
    return n;
  }

  // ----------------------------------------------------------------- weapons --
  _launchPitch(u, a, target) {
    const wpn = (u.spec?.weapons || []).find((w) => w.containersRot && (w.ammo || []).some((x) => x.id === a.id));
    if (!wpn) return 0;
    const dist = Math.hypot((target.x || 0) - (u.x || 0), (target.y || 0) - (u.y || 0));
    const look = Math.atan2((target.z || 0) - (u.z || 0), Math.max(dist, 1)) * R2D;
    let pitch = look + (wpn.addLaunchDeg || 0);
    if (wpn.elevArc) {
      const lo = Math.min(wpn.elevArc[0], wpn.elevArc[1]);
      const hi = Math.max(wpn.elevArc[0], wpn.elevArc[1]);
      pitch = clamp(pitch, lo, hi);
    }
    return pitch;
  }

  _launchMissile(u, a, target) {
    const hdg = bearing(u, target);
    const m = {
      id: _uid++, kind: 'missile', spec: a, team: u.team, name: a.name, owner: u.id, targetId: target.id, alive: true, active: true,
      x: u.x, y: u.y, z: Math.max(u.z, 12), heading: hdg, pitch: this._launchPitch(u, a, target), speed: Math.max(0, u.speed || 0), age: 0, hp: 1, lastKnown: { x: target.x, y: target.y, z: target.z },
      intendedId: target.id, seekerAt: null, spoofed: false,
      rcs: a.rcs, spec_: a,
    };
    m.spec = { ...a, kind: 'missile', length: 4, beam: 0.4, rcs: a.rcs };
    this.units.set(m.id, m);
    this._noteBracket(u, a, target);
    this.emit('launch', { by: u.id, ammo: a.name, target: target.id, msg: `${u.name} launches ${a.name} at ${target.name}` });
    return m;
  }

  /**
   * BearingLaunchPrediction.TorpedoLaunchProfile: the fastest speed setting whose
   * range still covers 1.1× the aim distance, else the longest range.
   */
  _torpedoRunKt(a, aimNm) {
    const kts = a.speedKts || [];
    const ranges = a.speedRangesNm || [];
    if (!kts.length) return a.runKt || 40;
    const need = aimNm * 1.1;
    for (let i = kts.length - 1; i >= 0; i--) if ((ranges[i] ?? 0) >= need) return kts[i];
    let best = 0;
    for (let i = 1; i < ranges.length; i++) if (ranges[i] > ranges[best]) best = i;
    return kts[Math.min(best, kts.length - 1)];
  }

  /**
   * GetPassiveSonarEcho, then the seeker's hard 5 dB gate. Transmission loss is
   * 20·log10(nm·2025) plus 0.5 dB per mile. Both above the layer adds the 10 dB duct.
   * A cross-layer path loses 4 dB, the middle of the 2.5–5.5 dB layer penalty.
   */
  _seekerExcess(tp, tgt, a) {
    const distNm = dist3(tp, tgt) / NM;
    if (!(distNm > 1e-6)) return 80;
    const noise = tgt.spec?.noise;
    if (!noise || !(noise.base >= 0)) return -1000;
    const kt = Math.abs((tgt.speed || 0) / KT);
    let sl = noise.base + Math.max(0, kt - (noise.creep || 0)) * (noise.flow ?? 1);
    sl += (cavitationIntensity(tgt) || 0) * (noise.cav || 0);
    const ping = activePing(tgt, 2);
    if (ping && ping.sl > sl) sl = ping.sl;
    let ambient = oceanNoiseDB(this.weather?.sea || 0);
    if (this.weather?.rain) {
      const depth = Math.min(Math.max(0, -(tp.z || 0)), Math.max(0, -(tgt.z || 0)));
      const fade = 1.1339275 * UNITY_M;
      let rain = (1 - depth / fade) * 15;
      if (rain > 15) rain = 15;
      if (rain > 0) ambient += rain;
    }
    const tl = 20 * Math.log10(distNm * 2025) + distNm * 0.5;
    let signal = sl - ambient + (a.seekerGain || 0) - tl;
    const layerZ = -OPEN_OCEAN_LAYER_FT * FT;
    const aboveS = (tp.z || 0) > layerZ;
    const aboveT = (tgt.z || 0) > layerZ;
    if (aboveS !== aboveT) signal -= 4;
    else if (aboveS && aboveT) signal += 10;
    return signal;
  }

  /** PassiveSonarSeeker.searchForTarget. Inside the cone, and the echo must clear 5 dB. */
  _torpedoSees(tp, tgt, a) {
    if (!tgt?.alive) return false;
    if (dist3(tp, tgt) > (a.seekerNm || 1) * NM) return false;
    if (Math.abs(wrap180(bearing(tp, tgt) - tp.heading)) >= (a.seekerFov || 90) / 2) return false;
    return this._seekerExcess(tp, tgt, a) >= 5;
  }

  /** GetMinRunDepth. Wave height, and never shallower than 0.0227 Unity. */
  _minRunZ() {
    const sea = clamp(this.weather?.sea || 0, 0, WAVE_HEIGHTS.length - 1) | 0;
    let z = -WAVE_HEIGHTS[sea] * UNITY_M;
    const floor = -0.02267855 * UNITY_M;
    if (z > floor) z = floor;
    return z;
  }

  /**
   * TorpedoLaunchSettings. A real target is met on the far side of the layer, 30 ft across it.
   * Open ocean uses the 350 ft stand-in. The run is then kept inside 90% of maximum depth.
   */
  _torpedoCruiseZ(a, target) {
    const off = 0.1360713 * UNITY_M;
    const layerZ = -OPEN_OCEAN_LAYER_FT * FT;
    let hold = -(a.depthM || 100 * FT);
    if (target && target.kind !== 'missile' && target.kind !== 'torpedo') {
      const aimZ = target.z || 0;
      hold = aimZ > layerZ ? layerZ - off : layerZ + off;
    }
    if (a.maxDepthM > 0 && hold < -0.9 * a.maxDepthM) hold = -0.9 * a.maxDepthM;
    const minZ = this._minRunZ();
    if ((a.guidance || 0) === 0 || hold > minZ) hold = minZ;
    if (target?.kind === 'sub' && (target.z || 0) < -1 && hold > -off) hold = -off;
    return hold;
  }

  /** Search depth is the datum depth. Unguided, wake, and a shot at the surface stop at minimum run depth. */
  _torpedoSearchZ(a, target) {
    let z = target?.z || 0;
    const minZ = this._minRunZ();
    const g = a.guidance || 0;
    if (g === 0 || g === 9 || z > minZ) z = minZ;
    return z;
  }

  /** setHeight. Look 1.1 Unity ahead, pitch at most 60°, and slew the nose at the turn rate. */
  _torpedoPitch(tp, a, wantZ, dt, maxAngle = 60) {
    const look = 1.1 * UNITY_M;
    const old = tp.pitch || 0;
    const horiz = Math.max(0.01 * UNITY_M, Math.abs((tp.speed || 0) * Math.cos(old * D2R)));
    const predict = tp.z + Math.sin(old * D2R) * (tp.speed || 0) * (look / horiz);
    const err = wantZ - predict;
    let desired = old + Math.atan2(err, look) * R2D;
    if (desired > maxAngle) desired = maxAngle;
    if (desired < -maxAngle) desired = -maxAngle;
    const turn = Math.max(a.turnRate || 10, 0.1);
    const targetRate = clamp((desired - old) * 5, -turn, turn);
    const accel = turn * 8 * dt;
    tp.pitchRate = (tp.pitchRate || 0) + clamp(targetRate - (tp.pitchRate || 0), -accel, accel);
    tp.pitch = old + tp.pitchRate * dt;
    return Math.abs(err) < 0.01 * UNITY_M && Math.abs(old) < 5;
  }

  /** Acoustic torpedo. Runs straight at the datum, then snakes, circles, or spirals until the seeker acquires. */
  _launchTorpedo(u, a, target) {
    const opening = dist2(u, target);
    const tubes = u.kind === 'air' ? [] : (u.spec?.weapons || []).filter((w) => w.tubeDeg != null && (w.ammo || []).some((x) => x.id === a.id));
    let hdg = bearing(u, target);
    if (tubes.length) {
      const rel = wrap180(hdg - (u.heading || 0));
      let tube = tubes[0], gap = Infinity;
      for (const w of tubes) {
        const d = Math.abs(wrap180(w.tubeDeg - rel));
        if (d < gap) { gap = d; tube = w; }
      }
      hdg = wrap360((u.heading || 0) + tube.tubeDeg);
    }
    const airDrop = u.kind === 'air' && u.z > 0;
    // AboveWaterLaunch. A surface shot leaves at 60 knots and sinks in. A deep tube is already under.
    const surface = !airDrop && (u.z || 0) > -1;
    const shipV = hdgVec(u.heading || 0);
    const transitKt = this._torpedoRunKt(a, opening / NM);
    const tp = {
      id: _uid++, kind: 'torpedo', spec: a, team: u.team, name: a.name, owner: u.id, targetId: target.id, alive: true, active: true,
      x: u.x, y: u.y, z: airDrop ? u.z : (surface ? (u.z || 0) : Math.min(u.z, -5)), heading: hdg,
      speed: (surface ? 60 : transitKt) * KT, transitKt, age: 0, run: 0, hp: 1,
      airborne: airDrop, chute: false, entry: surface, pitch: 0, sinkKt: 0,
      shipVx: surface ? shipV.x * (u.speed || 0) : 0, shipVy: surface ? shipV.y * (u.speed || 0) : 0,
      vx: airDrop ? Math.sin((u.heading || 0) * D2R) * u.speed : 0, vy: airDrop ? Math.cos((u.heading || 0) * D2R) * u.speed : 0, vz: 0,
      aim: { x: target.x, y: target.y, z: target.z }, lastKnown: { x: target.x, y: target.y, z: target.z },
      cruiseZ: this._torpedoCruiseZ(a, target), searchZ: this._torpedoSearchZ(a, target), pitchRate: 0,
      armAt: opening * (a.seekerFrac || 0), spoofed: false, reached: false, searching: false,
      homing: false, reattack: false, holdZ: null,
      searchHdg: hdg, circle: 0, straight: 0, snakeT: 0, spiralDown: true, spec_: a,
    };
    tp.spec = { ...a, kind: 'torpedo', length: 3, beam: 0.3, rcs: 0.05 };
    this.units.set(tp.id, tp);
    this._noteBracket(u, a, target);
    this.emit('launch', { by: u.id, ammo: a.name, target: target.id, msg: `${u.name} launches ${a.name} at ${target.name}` });
    return tp;
  }

  _stepTorpedo(tp, dt) {
    const a = tp.spec_;
    tp.age += dt;
    if (tp.entry && (tp.searching || tp.homing)) tp.entry = false;
    if (tp.entry) {
      // 60 knots out of the tube. After 0.3 s the sink builds by 0.2 knots each 1/60 s
      // fixed step, 12 knots per second, up to 20. The nose drops toward 20° at 10°/s.
      const spd = 60 * KT;
      tp.speed = spd;
      tp.pitch = (tp.pitch || 0) + clamp(-20 - (tp.pitch || 0), -10 * dt, 10 * dt);
      if (tp.age > 0.3) {
        const span = Math.min(dt, tp.age - 0.3);
        tp.sinkKt = Math.min(20, (tp.sinkKt || 0) + 12 * span);
      }
      const rad = (tp.pitch || 0) * D2R;
      const dir = hdgVec(tp.heading);
      tp.x += dir.x * Math.cos(rad) * spd * dt;
      tp.y += dir.y * Math.cos(rad) * spd * dt;
      tp.z += Math.sin(rad) * spd * dt - (tp.sinkKt || 0) * KT * dt;
      if (tp.age < 1) {
        tp.x += (tp.shipVx || 0) * (1 - tp.age) * dt;
        tp.y += (tp.shipVy || 0) * (1 - tp.age) * dt;
      }
      const unityM = 1852 / 27.559496;
      if ((tp.z < 0 && tp.age > 1) || tp.z < -0.453 * unityM) {
        tp.entry = false;
        tp.speed = (tp.transitKt || this._torpedoRunKt(a, dist2(tp, tp.aim) / NM)) * KT;
      }
      return;
    }
    if (tp.airborne) {
      // performTorpedoParachuteDropping: gravity, then chute damping toward ParachuteEndVelocity.
      tp.vz -= 9.81 * dt;
      if (tp.age > 0.5) tp.chute = true;
      let { vx, vy, vz } = tp;
      const end = (a.chuteKt || 100) * KT;
      if (tp.chute && Math.hypot(vx, vy, vz) > end) {
        const damp = Math.pow(a.chuteSlow || 0.985, dt / (1 / 60));
        vx *= damp; vy *= damp; vz *= damp;
      }
      const sp = Math.hypot(vx, vy, vz);
      if (tp.chute && Math.abs(sp / KT - (a.chuteKt || 100)) < 15 && sp > 1) {
        const scale = end / sp;
        vx *= scale; vy *= scale; vz *= scale;
      }
      tp.vx = vx; tp.vy = vy; tp.vz = vz;
      tp.x += vx * dt; tp.y += vy * dt; tp.z += vz * dt;
      // The drop state ends once the body is 0.05 Unity under the surface.
      if (tp.z < -0.05 * (1852 / 27.559496)) {
        tp.airborne = false;
        tp.z = Math.min(tp.z, -3.4);
        const horiz = Math.hypot(tp.vx, tp.vy);
        if (horiz > 1) tp.heading = wrap360(Math.atan2(tp.vx, tp.vy) * R2D);
        tp.speed = this._torpedoRunKt(a, dist2(tp, tp.aim) / NM) * KT;
      }
      return;
    }
    const tgt = this.units.get(tp.targetId);
    const datum = tp.aim || tp.lastKnown;
    const mode = a.searchMode || 0;
    // ShouldEnterTorpedoSearch: inside half a mile of the datum, or the datum is already in the seeker cone.
    // EnterSearchMode then runs at maximum speed until setHeight says the torpedo is level on the search depth.
    if (!tp.reached && datum) {
      const toAim = dist2(tp, datum);
      const aimInFov = Math.abs(wrap180(bearing(tp, datum) - tp.heading)) < (a.seekerFov || 90) / 2;
      if (toAim < 0.5 * NM || (toAim <= (a.seekerNm || 1) * NM && aimInFov)) {
        tp.reached = true;
        tp.searchHdg = tp.heading;
      }
    }
    const searchDepth = -(a.depthM || 30);
    const levelZ = tp.searchZ != null ? tp.searchZ : searchDepth;
    const onDepth = Math.abs(tp.z - levelZ) < 0.67 && Math.abs(tp.pitch || 0) < 5;
    if (tp.reached && onDepth && !tp.searching) {
      tp.searching = true;
      tp.circle = 0;
      tp.straight = 0;
      tp.snakeT = 0;
    }
    // The seeker powers up when EnterSearchMode exits. A noisemaker can seduce it from then on.
    if (tp.spoofed && tp._decoy?.on) tp.lastKnown = { x: tp._decoy.x, y: tp._decoy.y, z: tp.z };
    if (tp.searching && !tp.spoofed && (a.guidance === 7 || a.guidance === 8 || a.guidance === 10)) {
      for (const ship of this.units.values()) {
        if (!ship.alive || ship.team === tp.team) continue;
        for (const d of ship.decoy || []) {
          if (!d.on) continue;
          if (dist3(tp, d) > (a.seekerNm || 1) * NM) continue;
          if (Math.abs(wrap180(bearing(tp, d) - tp.heading)) >= (a.seekerFov || 90) / 2) continue;
          // Missing anti-countermeasure is 0. The missile roll treats a missing value as immune.
          if (a.antiChaff == null) tp.spec_ = { ...a, antiChaff: 0 };
          if (this._chaffRoll(tp, d)) {
            tp.spoofed = true;
            tp._decoy = d;
            tp.targetId = 0;
            tp.lastKnown = { x: d.x, y: d.y, z: tp.z };
            this.emit('noise', { msg: `${tp.name} seduced by noisemaker` });
          }
          break;
        }
        if (tp.spoofed) break;
      }
      for (const c of tp.spoofed ? [] : this.clouds) {
        if (c.kind !== 'noise' || c.left <= 0 || c.team === tp.team || dist2(tp, c) > c.r) continue;
        if (this.rng() < Math.min(1, c.spoof || 0)) {
          tp.spoofed = true;
          tp.targetId = 0;
          tp.lastKnown = { x: c.x, y: c.y, z: tp.z };
          this.emit('noise', { msg: `${tp.name} seduced by noisemaker` });
        }
        break;
      }
    }
    const sees = tp.searching && !tp.spoofed && (a.guidance === 7 || a.guidance === 8 || a.guidance === 10) && this._torpedoSees(tp, tgt, a);
    // A dropped echo is kept for 2 s. After that, losing it inside 10° of the datum
    // holds the last heading; beyond that, Reattack circles until the seeker acquires again.
    if (sees) { tp.homing = true; tp.reattack = false; tp.seenAt = tp.age; }
    const memory = !sees && tp.homing && !tp.spoofed && !tp.reattack && tp.seenAt != null && tp.age - tp.seenAt < 2;
    if (!sees && !memory && tp.homing && !tp.spoofed && !tp.reattack) {
      const yaw = datum ? Math.abs(wrap180(bearing(tp, datum) - tp.heading)) : 180;
      if (yaw > 10) { tp.reattack = true; tp.holdZ = tp.z; }
    }
    const phase = tp.spoofed ? 'spoof'
      : !tp.searching ? (tp.reached ? 'settle' : 'runin')
      : (sees || memory) ? 'terminal'
      : tp.reattack ? 'reattack'
      : (tp.homing || mode === 0) ? 'coast' : 'search';
    if (sees && tgt?.alive) tp.lastKnown = { x: tgt.x, y: tgt.y, z: tgt.z };
    if (phase === 'spoof') {
      tp.heading = bearing(tp, tp.lastKnown);
      tp.speed = (a.runKt || 40) * KT;
    } else if (phase === 'runin') {
      if (datum) {
        const want = bearing(tp, datum);
        const max = (a.turnRate || 10) * dt;
        tp.heading = wrap360(tp.heading + clamp(wrap180(want - tp.heading), -max, max));
      }
    } else if (phase === 'settle') {
      tp.speed = (a.maxKt || a.runKt || 40) * KT;
    } else if (phase === 'search' && mode === 1) {
      tp.speed = (a.searchKt || a.runKt || 40) * KT;
      tp.snakeT += dt;
      const ang = (a.snakeDeg ?? 30) * Math.sin(Math.PI * 2 * tp.snakeT / (a.snakeCycle || 6));
      tp.heading = wrap360(tp.searchHdg + ang);
    } else if (phase === 'search' && mode === 2) {
      tp.speed = (a.searchKt || a.runKt || 40) * KT;
      if (tp.straight > 0) tp.straight = Math.max(0, tp.straight - dt);
      else {
        tp.circle += (a.circleDps || 5) * dt;
        if (tp.circle >= 360) { tp.circle -= 360; tp.straight = a.circleStraight ?? 5; }
      }
      tp.heading = wrap360(tp.searchHdg + (tp.straight > 0 ? 0 : tp.circle));
    } else if (phase === 'search' && mode === 3) {
      tp.speed = (a.searchKt || a.runKt || 40) * KT;
      const rate = Math.min(a.turnRate || 10, 0.015915507 * tp.speed / KT / (a.spiralRadiusNm || 0.25));
      tp.heading = wrap360(tp.heading + rate * dt);
    } else if (phase === 'reattack') {
      tp.speed = ((a.reattackMode === 1 ? a.searchKt : a.maxKt) || a.runKt || 40) * KT;
      if (a.reattackMode === 1) tp.heading = wrap360(tp.heading + (a.reattackDps ?? 10) * dt);
    } else if (phase === 'terminal') {
      const want = bearing(tp, tp.lastKnown);
      const max = (a.turnRate || 10) * dt;
      tp.heading = wrap360(tp.heading + clamp(wrap180(want - tp.heading), -max, max));
      tp.speed = (a.runKt || 40) * KT;
    } else tp.speed = (a.runKt || 40) * KT;
    const step = tp.speed * dt;
    tp.run += step;
    if (tp.run > a.maxRangeNm * NM) { tp.alive = false; return; }
    const v = hdgVec(tp.heading);
    let wantZ = tp.cruiseZ != null ? tp.cruiseZ : searchDepth;
    let pitched = phase === 'runin' || phase === 'settle' || phase === 'search' || phase === 'terminal';
    let dive = 30;
    if (phase === 'reattack') { wantZ = tp.holdZ ?? tp.z; pitched = false; }
    else if (phase === 'coast' || phase === 'spoof') { wantZ = tp.z; pitched = false; }
    else if (phase === 'search' && mode === 3) {
      pitched = false;
      const ceil = a.spiralCeilM || Math.abs(searchDepth);
      const floor = a.spiralFloorM || Math.abs(searchDepth);
      wantZ = -(tp.spiralDown ? floor : ceil);
      dive = Math.max(1, Math.abs(tp.speed * Math.sin((a.spiralDeg || 6) * D2R)));
      if (Math.abs(tp.z - wantZ) < 8) tp.spiralDown = !tp.spiralDown;
    } else if (phase === 'terminal' && tgt?.alive) {
      const live = tgt.z < -2 ? tgt.z : (tp.searchZ ?? tgt.z);
      wantZ = live > this._minRunZ() ? this._minRunZ() : live;
    } else if (phase === 'settle' || phase === 'search') wantZ = tp.searchZ != null ? tp.searchZ : (tp.aim?.z ?? searchDepth);
    if (pitched) {
      // The nose rate is per 1/60 s fixed step. A long sim step is split so it cannot tumble past the dive.
      let left = dt;
      while (left > 1e-4) {
        const h = Math.min(left, 1 / 60);
        const close = this._torpedoPitch(tp, a, wantZ, h);
        const rad = (tp.pitch || 0) * D2R;
        if (close) {
          tp.z = smoothToward(tp.z, wantZ, 3 * h);
          tp.pitch = smoothToward(tp.pitch || 0, 0, 3 * h);
          tp.pitchRate = 0;
          tp.x += v.x * tp.speed * h;
          tp.y += v.y * tp.speed * h;
        } else {
          tp.x += v.x * Math.cos(rad) * tp.speed * h;
          tp.y += v.y * Math.cos(rad) * tp.speed * h;
          tp.z += Math.sin(rad) * tp.speed * h;
        }
        left -= h;
        if (tgt?.alive && !tp.spoofed && dist3(tp, tgt) < 40) {
          this._damage(tgt, a.power || 27, tp);
          tp.alive = false;
          this.emit('hit', { msg: `${tp.name} hits ${tgt.name}` });
          return;
        }
        if (tp.spoofed && dist2(tp, tp.lastKnown) < 40) {
          tp.alive = false;
          this.emit('hit', { msg: `${tp.name} attacks the noisemaker` });
          return;
        }
      }
    } else {
      tp.x += v.x * step; tp.y += v.y * step;
      tp.z += clamp(wantZ - tp.z, -dive * dt, dive * dt);
    }
    if (tgt?.alive && !tp.spoofed && dist3(tp, tgt) < 40) {
      this._damage(tgt, a.power || 27, tp);
      tp.alive = false;
      this.emit('hit', { msg: `${tp.name} hits ${tgt.name}` });
      return;
    }
    if (tp.spoofed && dist2(tp, tp.lastKnown) < 40) {
      tp.alive = false;
      this.emit('hit', { msg: `${tp.name} attacks the noisemaker` });
    }
  }

  /** Ready rack. RoundsMax falls back to RoundsLoaded; 0 means the magazine feeds the gun directly. */
  _gunRack(u, weapon, ammoId) {
    if (!u.racks) u.racks = {};
    let rack = u.racks[weapon.idx];
    if (!rack) {
      const have = u.ammo[ammoId] || 0;
      rack = u.racks[weapon.idx] = { cap: weapon.ready, ready: Math.min(weapon.ready, have), reload: 0, ammoId };
    }
    return rack;
  }

  /** FinishReload once ReloadTime has passed and nothing is asking the mount to fire. */
  _tickGunRacks(u, dt) {
    for (const rack of Object.values(u.racks || {})) {
      if (rack.reload <= 0) continue;
      rack.reload -= dt;
      if (rack.reload <= 0) {
        rack.reload = 0;
        rack.ready = Math.min(rack.cap, u.ammo[rack.ammoId] || 0);
      }
    }
  }

  /** One mount, one target. Extra clicks add rounds; a new target replaces the old order. */
  _queueGun(u, weapon, ammoId, target) {
    if (!u.guns) u.guns = [];
    const queued = u.guns.filter((g) => g.ammoId === ammoId).reduce((n, g) => n + g.left, 0);
    const volley = this._gunVolley(weapon);
    const add = Math.min(volley, (u.ammo[ammoId] || 0) - queued);
    if (add <= 0) return false;
    u.guns = u.guns.filter((g) => g.idx !== weapon.idx || g.targetId === target.id);
    let job = u.guns.find((g) => g.idx === weapon.idx && g.ammoId === ammoId);
    if (!job) {
      const react = this._reactionDelay(weapon);
      const clock = u.gunClock?.[weapon.idx];
      const cool = clock ? Math.max(0, clock.nextAt - this.t) : 0;
      job = { idx: weapon.idx, ammoId, targetId: target.id, left: 0, cool, shotN: clock?.shotN || 0, react, readyAt: this.t + react };
      u.guns.push(job);
    }
    job.left += add;
    job.targetId = target.id;
    return true;
  }

  /** WeaponSystemGun.OnUpdate: a sail-under submarine, or any target below 0.136 Unity. */
  _gunTargetUnder(target) {
    const depth = -(target.z || 0);
    if (!(depth > 0)) return false;
    if (target.kind === 'sub' && this._submerged(target)) return true;
    return depth > 0.1360713 * UNITY_M;
  }

  /**
   * RotateMountTowardsTarget. Local bearing 0 is the ship's bow. The mount slews at
   * HorizontalDegreesPerSecond and the first round waits until the error is inside 2°.
   */
  _stepGuns(u, dt) {
    if (!u.guns?.length) return;
    if (!u.mounts) u.mounts = {};
    let leftT = dt;
    for (const job of u.guns) {
      const weapon = (u.spec.weapons || []).find((w) => w.idx === job.idx);
      const target = this.units.get(job.targetId);
      const ammo = u.spec.ammoSpecs?.[job.ammoId];
      // OnUpdate ends the engage when the target is a submerged submarine or deeper than
      // 0.136 Unity (about 9.1 m). An ordered attack sets ignore-if-undetected, so a lost
      // radar contact does not, by itself, stop a gun that was told to fire.
      if (target && this._gunTargetUnder(target)) job.left = 0;
      if (!weapon || !ammo || !target?.alive || job.left <= 0 || !this._ammoCanEngage(ammo, u, target)) {
        job.left = 0;
        continue;
      }
      // AlignTurret pulls GameTime down to Globals._gunsTCLimit once the target is in range.
      this._capGunTime();
      const born = new Set();
      const rate = weapon.train || 0;
      if (u.mounts[job.idx] == null) u.mounts[job.idx] = 0;
      if (!u.elev) u.elev = {};
      if (u.elev[job.idx] == null) u.elev[job.idx] = 0;
      let remain = leftT;
      const spend = (use) => {
        if (!(use > 0)) return;
        this._flyBorn(born, use);
        remain -= use;
      };
      while (job.left > 0 && remain >= 0) {
        // OnUpdate does not aim the barrels until the random MaxReactiontime has elapsed.
        if ((job.react || 0) > 0) {
          const wait = job.readyAt - (this.t - remain);
          if (wait > 1e-6) {
            const use = Math.min(remain, wait);
            if (!(use > 1e-6)) break;
            spend(use);
            if (remain <= 1e-6) break;
            continue;
          }
        }
        // Bearing and elevation slew together. The round waits for 2° of bearing and 0.2° of elevation.
        const want = wrap180(bearing(u, target) - (u.heading || 0));
        const err = wrap180(want - u.mounts[job.idx]);
        const elev = (weapon.elevRate || 0) > 0 ? this._gunElev(u, weapon, ammo, target) : null;
        const elErr = elev ? elev.want - u.elev[job.idx] : 0;
        const brgNeed = Math.abs(err) > 2 ? (Math.abs(err) - 2) / Math.max(rate, 0.01) : 0;
        const elNeed = elev && Math.abs(elErr) > 0.2 ? (Math.abs(elErr) - 0.2) / weapon.elevRate : 0;
        if (brgNeed > 0 || elNeed > 0) {
          const need = Math.min(brgNeed > 0 ? brgNeed : Infinity, elNeed > 0 ? elNeed : Infinity);
          // A leftover smaller than the float step would spin forever with use === 0.
          if (!(need > 1e-4)) {
            if (Math.abs(err) > 2) u.mounts[job.idx] = wrap180(want - Math.sign(err || 1) * 2);
            if (elev && Math.abs(elErr) > 0.2) u.elev[job.idx] = elev.want - Math.sign(elErr || 1) * 0.2;
          } else {
            const use = Math.min(remain, need);
            if (!(use > 1e-6)) break;
            if (brgNeed > 0) u.mounts[job.idx] = wrap180(u.mounts[job.idx] + Math.sign(err || 1) * Math.max(rate, 0.01) * use);
            if (elNeed > 0) u.elev[job.idx] += Math.sign(elErr) * weapon.elevRate * use;
            spend(use);
            if (remain <= 1e-6) break;
            continue;
          }
        }
        if (elev) u.elev[job.idx] = elev.want;
        // NeedsSpottingFire. A director that does not track the shell waits out its flight before the next round.
        if (job.spot > 0) {
          if (this._needsSpot(u, weapon, ammo, target)) {
            const use = Math.min(remain, job.spot);
            job.spot -= use;
            job.cool = Math.max(0, (job.cool || 0) - use);
            spend(use);
            if (job.spot > 1e-4) break;
            continue;
          }
          job.spot = 0;
        }
        if (job.cool > 0) {
          const use = Math.min(remain, job.cool);
          job.cool -= use;
          spend(use);
          if (job.cool > 1e-6) break;
          continue;
        }
        if ((u.ammo[job.ammoId] || 0) <= 0) { job.left = 0; break; }
        const rack = weapon.ready > 0 ? this._gunRack(u, weapon, job.ammoId) : null;
        if (rack && rack.reload > 0) {
          const use = Math.min(remain, rack.reload);
          rack.reload -= use;
          spend(use);
          if (rack.reload > 1e-4) break;
          rack.ready = Math.min(rack.cap, u.ammo[job.ammoId] || 0);
          continue;
        }
        if (rack && rack.ready < 1) {
          if ((u.ammo[job.ammoId] || 0) > 0) { rack.reload = weapon.reloadS > 0 ? weapon.reloadS : 60; continue; }
          job.left = 0;
          break;
        }
        // The shell occupies a director until it splashes. A full set waits for the next impact.
        const director = weapon.directors?.length ? this._openDirector(u, weapon, target) : null;
        if (weapon.directors?.length && !director) {
          let wait = Infinity;
          for (const id of born) {
            const s = this.units.get(id);
            if (s?.alive) wait = Math.min(wait, Math.max(0, s.tof - s.age));
          }
          if (!(wait < Infinity)) break;
          const aliveBefore = [...born].filter((id) => this.units.get(id)?.alive).length;
          const use = Math.min(remain, wait);
          this._flyBorn(born, use);
          remain -= use;
          const aliveAfter = [...born].filter((id) => this.units.get(id)?.alive).length;
          if (aliveAfter >= aliveBefore && !(use > 0)) break;
          if (remain <= 1e-6) break;
          continue;
        }
        const have = u.ammo[job.ammoId] || 0;
        const room = rack ? Math.min(have, rack.ready) : have;
        const n = Math.min(this._gunVolley(weapon), job.left, room);
        if (n < 1) { job.left = 0; break; }
        let shell = null;
        for (let i = 0; i < n; i++) {
          u.ammo[job.ammoId]--;
          job.left--;
          if (rack) {
            rack.ready--;
            if (rack.ready < 1 && (u.ammo[job.ammoId] || 0) > 0) rack.reload = weapon.reloadS > 0 ? weapon.reloadS : 60;
          }
          const shot = shell ? this._cloneShell(shell) : this._fireShell(u, ammo, target);
          if (i === 0 && director) this._claimGuide(u, director, shot, target);
          born.add(shot.id);
          shell = shot;
        }
        const paced = this._gunBurstGap(weapon, (job.shotN || 0) + 1);
        job.shotN = paced.shotN;
        job.cool = paced.gap;
        job.spot = shell.tof;
        // fire() stamps _fireTime on the gun, so the next order still waits out this cycle.
        if (!u.gunClock) u.gunClock = {};
        u.gunClock[weapon.idx] = { nextAt: this.t - remain + paced.gap, shotN: paced.shotN };
      }
    }
    u.guns = u.guns.filter((g) => g.left > 0);
  }

  /**
   * A mount with several barrels fires all of them on one cycle, and they share one solution.
   * FireSequential walks the barrels one per cycle instead.
   */
  _gunVolley(weapon) {
    const n = weapon?.guns || 1;
    if (n <= 1 || weapon?.sequential) return 1;
    return n;
  }

  /** The other barrels of a simultaneous mount leave on the same solution vector. */
  _cloneShell(shell) {
    const s = { ...shell, id: _uid++, impact: { ...shell.impact }, age: 0 };
    delete s.guide;
    this.units.set(s.id, s);
    return s;
  }

  /**
   * BurstCount above 1. The gap inside the burst is the one that makes FireRate the average
   * once BurstDelay is included. A non-positive gap means the authored pause is too long, so the burst is dropped.
   */
  _gunBurstGap(weapon, shotN) {
    const n = weapon?.burstN || 0;
    const rate = Math.max(weapon?.fireRate || 20, 1);
    const plain = 60 / rate;
    if (n <= 1) return { gap: plain, shotN: 0 };
    const pause = weapon.burstDelay != null ? weapon.burstDelay : 1;
    const intra = (60 * n - rate * pause) / (rate * (n - 1));
    if (!(intra > 0)) return { gap: plain, shotN: 0 };
    if (shotN >= n) return { gap: pause, shotN: 0 };
    return { gap: intra, shotN };
  }

  /**
   * AlignTurret's elevation. A surface round uses the low ballistic angle, ½ asin(g R / v²).
   * An aircraft uses the line of sight. ElevationArc clamps the barrel; it does not forbid the shot.
   */
  _gunElev(u, weapon, ammo, target) {
    const range = Math.max(dist2(u, target), 1);
    const dz = (target.z || 0) - 8;
    let raw;
    if (Math.abs(dz) < 30) {
      const g = 9.81 * (ammo.grav > 0 ? ammo.grav : 1);
      const v = Math.max(ammo.muzzle || 100, 1);
      raw = 0.5 * Math.asin(clamp((g * range) / (v * v), -1, 1)) * R2D;
    } else raw = Math.atan2(dz, range) * R2D;
    const arc = weapon.elevArc;
    const want = arc ? clamp(raw, arc[0], arc[1]) : raw;
    return { raw, want };
  }

  _fireShell(u, a, target) {
    const range = dist2(u, target);
    const tof = range / Math.max(a.muzzle, 100);
    const lead = target.speed * tof; // lead along current heading
    const hv = hdgVec(target.heading ?? 0);
    const aim = { x: target.x + hv.x * lead, y: target.y + hv.y * lead };
    // GunBallistics.GetPatternSigmas: cross-range error is range × (CEP/1.792)/maxRange.
    // Along-range error is twice that scale at max range, and both grow with distance.
    const maxR = Math.max(a.maxRangeM, 1);
    const atMax = (a.cep || 0) / 1.792;
    const jitter = Math.min(0.02, Math.max(0.0001, atMax / maxR));
    const sigmaDefl = range * jitter;
    const sigmaAlong = 2 * atMax * (range / maxR);
    const los = hdgVec(bearing(u, aim));
    const side = { x: los.y, y: -los.x };
    const alongG = this._gauss();
    const deflG = this._gauss();
    const pattern = { x: los.x * alongG * sigmaAlong + side.x * deflG * sigmaDefl, y: los.y * alongG * sigmaAlong + side.y * deflG * sigmaDefl };
    // DeviationCheck. A surface round uses the naval solution. An aircraft uses BuildAaErrorBudget.
    const weapon = (u.spec?.weapons || []).find((w) => (w.ammo || []).some((x) => x.id === a.id));
    const air = target.kind === 'air' || target.kind === 'missile';
    const fc = air ? null : this._gunFc(u, weapon, a, target, range);
    const aa = air ? this._gunAa(u, weapon, a, target, range) : null;
    const off = fc?.offset || aa || { x: 0, y: 0, z: 0 };
    const impact = { x: aim.x + pattern.x + off.x, y: aim.y + pattern.y + off.y };
    if (air) impact.z = (target.z || 0) + (off.z || 0);
    const s = { id: _uid++, kind: 'shell', spec: { kind: 'shell', length: 1, beam: 0.2, rcs: 0 }, team: u.team, alive: true, active: true, name: a.name, x: u.x, y: u.y, z: 8, heading: bearing(u, aim), speed: a.muzzle, tof, age: 0, impact, shot: a, dmgMult: weapon?.dmgMult || 1, targetId: target.id, owner: u.id, hp: 1, fcKey: fc?.key || '', naval: !!fc, fcMiss: Math.hypot(off.x, off.y, off.z || 0) + Math.hypot(pattern.x, pattern.y), spotAt: tof * (fc?.tracks ? 0.5 : 1), spotted: false };
    this.units.set(s.id, s);
    return s;
  }

  /**
   * HasFreeGuidingSensors walks AssociatedSensors in order. A radar guides this shot when it is
   * on, CanGuideAmmo, and still has a free weapon channel. A search set follows the search switch.
   * A targeting set does not. The same target may share a director; a new target needs a free target channel.
   */
  _openDirector(u, weapon, target) {
    for (const i of weapon?.directors || []) {
      const s = (u.spec?.sensors || []).find((sen) => sen.idx === i);
      if (!s || s.kind !== 'Radar' || !(s.weaponChannels > 0) || !(s.targetChannels > 0)) continue;
      if (!s.illuminator && !this._radarSwitch(u, s)) continue;
      const held = this._guideHeld(u, s.idx);
      if (held.length >= s.weaponChannels) continue;
      const targets = new Set(held.map((h) => h.targetId));
      if (!targets.has(target.id) && targets.size >= s.targetChannels) continue;
      return s;
    }
    return null;
  }

  _guideHeld(u, idx) {
    if (!u.guides) u.guides = {};
    const list = (u.guides[idx] || []).filter((h) => this.units.get(h.id)?.alive);
    u.guides[idx] = list;
    return list;
  }

  _claimGuide(u, sensor, body, target) {
    this._guideHeld(u, sensor.idx).push({ id: body.id, targetId: target.id });
    body.guide = sensor.idx;
  }

  _releaseGuide(body) {
    if (body?.guide == null) return;
    const owner = this.units.get(body.owner);
    const list = owner?.guides?.[body.guide];
    if (list) {
      const at = list.findIndex((h) => h.id === body.id);
      if (at >= 0) list.splice(at, 1);
    }
    body.guide = undefined;
  }

  /**
   * NeedsSpottingFire. Naval guns only. A live director that tracks its own shells,
   * or a solution already at 0.95, fires straight through. Otherwise the range error
   * has to beat one and a half times the pattern before the mount waits for the splash.
   */
  _needsSpot(u, weapon, ammo, target) {
    if (!target || target.kind === 'air' || target.kind === 'missile') return false;
    const sensors = u.spec?.sensors || [];
    const tracks = (weapon?.directors || []).some((i) => {
      const s = sensors.find((sen) => sen.idx === i);
      if (!s?.fcTracks) return false;
      if (s.kind === 'Radar' && !s.illuminator && !this._radarSwitch(u, s)) return false;
      return true;
    });
    if (tracks) return false;
    const sol = u._fc?.[`${weapon?.idx || 0}:${target.id || 0}`]?.solution || 0;
    if (sol >= 0.95) return false;
    const profile = this._fcProfile(this._bestDirector(u, weapon));
    const range = dist2(u, target);
    const dark = profile.radar ? 1 : (1 + 2 * (1 - clamp(this.weather?.sun ?? 1, 0, 1)));
    const gain = Math.max(profile.gain, 0.01);
    const tof = range / Math.max(0.6 * (ammo.muzzle || 100), 0.001);
    const rangeSigma = Math.max(0.5952375 * UNITY_M, range * 0.015) / Math.max(gain * gain, 0.1) * dark * (1 - 0.7 * sol);
    const pred = (1 - sol) * (target.speed || 0) * tof * 0.5;
    const pattern = ((ammo.cep || 0) * range) / Math.max(ammo.maxRangeM, 1);
    return (rangeSigma + pred) > 1.5 * (pattern + pattern);
  }

  /** Globals._gunsTCLimit. The player's compression stays at 30 until they raise it again. */
  _capGunTime() {
    this.gunTc = true;
    if ((this.timeScale || 1) > 30) this.timeScale = 30;
  }

  /** Shells born inside this gun step are not in the frame snapshot, so the mount's own clock flies them. */
  _flyBorn(born, dt) {
    for (const id of born) {
      const s = this.units.get(id);
      if (s?.alive && s.kind === 'shell') this._stepShell(s, dt);
    }
  }

  /**
   * FireControl.ResolveBestDirector: a radar director beats any other sensor,
   * and the higher solution-gain rate wins inside that group.
   */
  _bestDirector(u, weapon) {
    let best = null, bestRadar = false, bestGain = -Infinity;
    for (const i of weapon?.directors || []) {
      const s = (u.spec?.sensors || []).find((sen) => sen.idx === i);
      if (!s) continue;
      const gain = this._fcProfile(s).gain;
      const radar = s.kind === 'Radar';
      if (!best || (radar && !bestRadar) || (radar === bestRadar && gain > bestGain)) {
        best = s; bestRadar = radar; bestGain = gain;
      }
    }
    return best;
  }

  /** ResolveFireControlProfile. An authored rate wins; otherwise a radar derives one from range resolution. */
  _fcProfile(sensor) {
    if (sensor?.fcGain >= 0) return { gain: Math.max(sensor.fcGain, 0.01), min: Math.max(sensor.fcMin || 0, 0), radar: sensor.kind === 'Radar' };
    if (sensor?.kind === 'Radar') {
      const n2 = clamp(36 / (sensor.rangeRes > 0 ? sensor.rangeRes : 100), 0.15, 1.25);
      if (sensor.illuminator) return { gain: clamp(2 * n2, 0.75, 2.5), min: clamp(0.4 * n2, 0.05, 0.5), radar: true };
      return { gain: 1.2, min: 0.1, radar: true };
    }
    return { gain: 0.6, min: 0, radar: false };
  }

  /**
   * SensorUtils.BuildSolution on the best director, then WeaponSystemGun.DeviationCheck.
   * The solution steps every 4 s. The first step is floored at FCMinSolution.
   * One deviation sample is held for the next 4 s, the way a burst shares an aim point.
   */
  _gunFc(u, weapon, a, target, range) {
    const dir = this._bestDirector(u, weapon);
    const profile = this._fcProfile(dir);
    const tracks = (weapon?.directors || []).some((i) => (u.spec?.sensors || []).find((s) => s.idx === i)?.fcTracks);
    const key = `${weapon?.idx || 0}:${target?.id || 0}`;
    if (!u._fc) u._fc = {};
    let st = u._fc[key];
    if (!st) st = u._fc[key] = { solution: 0, prevHdg: target.heading || 0, prevKt: (target.speed || 0) / KT, first: false, next: 0, dev: null, devUntil: 0, ownHdg: u.heading || 0, ownOk: false, tracks };
    this._advanceFc(st, profile, target, range);
    if (!st.dev || (this.t || 0) >= st.devUntil) {
      const dark = profile.radar ? 1 : (1 + 2 * (1 - clamp(this.weather?.sun ?? 1, 0, 1)));
      const gain = Math.max(profile.gain, 0.01);
      const sol = st.solution;
      const rangeSigma = Math.max(0.5952375 * UNITY_M, range * 0.015) / Math.max(gain * gain, 0.1) * dark * (1 - 0.7 * sol);
      const brgSigma = 1.5 * 0.001 * range / Math.sqrt(Math.max(gain, 0.1)) * dark;
      const tof = range / Math.max(0.6 * (a.muzzle || 100), 0.001);
      const pred = (1 - sol) * (target.speed || 0) * tof * 0.5;
      let sea = 0;
      const seaW = clamp((1.5 - gain) / 0.5, 0, 1);
      if (seaW > 0) {
        sea = 0.4 * (this.weather?.sea || 0) * 0.001 * range * seaW * dark;
        if (st.ownOk && Math.abs(wrap180((u.heading || 0) - st.ownHdg)) > 3) sea += 0.002 * range * seaW * dark;
        st.ownHdg = u.heading || 0;
        st.ownOk = true;
      }
      const along = this._gauss() * rangeSigma + this._gauss() * pred;
      const cross = this._gauss() * brgSigma + this._gauss() * pred + this._gauss() * sea;
      const los = hdgVec(bearing(u, target));
      const side = { x: los.y, y: -los.x };
      st.dev = { x: los.x * along + side.x * cross, y: los.y * along + side.y * cross };
      st.devUntil = (this.t || 0) + 4;
    }
    return { key, offset: st.dev, miss: Math.hypot(st.dev.x, st.dev.y), tracks: !!st.tracks };
  }

  /** SensorUtils.BuildSolution. The solution steps every 4 s and is floored at FCMinSolution. */
  _advanceFc(st, profile, target, range) {
    if ((this.t || 0) < st.next) return;
    const add = 0.075 / (1 + (Math.max(range, 0) / 6000) ** 1.5) * profile.gain * 2;
    st.solution = Math.min(1, st.solution + add);
    if (st.first) {
      if (Math.abs(wrap180((target.heading || 0) - st.prevHdg)) > 4) st.solution -= 0.1 / Math.max(profile.gain, 1);
      if (Math.abs(st.prevKt - (target.speed || 0) / KT) > 4) st.solution -= 0.1 / Math.max(profile.gain, 1);
      st.solution = clamp(st.solution, 0, 1);
    }
    st.first = true;
    st.prevHdg = target.heading || 0;
    st.prevKt = (target.speed || 0) / KT;
    st.solution = Math.max(st.solution, profile.min);
    st.next = (this.t || 0) + 4;
  }

  /**
   * BuildAaErrorBudget, in metres. A new track is unsettled: the multiplier is 3, then it
   * falls toward 1 on Globals._gunAAFCSettleTime. Prediction is a speed error times flight time.
   */
  _aaBudget(profile, ammo, target, range, st, sensor) {
    const gain = Math.max(profile.gain, 0.01);
    const dark = profile.radar ? 1 : (1 + 2 * (1 - clamp(this.weather?.sun ?? 1, 0, 1)));
    const age = Math.max(0, (this.t || 0) - (st.acquired || 0));
    const settle = 10 / Math.max(gain, 0.5);
    const settleMult = 1 + 2 * (settle > 0.01 ? Math.exp(-age / settle) : 0);
    const distU = range / UNITY_M;
    const tof = range / Math.max(0.6 * (ammo.muzzle || 100), 0.001);
    const angular = 1.5 * 0.001 * distU / Math.sqrt(Math.max(gain, 0.1)) * dark * settleMult;
    let layMils = 4;
    const seaW = clamp((1.5 - gain) / 0.5, 0, 1);
    if (seaW > 0) {
      const seaMils = 0.4 * clamp(this.weather?.sea || 0, 0, 12) * seaW;
      layMils = Math.sqrt(layMils * layMils + seaMils * seaMils);
    }
    const lay = layMils * 0.001 * distU;
    const rangeU = Math.max(0.5952375, distU * 0.015) / Math.max(gain * gain, 0.1) * dark * (1 - 0.7 * (st.solution || 0)) * settleMult;
    const speedU = (target.speed || 0) / UNITY_M;
    const pred = Math.max(3 / UNITY_M, 0.01 * speedU * settleMult) / Math.sqrt(Math.max(gain, 0.5)) * tof;
    const multi = this._multipathU(sensor, target, range);
    const m = UNITY_M;
    return { range: rangeU * m, angular: angular * m, lay: lay * m, pred: pred * m, multi: multi * m, settleMult, tof };
  }

  /** RadarMultipath.VerticalErrorUnity. A target above the beam has no multipath. */
  _multipathU(sensor, target, range) {
    const beam = ((sensor?.beamDeg || 0) * Math.PI) / 180;
    if (!(beam > 0.0001) || range < 1) return 0;
    const alt = Math.max(target?.z || 0, 0);
    const above = (2 * alt) / range / beam;
    if (above >= 1) return 0;
    const grazing = (Math.max(sensor?.heightM || 0, 0) + alt) / range;
    const sea = clamp(this.weather?.sea || 0, 0, WAVE_HEIGHTS.length - 1) | 0;
    const waveM = WAVE_HEIGHTS[sea] * UNITY_M * 0.25;
    const wl = BAND_M[String(sensor?.frequency || '').toLowerCase()] ?? BAND_M.undefined;
    let refl = 0.9;
    if (wl > 1e-5 && waveM > 0.0001) {
      const num = (Math.PI * 2 * waveM * Math.abs(Math.sin(grazing))) / wl;
      refl = 0.9 * Math.exp(-2 * num * num);
    }
    return 0.35 * beam * refl * (1 - above) * (range / UNITY_M);
  }

  /**
   * DeviationCheck for an aircraft. One aim error is shared for 4 s. The bias velocity is
   * drawn again when the target's heading moves 12° or its speed changes by 15 m/s.
   */
  _gunAa(u, weapon, a, target, range) {
    const dir = this._bestDirector(u, weapon);
    const profile = this._fcProfile(dir);
    const key = `${weapon?.idx || 0}:${target?.id || 0}`;
    if (!u._fc) u._fc = {};
    let st = u._fc[key];
    if (!st) st = u._fc[key] = { solution: 0, prevHdg: target.heading || 0, prevKt: (target.speed || 0) / KT, first: false, next: 0, dev: null, devUntil: 0, acquired: this.t || 0, bias: null };
    if (st.dev && (this.t || 0) < st.devUntil) return st.dev;
    this._advanceFc(st, profile, target, range);
    const b = this._aaBudget(profile, a, target, range, st, dir);
    const gain = Math.max(profile.gain, 0.01);
    const speedU = (target.speed || 0) / UNITY_M;
    const hdg = target.heading || 0;
    const spd = target.speed || 0;
    const fresh = !st.bias || st.bias.id !== target.id;
    if (fresh || Math.abs(wrap180(hdg - st.bias.hdg)) > 12 || Math.abs(spd - st.bias.spd) > 15) {
      const biasSpd = Math.max(4 / UNITY_M, 0.08 * speedU) / Math.sqrt(Math.max(gain, 0.5));
      const dirV = hdgVec(hdg);
      const side = { x: dirV.y, y: -dirV.x };
      st.bias = {
        id: target.id, hdg, spd, at: fresh ? st.acquired : (this.t || 0),
        x: dirV.x * this._gauss() * biasSpd + side.x * this._gauss() * biasSpd * 0.5,
        y: dirV.y * this._gauss() * biasSpd + side.y * this._gauss() * biasSpd * 0.5,
        z: this._gauss() * biasSpd * 0.5,
      };
    }
    const settle = 10 / Math.max(gain, 0.5);
    const decay = Math.exp(-Math.max(0, (this.t || 0) - st.bias.at) / settle) * b.tof;
    const along = this._gauss() * (b.range / UNITY_M) + this._gauss() * (b.pred / UNITY_M);
    const cross = this._gauss() * (b.angular / UNITY_M) + this._gauss() * (b.lay / UNITY_M) + this._gauss() * (b.pred / UNITY_M);
    const vert = this._gauss() * (b.angular / UNITY_M) + this._gauss() * (b.lay / UNITY_M) + this._gauss() * (b.pred / UNITY_M) + this._gauss() * (b.multi / UNITY_M);
    const dx = target.x - u.x, dy = target.y - u.y, dz = (target.z || 0) - 8;
    const slant = Math.max(Math.hypot(dx, dy, dz), 1e-3);
    const los = { x: dx / slant, y: dy / slant, z: dz / slant };
    let sx = -los.y, sy = los.x;
    const sl = Math.hypot(sx, sy) || 1;
    sx /= sl; sy /= sl;
    const vx = -los.z * sy, vy = los.z * sx, vz = los.x * sy - los.y * sx;
    const m = UNITY_M;
    st.dev = {
      x: (los.x * along + sx * cross + vx * vert + st.bias.x * decay) * m,
      y: (los.y * along + sy * cross + vy * vert + st.bias.y * decay) * m,
      z: (los.z * along + vz * vert + st.bias.z * decay) * m,
    };
    st.devUntil = (this.t || 0) + 4;
    return st.dev;
  }

  /** Utils.sampleGauss × 3, a unit-sigma normal. */
  _gauss() {
    const u = Math.max(1e-9, 1 - this.rng());
    const v = 1 - this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.sin(Math.PI * 2 * v);
  }

  _damage(victim, amount, source) {
    if (!victim.alive) return;
    victim.hp -= amount * TUNING.damagePerPower;
    if (victim.hp <= 0) {
      victim.alive = false;
      this._releaseGuide(victim);
      this.emit('kill', { id: victim.id, by: source?.owner ?? null, msg: `${victim.name} destroyed` });
    } else if (victim.hp < victim.maxHp * 0.5 && !victim._crippled) {
      victim._crippled = true; // mobility kill at <50%: speed capped
      this.emit('damage', { id: victim.id, msg: `${victim.name} heavily damaged` });
    }
  }

  // -------------------------------------------------------------- simulation --
  step(dt) {
    if (this.over) return;
    this.gunTc = false;
    this.t += dt;
    const all = [...this.units.values()];
    // Shells already in the air splash before the mount looks for a free director channel.
    for (const u of all) {
      if (u.alive && u.active && u.kind === 'shell') this._stepShell(u, dt);
    }
    for (const u of all) {
      if (!u.alive || u.kind === 'shell') continue;
      if (u.cooldown > 0) u.cooldown -= dt;
      if (u.engage?.left > 0) this._releaseEngage(u);
      if (!u.active) continue;
      if (u.kind === 'ship' || u.kind === 'sub') this._stepShip(u, dt);
      else if (u.kind === 'air') this._stepAir(u, dt);
      else if (u.kind === 'missile') this._stepMissile(u, dt);
      else if (u.kind === 'torpedo') this._stepTorpedo(u, dt);
      else if (u.kind === 'buoy') this._stepBuoy(u, dt);
      if (u.racks && !u.guns?.length) this._tickGunRacks(u, dt);
      if (u.guns?.length) this._stepGuns(u, dt);
      if (u.ai && u.team !== 0 && (u.team === this.playerTeam || !this.noEnemyAi) && (u.kind === 'ship' || u.kind === 'sub' || u.kind === 'land' || u.kind === 'air')) this._ai(u, dt);
    }
    this._stepDecks(dt);
    this._stepDefense(dt);
    this._detectT += dt;
    if (this._detectT >= TUNING.detectInterval) { this._detectT = 0; this._detect(); }
    for (const tr of this.triggers) tr(this);
    for (const [id, u] of this.units) if (!u.alive && (u.kind === 'missile' || u.kind === 'shell' || u.kind === 'torpedo' || u.kind === 'buoy')) this.units.delete(id);
    this._checkEnd();
  }

  // In-game stations come from UnitFormation, not the editor's 10 nm line.
  // Loose keeps the station each ship had when it joined. The others use GetNewStationPositionIn*Formation.
  buildFormations() {
    const members = [...this.units.values()].filter((u) => u.alive && u.active && u.team === this.playerTeam && (u.kind === 'ship' || u.kind === 'sub'));
    members.sort((a, b) => a.id - b.id);
    members.forEach((m, i) => { m.formation = { id: 1, index: i, leaderId: 0 }; });
    this._assignFormation(members, true);
  }

  setFormation(u, joined) {
    if (!u) return;
    if (!joined) { u.formation = null; return; }
    const members = this._formMembers();
    const leader = members.find((m) => m.formation?.index === 0) || members[0] || u;
    const next = members.reduce((n, m) => Math.max(n, m.formation?.index ?? 0), 0) + 1;
    u.formation = { id: 1, index: u === leader || !members.length ? 0 : next, leaderId: leader.id };
    this._assignFormation(this._formMembers(), false);
  }

  _formMembers() {
    return [...this.units.values()].filter((m) => m.formation && m.alive && m.team === this.playerTeam && (m.kind === 'ship' || m.kind === 'sub'));
  }

  cyclePattern() {
    const i = FORM_PATTERNS.findIndex(([id]) => id === this._form.pattern);
    this._form.pattern = FORM_PATTERNS[(i + 1) % FORM_PATTERNS.length][0];
    this._assignFormation(this._formMembers(), true);
    return this._form.pattern;
  }

  cycleSpacing() {
    const i = FORM_SPACING.findIndex(([id]) => id === this._form.spacingKey);
    const next = FORM_SPACING[(i + 1) % FORM_SPACING.length];
    this._form.spacingKey = next[0];
    this._form.spacing = next[1];
    this._assignFormation(this._formMembers(), true);
    return this._form.spacing;
  }

  _assignFormation(members, reform) {
    if (!members.length) return;
    members.sort((a, b) => (a.formation?.index ?? 0) - (b.formation?.index ?? 0) || a.id - b.id);
    const leader = members[0];
    const pattern = this._form.pattern;
    const spacing = this._form.spacing;
    const rotate = pattern === 'lineAbreast' || pattern === 'lineAstern';
    members.forEach((m) => {
      const prev = m.formation;
      const index = prev?.index ?? 0;
      let offX = 0, offY = 0;
      if (index > 0 && pattern === 'loose') {
        if (!reform && prev?.pattern === 'loose' && prev.frozen) { offX = prev.offX; offY = prev.offY; }
        else { const cap = this._looseOffset(leader, m); offX = cap.x; offY = cap.y; }
      } else if (index > 0 && !rotate) {
        if (!reform && prev?.frozen && prev.pattern === pattern && prev.spacing === spacing) { offX = prev.offX; offY = prev.offY; }
        else { const w = this._worldOffset(leader, formationOffsetNm(pattern, spacing, index)); offX = w.x; offY = w.y; }
      }
      m.formation = { id: 1, index, leaderId: leader.id, pattern, spacing, rotate, frozen: !rotate, offX, offY };
    });
  }

  /** Loose join: InverseTransform of the ship plus 0.1 nm along its own bow, stored as a world offset. */
  _looseOffset(leader, u) {
    const fwd = hdgVec(u.heading);
    return { x: u.x + fwd.x * 0.1 * NM - leader.x, y: u.y + fwd.y * 0.1 * NM - leader.y };
  }

  _worldOffset(leader, o) {
    const fwd = hdgVec(leader.heading);
    const right = { x: fwd.y, y: -fwd.x };
    return { x: (right.x * o.stbd + fwd.x * o.fwd) * NM, y: (right.y * o.stbd + fwd.y * o.fwd) * NM };
  }

  releaseWingman(u) {
    if (!u?.formation || u.formation.index === 0) return;
    u.formation = null;
  }

  stationPoint(leader, index) {
    const member = [...this.units.values()].find((m) => m.formation && m.formation.leaderId === leader.id && m.formation.index === index);
    if (!member) return { x: leader.x, y: leader.y };
    return this._stationOf(leader, member);
  }

  _stationOf(leader, member) {
    const f = member.formation;
    if (!f.rotate) return { x: leader.x + (f.offX || 0), y: leader.y + (f.offY || 0) };
    const o = formationOffsetNm(f.pattern, f.spacing, f.index);
    const w = this._worldOffset(leader, o);
    return { x: leader.x + w.x, y: leader.y + w.y };
  }

  _stepFormation(u) {
    if (!u.formation || u.formation.index === 0) return false;
    const leader = this.units.get(u.formation.leaderId);
    if (!leader?.alive) { this.releaseWingman(u); return false; }
    const goal = this._stationOf(leader, u);
    const d = dist2(u, goal);
    u.waypoints = [];
    u.course = d < Math.max(u.spec.length || 80, 80) ? leader.course : bearing(u, goal);
    u.telegraph = d > 0.4 * NM ? Math.max(leader.telegraph, 3) : leader.telegraph;
    return true;
  }

  /**
   * AI.AutoSetHidingState. The state is sticky: a branch that does not match leaves the
   * previous value. NotHiding is 0, ModeratelyHiding 1, Stealthy 2.
   */
  _updateHiding(u) {
    if (u.kind !== 'sub') return;
    if (u.hiding == null) u.hiding = 0;
    const tel = u.telegraph ?? 0;
    if (tel === 0 || tel === 1) u.hiding = 2;
    if (this._subSurfaced(u)) u.hiding = 1;
    if (tel > 1 && !this._subCavitating(u)) u.hiding = 1;
    if (u.airSearchOn) u.hiding = 0;
    if (u.surfSearchOn) u.hiding = 0;
    if (u.activeSonarOn) u.hiding = 0;
  }

  /** SubmarineParameters.CavitationOnsetSpeedKts. Depth in metres, rated speed in knots. */
  _cavOnsetKt(u) {
    const rated = u.spec?.noise?.cavRated || 0;
    if (!(rated > 0)) return Infinity;
    const depthM = Math.max(0, -(u.z || 0));
    return rated * Math.sqrt((10 + depthM) / 110);
  }

  /** updateParticles: demanded speed above the onset, or any astern bell, cavitates. */
  _subCavitating(u) {
    const noise = u.spec?.noise;
    if (!noise?.cavParticle || !(noise.cavRated > 0)) return false;
    const ordered = Number.isFinite(u.demandedKt) ? u.demandedKt : this.speedForTelegraph(u);
    return ordered < 0 || ordered > this._cavOnsetKt(u);
  }

  /**
   * TelegraphSpeed.SetSubmarineSpeed. A submerged boat that is hiding, not in player
   * override and not emergency-surfacing, is held to one knot under cavitation onset.
   * CavitationForbidden defaults on. A boat that is already cavitating never enters hiding.
   */
  _cavAvoidKt(u, kt) {
    u.avoidCav = false;
    if (u.kind !== 'sub' || u.playerOverride || u.cavForbidden === false || u.emergencySurface) return kt;
    if (this._subSurfaced(u) || !u.hiding) return kt;
    const cap = this._cavOnsetKt(u) - 1;
    if (kt > cap) {
      u.avoidCav = true;
      return cap;
    }
    return kt;
  }

  /**
   * Speed the engines chase. Telegraph first, then the sea-state cap for a surface ship
   * and the rudder cap. A surfaced submarine already has both the coefficient and the
   * sea-state cap inside speedForTelegraph. A hiding submarine is then held under cavitation.
   */
  _chaseKt(u) {
    const s = u.spec;
    let kt = this.speedForTelegraph(u);
    if (u._crippled) kt *= 0.5;
    const sea = this.weather?.sea || 0;
    if (sea > 3 && u.kind === 'ship') {
      const c = seaDragCoeff(s.disp || 0);
      const backMax = Math.abs(s.telegraph?.[0] ?? 3);
      const fwd = s.vmaxKt - (sea - 3) * c;
      const back = -backMax + (sea - 3) * c;
      if (kt > 0 && kt > fwd) kt = fwd > 5 ? fwd : 5;
      if (kt < 0 && kt < back) kt = back < -2 ? back : -2;
    }
    if (u.kind === 'sub') kt = this._cavAvoidKt(u, kt);
    // updateParticles reads the speed command, before the rudder trims wanted speed.
    if (u.kind === 'sub') u.demandedKt = kt;
    const ang = Math.abs(u.rudderNow || 0);
    if (ang > 1 && kt > 0) {
      const maxKt = u.kind === 'sub' && this._subSurfaced(u) && s.surfKt > 0 ? s.surfKt : s.vmaxKt;
      const cap = maxKt * (1 - 0.5 * Math.min(1, ang / 25));
      if (kt > cap) kt = cap;
    }
    return kt;
  }

  /**
   * Vessel.applyMainThrust / Submarine.applyMainThrust. Thrust is
   * (7 × ordered / max, or −1.5 astern) × horsepower / displacement. Acceleration
   * integrates at 0.01 × thrust and is clamped by MaxAccelerationFactor, then eased
   * off as speed nears the order. Past the order, speed decays by LinearDrag^dt.
   * Substeps are 1/60 s, the high-frame physics step.
   */
  _stepThrust(u, dt) {
    if (dt <= 0) return;
    const s = u.spec;
    const wanted = this._chaseKt(u);
    const surfaced = u.kind === 'sub' && this._subSurfaced(u);
    const maxFwd = Math.max(surfaced && s.surfKt > 0 ? s.surfKt : (s.vmaxKt || 1), 0.001);
    const demand = wanted > -0.001 ? (7 * wanted) / maxFwd : -1.5;
    const thrust = demand * (s.shaftHp || 10000) / Math.max(s.disp || 1000, 1);
    const drag = s.linearDrag ?? 0.98;
    const maxA = s.maxAccel ?? 1;
    const minA = s.minAccel ?? 0.2;
    const sub = u.kind === 'sub';
    let vel = (u.speed || 0) / KT;
    let acc = u.accelKt || 0;
    let left = dt;
    const h = 1 / 60;
    while (left > 1e-8) {
      const step = Math.min(h, left);
      left -= step;
      acc += 0.01 * thrust * step;
      if (acc > maxA) acc = maxA;
      else if (acc < -maxA) acc = -maxA;
      const damp = drag ** step;
      if (sub) {
        acc *= damp;
        if (Math.abs(thrust) < 0.01 || (thrust < 0 && acc > 0) || (thrust > 0 && acc < 0)) acc *= 0.9 * damp;
      }
      if (Math.abs(wanted) > 1) {
        const ratio = wanted === 0 ? 0 : vel / wanted;
        const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
        const scale = 1.1 - clamped;
        const hi = maxA * scale;
        if (wanted > 0) acc = acc < minA ? minA : acc > hi ? hi : acc;
        else acc = acc > -minA ? -minA : acc < -hi ? -hi : acc;
      }
      const driving = (thrust > 0 && vel < wanted) || (thrust < 0 && vel > wanted);
      if (driving) vel += acc * step;
      else vel *= damp;
      if (sub && ((thrust < 0 && vel > 0) || (thrust > 0 && vel < 0))) vel *= damp * damp * damp;
    }
    u.accelKt = acc;
    u.speed = vel * KT;
  }

  _stepShip(u, dt) {
    const s = u.spec;
    // waypoint following. A wingman on station ignores its own waypoints.
    if (u.vidId) this._steerVid(u);
    else if (!this._stepFormation(u) && u.waypoints.length && u.wpIdx < u.waypoints.length) {
      const wp = u.waypoints[u.wpIdx];
      if (dist2(u, wp) < Math.max(200, s.length)) { u.wpIdx++; if (wp.telegraph != null) u.telegraph = wp.telegraph; }
      else u.course = bearing(u, wp);
    }
    if (u.kind === 'sub') {
      this._updateHiding(u);
      this._retractMasts(u);
      if (u.snorkelUp && Math.abs((u.speed || 0) / KT) > (s.snorkelKt || 8) + 0.1) u.snorkelUp = false;
    }
    if (!u.helm) this._commandRudder(u, u.course);
    const h0 = u.heading;
    const v0 = hdgVec(h0);
    this._stepThrust(u, dt);
    this._stepRudder(u, dt);
    // Translate along the heading from before the yaw, then orbit the pivot, matching
    // applyMainThrust followed by RotateAround.
    u.x += v0.x * u.speed * dt; u.y += v0.y * u.speed * dt;
    this._orbitPivot(u, v0, wrap180(u.heading - h0));
    if (u.kind === 'sub') this._stepSubRoll(u, dt);
    else this._stepHeel(u, dt);
    if (u.kind === 'sub') this._stepSubDepth(u, dt);
    this._stepDecoy(u);
  }

  /**
   * TowedSystem decoy cable. The player order sticks, and the body streams only
   * while the speed is inside the band. A surfaced submarine keeps it stowed.
   * EMCON's Disable clears the order.
   */
  _stepDecoy(u) {
    if (!u.decoy?.length) return;
    const kt = Math.round((u.speed || 0) / KT);
    const back = hdgVec(wrap360((u.heading || 0) + 180));
    const stern = (u.spec?.length || 0) / 2;
    for (const d of u.decoy) {
      const band = kt >= d.minKt && kt <= d.maxKt;
      const surfaced = u.kind === 'sub' && this._subSurfaced(u);
      d.on = !!(d.wanted && !u.emcon && band && !surfaced);
      if (!d.on) continue;
      const reach = stern + (d.cableM || 0);
      d.x = u.x + back.x * reach;
      d.y = u.y + back.y * reach;
      d.z = -(d.depthM || 0);
    }
  }

  /** ToggleTowedDecoy. Enable remembers the order; Disable forgets it. */
  toggleDecoy(u) {
    const d = u?.decoy?.[0];
    if (!d) return false;
    d.wanted = !d.wanted;
    if (!d.wanted) d.on = false;
    else this._stepDecoy(u);
    return true;
  }

  /**
   * applyTiltAndPitchForces then setTiltAndPitch. A 10°/s turn is full tilt.
   * Astern reverses the heel and drops the speed pitch and lift. Pitch and tilt
   * ease with 3·dt; lift eases with 1·dt. Above 100× the vessel update flattens the ship.
   */
  _stepHeel(u, dt) {
    if ((this.timeScale || 1) > 100) {
      u._tilt = 0; u.roll = 0; u._pitch = 0; u.pitch = 0; u._lift = 0; u.heave = 0;
      return;
    }
    const spec = u.spec || {};
    let frac = clamp((u.turnRate || 0) / 10, -1, 1);
    const astern = (u.speed || 0) < 0;
    if (astern) frac = -frac;
    const tiltTarget = -(spec.tilt ?? 1) * frac / 10;
    u._tilt = smoothToward(u._tilt || 0, tiltTarget, 3 * dt);
    const beamU = Math.max((spec.beam || 10) / UNITY_M, 0.02);
    u.roll = Math.asin(clamp(u._tilt / beamU, -1, 1)) * R2D;

    let pitchCmd = 0, liftCmd = 0;
    const sea = this.weather?.sea || 0;
    const seaMax = spec.pitchSea ?? 100;
    if (!astern && sea <= seaMax) {
      const knots = (u.speed || 0) / KT;
      const speedFrac = knots / Math.max(spec.vmaxKt || 0.1, 0.1);
      pitchCmd = (spec.pitchFactor || 0) * speedFrac * 0.1;
      const band = spec.liftKt || [15, 25];
      let blend = 0;
      if (knots > band[1]) blend = 1;
      else if (knots > band[0]) blend = (knots - band[0]) / (band[1] - band[0]);
      liftCmd = (spec.lift || 0) * blend * 0.1;
      if (pitchCmd < 0) pitchCmd *= 0.2;
      if (sea === seaMax) { pitchCmd *= 0.5; liftCmd *= 0.5; }
    }
    // setTiltAndPitch divides pitch by 10 and throws away a bow-up command.
    let pitchTarget = pitchCmd / 10;
    if (pitchTarget > 0) pitchTarget = 0;
    const liftTarget = liftCmd < 0 ? 0 : liftCmd;
    u._pitch = smoothToward(u._pitch || 0, pitchTarget, 3 * dt);
    u._lift = smoothToward(u._lift || 0, liftTarget, dt);
    // Five sample points along the hull. Only the bow point (index 4) is shifted,
    // so the waterline slope is 0.8 of that rise over the length. A raised bow
    // sample loses buoyancy and the bow goes down. Lift lowers every sample,
    // and the hull rises by that amount.
    const bow = -(u._pitch || 0) * UNITY_M;
    const slope = 0.8 * bow / Math.max(spec.length || 1, 1);
    u.pitch = slope ? Math.atan(slope) * R2D : 0;
    u.heave = u._lift ? u._lift * UNITY_M : 0;
  }

  /** Pivot is one third of the mesh length forward of the origin. */
  _orbitPivot(u, forward, dHead) {
    const pivot = (u.spec?.length || 0) / 3;
    if (!(pivot > 0) || Math.abs(dHead) < 1e-8) return;
    const th = dHead * D2R;
    const c = Math.cos(th), sn = Math.sin(th);
    const ox = -forward.x * pivot, oy = -forward.y * pivot;
    u.x += ox * c + oy * sn - ox;
    u.y += -ox * sn + oy * c - oy;
  }

  /**
   * Submarine.applyTilt. Submerged bank is −MaxRollAngle × clamp(turnRate / 2).
   * Astern flips the sign. On the surface the target is zero and any leftover bank slews back.
   */
  _stepSubRoll(u, dt) {
    const d = u.spec?.dive;
    if (!d) return;
    let roll = u.roll || 0;
    const submerged = !this._subSurfaced(u);
    if (!submerged && Math.abs(roll) <= 0.1) { u.roll = 0; return; }
    let frac = (u.turnRate || 0) / 2;
    if (frac > 1) frac = 1;
    else if (frac < -1) frac = -1;
    if ((u.speed || 0) < 0) frac = -frac;
    const maxR = d.maxRoll ?? 30;
    let target = clamp(-maxR * frac, -maxR, maxR);
    if (!submerged) target = 0;
    const rate = (d.rollRate ?? 2) * dt;
    if (Math.abs(target - roll) < 0.1) roll = target;
    else if (target > roll) roll = Math.min(target, roll + rate);
    else roll = Math.max(target, roll - rate);
    u.roll = roll;
  }

  /**
   * Submarine.applyDepth. Tanks slew toward the depth error at BallastTankChangeRate and are
   * capped at MaxDepthChangeUsingTanks. Planes pitch with speed and add their vertical component.
   * Crossing the bow-under line on the way up snaps to the surface.
   */
  _stepSubDepth(u, dt) {
    const d = u.spec?.dive;
    if (!d || u.ordDepthM == null) return;
    const depthM = Math.max(0, -(u.z || 0));
    const errU = (u.ordDepthM - depthM) / UNITY_M;
    const maxU = d.maxTankFt * UNITY_PER_FT;
    const want = clamp(errU, -maxU, maxU);
    if (u.tankRate == null) u.tankRate = 0;
    if (u.tankRate < want) u.tankRate = Math.min(want, u.tankRate + d.ballastRate * dt);
    else if (u.tankRate > want) u.tankRate = Math.max(want, u.tankRate - d.ballastRate * dt);
    const frac = Math.abs((u.speed || 0) / KT) / Math.max(u.spec.vmaxKt || 1, 0.1);
    const depthFactor = clamp(2 * depthM / UNITY_M, 0, 1);
    const lim = d.maxPitch * depthFactor;
    const pitchWant = frac * clamp(d.maxPitch * errU, -lim, lim);
    if (u.pitch == null) u.pitch = 0;
    if (u.pitch < pitchWant) u.pitch = Math.min(pitchWant, u.pitch + d.pitchRate * dt);
    else if (u.pitch > pitchWant) u.pitch = Math.max(pitchWant, u.pitch - d.pitchRate * dt);
    if (frac > 0.1 && Math.abs(u.pitch) > 5) u.tankRate = 0;
    if (Math.abs(errU) < 0.001814284) u.tankRate = 0;
    let next = depthM + u.tankRate * UNITY_M * dt + (u.speed || 0) * Math.sin((u.pitch || 0) * D2R) * dt;
    const bowM = (d.bowUnderFt - d.trimFt) * FT;
    if (depthM > bowM && next < bowM) { next = 0; u.tankRate = 0; u.pitch = 0; u.ordDepthM = 0; u.depthPreset = 0; }
    if (next < 0) next = 0;
    if (next > d.crushFt * FT) next = d.crushFt * FT;
    u.z = -next;
  }

  /** Vessel.SetRudderToHeading: ordered rudder is half the heading error, clamped to ±25°. */
  _commandRudder(u, desired) {
    const dh = wrap180(desired - u.heading);
    let f = clamp(dh / 2, -25, 25);
    const a = Math.abs(f);
    if (a > 0.25 && a < 1) f = Math.sign(f);
    u.rudderSet = f;
  }

  /** Vessel.applyRudderThrust. Rudder moves at RudderTurnRate; yaw uses the primary/secondary force formula. */
  _stepRudder(u, dt) {
    const s = u.spec;
    const diff = u.rudderSet - u.rudderNow;
    const step = (s.rudderRate || 0) * dt;
    if (Math.abs(diff) <= step) u.rudderNow = u.rudderSet;
    else u.rudderNow += Math.sign(diff) * step;
    // A submarine always divides by its submerged maximum. A ship's maximum is its own.
    const vmax = s.vmaxKt || 1;
    const ordered = this.speedForTelegraph(u);
    const speedKt = u.speed / KT;
    const demand = ordered > -0.001 ? (7 * ordered) / vmax : -1.5;
    const thrust = demand * (s.shaftHp || 10000) / Math.max(s.disp || 1000, 1);
    // Mathf.Sign(0) is +1, so a coasting ship with the shaft stopped still heels the rudder that way.
    const thrustSign = thrust < 0 ? -1 : 1;
    if (Math.abs(thrust) <= 0.1 && Math.abs(speedKt) <= 0.1) { u.turnRate = 0; return; }
    const ang = Math.abs(u.rudderNow);
    let target = 0;
    if (ang > 0.1) {
      const frac = Math.abs(speedKt) / vmax;
      const c = Math.cos((90 - ang) * D2R);
      const c2 = c * c;
      const lift = Math.sqrt((1 - c2) * c2);
      const slow = frac < 0.5 ? frac * 2 : 1;
      const primary = slow * demand * lift;
      const secondary = 2 * frac;
      target = thrustSign * Math.sign(u.rudderNow || u.rudderSet) * (s.rudderForce ?? 1) * (primary + secondary);
    }
    // Amidships decay is 0.97 once per 1/60 s physics tick, not a continuous time constant.
    if (ang <= 0.1) u.turnRate *= 0.97 ** (dt * 60);
    else if (u.turnRate < target) u.turnRate = Math.min(target, u.turnRate + dt);
    else u.turnRate = Math.max(target, u.turnRate - dt);
    // SubmarineParameters leaves BackwardsRudderFactor at 0, so astern yaw is wiped. Ships set it to 1.
    if (u.kind === 'sub' && speedKt < 0) u.turnRate = 0;
    let yaw = u.turnRate * dt;
    if ((this.timeScale || 1) > 10) yaw = clamp(yaw, -Math.abs(u.rudderSet || 0), Math.abs(u.rudderSet || 0));
    u.heading = wrap360(u.heading + yaw);
  }

  _stepAir(u, dt) {
    const s = u.spec;
    const home = u.homeId ? this.units.get(u.homeId) : null;
    if (u.rtb && home?.alive) {
      u.layRun = null;
      u.layKt = 0;
      u.waypoints = [];
      u.course = bearing(u, home);
      u.ordAlt = 80;
      if (dist2(u, home) < 350 && u.z < 140) { this._recover(u, home); return; }
    } else if (u.vidId) this._steerVid(u);
    else if (this._stepPatrolBuoys(u)) { /* course and altitude belong to the sonobuoy run */ }
    if (!u.vidId && !u.layRun && u.waypoints.length && u.wpIdx < u.waypoints.length) {
      const wp = u.waypoints[u.wpIdx];
      if (dist2(u, wp) < 1500) { u.wpIdx++; if (wp.z != null) u.ordAlt = wp.z; }
      else { u.course = bearing(u, wp); if (wp.z != null) u.ordAlt = wp.z; }
    } else if (u.waypoints.length === 0 && u.ai && u.team !== this.playerTeam) { /* straight on */ }
    const target = u.layKt > 0 ? u.layKt * KT : this.speedForTelegraph(u) * KT;
    u.speed += (target - u.speed) * (1 - Math.exp(-dt / 10));
    const dh = wrap180(u.course - u.heading), maxTurn = 3.5;
    const turn = clamp(dh, -maxTurn * dt, maxTurn * dt);
    u.heading = wrap360(u.heading + turn);
    u.roll += (clamp(-turn / dt * 10, -55, 55) - u.roll) * Math.min(1, dt * 2);
    const dz = (u.ordAlt ?? u.z) - u.z, climb = clamp(dz, -s.climbMps * dt, s.climbMps * dt);
    u.z += climb; u.pitch = Math.atan2(climb / Math.max(dt, 1e-3), Math.max(u.speed, 1)) * R2D;
    const v = hdgVec(u.heading);
    u.x += v.x * u.speed * dt; u.y += v.y * u.speed * dt;
    if (u.layBuoys && !u.rtb) this._laySonobuoySalvo(u);
    if (u.fuelNm > 0) {
      u.fuelNm = Math.max(0, u.fuelNm - (u.speed * dt) / NM);
      if (!u.rtb && home && u.fuelNm <= dist2(u, home) / NM + 2) this.returnToBase(u, 'bingo');
    }
    if (!u.rtb && home && this._outOfPrimary(u)) this.returnToBase(u, 'winchester');
  }

  /** Torpedoes, missiles and bombs. Sonobuoys and fuel tanks are not a Winchester condition. */
  _outOfPrimary(u) {
    const ids = Object.keys(u.spec.ammoSpecs || {}).filter((id) => {
      const t = u.spec.ammoSpecs[id]?.type;
      return t === 'Torpedo' || t === 'Missile' || t === 'Bomb';
    });
    return ids.length > 0 && ids.every((id) => (u.ammo[id] || 0) <= 0);
  }

  // FlightDeckTimingsMode.Realistic is ×1. Globals._flightDeckTCLimit caps that work at 30×.
  _stepDecks(dt) {
    const scale = Math.max(this.timeScale || 1, 1e-6);
    const deckDt = dt * Math.min(1, 30 / scale);
    for (const ship of this.units.values()) {
      const deck = ship.deck; if (!deck) continue;
      const crew = Math.max(1, deck.crew || 1);
      for (const job of deck.jobs) {
        job.left -= deckDt * (job.phase === 'launch' ? 1 : crew);
        if (job.left > 0) continue;
        const extra = -job.left;
        if (job.phase === 'ready') {
          job.phase = 'launch';
          job.left = deck.launchDelay - extra;
          if (job.left > 0) continue;
        }
        if (job.phase === 'launch') { this._spawnAircraft(ship, job.spec); job.done = true; }
        else if (job.phase === 'rearm') {
          const bin = deck.bins.find((b) => b.id === job.typeId);
          if (bin) bin.count++;
          job.done = true;
        }
      }
      deck.jobs = deck.jobs.filter((j) => !j.done);
    }
  }

  _spawnAircraft(ship, spec) {
    const h = hdgVec(ship.heading);
    const u = this.addUnit({
      spec, team: ship.team, name: spec.name,
      x: ship.x + h.x * 90, y: ship.y + h.y * 90, z: 60,
      heading: ship.heading, telegraph: 3, ai: ship.team !== this.playerTeam, alt: 200 * FT,
    });
    u.homeId = ship.id;
    u.surfSearchOn = false;
    u.airSearchOn = false;
    this._syncEmitters(u);
    this.emit('deck', { id: u.id, msg: `${spec.name} airborne` });
    return u;
  }

  _recover(u, ship) {
    u.alive = false;
    u.rtb = false;
    const bin = ship.deck?.bins.find((b) => b.id === u.spec.id);
    ship.deck?.jobs.push({ spec: u.spec, typeId: u.spec.id, loadout: bin?.loadout || 'Default', phase: 'rearm', left: (u.spec.readyUpMin || 15) * 60 });
    this.emit('deck', { id: u.id, msg: `${u.name} on deck — rearming` });
  }

  /**
   * Semi-active homing is the illuminator, not an onboard radar. While that director still
   * paints the target, the missile is steered at the true position. A chaff bloom on that
   * ray can take the seeker; the radio link itself stays up. ConnectionLost coasts on the
   * last velocity. CanFinishOnOwnSeeker is false for a pure semi-active round, so 10 s of
   * loss frees the weapon channel for good.
   */
  _sarhLit(m) {
    if (m.guideLost || m.guide == null) return false;
    const owner = this.units.get(m.owner);
    const tgt = this.units.get(m.targetId);
    if (!owner?.alive || !tgt?.alive) return false;
    const sensor = (owner.spec?.sensors || []).find((s) => s.idx === m.guide);
    if (!sensor) return false;
    if (!sensor.illuminator && !this._radarSwitch(owner, sensor)) return false;
    const d = dist2(owner, tgt);
    const reach = this._radarRange(sensor, tgt, owner);
    const horizon = radioHorizon(this._antennaM(owner, sensor), this._visibleHeightM(tgt));
    return d <= reach && d <= horizon;
  }

  _stepSarh(m, dt, tgt) {
    if (m.spoofed && m._chaffLock) {
      const c = m._chaffLock;
      m.illum = true;
      m.lostAt = null;
      m.lastKnown = { x: c.x, y: c.y, z: m.z };
      return;
    }
    if (this._sarhLit(m)) {
      m.lostAt = null;
      m.illum = true;
      if (tgt) {
        this._sarhChaff(m, tgt);
        if (!m.spoofed) {
          m.lastKnown = { x: tgt.x, y: tgt.y, z: tgt.z };
          const hv = hdgVec(tgt.heading ?? 0);
          m.coastV = { x: hv.x * (tgt.speed || 0), y: hv.y * (tgt.speed || 0) };
        }
      }
      return;
    }
    m.illum = false;
    if (m.lostAt == null) m.lostAt = m.age - dt;
    const v = m.coastV || { x: 0, y: 0 };
    if (m.lastKnown) {
      m.lastKnown.x += v.x * dt;
      m.lastKnown.y += v.y * dt;
    }
    if (!m.guideLost && m.guide != null && m.age - m.lostAt > 10) {
      this._releaseGuide(m);
      m.guideLost = true;
    }
  }

  /**
   * SeekerBase.CheckCountermeasureLock. One bloom is rolled, then 35 s of further blooms
   * are ignored. Anti-countermeasure above 0.999 never locks. The player's fourth success
   * in a row is discarded.
   */
  _chaffRoll(m, c) {
    if ((m.spec_?.antiChaff ?? 1) > 0.999) return false;
    if (m._ignoredChaff?.has(c)) return false;
    if (m._chaffCheckAt != null && this.t - m._chaffCheckAt < 35) {
      if (!m._ignoredChaff) m._ignoredChaff = new Set();
      m._ignoredChaff.add(c);
      return false;
    }
    m._chaffCheckAt = this.t;
    const chance = Math.max(0.01, (c.spoof || 0) - (m.spec_.antiChaff || 0));
    let take = this.rng() < chance;
    if (m.team === this.playerTeam) {
      if (take) {
        this._playerSpoofed += 1;
        if (this._playerSpoofed > 3) {
          this._playerSpoofed = 0;
          take = false;
        }
      } else this._playerSpoofed = 0;
    }
    if (!take) {
      if (!m._ignoredChaff) m._ignoredChaff = new Set();
      m._ignoredChaff.add(c);
      return false;
    }
    return true;
  }

  /**
   * CheckRadioConnection's ray, then the countermeasure roll. The nearest bloom on the
   * illuminator-to-target segment is the only candidate.
   */
  _sarhChaff(m, tgt) {
    if ((m.spec_?.antiChaff ?? 1) > 0.999) return;
    const owner = this.units.get(m.owner);
    if (!owner) return;
    const ax = owner.x, ay = owner.y;
    const dx = tgt.x - ax, dy = tgt.y - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1) return;
    let best = null, bestAlong = Infinity;
    for (const c of this.clouds) {
      if (c.kind !== 'chaff' || c.team === m.team || m._ignoredChaff?.has(c)) continue;
      const t = ((c.x - ax) * dx + (c.y - ay) * dy) / len2;
      if (t <= 0 || t >= 1) continue;
      const px = ax + dx * t, py = ay + dy * t;
      if (Math.hypot(c.x - px, c.y - py) > c.r) continue;
      const along = t * Math.sqrt(len2);
      if (along < bestAlong) { bestAlong = along; best = c; }
    }
    if (!best || !this._chaffRoll(m, best)) return;
    m.spoofed = true;
    m._chaffLock = best;
    m.lastKnown = { x: best.x, y: best.y, z: m.z };
    this.emit('chaff', { msg: `${m.name} seduced by chaff` });
  }

  /**
   * CreateWaypointConfigs for a sea-skimmer. Outside the skim start it holds the loft.
   * Then the skim altitude, a final-phase altitude, and the terminal altitude.
   * A pop-up climbs and comes back down onto the target inside TerminalPopUpDist.
   * Without a pop-up, the last TerminalDiveDistance is a dive onto the target.
   */
  /**
   * Selective pop-up stays armed only for a submarine or a vessel of 420 displacement or less.
   * A larger ship, or no target, keeps the terminal altitude. Harpoon A is not selective.
   */
  _popOn(a, tgt) {
    if (!((a.popNm || 0) > 0)) return false;
    if (!a.selectivePop) return true;
    if (!tgt) return false;
    if (tgt.kind === 'sub') return true;
    if (tgt.kind === 'ship' && (tgt.spec?.disp || 0) <= 420) return true;
    return false;
  }

  _missileAlt(a, dxy, tgtZ, tgt) {
    const skim = Math.max(0, (a.seaSkimFt || 0) * FT);
    const loft = Math.max(0, (a.loftAlt || 0) * FT);
    const start = Math.max(0, (a.skimStartNm || 0) * NM);
    const finalD = Math.max(0, (a.finalNm || 0) * NM);
    const approach = a.approachNm == null ? null : Math.max(0, a.approachNm) * NM;
    const pop = this._popOn(a, tgt) ? a.popNm * NM : 0;
    const dive = pop > 0 ? 0 : Math.max(0, (a.diveNm || 0) * NM);
    const term = (a.termFt || 0) > 0 ? a.termFt * FT : skim;
    const finalZ = (a.finalFt || 0) > 0 ? a.finalFt * FT : skim;
    const deck = tgtZ || 0;
    if (start > 0 && dxy > start) return loft > 0 ? loft : skim;
    const skimEdge = finalD > 0 ? finalD : (approach == null ? Infinity : approach);
    if (dxy > skimEdge) return skim;
    if (finalD > 0 && (approach == null || dxy > approach)) return finalZ;
    const inner = pop || dive;
    if (inner > 0 && dxy > inner) return term;
    if (pop > 0) return this._missilePop(a, dxy, term, deck);
    if (dive > 0) return deck + (term - deck) * (dxy / dive);
    return term;
  }

  /** Kappa loft across TerminalPopUpDist: climb at the pop angle, then descend onto the target. */
  _missilePop(a, dxy, base, tgtZ) {
    const popM = a.popNm * NM;
    const ang = Math.max(a.popAngle || 60, 1) * D2R;
    let peak = tgtZ + Math.max(a.popFt || 0, 0) * FT;
    if (peak < base) peak = base;
    let climb = (peak - base) / Math.tan(ang);
    if (climb * 2 > popM) {
      climb = popM / 2;
      peak = base + climb * Math.tan(ang);
    }
    const span = climb * 2;
    if (!(climb > 0) || dxy >= span) return base;
    if (dxy > climb) return base + (peak - base) * ((span - dxy) / climb);
    return tgtZ + (peak - tgtZ) * (dxy / climb);
  }

  /**
   * setCourseTowardsPosition. Lateral g is v² / (radius × 9.8). Above MaxTurnG the
   * turn rate is scaled down. The launch phase does not steer at all.
   */
  _missileTurn(a, speed, toBearing) {
    let rate = Math.max(a.turnRate || 0.1, 0.1);
    const gMax = a.maxTurnG > 0 ? a.maxTurnG : 200;
    const v = speed || 0;
    if (v > 1) {
      const radius = v * (360 / rate) / (2 * Math.PI);
      const g = (v * v) / (radius * 9.8);
      if (g > gMax) rate *= gMax / g;
    }
    // ToBearing uses LaunchTurnRate when it is faster than the g-limited rate, and that rate is not limited again.
    if (toBearing && (a.launchTurn || 0) > rate) rate = a.launchTurn;
    return rate;
  }

  _stepMissile(m, dt) {
    const a = m.spec_;
    m.age += dt;
    if (a.guidance === 3 && !m.spoofed) this._seekRadar(m);
    const tgt = this.units.get(m.targetId);
    const tgtOk = tgt && tgt.alive;
    if (a.guidance === 2) this._stepSarh(m, dt, tgtOk ? tgt : null);
    // acquire: until seeker range, fly to last datalinked position; then home on the real target
    else if (tgtOk) {
      const d = dist3(m, tgt);
      const homing = d <= a.seekerNm * NM * 1.0 || a.guidance === 1;
      if (homing || m.age < 0.5) m.lastKnown = { x: tgt.x, y: tgt.y, z: tgt.z };
    }
    const aim = m.lastKnown;
    // CalculateThrustOverTime. Acceleration is stored times 10. Knots per second are
    // g × 9.81 × 1.94384 × 1.2. A zero boost does not invent a 40 m/s² floor.
    const vmax = a.vmaxKt * KT;
    const boost = ((a.accelKt || 0) / 10) * 9.81 * 1.94384 * 1.2 * KT;
    const powered = m.age < (a.flightTime || 1e9) ? 1 : -0.5;
    m.speed = Math.max(0, Math.min(vmax, m.speed + boost * powered * dt));
    // altitude profile
    const dxy = Math.hypot(aim.x - m.x, aim.y - m.y);
    let wantZ;
    let pitchDeg = 45;
    if (a.target === 'AAW') wantZ = aim.z;
    else if (a.seaSkimFt > 0) {
      wantZ = this._missileAlt(a, dxy, aim.z || 0, tgtOk ? tgt : null);
      if (this._popOn(a, tgtOk ? tgt : null) && dxy <= a.popNm * NM) pitchDeg = a.popAngle || 60;
      else if ((a.skimStartNm || 0) > 0 && dxy > a.skimStartNm * NM) pitchDeg = a.loftAngle || 30;
      else pitchDeg = a.skimDescent || 30;
    } else wantZ = dxy < 3000 ? 3 : Math.max(a.loftAlt || 3000, 500) * (dxy > 20000 ? 1 : dxy / 20000);
    // steering (turn-rate limited, lead pursuit toward predicted intercept)
    let ax = aim.x, ay = aim.y;
    if (m.jamBias) { const side = hdgVec(m.heading + 90); ax += side.x * m.jamBias; ay += side.y * m.jamBias; }
    if (tgtOk && !m.spoofed && a.target !== 'ASuW' && m.illum !== false) { const tof = dxy / Math.max(m.speed, 1); const hv = hdgVec(tgt.heading ?? 0); ax += hv.x * tgt.speed * tof; ay += hv.y * tgt.speed * tof; }
    const wantH = bearing(m, { x: ax, y: ay });
    const guided = m.age >= (a.initialFlight || 0);
    // ToBearing lasts until the nose is within 5° or ten seconds after the launch phase.
    const toBearing = guided && m.age - (a.initialFlight || 0) <= 10 && Math.abs(wrap180(wantH - m.heading)) > 5;
    const maxTurn = (guided ? this._missileTurn(a, m.speed, toBearing) : 0) * dt;
    m.heading = wrap360(m.heading + clamp(wrap180(wantH - m.heading), -maxTurn, maxTurn));
    if (guided) {
      const dz = wantZ - m.z;
      const shaped = a.seaSkimFt > 0;
      const maxClimb = Math.tan(Math.min(Math.max(pitchDeg, 1), 89) * D2R) * m.speed * dt * (shaped ? 1 : (m.age < 2 ? 1.5 : 0.6));
      const climb = clamp(dz, -maxClimb, maxClimb);
      m.z = Math.max(1, m.z + climb);
      let path = Math.atan2(climb, Math.max(m.speed * dt, 0.01)) * R2D;
      if (shaped) {
        // The path follows the altitude curve. The nose slews toward that path: the g-limited
        // turn rate outside the approach, and TerminalVerticalTurnRate once inside it.
        const popping = this._popOn(a, tgtOk ? tgt : null) && dxy <= a.popNm * NM;
        if (a.skimNose && Math.abs(wantZ - m.z) < 2 && !popping) path = a.skimNose;
        const terminal = a.approachNm != null && dxy <= a.approachNm * NM;
        const split = terminal && a.vertTurn > 0 && Math.abs(a.vertTurn - (a.turnRate || 0)) > 1;
        const pitchRate = split ? a.vertTurn : this._missileTurn(a, m.speed);
        const cur = m.pitch || 0;
        m.pitch = cur + clamp(path - cur, -pitchRate * dt, pitchRate * dt);
      } else m.pitch = path;
    }
    const v = hdgVec(m.heading);
    const along = guided ? 1 : Math.cos((m.pitch || 0) * D2R);
    if (!guided) m.z = Math.max(1, m.z + Math.sin((m.pitch || 0) * D2R) * m.speed * dt);
    m.x += v.x * m.speed * along * dt; m.y += v.y * m.speed * along * dt;
    if (m.spoofed && m._chaffLock && dist2(m, m._chaffLock) < 40) {
      m.alive = false;
      this._releaseGuide(m);
      this.emit('miss', { id: m.targetId, msg: `${m.name} seduced by chaff`, x: m.x, y: m.y, z: m.z });
      return;
    }
    // terminal
    if (tgtOk && !m.spoofed) {
      const fuze = Math.max(a.prox, a.target === 'AAW' ? 40 : 0) + (tgt.kind === 'ship' ? (tgt.spec.length || 0) * 0.35 : (tgt.spec.span || 8) * 0.5);
      const reach = a.target === 'AAW' ? dist3(m, tgt) : dist2(m, tgt) + Math.max(0, m.z - 15);
      if (reach < fuze + m.speed * dt * 0.5) {
        m.alive = false;
        this._releaseGuide(m);
        if (this.rng() < a.reliability) { this.emit('hit', { id: tgt.id, x: tgt.x, y: tgt.y, z: tgt.z, msg: `${m.name} hits ${tgt.name}` }); this._damage(tgt, a.power, m); }
        else this.emit('miss', { id: tgt.id, msg: `${m.name} failed (dud/seeker)`, x: m.x, y: m.y, z: m.z });
        return;
      }
    }
    if (m.age > (a.flightTime || 900) || (!tgtOk && dxy < 800)) {
      m.alive = false;
      this._releaseGuide(m);
      this.emit('miss', { id: m.targetId, msg: `${m.name} lost its target`, x: m.x, y: m.y, z: m.z });
    }
  }

  /**
   * ActiveRadarSeeker.searchForTarget. createRadarEcho's aspect RCS, then RCS / nm^4.
   * Broadside is the class value. Bow and stern are the frontal fraction. The strongest
   * return inside the cone and the range gate takes the missile off the designated ship.
   * A chaff bloom in that same cone and gate is a contact. The countermeasure roll takes
   * the seeker onto the bloom without comparing its RCS to the ship.
   */
  _seekRadar(m) {
    const a = m.spec_;
    const intended = this.units.get(m.intendedId);
    const pred = intended?.alive ? intended : m.lastKnown;
    if (!pred || dist2(m, pred) > (a.seekerNm || 10) * NM) return;
    if (m.seekerAt == null) m.seekerAt = m.age;
    const gate = a.rangeGateNm > 0 ? Math.min(a.rangeGateNm * 2 ** Math.max(0, m.age - m.seekerAt), 1000) * NM : Infinity;
    const fov = a.seekerFov || 45;
    const seekerM = (a.seekerNm || 10) * NM;
    for (const c of this.clouds) {
      if (c.kind !== 'chaff' || c.team === m.team) continue;
      const d = dist2(m, c);
      if (d > seekerM || dist2(pred, c) > gate) continue;
      if (d >= 1 && Math.abs(wrap180(bearing(m, c) - m.heading)) > fov) continue;
      if (!this._chaffRoll(m, c)) continue;
      m.spoofed = true;
      m._chaffLock = c;
      m.targetId = 0;
      m.lastKnown = { x: c.x, y: c.y, z: m.z };
      this.emit('chaff', { msg: `${m.name} seduced by chaff` });
      return;
    }
    let best = null, bestSig = -1;
    for (const u of this.all()) {
      if ((u.kind !== 'ship' && u.kind !== 'sub') || u.team === m.team) continue;
      const d = dist2(m, u);
      if (d > (a.seekerNm || 10) * NM || dist2(pred, u) > gate) continue;
      if (Math.abs(wrap180(bearing(m, u) - m.heading)) > fov) continue;
      const nm = Math.max(d / NM, 0.05);
      const sig = this._echoRcs(m, u) / nm ** 4;
      if (sig > bestSig) { bestSig = sig; best = u; }
    }
    if (best && best.id !== m.targetId) {
      m.targetId = best.id;
      m.lastKnown = { x: best.x, y: best.y, z: best.z || 0 };
      if (best.id !== m.intendedId && !m._shifted) {
        m._shifted = true;
        this.emit('seeker', { id: m.id, msg: `${m.name} seeker shifts to ${best.name}` });
      }
    }
  }

  /**
   * CanObserveFallOfShot. Daylight is enough. In the dark only a radar that is switched on
   * sees the splash. A round-tracking radar always does, and it reports at half the flight.
   */
  _canObserveSplash(o, shell) {
    if ((this.weather?.sun ?? 1) >= 0.25) return true;
    const idx = Number(String(shell.fcKey || '').split(':')[0]);
    const weapon = (o?.spec?.weapons || []).find((w) => w.idx === idx);
    return (weapon?.directors || []).some((i) => {
      const s = (o.spec?.sensors || []).find((sen) => sen.idx === i);
      return s?.kind === 'Radar' && (s.illuminator || this._radarSwitch(o, s));
    });
  }

  /** A naval splash raises the director solution. A round-tracking radar takes the full 0.10–0.15. */
  _spotFall(s) {
    if (s.spotted) return;
    const o = this.units.get(s.owner);
    const st = o?._fc?.[s.fcKey];
    if (!st) return;
    if (!st.tracks && !this._canObserveSplash(o, s)) return;
    s.spotted = true;
    const factor = st.tracks ? 1 : clamp(1.25 - (s.fcMiss || 0) / 800, 0.25, 1);
    st.solution = Math.min(1, st.solution + (0.1 + this.rng() * 0.05) * factor);
  }

  /** MassScaledAirframeHealth. A 15 t airframe is 4, and the curve is clamped. */
  _airframeHealth(kg) {
    if (!(kg >= 100)) return 4;
    return 4 * clamp((kg / 15000) ** 0.75, 0.25, 8);
  }

  /** MassScaledMissileHealth from dry mass. Under 20 kg stays at 2. */
  _missileHealth(dryKg) {
    if (!(dryKg >= 20)) return 2;
    return 2 * clamp((dryKg / 700) ** 0.75, 0.5, 5);
  }

  /** ProximityDamageFalloff. Full burst inside a tenth of the fuze, then inverse square. */
  _proximityFalloff(missM, fuzeM) {
    if (fuzeM <= 0.01 || missM <= 0) return 1;
    const inner = 0.1 * fuzeM;
    if (missM <= inner) return 1;
    const k = inner / missM;
    return k * k;
  }

  /**
   * Projectile.ProcessCollision against an aircraft or a missile. The fuze sphere is
   * FuzeProximityDistance in metres. Burst damage is warhead power times the falloff,
   * varied from half to one and a half, and a close burst can shatter the airframe outright.
   */
  _gunAirHit(s, t, d) {
    const fuze = s.shot?.prox || 0;
    const proximity = fuze > 0.01;
    if (proximity && d > fuze) return;
    if (!proximity && d > Math.max(2, (t.spec?.span || t.spec?.length || 4) * 0.15)) return;
    const health = t.kind === 'missile'
      ? this._missileHealth((t.spec_?.massKg || t.spec?.massKg || 700) - (t.spec_?.fuelKg || t.spec?.fuelKg || 0))
      : this._airframeHealth(t.spec?.emptyKg || 5000);
    const dealt = (s.shot?.power || 0) * (s.dmgMult || 1) * this._proximityFalloff(proximity ? d : 0, fuze) * (0.5 + this.rng());
    if (dealt <= 0) return;
    t._gunDamage = (t._gunDamage || 0) + dealt;
    if (this.rng() < clamp(0.3 * dealt / Math.max(0.05, health), 0, 1)) t._gunDamage = Math.max(t._gunDamage, health);
    this.emit('hit', { id: t.id, x: t.x, y: t.y, z: t.z || 6, msg: `${s.name} hits ${t.name}` });
    if (t._gunDamage >= health) this._damage(t, t.hp, s);
    else this._damage(t, (dealt / health) * t.maxHp, s);
  }

  _stepShell(s, dt) {
    s.age += dt;
    if (s.naval && !s.spotted && s.age >= (s.spotAt ?? s.tof)) this._spotFall(s);
    const k = Math.min(1, s.age / s.tof);
    const o = this.units.get(s.owner);
    if (s.age >= s.tof) {
      s.alive = false;
      this._releaseGuide(s);
      const t = this.units.get(s.targetId);
      if (s.naval) this._spotFall(s);
      this.emit('splash', { x: s.impact.x, y: s.impact.y, z: 0 });
      if (t && t.alive) {
        const radius = t.kind === 'ship' ? Math.max(t.spec.length, 20) * 0.5 : (t.spec.span || 10);
        const air = t.kind === 'air' || t.kind === 'missile';
        const d = air
          ? Math.hypot(s.impact.x - t.x, s.impact.y - t.y, (s.impact.z || 0) - (t.z || 0))
          : Math.hypot(s.impact.x - t.x, s.impact.y - t.y);
        if (air) this._gunAirHit(s, t, d);
        else if (d < radius * TUNING.gunHitScale) { this.emit('hit', { id: t.id, x: t.x, y: t.y, z: 6, msg: `${s.name} hits ${t.name}` }); this._damage(t, s.shot.power, s); }
      }
      return;
    }
    // visual position along the arc
    const from = o ?? s, v = hdgVec(s.heading);
    const R = Math.hypot(s.impact.x - (s._x0 ?? (s._x0 = s.x)), s.impact.y - (s._y0 ?? (s._y0 = s.y)));
    s.x = s._x0 + (s.impact.x - s._x0) * k; s.y = s._y0 + (s.impact.y - s._y0) * k;
    s.z = 8 + 4 * k * (1 - k) * Math.min(R * 0.35, 3000) * 1.0;
    void from; void v;
  }

  // --------------------------------------------------------------- detection --
  /**
   * SensorUtils.CalculateVisualRange × the observer's best optics.
   * The target's VisualIdentificationRange is nautical miles. Broadside reflects fully;
   * bow and stern use VisibilityFromFront. Returns ranges in metres.
   */
  /**
   * IsSensorUnderwater. A periscope is never underwater for this check, but it only looks
   * while it is raised. Once the sail is under, the lookout mount is below the surface.
   */
  _eyeSensors(ob) {
    const sensors = ob?.spec?.sensors || [];
    if (ob?.kind === 'sub' && this._submerged(ob)) {
      if (!ob.periscopeUp || this._mastRetracted(ob)) return [];
      return sensors.filter((s) => s.kind === 'Periscope');
    }
    return sensors.filter((s) => s.kind === 'Visual' || (s.kind === 'Periscope' && ob?.periscopeUp));
  }

  _visual(ob, tgt, d, opts = {}) {
    const baseNm = tgt.spec.visIdNm || 0;
    if (baseNm <= 0) return { detect: false, identify: false };
    const eyes = this._eyeSensors(ob);
    if (eyes.length === 0 && ob?.kind === 'sub' && this._submerged(ob)) return { detect: false, identify: false };
    const aspect = Math.abs(wrap180(bearing(ob, tgt) - (tgt.heading || 0)));
    const flank = 1 - Math.abs(aspect - 90) / 90;
    const front = tgt.spec.visFront ?? 0.61;
    const reflect = front + (1 - front) * flank;
    // A submerged hull with no mast uses a hundredth of the identification range.
    let unity = Math.max(baseNm * 27.559496, 3) * reflect * this._visualEnv(ob, tgt, opts);
    if (opts.submergedHull) unity /= 100;
    const down = this._inLookDown(ob, tgt);
    const metres = 1852 / 27.559496;
    const hT = this._visibleHeightM(tgt);
    const slots = eyes.length ? eyes : [null];
    let idReach = 0, detReach = 0;
    for (const s of slots) {
      const ld = down ? (s?.lookDown ?? 1) : 1;
      let idR = unity * (s?.vidMult || 1) * ld * metres;
      let detR = unity * (s?.maxMult || 1) * ld * metres;
      // Look-down returns before the horizon min. Otherwise the geometric horizon caps the eye.
      if (!down) {
        const h = visualHorizon(this._eyeHeightM(ob, s), hT);
        idR = Math.min(idR, h);
        detR = Math.min(detR, h);
      }
      idReach = Math.max(idReach, idR);
      detReach = Math.max(detReach, detR);
    }
    // A submerged boat is detected, never identified. flag3 requires !isSubmerged().
    if (opts.submergedHull) return { identify: false, detect: d < detReach };
    return { identify: d < idReach, detect: d < detReach };
  }

  /** Optics mount height. An aircraft eye is the aircraft altitude. */
  _eyeHeightM(ob, sensor) {
    if (ob?.kind === 'air') return Math.max(0, ob.z || 0);
    if (ob?.kind === 'sub') return Math.max(0, (ob.z || 0) + (sensor?.offsetM || sensor?.heightM || 0));
    if (sensor?.heightM > 0) return sensor.heightM;
    return Math.max(ob?.z || 0, 3);
  }

  /** Sail is under: y <= -(SailUnderWater − TrimDepth). */
  _submerged(tgt) {
    return tgt?.kind === 'sub' && -(tgt.z || 0) >= (tgt.spec?.sailUnderM || 0);
  }

  /** The search-radar switch. A targeting set is not a search emitter. */
  _radarSwitch(u, radar) {
    if (!radar || radar.kind !== 'Radar') return false;
    if (radar.role === 'Surface') return !!u.surfSearchOn;
    if (radar.role === 'Air') return !!u.airSearchOn;
    if (radar.role === 'SurfaceAndAir' || radar.role === 'AirAndSurface') return !!(u.airSearchOn || u.surfSearchOn);
    return !!u.sensorsOn;
  }

  /**
   * SensorSystem.Enable refuses a submarine mast below periscope depth or in sea state above 5,
   * and updateFoam retracts it once the keel passes periscope depth. A surfaced sail is not a mast.
   */
  /** updateFoam retracts every mast once the keel is past periscope depth plus 0.01 Unity. */
  _mastRetracted(u) {
    if (u?.kind !== 'sub' || !this._submerged(u)) return false;
    const peri = u.spec?.periscopeM || 40 * FT;
    return -(u.z || 0) > peri + 0.01 * UNITY_M;
  }

  _retractMasts(u) {
    if (!this._mastRetracted(u)) return;
    u.periscopeUp = false;
    u.esmUp = false;
    u.snorkelUp = false;
    if (u.surfSearchOn || u.airSearchOn) {
      u.surfSearchOn = false;
      u.airSearchOn = false;
      this._syncEmitters(u);
    }
  }

  /** SensorSystem.Enable while submerged: too deep, or sea state above 5. */
  _mastRefuse(u) {
    if (u?.kind !== 'sub' || !this._submerged(u)) return '';
    if (this._mastRetracted(u)) {
      const ft = Math.round((u.spec?.periscopeM || 40 * FT) / FT);
      return `Cannot raise the mast below ${ft} ft`;
    }
    if ((this.weather?.sea || 0) > 5) return 'Cannot raise the mast in this sea state';
    return '';
  }

  _radarLive(u, radar) {
    if (!this._radarSwitch(u, radar)) return false;
    if (u?.kind !== 'sub' || !this._submerged(u)) return true;
    if ((this.weather?.sea || 0) > 5) return false;
    return !this._mastRetracted(u);
  }

  /** getRaisedMastsCount: periscope, search radar, ESM and snorkel each count once. */
  _mastCount(tgt) {
    if (tgt?.kind !== 'sub' || this._mastRetracted(tgt)) return 0;
    let n = 0;
    if (tgt.periscopeUp) n++;
    if ((tgt.spec?.sensors || []).some((s) => s.kind === 'Radar' && !s.illuminator && this._radarLive(tgt, s))) n++;
    if (tgt.esmUp) n++;
    if (tgt.snorkelUp) n++;
    return n;
  }

  /**
   * CalculateVisualRange for a submerged submarine. Raised masts use a 25 nm base times
   * 0.01 per mast, faded by sea state. Otherwise only an aircraft looking down at 20° or
   * more can see the hull, and only while it is shallower than 100 ft.
   */
  _visualSubmerged(ob, tgt, d) {
    const masts = this._mastCount(tgt);
    if (masts > 0) {
      const env = this._visualEnv(ob, tgt, { masts: true });
      const sea = this.weather?.sea || 0;
      const rcs = sea > 0 ? (0.01 * masts) / 10 ** (sea / 10) : 0.01 * masts;
      let max = 0, look = 1;
      for (const s of this._eyeSensors(ob)) {
        const m = s.maxMult || 1;
        if (m >= max) { max = m; look = s.lookDown ?? 1; }
      }
      if (max === 0) {
        if (ob?.kind === 'sub' && this._submerged(ob)) return { detect: false, identify: false };
        max = 1;
      }
      const down = this._inLookDown(ob, tgt);
      const unity = 688.9874 * env * rcs * (down ? look : 1);
      let reach = unity * max * (1852 / 27.559496);
      if (!down) {
        const eye = this._eyeSensors(ob)[0];
        reach = Math.min(reach, visualHorizon(this._eyeHeightM(ob, eye), 3));
      }
      return { identify: false, detect: d < reach };
    }
    const depth = -(tgt.z || 0);
    if (depth > 0.453571 * (1852 / 27.559496)) return { detect: false, identify: false };
    if (ob.kind !== 'air') return { detect: false, identify: false };
    const slant = Math.hypot(tgt.x - ob.x, tgt.y - ob.y, (ob.z || 0) - (tgt.z || 0));
    const elev = Math.asin(Math.min(1, Math.abs((ob.z || 0) - (tgt.z || 0)) / Math.max(slant, 1e-6))) * R2D;
    if (elev < 20) return { detect: false, identify: false };
    return this._visual(ob, tgt, d, { submergedHull: true });
  }

  /**
   * SensorSystem.IsInLookDown. The line of sight must sit more than 1.5° below the
   * horizon dip. Ships and submarines are only penalised while making way (> 1 kt);
   * a stopped hull is not. LookDownMultiplier then scales both the identify and detect ranges.
   */
  _inLookDown(ob, tgt) {
    const movingHull = (tgt.kind === 'ship' || tgt.kind === 'sub') && Math.abs(tgt.speed) > KT;
    const eligible = movingHull || tgt.kind === 'land' || (ob.kind === 'air' && tgt.kind !== 'ship' && tgt.kind !== 'sub');
    if (!eligible) return false;
    const dz = tgt.z - ob.z;
    const horiz = Math.hypot(tgt.x - ob.x, tgt.y - ob.y);
    const dist = Math.hypot(horiz, dz);
    if (dist < 1) return false;
    const fromDown = Math.acos(clamp(-dz / dist, -1, 1)) * R2D;
    const horizon = radioHorizon(Math.max(ob.z, 0), 0);
    const dip = horizon > 1 ? (Math.max(ob.z, 0) / horizon) * R2D : 0;
    return fromDown + 1.5 < 90 - dip;
  }

  /**
   * SensorUtils.ModifyVisualIdentificationRangeByEnvironmentalConditions.
   * Scattered clouds cut the range in half only inside the 3,500–9,500 ft slab, or when the
   * line of sight crosses it. Rain, snow and fog apply below the cloud base. Sea state
   * applies to a submerged target. Night uses the environment.ini sun intensity.
   */
  _visualEnv(ob, tgt, opts = {}) {
    const w = this.weather || { clouds: 'clear', sun: 1, moon: 0 };
    let range = 1;
    const c = w.clouds || 'clear';
    let baseFt = 3500, topFt = 3800, factor = 1, cloudy = false;
    if (c.includes('scattered')) { cloudy = true; topFt = 9500; factor = 0.5; }
    else if (c.includes('broken')) { cloudy = true; topFt = 14500; factor = 0.25; }
    else if (c.includes('overcast')) { cloudy = true; baseFt = 3500; topFt = 9000; factor = 0.001; }
    const submerged = this._submerged(tgt);
    const oy = ob.z / FT, ty = tgt.z / FT;
    if (cloudy) {
      const inside = (y) => y > baseFt && y < topFt;
      const through = (oy > topFt && ty < baseFt) || (oy < baseFt && ty > topFt);
      // Mast detection is not blanketed just because the hull is under. A sail still
      // in the air is not submerged, so it keeps the surface visual.
      if ((submerged && !opts.masts) || inside(oy) || inside(ty) || through) range *= factor;
    }
    if (oy < baseFt || ty < baseFt) {
      if (w.rain) range *= 0.75;
      if (w.snow) range *= 0.5;
      if (w.fog) range *= 0.33;
    }
    if (submerged) {
      const sea = w.sea || 0;
      range *= sea <= 1 ? 1 : sea === 2 ? 0.9 : sea === 3 ? 0.75 : sea === 4 ? 0.5 : sea === 5 ? 0.25 : 0;
    }
    let nv = 0;
    for (const s of this._eyeSensors(ob)) nv = Math.max(nv, s.nightVision || 0);
    const sun = w.sun ?? 1;
    let light = sun < 0.025 ? 0.09 : sun;
    light += w.moon || 0;
    if (sun < 0.1) light += nv;
    else if (sun < 0.25) light += nv / 2;
    else if (sun < 0.5) light += nv / 3;
    if (sun < 0.37 && tgt.team !== 0 && tgt.kind === 'ship' && !tgt.emcon) range *= 1.5;
    if (tgt.team === 0) light = Math.max(light, 0.6);
    if (light > 1) light = 1;
    return range * light;
  }

  /**
   * SensorPosition.y, floored at the sea. A ship's mount height is the authored local Y.
   * A submarine adds RadarOffset to its origin; a negative result is the waterline.
   */
  _antennaM(ob, sensor) {
    if (ob.kind === 'air') return Math.max(0, ob.z || 0);
    if (ob.kind === 'sub') return Math.max(0, (ob.z || 0) + (sensor?.offsetM || 0));
    return sensor?.heightM > 1 ? sensor.heightM : TUNING.radarHeightShip;
  }

  /**
   * VisibleAltitude. A submerged submarine with any mast up is 3 m. A bare hull is at the
   * waterline. A surfaced hull uses the mesh top measured from its colliders.
   */
  _visibleHeightM(tgt) {
    if (!tgt) return 0;
    if (tgt.kind === 'air' || tgt.kind === 'missile') return Math.max(0, tgt.z || 0);
    if (tgt.kind === 'sub' && this._submerged(tgt)) return this._mastCount(tgt) > 0 ? 3 : 0;
    return Math.max(tgt.z || 0, tgt.spec?.visibleM || 3);
  }

  /**
   * calculateTargetReflectionValue. Broadside is the class RCS, bow and stern the frontal
   * fraction. A submerged boat with masts up is 0.01 m² per mast, faded by sea state.
   */
  _echoRcs(ob, tgt) {
    if (tgt?.kind === 'sub' && this._submerged(tgt)) {
      const masts = this._mastCount(tgt);
      if (masts > 0) {
        const sea = this.weather?.sea || 0;
        return sea > 0 ? (0.01 * masts) / 10 ** (sea / 10) : 0.01 * masts;
      }
    }
    const max = Math.max(tgt?.spec?.rcs ?? tgt?.rcs ?? 100, 1e-6);
    const min = tgt?.spec?.rcsMin ?? max * 0.5;
    const aspect = Math.abs(wrap180(bearing(ob || tgt, tgt) - (tgt.heading || 0)));
    const flank = 1 - Math.abs(aspect - 90) / 90;
    return min + (max - min) * flank;
  }

  /**
   * Search-radar createRadarEcho, then GetRangeInternal's cap. The radar equation runs
   * first; sea state above 1 multiplies a surface hull by 1 − 0.05 × sea; the authored
   * maximum then caps a search set. Fire control is the raw equation.
   */
  _radarRange(sensor, target, observer) {
    let range = radarPhysicsM(sensor, this._echoRcs(observer, target));
    const sea = this.weather?.sea || 0;
    const surfaceHull = target?.kind === 'ship' || (target?.kind === 'sub' && !this._submerged(target));
    if (!sensor?.illuminator && sea > 1 && surfaceHull) range *= 1 - 0.05 * sea;
    if (!sensor?.illuminator && sensor?.maxRangeKm > 0) range = Math.min(range, sensor.maxRangeKm * 1000);
    return range;
  }

  /**
   * SensorSystem.IsInLookDown for a radar mount. The line of sight has to sit more than
   * 1.5° under the horizon dip. Heights are the antenna and VisibleAltitude, not the keel.
   */
  _radarInLookDown(ob, sensor, tgt) {
    const hOb = this._antennaM(ob, sensor);
    const hT = this._visibleHeightM(tgt);
    const horiz = Math.hypot((tgt.x || 0) - (ob.x || 0), (tgt.y || 0) - (ob.y || 0));
    const dz = hT - hOb;
    const dist = Math.hypot(horiz, dz);
    if (dist < 1) return false;
    const fromDown = Math.acos(clamp(-dz / dist, -1, 1)) * R2D;
    const horizon = radioHorizon(hOb, 0);
    const dip = horizon > 1 ? (hOb / horizon) * R2D : 0;
    return fromDown + 1.5 < 90 - dip;
  }

  /** GetRangeInternal multiplies the capped search range, or the raw fire-control range, by LookDownMultiplier. */
  _radarReachM(ob, sensor, tgt) {
    let range = this._radarRange(sensor, tgt, ob);
    const ld = sensor?.lookDown ?? 1;
    if (ld < 1 && this._radarInLookDown(ob, sensor, tgt)) range *= ld;
    return range;
  }

  _detect() {
    this._ifOpen = true;
    this._ifCache = new Map();
    try { this._detectTeams(); }
    finally { this._ifOpen = false; this._ifCache = null; }
  }

  _detectTeams() {
    for (const team of [1, 2]) {
      const cmap = this.contacts[team];
      const observers = [...this.all()].filter((u) => u.team === team && u.active && (u.kind === 'ship' || u.kind === 'sub' || u.kind === 'air'));
      const seen = new Map();
      for (const tgt of this.all()) {
        if (tgt.team === team || !tgt.active || tgt.kind === 'shell' || tgt.kind === 'buoy') continue;
        if (tgt.kind === 'torpedo') {
          if (tgt.airborne || !tgt.searching) continue;
          let heard = false;
          for (const ob of observers) if (this._sonarHears(ob, tgt)) { heard = true; break; }
          if (!heard) heard = this._buoyHears(team, tgt);
          if (heard) seen.set(tgt.id, { level: 1, sources: { r: false, e: false, v: false, s: true, m: false } });
          continue;
        }
        let best = null;
        for (const ob of observers) {
          const d = dist2(ob, tgt);
          if (this._submerged(tgt)) {
            const sonarLoc = this._sonarLocate(ob, tgt);
            const mad = this._madHears(ob, tgt);
            const vis = this._visualSubmerged(ob, tgt, d);
            // A raised mast is a 3 m target. Only radars flagged CanDetectPeriscope paint it.
            let esm = false;
            let radar = false;
            const mast = this._mastCount(tgt) > 0;
            // ESM GetRange is the one-way equation only. It does not stop at the horizon.
            if (ob.spec?.sensors) {
              for (const s of ob.spec.sensors) if (s.kind === 'ESM' && this._esmLive(ob) && this._esmHears(s, tgt, d)) esm = true;
            }
            if (mast && ob.spec?.sensors) {
              for (const s of ob.spec.sensors) {
                if (s.kind !== 'Radar' || !s.peri || !s.maxRangeKm || !this._radarLive(ob, s)) continue;
                if (s.role === 'Air') continue;
                if (d > radioHorizon(this._antennaM(ob, s), 3)) continue;
                if (d >= s.minRangeKm * 1000 && d <= this._radarReachM(ob, s, tgt)) radar = true;
              }
            }
            if (sonarLoc || mad || vis.detect || esm || radar) {
              const src = { r: radar, e: esm, v: !!vis.detect, s: !!sonarLoc, m: mad };
              if (!best) best = { level: 1, sources: src };
              if (vis.detect) best.sources.v = true;
              if (esm) best.sources.e = true;
              if (radar) best.sources.r = true;
              if (sonarLoc) { best.sources.s = true; best.sonar = this._tighterSonar(best.sonar, sonarLoc); }
              if (mad) { best.sources.m = true; this._noteMad(best, ob, tgt, d); }
            }
            continue;
          }
          const src = { r: false, e: false, v: false, s: false, m: false };
          let level = 0;
          let sonarLoc = null;
          const vis = this._visual(ob, tgt, d);
          if (vis.identify) { level = 2; src.v = true; }
          else if (vis.detect) { level = 1; src.v = true; }
          if (ob.spec.sensors) {
            for (const s of ob.spec.sensors) {
              if (s.kind === 'Sonar' && (tgt.kind === 'sub' || tgt.kind === 'ship')) {
                // A dipped or towed head is in the water. Sonar has no horizon gate.
                const wet = !!s.tow;
                const hT = tgt.kind === 'sub' ? 0 : this._visibleHeightM(tgt);
                const dryAir = ob.kind === 'air' && !wet && d > radioHorizon(ob.z || 0, hT);
                if (!dryAir) {
                  const hit = this._sonarHit(ob, s, tgt);
                  if (hit) {
                    level = Math.max(level, 1); src.s = true;
                    sonarLoc = this._tighterSonar(sonarLoc, this._sonarLoc(s, tgt, hit));
                  }
                }
              } else if (s.kind === 'Radar' && s.maxRangeKm) {
                // GetRangeInternal horizons each mount. A submarine mast uses its own offset, not 18 m.
                if (!this._radarLive(ob, s)) continue;
                if (s.role === 'Air' && tgt.kind === 'ship') continue;
                // IsDetectableTarget rejects every air target for a surface-role radar. The loader then clears that radar's altitude brackets.
                if (s.role === 'Surface' && (tgt.kind === 'air' || tgt.kind === 'missile')) continue;
                if (tgt.kind === 'air' || tgt.kind === 'missile') { if (tgt.z < s.minAlt || (s.maxAlt && tgt.z > s.maxAlt)) continue; }
                if (d > radioHorizon(this._antennaM(ob, s), this._visibleHeightM(tgt))) continue;
                if (d >= s.minRangeKm * 1000 && d <= this._radarReachM(ob, s, tgt)) { level = Math.max(level, 1); src.r = true; }
              } else if (s.kind === 'ESM' && this._esmLive(ob) && this._esmHears(s, tgt, d)) {
                level = Math.max(level, 1); src.e = true;
              } else if (s.kind === 'MAD' && this._madHears(ob, tgt)) {
                level = Math.max(level, 1); src.m = true;
              }
            }
          }
          if (level > 0) {
            if (!best) best = { level, sources: { ...src } };
            else {
              best.level = Math.max(best.level, level);
              for (const k of ['r', 'e', 'v', 's', 'm']) best.sources[k] ||= src[k];
            }
            if (src.m) this._noteMad(best, ob, tgt, d);
            if (sonarLoc) best.sonar = this._tighterSonar(best.sonar, sonarLoc);
          }
        }
        if (tgt.kind === 'sub') {
          const buoy = this._buoyHears(team, tgt);
          if (buoy) {
            if (!best) best = { level: 1, sources: { r: false, e: false, v: false, s: true, m: false } };
            else { best.level = Math.max(best.level, 1); best.sources.s = true; }
            best.sonar = this._tighterSonar(best.sonar, buoy);
          }
        }
        if (best) seen.set(tgt.id, best);
      }
      // data link: contacts shared across the task force
      for (const [id, b] of seen) {
        const t = this.units.get(id);
        const prev = cmap.get(id);
        const known = prev && prev.level >= b.level ? prev.level : b.level;
        const track = prev?.track || this._trackSeq[team]++;
        const hostile = !!(b.sources.r && b.sources.e && t.team !== team && t.team !== 0);
        // VehicleTMAUpdate plots a bearing+range track at the truth plus one sample of the
        // measurement noise. Passive sonar range error is (pseudo·R/20)²/12 metres and bearing
        // error is beam²/112 degrees. An active echo uses 0.1 m. MAD is 5° and range/5.
        let x = t.x, y = t.y, madFix = prev?.madFix || null, madErr = null, madOb = 0;
        let sonarFix = prev?.sonarFix || null, sonarErr = null, sonarEar = null;
        const pinned = b.sources.r || b.sources.v;
        const madOnly = b.sources.m && !b.sources.s && !b.sources.r && !b.sources.e && !b.sources.v;
        if (!pinned && b.sonar && (t.kind === 'ship' || t.kind === 'sub')) {
          if (!sonarFix) sonarFix = { brg: this._gauss(), rng: this._gauss() };
          const plot = this._sonarPlot(b.sonar, t, sonarFix);
          x = plot.x; y = plot.y; sonarErr = plot.sonarErr; sonarEar = plot.sonarEar;
        } else if (madOnly && b.madOb) {
          const ob = this.units.get(b.madOb);
          if (ob) {
            if (!madFix) madFix = { brg: this._gauss(), rng: this._gauss() };
            const plot = this._madPlot(ob, t, madFix);
            x = plot.x; y = plot.y; madErr = plot.madErr; madOb = ob.id;
          }
        }
        cmap.set(id, { id, track, level: Math.max(known, b.level), sources: b.sources, hostile, x, y, z: t.z, heading: t.heading, speed: t.speed, t: this.t, live: true, kind: t.kind, madFix, madErr, madOb, sonarFix, sonarErr, sonarEar });
        if (!prev && team === this.playerTeam) {
          const word = b.sources.v ? 'visual' : b.sources.r ? 'radar' : b.sources.e ? 'ESM' : b.sources.s ? 'sonar' : b.sources.m ? 'MAD' : 'passive';
          this.emit('contact', { team, id, msg: `New ${word} contact! Designate track ${track}` });
        }
      }
      for (const [id, c] of cmap) { if (!seen.has(id)) { c.live = false; if (this.t - c.t > 120 || !this.units.get(id)?.alive) cmap.delete(id); } }
    }
    this._nbEnd();
  }

  /**
   * SensorSystemESM.GetRange, in metres. One-way radar equation:
   * sqrt(P·Gr·Ge·λ² / (4π)² / Smin). Fire-control radars are silent unless they are guiding.
   */
  /** SensorSystemSonar.GetRange: the map ring. Active kilometres while transmitting, otherwise passive. */
  _sonarReach(ob, s) {
    const km = ob.activeSonarOn ? (s.activeKm || s.passiveKm || s.maxRangeKm || 0) : (s.passiveKm || 0);
    return km * 1000;
  }

  /** CommitPassiveBatch / CommitActiveBatch: signal excess against SNRDetectionThreshold (default 5 dB). */
  _sonarExcessHears(ob, sensor, tgt, ear = ob) {
    return !!this._sonarHit(ob, sensor, tgt, ear);
  }

  /**
   * Passive and active are separate tracks. An active echo (range error 0.1 m) wins over the
   * passive pseudorange when both are above the threshold. `ear` is the hydrophone.
   */
  _sonarHit(ob, sensor, tgt, ear = ob) {
    if (!sensor) return null;
    if (sensor.tow && !this._towedLive(ob, sensor)) return null;
    if (sensor.tow) ear = this._towedEar(ob, sensor);
    const hull = tgt?.spec?.noise && tgt.spec.noise.base >= 0;
    const sea = this.weather?.sea || 0;
    const rain = !!this.weather?.rain;
    const threshold = sensor.threshold ?? 5;
    let passive = false;
    if (!sensor.activeOnly) {
      const read = this._withInterference(ob, sensor, tgt, ear) || passiveReading(ear, sensor, tgt, { sea, rain });
      let excess = read.broadband;
      const tones = [];
      for (const line of read.lines) {
        if (line.immediate) { if (line.excess >= 0) excess = Math.max(excess, line.excess); }
        else tones.push(line);
      }
      if (sensor.narrowBand && tones.length) excess = Math.max(excess, this._narrowIntegrate(ob, tgt, tones));
      if (excess >= threshold) passive = true;
    }
    let active = false;
    if (hull && ob.activeSonarOn && (sensor.outputPower || 0) > 0) active = sonarExcess(ear, sensor, tgt, { sea, active: true, rain }) >= threshold;
    if (!passive && !active) return null;
    return { active, ear };
  }

  /** Tightest range error wins, the same way merged tracks prefer the small measurement. */
  _tighterSonar(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return b.rangeStd < a.rangeStd ? b : a;
  }

  _sonarLocate(ob, tgt) {
    let best = null;
    for (const s of ob.spec?.sensors || []) {
      if (s.kind !== 'Sonar') continue;
      const hit = this._sonarHit(ob, s, tgt);
      if (hit) best = this._tighterSonar(best, this._sonarLoc(s, tgt, hit));
    }
    return best;
  }

  /**
   * ProducePassiveTracks writes TrackRangeInMeters.Error = (PseudorangeResolution·range/20)²/12.
   * CreateActiveTrack writes 0.1 m. Bearing error is AngularResolution²/112 degrees. TMAContext
   * leaves the bearing-error scale at 1.
   */
  _sonarLoc(sensor, tgt, hit) {
    const range = Math.max(1, dist2(hit.ear, tgt));
    const brgStd = ((sensor.beamDeg || 1) ** 2) / 112;
    const pseudo = sensor.pseudo ?? 1;
    const rangeStd = hit.active ? 0.1 : ((pseudo * range / 20) ** 2) / 12;
    return { rangeStd, brgStd, ox: hit.ear.x, oy: hit.ear.y, active: !!hit.active };
  }

  /** One latched sample of that measurement noise, redrawn from the current hydrophone. */
  _sonarPlot(loc, tgt, fix) {
    const range = Math.max(1, dist2({ x: loc.ox, y: loc.oy }, tgt));
    const brg = bearing({ x: loc.ox, y: loc.oy }, tgt) + fix.brg * loc.brgStd;
    const rng = Math.max(1, range + fix.rng * loc.rangeStd);
    const hv = hdgVec(brg);
    return {
      x: loc.ox + hv.x * rng,
      y: loc.oy + hv.y * rng,
      sonarEar: { x: loc.ox, y: loc.oy },
      sonarErr: { brgDeg: loc.brgStd, rngM: loc.rangeStd, crossM: range * Math.sin(loc.brgStd * D2R) },
    };
  }

  /**
   * Narrowband confidence. The first batch has zero elapsed time, so a line cannot
   * cross the threshold until a later update. Integrated excess is raw + 10·log10(confidence).
   */
  _narrowIntegrate(ob, tgt, lines) {
    if (ob._nbStamp !== this.t) {
      ob._nbDt = ob._nbAt == null ? 0 : Math.min(Math.max(0, this.t - ob._nbAt), 600);
      ob._nbAt = this.t;
      ob._nbStamp = this.t;
      ob._nbSeen = new Set();
      if (!ob._nb) ob._nb = new Map();
    }
    let best = -1000;
    for (const line of lines) {
      const key = `${tgt.id}:${line.id}`;
      ob._nbSeen.add(key);
      let c = ob._nb.get(key) || 0;
      if (line.excess >= 0) {
        const rate = Math.min(2, Math.max(0.05, line.excess / 20));
        c = Math.min(1, c + 0.025 * rate * ob._nbDt);
      } else c -= 0.02 * ob._nbDt;
      if (c <= 0) ob._nb.delete(key);
      else ob._nb.set(key, c);
      if (c > 0.001 && line.excess > -900) best = Math.max(best, line.excess + 10 * Math.log10(c));
    }
    return best;
  }

  _nbEnd() {
    for (const u of this.units.values()) {
      if (u._nbStamp !== this.t || !u._nb) continue;
      for (const [k, v] of u._nb) {
        if (u._nbSeen.has(k)) continue;
        const n = v - 0.02 * u._nbDt;
        if (n <= 0) u._nb.delete(k);
        else u._nb.set(k, n);
      }
    }
  }

  /**
   * Received levels of every noisy hull, then ApplyInterference inside this sonar's beam.
   * Own-taskforce ships mask and are not contacts. Outside _detect each call rebuilds.
   */
  _withInterference(ob, sensor, tgt, ear) {
    if (tgt?.kind !== 'ship' && tgt?.kind !== 'sub') return null;
    const map = this._interferenceMap(ob, sensor, ear);
    return map.get(tgt.id) || null;
  }

  _interferenceMap(ob, sensor, ear) {
    const build = () => {
      const sea = this.weather?.sea || 0;
      const rain = !!this.weather?.rain;
      const gain = (sensor.gain || 0) - bandGainReduction(sensor.band || 0);
      const items = [];
      for (const u of this.units.values()) {
        if (u === ob || !u.active || !u.alive) continue;
        if (u.kind !== 'ship' && u.kind !== 'sub') continue;
        if (!u.spec?.noise || u.spec.noise.base < 0 || (u.z || 0) > 0) continue;
        const read = passiveReading(ear, sensor, u, { sea, rain });
        items.push({
          id: u.id,
          interferer: u.team === ob.team,
          excess: read.broadband,
          ambient: read.ambient || 0,
          lines: read.lines,
          bearingRad: Math.atan2(u.x - ear.x, u.y - ear.y),
        });
      }
      applyInterference(items, {
        gain,
        halfBeamRad: ((sensor.beamDeg ?? 1) * Math.PI / 180) / 2,
        tier: sensor.signalProcessing || 0,
      });
      for (const it of items) it.broadband = it.excess;
      const map = new Map();
      for (const it of items) if (!it.interferer) map.set(it.id, it);
      return map;
    };
    if (!this._ifOpen) return build();
    const key = `${ob.id}:${sensor.idx}`;
    let map = this._ifCache.get(key);
    if (!map) { map = build(); this._ifCache.set(key, map); }
    return map;
  }

  _sonarHears(ob, tgt) {
    return (ob.spec.sensors || []).some((s) => s.kind === 'Sonar' && this._sonarExcessHears(ob, s, tgt));
  }

  /**
   * TowedSystem.OnFixedUpdate retracts outside the speed window. A submarine also retracts
   * when its sail is out of the water. A dipping sonar (speed 0–0) only runs from a helicopter
   * that is above the surface and at or below MaxDeployAltitude. Open ocean is 2000 m, so the
   * shallow-bottom retract stays open. Speeds and the altitude cap compare rounded knots and feet.
   */
  _towedLive(ob, sensor) {
    const tow = sensor?.tow;
    if (!tow) return true;
    if (tow.clipOn) return true;
    const kt = Math.round((ob.speed || 0) / KT);
    if (kt < Math.round(tow.minKt) || kt > Math.round(tow.maxKt)) return false;
    if (ob.kind === 'sub' && -(ob.z || 0) < (ob.spec?.sailUnderM || 0)) return false;
    if (ob.kind === 'air') {
      const altFt = (ob.z || 0) / FT;
      if (!(ob.z > 0) || Math.round(altFt) > Math.round(tow.maxAltFt ?? 60000)) return false;
    }
    return true;
  }

  /** Towed cable streams astern. A dipping head hangs under the helicopter at Depth. */
  _towedEar(ob, sensor) {
    const depth = -(sensor.tow?.depthM || 0);
    if (sensor.sonarType === 'dipping') {
      return {
        x: ob.x, y: ob.y, z: depth,
        heading: ob.heading || 0, speed: ob.speed || 0, spec: ob.spec, kind: ob.kind,
      };
    }
    const back = hdgVec((ob.heading || 0) + 180);
    const m = sensor.tow?.cableM || 0;
    return {
      x: ob.x + back.x * m, y: ob.y + back.y * m,
      z: Math.min(ob.z || 0, depth),
      heading: ob.heading || 0, speed: ob.speed || 0, spec: ob.spec, kind: ob.kind,
    };
  }

  /**
   * SensorSystemMAD.seekMADContacts. MaxDetectionRange is nautical miles (×27.559496 Unity).
   * A submarine is heard inside (displacement / 50000) of that range, halved for a low-magnetic hull.
   * A towed MAD bird is only live at or below MaxDeployAltitude and between the deploy speeds.
   */
  _madHears(ob, tgt) {
    if (tgt.kind !== 'sub' || !tgt.spec) return false;
    const kt = ob.speed / KT;
    const slant = Math.hypot(dist2(ob, tgt), ob.z - tgt.z);
    for (const s of ob.spec.sensors || []) {
      if (s.kind !== 'MAD' || !s.madNm) continue;
      if (ob.z > s.madAltFt * FT) continue;
      if (s.towed && s.madMaxKt > 0 && (kt < s.madMinKt || kt > s.madMaxKt)) continue;
      const cap = s.madNm * NM;
      let reach = ((tgt.spec.disp || 0) / 50000) * cap;
      if (tgt.spec.lowMag) reach *= 0.5;
      if (slant <= cap && slant <= reach) return true;
    }
    return false;
  }

  /** Closest MAD platform wins the fix. Slant matches the detection magnitude. */
  _noteMad(best, ob, tgt, d) {
    const slant = Math.hypot(d, ob.z - tgt.z);
    if (!best.madOb || slant < best.madSlant) { best.madOb = ob.id; best.madSlant = slant; }
  }

  /**
   * One sample of the MAD measurement noise, held for the life of the track.
   * Bearing sigma is 5°. Range sigma is a fifth of the horizontal range.
   */
  _madPlot(ob, tgt, fix) {
    const range = Math.max(1, dist2(ob, tgt));
    const brg = bearing(ob, tgt) + fix.brg * 5;
    const rng = Math.max(1, range + fix.rng * (range / 5));
    const hv = hdgVec(brg);
    return {
      x: ob.x + hv.x * rng,
      y: ob.y + hv.y * rng,
      madErr: { brgDeg: 5, rngM: range / 5, crossM: range * Math.sin(5 * D2R) },
    };
  }

  /** A submarine ESM mast is created off. Ships are not masts, so theirs stays available. */
  _esmLive(ob) {
    if (ob?.kind !== 'sub') return true;
    return !!ob.esmUp && !this._mastRetracted(ob);
  }

  _esmHears(esm, tgt, d) {
    const bands = esm.bands || [];
    const ge = 10 ** ((esm.gain || 0) / 10);
    if (ge <= 0) return false;
    let reach = 0;
    for (const radar of tgt.spec.sensors || []) {
      if (radar.kind !== 'Radar' || radar.illuminator || !radar.peakPower) continue;
      const freq = String(radar.frequency || '').toLowerCase();
      if (bands.length && freq && !bands.includes(freq)) continue;
      if (!this._radarLive(tgt, radar)) continue;
      const wl = BAND_M[freq] || BAND_M.undefined;
      const gr = 10 ** ((radar.gain || 0) / 10);
      const metres = Math.sqrt(radar.peakPower * gr * ge * wl * wl / FOUR_PI_SQ / ESM_SMIN);
      if (metres > reach) reach = metres;
    }
    return reach > 0 && d <= reach;
  }

  _syncEmitters(u) { u.sensorsOn = !!(u.airSearchOn || u.surfSearchOn); }

  hasSearchRadar(u, group) {
    return (u.spec.sensors || []).some((s) => s.kind === 'Radar' && (group === 'surf' ? s.role === 'Surface' : (s.role === 'Air' || s.role === 'SurfaceAndAir')));
  }

  _raiseMast(u, raising) {
    if (!raising) return true;
    const why = this._mastRefuse(u);
    if (!why) return true;
    u.orderText = why;
    return false;
  }

  toggleAirSearch(u) {
    if (!this.hasSearchRadar(u, 'air')) return false;
    if (!u.airSearchOn && !this._raiseMast(u, true)) return false;
    u.airSearchOn = !u.airSearchOn;
    this._syncEmitters(u);
    this._syncEmcon(u);
    return true;
  }

  toggleSurfaceSearch(u) {
    if (!this.hasSearchRadar(u, 'surf')) return false;
    if (!u.surfSearchOn && !this._raiseMast(u, true)) return false;
    u.surfSearchOn = !u.surfSearchOn;
    this._syncEmitters(u);
    this._syncEmcon(u);
    return true;
  }

  togglePeriscope(u) {
    if (u?.kind !== 'sub' || !(u.spec?.sensors || []).some((s) => s.kind === 'Periscope')) return false;
    if (!u.periscopeUp && !this._raiseMast(u, true)) return false;
    u.periscopeUp = !u.periscopeUp;
    u.orderText = u.periscopeUp ? 'Raise the scope' : 'Lower the scope';
    return true;
  }

  toggleEsm(u) {
    if (u?.kind !== 'sub' || !(u.spec?.sensors || []).some((s) => s.kind === 'ESM')) return false;
    if (!u.esmUp && !this._raiseMast(u, true)) return false;
    u.esmUp = !u.esmUp;
    u.orderText = u.esmUp ? 'Raise the ESM mast' : 'Lower the ESM mast';
    return true;
  }

  toggleSnorkel(u) {
    if (u?.kind !== 'sub' || !(u.spec?.snorkelKt > 0)) return false;
    if (u.snorkelUp) { u.snorkelUp = false; u.orderText = 'Lower the snorkel'; return true; }
    if (!this._raiseMast(u, true)) return false;
    if (Math.abs((u.speed || 0) / KT) > u.spec.snorkelKt + 0.1) {
      u.orderText = `Cannot snorkel above ${u.spec.snorkelKt} kt`;
      return false;
    }
    u.snorkelUp = true;
    u.orderText = 'Raise the snorkel';
    return true;
  }

  /**
   * setEMCON(true) kills search radars, active sonar, and leaves them off.
   * CheckEMCON then keeps the flag set until a radar or the active sonar is switched on.
   */
  setEmcon(u, on) {
    u.emcon = !!on;
    if (u.emcon) {
      u.airSearchOn = false;
      u.surfSearchOn = false;
      u.activeSonarOn = false;
      for (const d of u.decoy || []) { d.wanted = false; d.on = false; }
      this._syncEmitters(u);
    }
    this._syncEmcon(u);
  }

  /** CheckEMCON: silent when no search radar and no active sonar is transmitting. */
  _syncEmcon(u) {
    if (!u) return;
    u.emcon = !(u.airSearchOn || u.surfSearchOn || u.activeSonarOn);
  }

  toggleEmcon(u) { this.setEmcon(u, !u.emcon); }

  /** SensorSystemSonar.ToggleActiveCommand flips that sonar's IsActive. A set with no active range cannot ping. */
  hasActiveSonar(u) {
    return (u?.spec?.sensors || []).some((s) => s.kind === 'Sonar' && ((s.activeKm || 0) > 0 || (s.outputPower || 0) > 0));
  }

  toggleActiveSonar(u) {
    if (!this.hasActiveSonar(u)) return false;
    u.activeSonarOn = !u.activeSonarOn;
    this._syncEmcon(u);
    return true;
  }

  // ObjectBaseViewModel.CycleRuleOfEngagement: Tight → Hold → Free → Tight.
  cycleRoe(u) {
    const next = u.roe === 'tight' ? 'hold' : u.roe === 'hold' ? 'free' : 'tight';
    u.roe = next;
    return next;
  }

  setRoe(u, roe) {
    if (roe === 'tight' || roe === 'hold' || roe === 'free') u.roe = roe;
    return u.roe;
  }

  /**
   * AI.GetPossibleTargetsList when status != Free.
   * Units: only something already in our threat list, inside 275.59497 render
   * units (10 nm), and the shooter is not an aircraft. Missiles aimed at our
   * side stay engageable. Weapons Free skips this gate.
   */
  canAutoEngage(u, target) {
    if (!u?.alive || !target?.alive) return false;
    // Weapons Hold blocks automatic fire, including fire at incoming weapons.
    if (u.roe === 'hold') return false;
    if (u.roe === 'free') return true;
    // AI.GetPossibleTargetsList: a weapon is engaged on Tight when it is homing on this taskforce.
    if (target.kind === 'missile' || target.kind === 'shell' || target.kind === 'torpedo') {
      const vic = this.units.get(target.targetId);
      return !!(vic && vic.team === u.team);
    }
    // Surface units only shoot back at a unit already in _threats, and only inside 10 nm (275.59 Unity).
    if (u.kind === 'air') return false;
    if (!u.threats?.has(target.id)) return false;
    return dist2(u, target) <= 10 * NM;
  }

  /** Is unit `u` visible to the player (for rendering / UI)? */
  playerSees(u) {
    if (this.revealAll || u.team === this.playerTeam || u.team === 0 && false) return true;
    const c = this.contacts[this.playerTeam]?.get(u.id);
    return !!(c && c.live);
  }

  // --------------------------------------------------------------- defense --
  // WeaponSystemChaff launches when a missile is inside ReactionRange (nm × 27.559496)
  // and the ship is not at Weapons Hold. The bloom collider is a sphere of scale 7
  // (radius 3.5 Unity units). CIWS acquires out to twice gun range, waits out
  // ReactionTime, then fires at FireRate. Hits are Poisson draws from the calibrated
  // dispersion, and they land one time of flight later. ECM jams an active radar
  // seeker once. Noisemakers are manual.
  _stepDefense(dt) {
    for (const c of this.clouds) c.left -= dt;
    this.clouds = this.clouds.filter((c) => c.left > 0);
    for (const u of this.units.values()) {
      if (!u.alive) continue;
      for (const c of u.chaff || []) if (c.cool > 0) c.cool = Math.max(0, c.cool - dt);
      for (const n of u.noise || []) if (n.cool > 0) n.cool = Math.max(0, n.cool - dt);
      for (const g of u.ciws || []) {
        if (g.cool > 0) g.cool = Math.max(0, g.cool - dt);
        // WeaponSystem.OnUpdate finishes a gun or CIWS reload once ReloadTime has elapsed.
        if (g.reload > 0) {
          g.reload -= dt;
          if (g.reload <= 0) {
            g.reload = 0;
            if (g.readyCap > 0) g.ready = Math.min(g.readyCap, u.ammo[g.ammoId] || 0);
          }
        }
      }
      if (u.roe === 'hold') continue;
      if (u.roe === 'tight') this._autoDefend(u);
      const inbound = [];
      for (const m of this.units.values()) {
        if (m.alive && m.kind === 'missile' && m.targetId === u.id && m.team !== u.team) inbound.push(m);
      }
      if (inbound.length) {
        this._stepChaff(u, inbound);
        this._stepEcm(u, inbound);
      }
      // A missile threat is answered at any ROE except hold. Aircraft need weapons free.
      if (inbound.length || u.roe === 'free') this._stepCiws(u, inbound, dt);
    }
  }

  /** Weapons Tight shoots an incoming weapon that is aimed at this taskforce. Hold does not. */
  _autoDefend(u) {
    if (u.cooldown > 0 || (u.kind !== 'ship' && u.kind !== 'air' && u.kind !== 'land')) return;
    let best = null, bestD = 1e12;
    for (const m of this.units.values()) {
      if (!m.alive || m.team === u.team || (m.kind !== 'missile' && m.kind !== 'shell' && m.kind !== 'torpedo')) continue;
      if (!this.canAutoEngage(u, m)) continue;
      const d = dist2(u, m);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (!best) return;
    const options = this.firableAmmo(u, best);
    if (!options.length) return;
    options.sort((a, b) => (a.spec.target === 'AAW' ? 0 : 1) - (b.spec.target === 'AAW' ? 0 : 1));
    this.fire(u, options[0].id, best, 'auto');
  }

  _stepChaff(u, inbound) {
    if (!u.chaff?.length) return;
    let nearest = inbound[0], nearestD = dist2(u, nearest);
    for (const m of inbound) { const d = dist2(u, m); if (d < nearestD) { nearest = m; nearestD = d; } }
    const dNm = nearestD / NM;
    u.chaff.forEach((c, i) => {
      if (c.cool > 0 || c.left < 1 || dNm > (c.reactionNm || 2.7)) return;
      c.left--;
      c.cool = c.reloadS || 60;
      const side = hdgVec(bearing(u, nearest) + (i % 2 ? 90 : -90));
      this.clouds.push({
        kind: 'chaff', team: u.team, spoof: c.spoof ?? 0.5,
        rcs: u.spec?.ammoSpecs?.[c.ammoId]?.rcs || 100000,
        x: u.x + side.x * 300, y: u.y + side.y * 300,
        r: 3.5 * (NM / 27.559496), left: c.effectS || 50,
      });
      this.emit('chaff', { id: u.id, msg: `${u.name} launches chaff` });
    });
  }

  _stepCiws(u, inbound, dt) {
    for (const g of u.ciws || []) {
      const ammo = u.ammo[g.ammoId] || 0;
      // Threats first: a missile or bomb aimed at this ship. Aircraft are only
      // considered once that list is empty, and only with weapons free.
      let best = null, bestD = Infinity;
      for (const m of inbound) {
        if (!m.alive) continue;
        const d = dist2(u, m);
        if (d > g.maxRangeNm * 2 * NM) continue;
        if (Math.abs(wrap180(bearing(m, u) - m.heading)) > 80) continue;
        if (g.arcSet && !this._inFiringArc(u, g.arcs, m)) continue;
        if (!this._ciwsElevOk(u, g, m)) continue;
        if (d < bestD) { best = m; bestD = d; }
      }
      if (!best && u.roe === 'free' && (g.pkAir || 0) > 0) {
        const reach = g.maxRangeNm * NM;
        for (const m of this.units.values()) {
          if (!m.alive || m.kind !== 'air' || m.team === u.team || m.team === 0) continue;
          if (!this.contacts[u.team]?.get(m.id)?.live) continue;
          const d = dist2(u, m);
          if (d > reach) continue;
          if (g.arcSet && !this._inFiringArc(u, g.arcs, m)) continue;
          if (!this._ciwsElevOk(u, g, m)) continue;
          if (d < bestD) { best = m; bestD = d; }
        }
      }
      // HoldsCurrentEngagement. ReactionTime is also how long the mount stays on
      // the target it already has. A missile still takes the lock from an aircraft.
      if (best && g.lock && best.id !== g.lock && this._ciwsKeep(u, g, best)) {
        const kept = this.units.get(g.lock);
        best = kept;
        bestD = dist2(u, kept);
      }
      if (!best) { g.lock = 0; g.firing = false; g.coast = 0; continue; }
      // The Phalanx mount is a gun, so tracking a missile also pulls time compression down.
      this._capGunTime();
      if (g.lock !== best.id) {
        g.lock = best.id; g.arm = 0; g.fired = 0; g.seen = 0; g.hitAt = null; g.trackAt = this.t; g.tick = 0; g.firing = false; g.coast = 0; g.holdM = 0; g.cycleAt = null;
      }
      g.arm += dt;
      const drum = !(g.readyCap > 0) || (g.reload <= 0 && g.ready >= 1);
      const inRange = bestD <= g.maxRangeNm * NM && ammo >= 1 && drum;
      const volleyOpen = !(g.volleyMax > 0) || g.fired < g.volleyMax;
      const want = g.cool <= 0 && g.arm >= (g.reactionS || 0) && inRange && volleyOpen;
      const ranging = (g.ranging || 0) > 0;
      const inBand = !ranging || ((g.volleyM || 0) > 0 && bestD <= g.volleyM);
      let open = false;
      if (!ranging) {
        if (want && !g.holdM) g.holdM = this._ciwsHold(u, g, best);
        open = want && bestD <= (g.holdM || Infinity);
      } else if (want && inBand) {
        open = true;
      } else if (want && g.firing && g.fired < g.ranging) {
        open = true;
      } else if (want && (g.cycleAt == null || this.t - g.cycleAt >= (g.rangeInterval || 2))) {
        g.fired = 0;
        g.cycleAt = this.t;
        open = true;
      }
      if (open && !g.firing) {
        g.firing = true;
        g.hitAt = this.t + this._ciwsFlight(u, g, best);
      } else if (!open && g.firing) {
        g.firing = false;
        g.coast = this._ciwsFlight(u, g, best);
        if (g.volleyMax > 0 && g.fired >= g.volleyMax) g.cool = g.cooldownS || 3;
      }
      if (g.firing) {
        const rps = (g.fireRate || 0) / 60;
        g.tick = (g.tick || 0) + dt;
        if (g.tick > 0.2) {
          let n = Math.floor(rps * g.tick);
          if (n < 1) n = 1;
          n = Math.min(n, u.ammo[g.ammoId] || 0);
          if (g.readyCap > 0) n = Math.min(n, g.ready);
          const roundCap = ranging && !inBand ? g.ranging : (g.volleyMax > 0 ? g.volleyMax : Infinity);
          if (roundCap < Infinity) n = Math.min(n, Math.max(0, roundCap - (g.fired || 0)));
          if (n > 0) {
            u.ammo[g.ammoId] -= n;
            if (g.readyCap > 0) g.ready -= n;
            g.fired = (g.fired || 0) + n;
          }
          g.tick = 0;
          // An empty drum starts StartReload. Rounds already left the magazine as they were fired.
          if (g.readyCap > 0 && g.ready < 1) {
            g.firing = false;
            g.coast = this._ciwsFlight(u, g, best);
            if ((u.ammo[g.ammoId] || 0) > 0) g.reload = g.reloadS > 0 ? g.reloadS : 900;
          } else if (ranging && !inBand && g.fired >= g.ranging) {
            g.firing = false;
            g.coast = this._ciwsFlight(u, g, best);
          } else if (g.volleyMax > 0 && g.fired >= g.volleyMax) {
            g.firing = false;
            g.cool = g.cooldownS || 3;
            g.coast = this._ciwsFlight(u, g, best);
          }
        }
        this._ciwsResolve(u, g, best, dt);
      } else if ((g.coast || 0) > 0) {
        g.coast -= dt;
        this._ciwsResolve(u, g, best, dt);
      }
    }
  }

  /**
   * HoldsCurrentEngagement. The current target stays until ReactionTime has passed,
   * unless it has left the arc or a missile is replacing an aircraft.
   */
  _ciwsKeep(u, g, candidate) {
    const dwell = g.reactionS || 0;
    if (!(dwell > 0)) return false;
    const cur = this.units.get(g.lock);
    if (!cur?.alive) return false;
    if (this.t - (g.trackAt || 0) >= dwell) return false;
    if (cur.kind !== 'missile' && cur.kind !== 'air' && (cur.z || 0) < -2) return false;
    if (g.arcSet && !this._inFiringArc(u, g.arcs, cur)) return false;
    if (!this._ciwsElevOk(u, g, cur)) return false;
    if (candidate.kind === 'missile' && cur.kind !== 'missile') return false;
    return true;
  }

  /** IsTargetInVerticalFiringArc. 0,0 is the whole sphere. The angle is the line of sight above the deck. */
  _ciwsElevOk(u, g, m) {
    const arc = g.elevArc;
    if (!arc || arc.length < 2 || (arc[0] === 0 && arc[1] === 0)) return true;
    const horiz = Math.max(dist2(u, m), 0.01);
    const elev = Math.atan2((m.z || 0) - (u.z || 0), horiz) * R2D;
    return elev >= arc[0] && elev <= arc[1];
  }

  /** Line-of-sight rate (deg/s) of target relative to the mount. */
  _ciwsRate(u, m) {
    const dx = m.x - u.x, dy = m.y - u.y;
    const d = Math.hypot(dx, dy) || 1;
    const mv = hdgVec(m.heading || 0);
    const sv = hdgVec(u.heading || 0);
    const rvx = mv.x * (m.speed || 0) - sv.x * (u.speed || 0);
    const rvy = mv.y * (m.speed || 0) - sv.y * (u.speed || 0);
    const tangential = rvx * (-dy / d) + rvy * (dx / d);
    return Math.abs(tangential) / d * (180 / Math.PI);
  }

  _ciwsCal(g, ammo) {
    if (g._cal) return g._cal;
    g._cal = calibrateCiws(g, ammo);
    return g._cal;
  }

  _ciwsSim(u, g, m) {
    const ammo = u.spec?.ammoSpecs?.[g.ammoId] || {};
    const cal = this._ciwsCal(g, ammo);
    const dx = m.x - u.x, dy = m.y - u.y, dz = (m.z || 0) - (u.z || 0);
    const range = Math.hypot(dx, dy, dz);
    const mv = hdgVec(m.heading || 0);
    const sv = hdgVec(u.heading || 0);
    const mvx = mv.x * (m.speed || 0);
    const mvy = mv.y * (m.speed || 0);
    const svx = sv.x * (u.speed || 0);
    const svy = sv.y * (u.speed || 0);
    const closing = range > 0.01 ? -((mvx - svx) * dx + (mvy - svy) * dy) / range : 0;
    const nose = hdgVec(m.heading || 0);
    const head = range > 0.01 ? Math.abs((nose.x * dx + nose.y * dy) / range) : 1;
    // BuildBurstContext adds the missile's weave to the line-of-sight rate, then
    // refuses the burst when that exceeds the mount's train rate. Aircraft weave is 0.
    const evadeDeg = m.kind === 'air' ? 0 : Math.max(0, m.spec_?.evadeDeg || 0);
    const rate = this._ciwsRate(u, m) + evadeDeg;
    const slew = Math.max(10, g.train || 10);
    let error = 1;
    if ((u.kind === 'ship' || u.kind === 'sub') && (this.weather?.sea || 0) > 4) error = 1 + 0.15 * (this.weather.sea - 4);
    const speed = ammo.muzzle || 800;
    const damage = (ammo.power || 0) * (g.dmgMult || 1);
    // An aircraft uses the airframe calibration: wider sigma, no rake, and it is not a wreck to shred late.
    const air = m.kind === 'air';
    const health = air
      ? this._airframeHealth(m.spec?.emptyKg || 5000)
      : this._missileHealth((m.spec_?.massKg || ammo.massKg || 700) - (m.spec_?.fuelKg || 0));
    const up = range > 0.01 ? dz / range : 0;
    return {
      fc: { mode: g.fcMode || 'Director', gain: 1, spot: 1, tracks: g.fcMode === 'ClosedLoop', manual: g.fcMode === 'Manual' },
      disp: cal.disp, sigmaFcs: air ? cal.sigmaAir : cal.sigmaMissile, error, stress: 1 + 2 * (rate / slew) ** 2,
      hitRate: 1, settle: 3, speed, maxRange: ammo.maxRangeM || g.maxRangeNm * NM,
      area: air ? presentedBody(m.spec || {}, head, up) : presentedArea(m.spec_ || ammo, head), targetSpeed: m.speed || 0,
      evadeAccel: (m.speed || 0) * evadeDeg * (Math.PI / 180),
      rps: (g.fireRate || 0) / 60, burst: Math.max(0.2, g.burstS || 1),
      closing, range, rate, slew, damage, health, canTrack: rate <= slew,
    };
  }

  _ciwsFlight(u, g, m) {
    const p = this._ciwsSim(u, g, m);
    const meetK = p.speed > 1 ? p.speed / (p.speed + Math.max(0, p.closing)) : 1;
    return timeOfFlight(p, Math.max(30, p.range * meetK));
  }

  _ciwsHold(u, g, m) {
    const p = this._ciwsSim(u, g, m);
    const avail = g.volleyMax > 0 ? Math.min(u.ammo[g.ammoId] || 0, g.volleyMax) : (u.ammo[g.ammoId] || 0);
    return holdFireRange(p, avail);
  }

  /**
   * ResolveFireTick. Rounds spend a time of flight in the air. A hit inside the
   * last 0.4 s does not stop the missile unless the burst has shredded it, and
   * inside 0.2 s nothing stops it.
   */
  _ciwsResolve(u, g, m, dt) {
    if (!m?.alive) return;
    const p = this._ciwsSim(u, g, m);
    if (!p.canTrack) return;
    if (g.hitAt == null || this.t < g.hitAt) return;
    const rounds = p.rps * dt;
    if (!(rounds > 0)) return;
    const age = Math.max(0, this.t - (g.trackAt || this.t));
    const seen = g.seen || 0;
    const meetK = p.speed > 1 ? p.speed / (p.speed + Math.max(0, p.closing)) : 1;
    const meet = Math.max(30, p.range * meetK);
    const lambda = expectedHits(p, meet, age, seen, rounds);
    g.seen = seen + rounds;
    const hits = samplePoisson(lambda, () => this.rng());
    if (!hits) return;
    const vital = clamp(0.3 * p.damage / Math.max(0.05, p.health), 0, 1);
    let dealt = 0;
    let vitalHit = false;
    for (let i = 0; i < hits; i++) {
      if (!vitalHit && this.rng() < vital) vitalHit = true;
      dealt += variedHit(p.damage, this.rng());
    }
    m._ciwsDamage = (m._ciwsDamage || 0) + dealt;
    if (vitalHit) m._ciwsDamage = Math.max(m._ciwsDamage, p.health);
    const late = m.kind !== 'air' && p.closing > 1 && meet / p.closing < 0.4;
    const tooLate = m.kind !== 'air' && p.closing > 1 && meet / p.closing < 0.2;
    const worn = m._ciwsDamage >= p.health;
    const stopped = worn && !late;
    const shredded = !tooLate && m._ciwsDamage >= p.health * 1.5;
    if (!g._said) {
      g._said = true;
      this.emit('ciws', { id: u.id, msg: `${u.name} CIWS engages ${m.name}` });
    }
    if (stopped || shredded) {
      g.firing = false;
      g.coast = 0;
      if (m.kind === 'air') this._damage(m, m.hp, u);
      else { m.alive = false; this._releaseGuide(m); }
      this.emit('ciws', { id: u.id, msg: `${u.name} CIWS destroys ${m.name}` });
    }
  }

  _stepEcm(u, inbound) {
    if (!u.ecm?.length) return;
    // setEMCON ceases Offensive and Universal jammers. Defensive sets keep working.
    const sets = u.ecm.filter((e) => !(u.emcon && (e.ecmType === 'Offensive' || e.ecmType === 'Universal')));
    if (!sets.length) return;
    const jam = Math.max(...sets.map((e) => e.jam || 0));
    for (const m of inbound) {
      if (!m.alive || m._jamChecked) continue;
      const guidance = m.spec_?.guidance;
      if (guidance !== 2 && guidance !== 3) continue;
      if (dist2(u, m) > (m.spec_.seekerNm || 10) * NM) continue;
      m._jamChecked = true;
      let chance = jam - (m.spec_.antiJam ?? 1);
      if (chance < 0.01) chance = 0.01;
      if (this.rng() < chance) {
        m.jammed = true;
        m.jamBias = 1.8898791 * (NM / 27.559496);
        this.emit('ecm', { id: u.id, msg: `${u.name} jams ${m.name}` });
      }
    }
  }

  /** Noisemaker ejector. The briefing requires the player to do this by hand. */
  deployNoisemaker(u) {
    const n = u?.noise?.[0];
    if (!n) return false;
    const have = u.ammo[n.ammoId] || 0;
    if (have < 1 || n.cool > 0) return false;
    u.ammo[n.ammoId] = have - 1;
    n.cool = n.reloadS || 30;
    const back = hdgVec(wrap360(u.heading + 180));
    this.clouds.push({ kind: 'noise', team: u.team, x: u.x + back.x * 80, y: u.y + back.y * 80, r: 120, left: n.lifeS || 360, spoof: n.spoof || 0.7 });
    this.emit('noise', { id: u.id, msg: `${u.name} deploys a noisemaker` });
    return true;
  }

  // --------------------------------------------------------------------- AI --
  /**
   * CheckIfAlreadyHandled. One decision accepts a single engage task. The mount then
   * releases the remaining shots on its fire-rate interval instead of all at once.
   */
  _ai(u) {
    if (u.engage?.left > 0) { this._releaseEngage(u); return; }
    const cmap = this.contacts[u.team];
    if (!cmap) return;
    const ranked = [];
    for (const c of cmap.values()) {
      if (!c.live) continue;
      const t = this.units.get(c.id); if (!t || !t.alive || t.team === 0 || t.kind === 'sub') continue;
      const d = dist2(u, t);
      if (c.level < 2 && t.kind === 'ship' && d > 20 * NM) continue; // need ID to shoot surface targets at long range
      if (!this.canAutoEngage(u, t)) continue;
      ranked.push({ t, d });
    }
    ranked.sort((a, b) => a.d - b.d);
    for (const { t: best } of ranked) {
      if (this._targetHandled(u, best)) continue;
      const options = this.firableAmmo(u, best);
      if (!options.length) continue;
      options.sort((a, b) => b.spec.maxRangeNm - a.spec.maxRangeNm);
      const choice = best.kind === 'ship' ? options.find((o) => o.spec.type === 'Missile') || options[0] : options[0];
      if (choice.spec.type === 'Projectile') {
        if (u.cooldown > 0) return;
        this.fire(u, choice.id, best, 'auto');
        return;
      }
      const salvo = Math.min(this._aiSalvo(u, best, choice.spec, choice.count), choice.count);
      this._openEngage(u, choice.id, best, salvo, 'auto');
      if (best.threats) best.threats.add(u.id);
      this._releaseEngage(u);
      return;
    }
  }

  /**
   * WeaponMount.rotate. A trainable rail is done inside 1° of bearing and 0.2° of elevation.
   * A fixed tube is done inside 0.5° of its LaunchAngle. A mount that cannot rotate is already ready.
   */
  _aimWeapon(u, a, target) {
    const list = (u.spec?.weapons || []).filter((w) => (w.ammo || []).some((x) => x.id === a.id) && w.kind !== 'Gun' && w.kind !== 'CIWS' && w.kind !== 'Chaff');
    const tubes = u.kind === 'air' ? [] : list.filter((w) => w.tubeDeg != null);
    if (!tubes.length) return list.find((w) => w.mountRot) || list[0] || null;
    const rel = wrap180(bearing(u, target) - (u.heading || 0));
    let tube = tubes[0], gap = Infinity;
    for (const w of tubes) {
      const d = Math.abs(wrap180(w.tubeDeg - rel));
      if (d < gap) { gap = d; tube = w; }
    }
    return tube;
  }

  _slewMount(store, idx, want, tol, rate, dt, wrap) {
    const now = store[idx] || 0;
    const err = wrap ? wrap180(want - now) : want - now;
    if (Math.abs(err) <= tol || !(rate > 0) || !(dt > 0)) return;
    const step = Math.min(Math.abs(err) - tol, rate * dt);
    store[idx] = wrap ? wrap180(now + Math.sign(err) * step) : now + Math.sign(err) * step;
  }

  _launcherReady(u, a, target, dt) {
    const weapon = this._aimWeapon(u, a, target);
    if (!weapon?.mountRot) return true;
    if (!u.mounts) u.mounts = {};
    if (!u.elev) u.elev = {};
    if (u.mounts[weapon.idx] == null) u.mounts[weapon.idx] = 0;
    if (u.elev[weapon.idx] == null) u.elev[weapon.idx] = 0;
    const rel = wrap180(bearing(u, target) - (u.heading || 0));
    const fixed = weapon.tubeDeg != null;
    let want = fixed ? weapon.tubeDeg : rel;
    let inArc = true;
    if (!fixed && weapon.arcSet) {
      const lo = Math.min(weapon.arcs[0], weapon.arcs[1]);
      const hi = Math.max(weapon.arcs[0], weapon.arcs[1]);
      inArc = rel >= lo && rel <= hi;
      if (!inArc) want = clamp(rel, lo, hi);
    }
    const tol = fixed ? 0.5 : 1;
    this._slewMount(u.mounts, weapon.idx, want, tol, weapon.train || 0, dt, true);
    let elevOk = true;
    if (weapon.containersRot && (weapon.elevRate || 0) > 0) {
      const wantEl = this._launchPitch(u, a, target);
      this._slewMount(u.elev, weapon.idx, wantEl, 0.2, weapon.elevRate, dt, false);
      elevOk = Math.abs(wantEl - u.elev[weapon.idx]) <= 0.2 + 1e-4;
    }
    const brgOk = Math.abs(wrap180(want - u.mounts[weapon.idx])) <= tol + 1e-4;
    return inArc && brgOk && elevOk;
  }

  /** The first SharedLaunchInterval written for a SystemName. Later mounts of that name reuse it. */
  _sharedGap(u, weapon) {
    const name = weapon?.system;
    if (!name) return 0;
    for (const w of u.spec?.weapons || []) {
      if (w.system === name && w.sharedLaunch != null) return w.sharedLaunch;
    }
    return 0;
  }

  _stampShared(u, weapon) {
    const gap = this._sharedGap(u, weapon);
    if (!(gap > 0) || !weapon?.system) return;
    if (!u.launchAt) u.launchAt = {};
    u.launchAt[weapon.system] = this.t;
  }

  _sharedBlocks(u, weapon) {
    const gap = this._sharedGap(u, weapon);
    if (!(gap > 0) || !weapon?.system) return false;
    const last = u.launchAt?.[weapon.system];
    return last != null && this.t - last < gap - 1e-6;
  }

  /**
   * isInRearAspect. Only an aircraft is gated. The shooter must sit inside TargetRearCone,
   * measured from the tail, or the engage is refused.
   */
  _inRearAspect(shooter, target, ammo) {
    if (!ammo?.rearAspect) return true;
    if (target?.kind !== 'air') return true;
    const tail = hdgVec(wrap360((target.heading || 0) + 180));
    const dx = (shooter?.x || 0) - (target.x || 0);
    const dy = (shooter?.y || 0) - (target.y || 0);
    const dz = (shooter?.z || 0) - (target.z || 0);
    const mag = Math.hypot(dx, dy, dz);
    if (mag < 1) return true;
    const angle = Math.acos(clamp((tail.x * dx + tail.y * dy) / mag, -1, 1)) * R2D;
    return angle < (ammo.rearCone || 0) / 2;
  }

  /** The ammunition section named for this launcher. Absent, the round does not wait on the rail. */
  _railWarmup(a, weapon) {
    if (!a?.railWarmup || !weapon?.system) return 0;
    return a.railWarmup[weapon.system] || 0;
  }

  /** 60 / FireRate, and never shorter than the ship torpedo delay or the shared launch wait. */
  _launchInterval(u, a, weapon) {
    const wpn = weapon || (u.spec?.weapons || []).find((w) => (w.ammo || []).some((x) => x.id === a?.id));
    const rate = wpn?.fireRate > 0 ? 60 / wpn.fireRate : 1;
    const torp = a?.type === 'Torpedo' ? (u.spec?.torpedoDelay || 0) : 0;
    return Math.max(rate, torp, this._sharedGap(u, wpn));
  }

  /** HandleEngageTasks hands the mount one shot. A salvo then uses SalvoFireTime; the next salvo waits the full interval. */
  _releaseEngage(u) {
    const e = u.engage;
    if (!e || e.left <= 0) { u.engage = null; return; }
    const target = this.units.get(e.targetId);
    if (!target?.alive) { u.engage = null; return; }
    const a = u.spec?.ammoSpecs?.[e.ammoId];
    if (a?.rearAspect && !this._inRearAspect(u, target, a)) { u.engage = null; return; }
    const prev = e.aimedAt ?? this.t;
    const readyAt = e.readyAt ?? prev;
    if ((e.react || 0) > 0 && this.t <= readyAt + 1e-9) { e.aimedAt = this.t; return; }
    const slewFrom = (e.react || 0) > 0 ? Math.max(prev, readyAt) : prev;
    const aimDt = Math.max(0, this.t - slewFrom);
    e.aimedAt = this.t;
    const weapon = a ? this._aimWeapon(u, a, target) : null;
    // OnRailWarmup runs after the mount is aimed and does not keep training during the wait.
    const rail = this._railWarmup(a, weapon);
    if (rail > 0 && e.railAt != null && this.t + 1e-6 < e.railAt + rail) { e.aimedAt = this.t; return; }
    if (a && !this._launcherReady(u, a, target, aimDt)) return;
    if (rail > 0 && e.railAt == null) { e.railAt = this.t; return; }
    // PreLaunchDelay starts when the hatches open, after the rail wait. It holds the first round only.
    const pre = weapon?.preLaunch || 0;
    if (pre > 0 && !e.preDone) {
      if (e.preAt == null) { e.preAt = this.t; return; }
      if (this.t + 1e-6 < e.preAt + pre) return;
      e.preDone = true;
    }
    let guard = 0;
    while (e.left > 0 && this.t + 1e-6 >= e.nextAt && guard++ < 12) {
      if ((e.burst || 0) === 0 && weapon && this._sharedBlocks(u, weapon)) return;
      u.cooldown = 0;
      if (!this.fire(u, e.ammoId, target, 'mount')) { u.engage = null; return; }
      e.left--;
      const salvoN = weapon?.salvoN || 1;
      const more = (e.burst || 0) + 1 < salvoN && e.left > 0;
      e.burst = more ? (e.burst || 0) + 1 : 0;
      const interval = more ? Math.max(0, weapon?.salvoDt ?? 1) : this._launchInterval(u, a, weapon);
      e.nextAt = this.t + interval;
      if (interval <= 0 && !more) break;
    }
    if (e.left <= 0) u.engage = null;
  }

  /** CommonLaunchSettings records the first launch and the predicted impact plus 20 s. */
  _noteBracket(u, a, target) {
    if (!target || (target.kind !== 'ship' && target.kind !== 'sub' && target.kind !== 'land')) return;
    if (a?.type !== 'Missile' && a?.type !== 'Torpedo') return;
    const family = a.type === 'Torpedo' ? 'torpedo' : 'missile';
    const key = `${u.team}:${target.id}:${family}`;
    const knots = a.type === 'Torpedo' ? (a.maxKt || a.runKt || 40) : (a.vmaxKt || 400);
    const tof = dist3(u, target) / Math.max(1, knots * KT) + 20;
    const prev = this._brackets.get(key);
    const launch = !prev || prev.hit < this.t ? this.t : prev.launch;
    this._brackets.set(key, { launch, hit: this.t + tof });
  }

  _satLimit(target, family) {
    if (target.kind === 'missile' || target.kind === 'torpedo') {
      return family === 'torpedo' ? (target.spec?.maxTorpedoSat ?? 1) : (target.spec?.maxMissileSat ?? 2);
    }
    return family === 'torpedo' ? (target.spec?.torpedoesToSaturate ?? 2) : (target.spec?.missilesToSaturate ?? 2);
  }

  /** Incoming missiles and torpedoes aimed at the target. An aircraft's shot at an air target does not count for a ship. */
  _inboundSat(shooter, target) {
    let missile = 0, missileN = 0, torpedo = 0, incoming = 0;
    const airTarget = target.kind === 'air' || target.kind === 'missile';
    for (const w of this.units.values()) {
      if (!w.alive || w.targetId !== target.id) continue;
      if (w.kind !== 'missile' && w.kind !== 'torpedo') continue;
      incoming++;
      if (shooter?.kind !== 'air' && airTarget && this.units.get(w.owner)?.kind === 'air') continue;
      const sat = w.spec?.saturation ?? 1;
      if (w.kind === 'torpedo') torpedo += sat;
      else { missile += sat; missileN++; }
    }
    // Shots still on the engage task count before they leave the tube.
    for (const s of this.units.values()) {
      const e = s.engage;
      if (!e || e.left <= 0 || e.targetId !== target.id) continue;
      const spec = s.spec?.ammoSpecs?.[e.ammoId];
      const sat = (spec?.saturation ?? 1) * e.left;
      if (spec?.type === 'Torpedo') torpedo += sat;
      else { missile += sat; missileN += e.left; }
    }
    return { missile, missileN, torpedo, incoming };
  }

  _bracketBlocks(shooter, target, incoming) {
    if (target.kind !== 'ship' && target.kind !== 'sub' && target.kind !== 'land') return false;
    for (const family of ['missile', 'torpedo']) {
      const key = `${shooter.team}:${target.id}:${family}`;
      const rec = this._brackets.get(key);
      if (!rec) continue;
      if (incoming === 0 || rec.hit < this.t) { this._brackets.delete(key); continue; }
      if (rec.launch + 20 < this.t) return true;
    }
    return false;
  }

  _targetHandled(shooter, target) {
    const sat = this._inboundSat(shooter, target);
    if (this._bracketBlocks(shooter, target, sat.incoming)) return true;
    const air = target.kind === 'air' || target.kind === 'missile';
    const missilesHandled = shooter?.team === this.playerTeam && shooter?.kind === 'ship' && air
      ? sat.missileN >= 1
      : sat.missile > this._satLimit(target, 'missile');
    return missilesHandled || sat.torpedo > this._satLimit(target, 'torpedo');
  }

  /**
   * AutoAttackSalvoSize. A free torpedo is three, a wire torpedo is one, and other weapons
   * are one. A shipborne guided missile at an aircraft is capped at two.
   */
  _aiSalvo(u, target, spec, count) {
    if (!spec) return 1;
    if (spec.type === 'Torpedo') return spec.midcourse === 2 ? 1 : 3;
    const air = target && (target.kind === 'air' || target.kind === 'missile');
    if (u?.team === this.playerTeam && u?.kind === 'ship' && air && spec.type === 'Missile') return 1;
    if (spec.type === 'Missile' && spec.guidance === 2 && u?.kind !== 'air' && air && count > 1) return Math.min(2, count);
    return 1;
  }

  // ---------------------------------------------------------------- end state --
  _checkEnd() {
    if (this.over) return;
    const live = { 1: 0, 2: 0 };
    for (const u of this.all()) if ((u.kind === 'ship' || u.kind === 'air' || u.kind === 'sub' || u.kind === 'land') && u.team in live && u.active) live[u.team]++;
    if (this.noEndCheck) return;
    if (live[1] === 0 && this.t > 5) { this.over = { winner: 2 }; this.emit('end', { msg: 'Mission failed — all friendly units lost' }); }
    else if (live[2] === 0 && this.t > 5 && this.hadEnemies) { this.over = { winner: 1 }; this.emit('end', { msg: 'Victory — enemy forces eliminated' }); }
  }
}
