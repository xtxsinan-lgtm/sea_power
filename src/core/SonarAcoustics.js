// SeaPower.SonarAcoustics + SonarContactMath.Evaluate.
// OptionsManager.UseImprovedSonarModel is hard-wired true, so this is the live detector.
// The ini kilometre range is only SensorSystemSonar.GetRange (the map ring).
import { NM, KT, R2D, wrap180, bearing, hdgVec, clamp } from './Units.js';

const U2M = 67.200066;
const NEG = Number.NEGATIVE_INFINITY;

/** environment.ini [Sonar] plus the constructor defaults for keys that ini does not author. */
export const SONAR_ENV = {
  baseAmbient: 60,
  perSeaState: 5,
  rain: 15,
  shippingLF: 60,
  thermalHF: 18,
  processingRef: 72,
  processingMaxRejection: 0.9,
  processingDecay: 0.933,
  nbImmunity: 0.7,
  bottomLoss: 5,
  surfaceLoss: 1.5,
  thermoclineLoss: 0.5,
  skipFactor: 10,
  ductSkip: 60,
  maxBounce: 1,
  ductLeakLF: 0.2,
  bottomScatter: -25,
  surfaceScatter: -27,
  sofarM: 800,
  czPenaltyMax: 7.5,
  czRefTL: 67,
  czActiveReduction: 10,
  czDistNm: 30,
  czHalfNm: 5,
  czGain: 35,
  bbActive: 30,
  bbPassive: 15,
  bbMinDepthM: 450,
  bottomProxM: 50,
  bottomProxActive: 15,
  bottomProxPassive: 0,
  shadowRadiusKm: 15,
  shadowRamp: 3,
  shadowMax: 25,
  reverbChannelReduction: 15,
  shallowRefM: 200,
  shallowMax: 15,
  minLayerFt: 500,
  minCzFt: 3000,
  // ApplyInterference. Processing gain below 0 means 3 dB per signal-processing tier.
  interfSidelobe: 30,
  interfCoupling: 0.1,
  interfProcGain: -1,
  interfMaxRise: 15,
  interfScale: 0.25,
};

// No environment map and no terrain mesh. getOceanNoise then adds 1, getSurfaceDuct stays 10.
// Water deeper than MinDepthForLayerAppearance gets a layer; the original draws 250–450 ft from the tile.
export const OPEN_OCEAN_DEPTH_M = 2000;
export const OPEN_OCEAN_LAYER_FT = 350;

function beamAttenuationDB(d, halfBeam, sidelobeDB) {
  if (d <= halfBeam) return 0;
  const edge = halfBeam * 2.5;
  if (d >= edge) return sidelobeDB;
  const t = (d - halfBeam) / (edge - halfBeam);
  return sidelobeDB * 0.5 * (1 - Math.cos(t * Math.PI));
}

/**
 * SonarContactMath.ApplyInterference. AswSimulation is hard-wired to Realistic.
 * A loud received level inside the beam raises the victim's noise floor. The rise
 * saturates at InterferenceMaxRiseDB and is then scaled by InterferenceEffectScale.
 * Interferer-only entries (own taskforce) mask others and are not themselves adjusted.
 */
export function applyInterference(items, { gain = 0, halfBeamRad = 0, tier = 0 } = {}) {
  if (!items || items.length < 2) return;
  const coupling = 10 * Math.log10(clamp(SONAR_ENV.interfCoupling, 0.0001, 1));
  const proc = SONAR_ENV.interfProcGain >= 0 ? SONAR_ENV.interfProcGain : 3 * (tier || 0);
  // Received level is the log-add of every source, including the active-ping line.
  // ApplyInterference walks SourceResults, not the broadband excess alone.
  const rl = items.map((it) => {
    let acc = it.excess > -999 ? it.excess + (it.ambient || 0) - gain : -1000;
    if (it.lines) {
      for (const line of it.lines) {
        if (!(line.excess > -999)) continue;
        acc = logAddDB(acc, line.excess + (line.ambient ?? it.ambient ?? 0) - gain);
      }
    }
    return acc;
  });
  for (let k = 0; k < items.length; k++) {
    if (items[k].interferer || !(items[k].excess > -999)) continue;
    let acc = NEG;
    for (let l = 0; l < items.length; l++) {
      if (l === k || !(rl[l] > -999)) continue;
      let d = Math.abs((items[k].bearingRad || 0) - (items[l].bearingRad || 0));
      d = Math.abs((d + Math.PI) % (2 * Math.PI) - Math.PI);
      acc = logAddDB(acc, rl[l] - beamAttenuationDB(d, halfBeamRad, SONAR_ENV.interfSidelobe));
    }
    acc += coupling - proc;
    if (!(acc > -999)) continue;
    const floor = (items[k].ambient || 0) - gain;
    let rise = logAddDB(floor, acc) - floor;
    if (!(rise > 0) || !Number.isFinite(rise)) continue;
    if (SONAR_ENV.interfMaxRise > 0) rise = SONAR_ENV.interfMaxRise * (1 - Math.exp(-rise / SONAR_ENV.interfMaxRise));
    rise *= SONAR_ENV.interfScale;
    items[k].excess -= rise;
    if (items[k].lines) for (const line of items[k].lines) line.excess -= rise;
  }
}

export function logAddDB(a, b) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  if (b < a - 20) return a;
  if (a < b - 20) return b;
  return Math.max(a, b) + 10 * Math.log10(1 + 10 ** (-Math.abs(a - b) / 10));
}

export function absorptionPerKmDB(freqKHz) {
  const n = freqKHz * freqKHz;
  return 0.11 * n / (1 + n) + 44 * n / (4100 + n) + 0.000275 * n + 0.003;
}

export function transmissionLossDB(distNm, freqKHz, waterDepthM, bouncePerKm = 0) {
  const km = distNm * 1.852;
  const yards = distNm * 2025.37;
  const chem = absorptionPerKmDB(freqKHz) * km;
  if (yards < 1) return chem;
  let spread;
  if (waterDepthM <= 0) spread = 20 * Math.log10(yards);
  else {
    const depthKm = waterDepthM / 1000;
    const knee = depthKm * 1093.6123;
    if (yards <= knee) spread = 20 * Math.log10(yards);
    else {
      spread = 20 * Math.log10(knee) + 10 * Math.log10(yards / knee);
      if (bouncePerKm > 0) spread += bouncePerKm * (km - depthKm);
    }
  }
  return spread + chem;
}

export function boundaryLossFreqFactor(kHz) {
  if (kHz < 2) return 0.6;
  if (kHz < 10) return 1;
  return 1.6;
}
export function crossLayerFreqFactor(kHz) {
  if (kHz < 2) return 0.5;
  if (kHz < 10) return 1;
  return 1.5;
}
export function layerLeakageFreqFactor(kHz) {
  if (kHz < 2) return 1;
  if (kHz < 10) return 0.4;
  return 0.1;
}
export function shadowFreqFactor(kHz) {
  if (kHz < 2) return 0.6;
  if (kHz < 10) return 1;
  return 1.5;
}
export function bandGainReduction(band) {
  if (band === 1) return 10;
  if (band === 2) return 5;
  return 0;
}
export function bandToKHz(band) {
  if (band === 1) return 1;
  if (band === 3) return 30;
  return 3.5;
}
export function bandForKHz(kHz) {
  if (kHz < 1) return 1;
  if (kHz < 10) return 2;
  return 3;
}

export function ownNoiseDB(noise, kt, sonarType) {
  if (!noise || noise.base < 0) return 0;
  let n = noise.base - 60 - (noise.rafting || 0) * 5;
  n += (noise.cavitation || 0) * (noise.cav || 0);
  if (sonarType === 'towed' || sonarType === 'vds') n += 10 * Math.log10(0.2);
  if (sonarType === 'dipping') n = -999;
  const flow = (noise.flow ?? 1) * (50 * Math.log10(Math.max(Math.abs(kt), 0.01)) + 25);
  return logAddDB(flow, n);
}

/** Rain added to the ambient level. It fades across 1.1339275 Unity of the shallower depth. */
export function rainNoiseDB(band, sonarZ, targetZ, active = false) {
  const depth = Math.min(Math.max(0, -(sonarZ || 0)), Math.max(0, -(targetZ || 0)));
  const fadeM = 1.1339275 * U2M;
  const factor = active ? 1 : band === 1 ? 0.25 : band === 3 ? 1.5 : 1;
  const cap = SONAR_ENV.rain * factor;
  return Math.min(cap, Math.max(0, (1 - depth / fadeM) * cap));
}

function withRain(ambient, band, ob, tgt, rain, active) {
  if (!rain || tgt?.kind === 'air') return ambient;
  const add = rainNoiseDB(band, ob?.z, tgt?.z, active);
  return add > 0 ? logAddDB(ambient, add) : ambient;
}

/**
 * VesselPropulsionSystem / SubmarinePropulsionSystem updateParticles.
 * The particle follows demanded speed. A hiding submarine's demand is already
 * the cavitation cap, so a high telegraph bell stays quiet. No particle means silence.
 */
export function cavitationIntensity(tgt) {
  const noise = tgt?.spec?.noise;
  if (!noise?.cavParticle) return 0;
  const tel = tgt.spec?.telegraph;
  const ordered = Number.isFinite(tgt.demandedKt)
    ? tgt.demandedKt
    : (tel ? (tel[(tgt.telegraph ?? 0) + 1] ?? 0) : (tgt.speed || 0) / KT);
  if (tgt.kind === 'sub') {
    if (!(noise.cavRated > 0)) return 0;
    const onset = noise.cavRated * Math.sqrt((10 + Math.max(0, -(tgt.z || 0))) / 110);
    return ordered < 0 || ordered > onset ? 1 : 0;
  }
  if (ordered < 0) return 1;
  if (!(noise.cavIndex >= 1)) return 0;
  const kt = Math.abs((tgt.speed || 0) / KT);
  const onset = tel && noise.cavIndex < tel.length ? Math.abs(tel[noise.cavIndex]) : (tgt.spec?.vmaxKt || 0) * 0.9;
  const span = Math.max(1, (tgt.spec?.vmaxKt || 0) - onset);
  return Math.min(1, Math.max(0, (kt - onset) / span));
}
export function broadbandSL(noise, kt, cavitation, onsetKt = noise.onsetKt) {
  let sl = noise.base;
  const onset = Number.isFinite(onsetKt) ? onsetKt : 1e9;
  const creep = noise.creep || 0;
  const below = Math.max(0, Math.min(Math.abs(kt), onset) - creep);
  const above = Math.max(0, Math.abs(kt) - Math.max(onset, creep));
  sl += (below + 2 * above) * (noise.flow ?? 1);
  sl -= Math.max(0, creep - Math.abs(kt)) * (noise.belowCreep || 0);
  sl += (cavitation || 0) * (noise.cav || 0);
  return sl + 10 * Math.log10(1 / 3);
}

export function processingRejection(tier) {
  if (tier <= 0) return 0;
  const d = clamp(SONAR_ENV.processingDecay, 0, 1);
  return SONAR_ENV.processingMaxRejection * (1 - d ** tier);
}

export function effectiveAmbient(ambient, rejection) {
  const over = ambient - SONAR_ENV.processingRef;
  if (over <= 0 || rejection <= 0) return ambient;
  return ambient - over * rejection;
}

function directPathHorizonNm(h1M, h2M, rayKm) {
  if (rayKm <= 0) return Infinity;
  const diam = 2 * rayKm * 1000;
  return (Math.sqrt(diam * Math.max(h1M, 0)) + Math.sqrt(diam * Math.max(h2M, 0))) / 1000 / 1.852;
}

function shadowPenalty(distNm, horizonNm, kHz, scale) {
  const past = distNm - horizonNm;
  if (past <= 0) return 0;
  return Math.min(SONAR_ENV.shadowRamp * shadowFreqFactor(kHz) * past, SONAR_ENV.shadowMax) * scale;
}

function ductBonusDB(distNm, duct, sonarY, targetY, layerS, layerT, kHz, waterDepthM) {
  if (duct <= 0 || distNm <= 0) return 0;
  const thick = Math.max(0.001, -layerS);
  const ft = thick * 220.47266;
  const ref = Math.max(0.5, ft / 300);
  let a = distNm;
  if (waterDepthM > 0) a = Math.min(distNm, waterDepthM / 1852);
  const gained = Math.min(10 * Math.log10(Math.max(a, ref) / ref), duct);
  const freq = kHz < 1 ? 0.4 : kHz < 5 ? 0.7 : 1;
  const s = clamp(-sonarY / thick, 0, 1);
  const t = clamp(-targetY / Math.max(0.001, -layerT), 0, 1);
  return gained * freq * Math.max(0, 1 - 0.5 * (s + t));
}

function aboveLayerLeak(duct, layerUnity, deepRate) {
  const layerM = layerUnity < 0 ? -layerUnity * U2M : 0;
  if (layerM <= 1 || duct <= 0) return deepRate;
  return SONAR_ENV.surfaceLoss / (SONAR_ENV.ductSkip * layerM / 1000) * (10 / duct);
}

function convergenceWindow(distNm) {
  const cz = SONAR_ENV.czDistNm;
  const half = SONAR_ENV.czHalfNm;
  if (cz <= 0 || half <= 0 || distNm < cz / 2) return null;
  const mod = distNm % cz;
  const off = mod > cz / 2 ? cz - mod : mod;
  if (off >= half) return null;
  const n = mod > cz / 2 ? Math.floor(distNm / cz) + 1 : Math.round(distNm / cz);
  if (n < 1) return null;
  return { n, taper: Math.cos(off / half * Math.PI / 2) };
}

function czGain(distNm, kHz, waterM, bounce, active, sonarY, targetY, maxCz) {
  const win = convergenceWindow(distNm);
  if (!win || maxCz <= 0) return NEG;
  const freq = boundaryLossFreqFactor(kHz);
  const peak = clamp(
    transmissionLossDB(SONAR_ENV.czDistNm, kHz, waterM, bounce * freq) - SONAR_ENV.czRefTL - (active ? SONAR_ENV.czActiveReduction : 0),
    0, SONAR_ENV.czGain,
  );
  const axis = SONAR_ENV.sofarM;
  const s = clamp(Math.max(0, -sonarY) * U2M / axis, 0, 1);
  const t = clamp(Math.max(0, -targetY) * U2M / axis, 0, 1);
  const frac = (2 - s - t) / 2;
  const ring = (win.n === maxCz ? 0.5 : 1) * peak * win.taper;
  return ring - frac * 2 * SONAR_ENV.czPenaltyMax;
}

function bottomBounce(distNm, waterM, active) {
  if (waterM <= 0 || distNm <= 0 || distNm > SONAR_ENV.czDistNm) return 0;
  const rangeM = distNm * 1852;
  const grazing = Math.atan2(2 * waterM, rangeM) * R2D;
  const a = clamp((15 - grazing) / 2, 0, 1);
  const b = clamp((grazing - 8) / 2, 0, 1);
  const gain = active ? Math.max(0, SONAR_ENV.bbActive - 2 * SONAR_ENV.bottomLoss) : Math.max(0, SONAR_ENV.bbPassive - SONAR_ENV.bottomLoss);
  return 0.5 * gain * Math.min(a, b);
}

function reverbNL(output, tl, distNm, waterM, ambient, duct2, bbBonus, bottomReduction) {
  const rangeM = distNm * 1852;
  const patch = 750 * rangeM * 0.08727;
  const logP = 10 * Math.log10(Math.max(patch, 1e-6));
  let bottom = NEG;
  if (rangeM > waterM && rangeM > 0) {
    const shallow = waterM > 0 ? clamp(10 * Math.log10(SONAR_ENV.shallowRefM / waterM), 0, SONAR_ENV.shallowMax) : 0;
    bottom = output - 2 * tl + SONAR_ENV.bottomScatter + logP + bbBonus * 0.75 + shallow - bottomReduction;
  }
  const surface = rangeM > 0 ? output - 2 * tl + SONAR_ENV.surfaceScatter + logP + duct2 : NEG;
  return Math.max(ambient, Math.max(bottom, surface));
}

function bottomProx(heightM, maxPenalty, kHz) {
  const f = kHz < 2 ? 1 : kHz < 10 ? 0.7 : 0.35;
  return maxPenalty * clamp(1 - Math.max(0, heightM) / SONAR_ENV.bottomProxM, 0, 1) * f;
}

/**
 * One source's direct-path excess, taking the better of direct, convergence and bottom bounce.
 * Returns dB. Callers log-add broadband sources and compare with the 5 dB threshold.
 */
export function signalExcess(c) {
  const dx = c.target.x - c.sonar.x;
  const dy = c.target.y - c.sonar.y;
  const dz = c.target.z - c.sonar.z;
  const distNm = Math.hypot(dx, dy, dz) / NM;
  if (c.inBaffles || c.hasLOS === false) return -1000;
  const sonarU = c.sonar.z / U2M;
  const targetU = c.target.z / U2M;
  const layerS = c.layerUnity;
  const layerT = c.layerUnity;
  const aboveS = sonarU > layerS || layerS > 0;
  const aboveT = targetU > layerT || layerT > 0;
  const cross = aboveS !== aboveT;
  const bothAbove = aboveS && aboveT;
  const depth = c.waterDepthM;
  const depthFrac = SONAR_ENV.minCzFt * 0.3048 > 1 ? clamp((depth - 0.5 * SONAR_ENV.minCzFt * 0.3048) / (0.5 * SONAR_ENV.minCzFt * 0.3048), 0, 1) : 0;
  const channel = SONAR_ENV.czDistNm > 0 ? (SONAR_ENV.surfaceLoss + SONAR_ENV.thermoclineLoss) / (SONAR_ENV.czDistNm * 1.852) : 0;
  const deepBounce = depth > 0 ? (SONAR_ENV.bottomLoss + SONAR_ENV.thermoclineLoss) / (SONAR_ENV.skipFactor * depth / 1000) : 0;
  const mixed = deepBounce + (channel - deepBounce) * depthFrac;
  const leak = aboveLayerLeak(c.duct, layerS, mixed);
  const surfaceBounce = Math.min(bothAbove && layerS < 0 ? leak : mixed, SONAR_ENV.maxBounce);
  const czBounce = Math.min(mixed, SONAR_ENV.maxBounce);
  const bbBounce = Math.min(deepBounce, SONAR_ENV.maxBounce);
  let shadowHorizon = Infinity;
  if ((!bothAbove || !(c.duct > 0)) && targetU < 0 && depthFrac > 0 && SONAR_ENV.shadowRadiusKm > 0) {
    const h1 = (aboveS ? Math.max(0, -sonarU) : Math.max(0, layerS - sonarU)) * U2M;
    const h2 = (aboveT ? Math.max(0, -targetU) : Math.max(0, layerT - targetU)) * U2M;
    shadowHorizon = directPathHorizonNm(h1, h2, SONAR_ENV.shadowRadiusKm);
  }
  const czOk = c.convergence && !bothAbove;
  const cz = czOk ? czGain(distNm, c.kHz, depth, czBounce, c.isActive, sonarU, targetU, c.maxCz || 0) : NEG;
  const bbRaw = c.bottomBounce && !bothAbove ? bottomBounce(distNm, depth, c.isActive) : 0;
  const crossed = (aboveS ? 1 : 0) + (aboveT ? 1 : 0);
  const xPen = (c.xLayer || 0) * 0.25 * crossed * (c.isActive ? 2 : 1);
  const czNet = Number.isFinite(cz) ? cz - xPen : NEG;
  const bbNet = bbRaw > 0 ? bbRaw - xPen : NEG;

  const freqFactor = boundaryLossFreqFactor(c.kHz);
  let absorp = surfaceBounce * freqFactor;
  if (bothAbove) absorp += SONAR_ENV.ductLeakLF * layerLeakageFreqFactor(c.kHz);
  const tl = transmissionLossDB(distNm, c.kHz, depth, absorp);
  const duct = bothAbove ? ductBonusDB(distNm, c.duct, sonarU, targetU, layerS, layerT, c.kHz, depth) : 0;
  const shadow = shadowPenalty(distNm, shadowHorizon, c.kHz, depthFrac);

  if (c.isActive) {
    const duct2 = duct * 2;
    const cut = depthFrac * SONAR_ENV.reverbChannelReduction;
    const nl = reverbNL(c.output, tl, distNm, depth, c.ambient, duct2, 0, cut) + (c.clutter || 0);
    const direct = (c.output - 2 * tl + c.targetSL - nl + c.gain) + ((cross ? -(c.xLayer || 0) * crossLayerFreqFactor(c.kHz) * 2 : bothAbove ? duct2 : 0) - shadow * 2);
    let alt = NEG;
    if (Number.isFinite(czNet)) {
      const tl2 = transmissionLossDB(distNm, c.kHz, depth, czBounce * freqFactor);
      const nl2 = reverbNL(c.output, tl2, distNm, depth, c.ambient, 0, 0, cut) + (c.clutter || 0);
      alt = Math.max(alt, c.output - 2 * tl2 + c.targetSL - nl2 + c.gain + czNet);
    }
    if (Number.isFinite(bbNet)) {
      const tl3 = transmissionLossDB(distNm, c.kHz, depth, bbBounce * freqFactor);
      const nl3 = reverbNL(c.output, tl3, distNm, depth, c.ambient, 0, bbRaw, 0) + (c.clutter || 0);
      alt = Math.max(alt, c.output - 2 * tl3 + c.targetSL - nl3 + c.gain + bbNet);
    }
    const best = Math.max(direct, alt);
    return Number.isFinite(best) ? best : -1000;
  }

  const direct = (c.targetSL - tl - c.ambient + c.gain) - (c.clutter || 0) + (cross ? -(c.xLayer || 0) * crossLayerFreqFactor(c.kHz) : bothAbove ? duct : 0) - shadow;
  let alt = NEG;
  if (Number.isFinite(czNet)) {
    const tl2 = transmissionLossDB(distNm, c.kHz, depth, czBounce * freqFactor);
    alt = Math.max(alt, c.targetSL - tl2 - c.ambient + c.gain - (c.clutter || 0) + czNet);
  }
  if (Number.isFinite(bbNet)) {
    const tl3 = transmissionLossDB(distNm, c.kHz, depth, bbBounce * freqFactor);
    alt = Math.max(alt, c.targetSL - tl3 - c.ambient + c.gain - (c.clutter || 0) + bbNet);
  }
  const best = Math.max(direct, alt);
  return Number.isFinite(best) ? best : -1000;
}

/** Sensor library section → the fields SonarParameters reads. Hull baffles default to 120°, −120°. */
export function sonarRecord(lib = {}) {
  const listen = parseSonarFrequency(lib.SonarFrequency);
  const ping = parseSonarFrequency(lib.ActiveFrequency);
  const type = String(lib.Type || 'Hull').toLowerCase();
  const n = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
  const hull = type === 'hull' || type === 'activeintercept';
  let baffles = null;
  if (hull) {
    const parts = String(lib.Baffles ?? '').split(',').map((p) => parseFloat(p)).filter((x) => Number.isFinite(x));
    baffles = parts.length >= 2 ? [parts[0], parts[1]] : [120, -120];
  }
  const gain = n(lib.Gain, 0);
  const authored = lib.ActiveGain == null || lib.ActiveGain === '' ? gain : n(lib.ActiveGain, gain);
  const sonarType = type === 'towed' ? 'towed' : type === 'vds' ? 'vds' : type === 'dipping' ? 'dipping' : 'hull';
  return {
    band: listen.band, kHz: listen.kHz, activeBand: ping.band, activeKHz: ping.kHz,
    gain, activeGain: authored < 0 ? gain : authored,
    outputPower: n(lib.OutputPower, 0),
    threshold: n(lib.SNRDetectionThreshold, 5),
    signalProcessing: n(lib.SignalProcessing, 0),
    beamDeg: n(lib.AngularResolution, 1),
    // PseudorangeResolution defaults to 1. Passive range error is (pseudo·range/20)²/12 metres.
    pseudo: n(lib.PseudorangeResolution, 1),
    maxCz: lib.MaxConvergenceZones == null || lib.MaxConvergenceZones === '' ? 3 : n(lib.MaxConvergenceZones, 3),
    sonarType, baffles,
    narrowBand: /^true$/i.test(String(lib.NarrowBandCapable || '')) || sonarType === 'towed',
    activeOnly: /^true$/i.test(String(lib.IsActiveOnly || '')),
  };
}

/** "3000hz" / "lf" → { band: 1|2|3, kHz }. Undefined is band 0 at 3.5 kHz. */
export function parseSonarFrequency(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return { band: 0, kHz: 3.5 };
  if (t === 'lf') return { band: 1, kHz: 1 };
  if (t === 'mf') return { band: 2, kHz: 3.5 };
  if (t === 'hf') return { band: 3, kHz: 30 };
  let scale = 1;
  let body = t;
  if (body.endsWith('khz')) body = body.slice(0, -3);
  else if (body.endsWith('hz')) { body = body.slice(0, -2); scale = 0.001; }
  const kHz = parseFloat(body) * scale;
  if (!Number.isFinite(kHz)) return { band: 0, kHz: 3.5 };
  return { band: kHz < 1 ? 1 : kHz < 10 ? 2 : 3, kHz };
}

export function oceanNoiseDB(seaState) {
  return 1 + SONAR_ENV.baseAmbient + (seaState || 0) * SONAR_ENV.perSeaState;
}

/** SonarAcoustics.BandAmbientNoise. LF adds shipping, HF takes the thermal floor. */
export function bandAmbient(band, ocean) {
  if (band === 1) return logAddDB(ocean, SONAR_ENV.shippingLF);
  if (band === 3) return Math.max(ocean - 10, SONAR_ENV.thermalHF);
  return ocean;
}

function powerScaledBase(base, kt, generation) {
  const rise = 10 * Math.log10(1 + (Math.abs(kt) / 15) ** 3);
  return base + rise * 0.85 ** (generation || 0);
}

function machinerySL(noise, kt) {
  return powerScaledBase(noise.base, kt, noise.rafting) - 17 - (noise.rafting || 0) * 2 + (noise.distinctive ? 5 : 0);
}

function propellerKHz(blades, kt) {
  return Math.max(0.003, (blades || 1) * Math.abs(kt) / 6 / 1000);
}

function propellerSL(noise, kt, onsetKt) {
  if (kt < 1) return -1000;
  const knee = onsetKt < 1000 ? Math.max(onsetKt, 1) : 15;
  const rpm = 60 * Math.log10(Math.max(noise.tonalRpm ?? 100, 0.01) / 50);
  const creep = Math.max(noise.creep || 0, 1);
  const ref = 10 * Math.log10(1 + (10 / creep) ** 3);
  let curve;
  if (kt <= knee) curve = rpm + 10 * Math.log10(1 + (kt / creep) ** 3) - ref;
  else curve = rpm + 10 * Math.log10(1 + (knee / creep) ** 3) - ref + 50 * Math.log10(kt / knee);
  const blades = Math.max(noise.blades || 1, 1);
  let sl = 95 + curve - 10 * Math.log10(blades / 5);
  if ((noise.disp || 0) > 0) sl += 6.6666665 * Math.log10(noise.disp / 3000);
  sl -= noise.propDeficit || 0;
  if (blades % 2 === 0 && noise.prop !== 'pumpjet') sl += 3;
  sl += ((noise.shafts || 1) - 1) * 3;
  if (noise.prairie && kt < onsetKt) sl -= 10;
  return sl;
}

/** Narrowband noise floor. The 0.5^tier bandwidth and the sonobuoy/towed bonus are Sonar.ProcessPassiveContact. */
function narrowAmbient(raw, tier, buoy, sonarType) {
  const broad = processingRejection(tier);
  const frac = tier > 0 ? 0.5 ** tier : 0;
  if (frac <= 0) return effectiveAmbient(raw, broad);
  const rejection = Math.max(broad, (1 - frac) * SONAR_ENV.nbImmunity);
  let n = effectiveAmbient(raw, rejection) + 10 * Math.log10(frac) + tier;
  if (buoy || sonarType === 'towed') n -= 5;
  return n;
}

export function layerUnity(waterDepthM) {
  const bottomFt = -waterDepthM / 0.3048;
  if (bottomFt < -SONAR_ENV.minLayerFt) return -OPEN_OCEAN_LAYER_FT * 0.00453571;
  return 100;
}

/** Relative bearing in baffles. Hull default is 120° … −120°, the stern arc. */
export function inSonarBaffles(heading, from, to, baffles) {
  if (!baffles || (baffles[0] === 0 && baffles[1] === 0)) return false;
  const rel = wrap180(bearing(from, to) - heading);
  const [x, y] = baffles;
  if (x < y) return x < rel && rel < y;
  return y >= rel || rel >= x;
}

function targetStrength(ob, tgt, reflect) {
  const maxR = reflect;
  const minR = 0.5 * reflect;
  const to = hdgVec(bearing(ob, tgt));
  const fwd = hdgVec(tgt.heading || 0);
  const dot = clamp(to.x * fwd.x + to.y * fwd.y, -1, 1);
  const ang = Math.acos(dot) * R2D;
  const t = 1 - Math.abs(ang - 90) / 90;
  return minR + (maxR - minR) * t;
}

function acousticFrame(ob, sensor, tgt, sea, waterDepthM) {
  const listen = Math.max(sensor.band || 2, 1);
  const noise = tgt.spec?.noise;
  const hull = noise && noise.base >= 0 ? noise : null;
  if (!hull && !activePing(tgt, listen)) return null;
  const own = ob.spec?.noise;
  const self = ownNoiseDB(
    { ...own, cavitation: cavitationIntensity(ob) },
    (ob.speed || 0) / KT,
    sensor.sonarType || 'hull',
  );
  const ambient0 = logAddDB(bandAmbient(listen, oceanNoiseDB(sea)), self);
  const sonar = { x: ob.x, y: ob.y, z: ob.z || 0 };
  const target = { x: tgt.x, y: tgt.y, z: tgt.z || 0 };
  const layer = layerUnity(waterDepthM);
  const bottomFt = -waterDepthM / 0.3048;
  const deep = bottomFt < -SONAR_ENV.minCzFt && bottomFt < -SONAR_ENV.minLayerFt;
  return {
    noise: hull, listen, ambient0, bottomFt,
    base: {
      sonar, target, waterDepthM, layerUnity: layer, duct: 10, xLayer: 0,
      inBaffles: inSonarBaffles(ob.heading || 0, ob, tgt, sensor.baffles),
      hasLOS: true,
      convergence: deep && (sensor.maxCz || 0) > 0,
      bottomBounce: waterDepthM >= SONAR_ENV.bbMinDepthM,
      maxCz: sensor.maxCz || 0,
    },
  };
}

function propTonalKt(tgt) {
  const actual = Math.abs((tgt.speed || 0) / KT);
  if (tgt.kind === 'sub' && tgt.spec?.telegraph) {
    const demanded = Math.abs(tgt.spec.telegraph[(tgt.telegraph ?? 0) + 1] ?? actual);
    return Math.min(actual, demanded);
  }
  return actual;
}

function cavitationOnsetKt(noise, tgt) {
  if (tgt.kind === 'sub') return (noise.cavRated || 0) * Math.sqrt((10 + Math.max(0, -(tgt.z || 0))) / 110);
  const idx = noise.cavIndex;
  const tel = tgt.spec?.telegraph;
  if (idx >= 1 && tel && idx < tel.length) return Math.abs(tel[idx]);
  return (tgt.spec?.vmaxKt || 0) * 0.9;
}

function pingMismatch(pingBand, listenBand) {
  if (!pingBand || pingBand === listenBand) return 0;
  return Math.abs(pingBand - listenBand) === 1 ? -15 : -30;
}

/** ActivePingNoiseSLWithFreq. A transmitting sonar or an active torpedo seeker. Active defaults off. */
export function activePing(tgt, listenBand) {
  if (!tgt) return null;
  if (tgt.kind !== 'torpedo' && !tgt.activeSonarOn) return null;
  if (tgt.kind === 'torpedo') {
    const g = tgt.spec_?.guidance ?? tgt.spec?.guidance;
    const power = tgt.spec_?.seekerPower || tgt.spec?.seekerPower || 0;
    if (tgt.airborne || !tgt.searching || (g !== 7 && g !== 10) || !(power > 0)) return null;
    return { sl: Math.max(0, power + pingMismatch(2, listenBand)), kHz: 3.5 };
  }
  let best = null;
  const consider = (sensor) => {
    if (!sensor || !(sensor.outputPower > 0)) return;
    let band;
    let kHz;
    if (sensor.activeBand) {
      band = sensor.activeBand;
      kHz = sensor.activeKHz || bandToKHz(band);
    } else if ((sensor.band || 2) === 1) {
      band = 2;
      kHz = 3.5;
    } else {
      band = sensor.band || 2;
      kHz = bandToKHz(band);
    }
    const sl = Math.max(0, sensor.outputPower + pingMismatch(band, listenBand));
    if (!best || sl > best.sl) best = { sl, kHz };
  };
  for (const s of tgt.spec?.sensors || []) if (s.kind === 'Sonar') consider(s);
  if (tgt.sonar) consider(tgt.sonar);
  return best;
}

/**
 * Passive broadband excess, plus propeller and machinery lines when the sonar is narrowband capable.
 * Lines are the raw excess. CommitPassiveBatch adds 10·log10(confidence) after integration.
 */
export function passiveReading(ob, sensor, tgt, { sea = 0, waterDepthM = OPEN_OCEAN_DEPTH_M, rain = false } = {}) {
  const frame = acousticFrame(ob, sensor, tgt, sea, waterDepthM);
  if (!frame) return { broadband: -1000, lines: [], ambient: 0 };
  const { noise, listen, ambient0, bottomFt, base } = frame;
  const wet = withRain(ambient0, listen, ob, tgt, rain, false);
  const ambient = effectiveAmbient(wet, processingRejection(sensor.signalProcessing || 0));
  if (!noise) {
    const ping = activePing(tgt, listen);
    if (!ping) return { broadband: -1000, lines: [], ambient: amb };
    const amb = sensor.narrowBand
      ? narrowAmbient(wet, sensor.signalProcessing || 0, !!sensor.buoy, sensor.sonarType)
      : ambient;
    const gain = (sensor.gain || 0) - bandGainReduction(listen);
    const height = (tgt.z || 0) - bottomFt * 0.3048;
    return {
      broadband: -1000,
      ambient: amb,
      lines: [{
        id: 'ping', immediate: true, ambient: amb,
        excess: signalExcess({
          ...base, isActive: false, kHz: ping.kHz, gain, targetSL: ping.sl, ambient: amb,
          clutter: bottomProx(height, SONAR_ENV.bottomProxPassive, ping.kHz),
        }),
      }],
    };
  }
  const tierBonus = sensor.sonarType === 'towed' || sensor.sonarType === 'vds' || sensor.buoy ? 0 : 7;
  const gain = (sensor.gain || 0) - bandGainReduction(listen);
  const onsetKt = cavitationOnsetKt(noise, tgt);
  const sl = broadbandSL(noise, (tgt.speed || 0) / KT, cavitationIntensity(tgt), onsetKt);
  const height = (tgt.z || 0) - bottomFt * 0.3048;
  let broadband = NEG;
  for (let band = listen; band <= 3; band++) {
    const ex = signalExcess({
      ...base, isActive: false, kHz: bandToKHz(band), gain, targetSL: sl,
      ambient: ambient - tierBonus * (band - listen),
      clutter: bottomProx(height, SONAR_ENV.bottomProxPassive, bandToKHz(band)),
    });
    broadband = logAddDB(broadband, ex);
  }
  const lines = [];
  if (sensor.narrowBand && (tgt.kind === 'sub' || tgt.kind === 'ship')) {
    const nb = narrowAmbient(wet, sensor.signalProcessing || 0, !!sensor.buoy, sensor.sonarType);
    const tone = (id, kHz, level) => {
      if (level <= -900) return;
      lines.push({
        id, ambient: nb, excess: signalExcess({
          ...base, isActive: false, kHz, gain, targetSL: level, ambient: nb,
          clutter: bottomProx(height, SONAR_ENV.bottomProxPassive, kHz),
        }),
      });
    };
    tone('mach', Math.max(0.05, (noise.electric || 50) / 1000), machinerySL(noise, Math.abs((tgt.speed || 0) / KT)));
    const pk = propTonalKt(tgt);
    tone('prop', propellerKHz(noise.blades, pk), propellerSL(noise, pk, cavitationOnsetKt(noise, tgt)));
  }
  const ping = activePing(tgt, listen);
  if (ping) {
    const amb = sensor.narrowBand
      ? narrowAmbient(wet, sensor.signalProcessing || 0, !!sensor.buoy, sensor.sonarType)
      : ambient;
    lines.push({
      id: 'ping', immediate: true, ambient: amb,
      excess: signalExcess({
        ...base, isActive: false, kHz: ping.kHz, gain, targetSL: ping.sl, ambient: amb,
        clutter: bottomProx(height, SONAR_ENV.bottomProxPassive, ping.kHz),
      }),
    });
  }
  return { broadband, lines, ambient };
}

/**
 * Passive broadband excess, or active excess. Compared with SNRDetectionThreshold (default 5 dB).
 */
export function sonarExcess(ob, sensor, tgt, { sea = 0, waterDepthM = OPEN_OCEAN_DEPTH_M, active = false, rain = false } = {}) {
  const frame = acousticFrame(ob, sensor, tgt, sea, waterDepthM);
  if (!frame) return -1000;
  if (!active) return passiveReading(ob, sensor, tgt, { sea, waterDepthM, rain }).broadband;
  if (!frame.noise) return -1000;
  const { noise, ambient0, bottomFt, base } = frame;
  const kHz = sensor.activeKHz || sensor.kHz || 3.5;
  const band = sensor.activeBand || bandForKHz(kHz);
  const ambient = effectiveAmbient(withRain(ambient0, band, ob, tgt, rain, true), processingRejection(sensor.signalProcessing || 0));
  return signalExcess({
    ...base, isActive: true, kHz,
    output: sensor.outputPower || 0,
    gain: (sensor.activeGain ?? sensor.gain) - bandGainReduction(band),
    targetSL: targetStrength(ob, tgt, noise.reflect ?? 25),
    ambient,
    clutter: bottomProx((tgt.z || 0) - bottomFt * 0.3048, SONAR_ENV.bottomProxActive, kHz),
  });
}
