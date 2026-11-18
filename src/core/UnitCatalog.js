// UnitCatalog — turns converted game data (data/*.json) into engine specs.
// `loadJson(relPath)` is injected (fetch in the browser, fs in Node tests).
import { num, bool, csv, csvNum } from './IniParser.js';
import { NM, KT, FT, rcsExtents } from './Units.js';
import { sonarRecord } from './SonarAcoustics.js';

const PROP_DEFICIT = { tandem: 3, skewback: 10, pumpjet: 20 };

/**
 * LiftVelocityInKnots. Missing values are 15 and 25 kt. The loader then
 * refuses a start below 5 kt and keeps the top at least the start.
 */
function liftBandKt(raw) {
  const parts = raw == null || raw === '' ? [] : csvNum(String(raw));
  let x = parts.length ? parts[0] : 15;
  let y = parts.length > 1 ? parts[1] : 25;
  if (!Number.isFinite(x)) x = 15;
  if (!Number.isFinite(y)) y = 25;
  if (x < 5) x = 5;
  if (y < x) y = x + 10;
  return [x, y];
}

/** VesselLoader clamps LinearDrag into (0, 1) so Pow(drag, dt) stays a decay. */
function clampDrag(drag) {
  if (drag > 0.9999) return 0.9999;
  if (drag < 0.0001) return 0.0001;
  return drag;
}

/** CavitationParameters. A single number fills y with 0, so the rated speed is x. Default is (20, −100). */
function cavRatedKt(raw) {
  if (raw == null || raw === '') return (328.08398 + 100) / 20;
  const parts = csvNum(String(raw));
  const x = parts[0];
  if (!Number.isFinite(x) || x === 0) return 0;
  const y = parts.length < 2 ? 0 : parts[1];
  return y !== 0 ? (328.08398 - y) / x : x;
}

/** SensorData plus the propeller and machinery lines narrowband sonar integrates. */
function hullNoise(sd, physics, ini) {
  const prop = String(sd.PropellerType || 'regular').toLowerCase();
  const rafting = Math.min(5, Math.max(0, num(sd.MachineryRaftingGeneration, 0)));
  const cavName = String((ini.Particles || {}).Cavitation ?? '');
  const isSub = (ini.General || {}).UnitType === 'Submarine';
  return {
    base: num(sd.BaseNoise, 100), flow: num(sd.FlowNoise, 1), cav: num(sd.CavitationNoise, 10),
    rafting, reflect: num(sd.TargetReflectionStrength, 25),
    creep: csvNum(physics.TelegraphVelocities || '')[2] || 0,
    // VesselLoader default is −1. The value is an index into TelegraphVelocities, not a speed.
    cavIndex: num(physics.CavitationSpeed, -1),
    cavRated: isSub ? cavRatedKt(physics.CavitationParameters) : 0,
    cavParticle: cavName !== '' && cavName.toLowerCase() !== 'false',
    blades: num(sd.BladesCount, 5), electric: num(sd.ElectricFrequency, 50),
    shafts: num((ini.PropulsionSystems || {}).NumberOfPropulsionSystems, 1),
    prairie: bool(sd.Prairie, false), distinctive: bool(sd.DistinctiveNoise, false),
    prop, propDeficit: PROP_DEFICIT[prop] || 0, tonalRpm: num(sd.TonalRPMModifier, 100),
    disp: num(physics.Displacement, 0),
  };
}

/** Unity Resources.Load path: ResourcesFolder + ResourcesRoot (ObjectBaseLoader). */
export function modelKey(ini) {
  const m = ini?.Models;
  if (!m) return '';
  const folder = String(m.ResourcesFolder || '').replace(/\\/g, '/');
  const root = m.ResourcesRoot || '';
  if (!folder || !root) return '';
  return folder.endsWith('/') ? folder + root : folder + '/' + root;
}

export class UnitCatalog {
  constructor(loadJson) {
    this.loadJson = loadJson;
    this.cache = new Map();
    this.lang = null;
    this.sensors = null;
    this.weapons = null;
  }

  async _get(path) {
    if (!this.cache.has(path)) this.cache.set(path, this.loadJson(path));
    return this.cache.get(path);
  }

  async init() {
    [this.lang, this.sensors, this.weapons] = await Promise.all([this._get('lang_en.json'), this._get('systems/sensors.json'), this._get('systems/weapons.json')]);
    return this;
  }

  /** Display name from language_en. Ammo lives under AmmunitionNames as "Name,short,role,description". */
  displayName(id, variantKey) {
    const ammo = this.lang?.ammunition_names;
    const e = this.lang?.vessel_names?.[id] || this.lang?.aircraft_names?.[id] || this.lang?.land_units_names?.[id]
      || ammo?.AmmunitionNames?.[id] || ammo?.AmmunitionNames_Nato?.[id];
    if (!e) return id;
    if (typeof e === 'string') return e.split(',')[0] || id;
    const raw = (variantKey && e[variantKey]) || e.Default || id;
    return String(raw).split(',')[0];
  }

  /** AmmunitionNames is "Name,short,role,description". The bottom bar uses the short name, SM-1MR. */
  ammoShort(id) {
    const ammo = this.lang?.ammunition_names;
    const e = ammo?.AmmunitionNames?.[id] || ammo?.AmmunitionNames_Nato?.[id];
    if (typeof e !== 'string') return this.displayName(id);
    const parts = e.split(',');
    return parts[1] || parts[0] || id;
  }

  // ------------------------------------------------------------------ ammo --
  async ammo(id) {
    const key = 'ammunition/' + id + '.json';
    if (this.cache.has('spec:' + key)) return this.cache.get('spec:' + key);
    let ini;
    try { ini = await this._get(key); } catch { ini = null; }
    let spec = null;
    if (ini) {
      const g = ini.General || {}, gd = ini.Guidance || {}, w = ini.WarheadData || {}, ph = ini.Physics || {};
      const type = g.Type || 'Projectile';
      spec = {
        id, name: this.displayName(id), short: this.ammoShort(id), type, target: g.TargetType || 'ASuW', secondary: g.SecondaryTargetType || '',
        power: num(w.Power, 5), killProb: num(w.KillProbability, 0), prox: num(w.FuzeProximityDistance, 0),
        // missiles
        guidance: num(gd.GuidanceType, 0), vmaxKt: num(gd.MaxVelocity, 400),
        // IsRearAspectOnly. The cone is the full angle behind an aircraft; other targets are not gated.
        rearAspect: bool(gd.IsRearAspectOnly, false), rearCone: num(gd.TargetRearCone, 0),
        // 0 none, 1 radio command, 2 wire, 3 datalink.
        midcourse: num(gd.MidCourseCorrection, 0),
        // MaxTurnRate defaults to 5 deg/s and is never below 0.1. MaxTurnG defaults to 200.
        turnRate: Math.max(0.1, num(gd.MaxTurnRate, 5)), maxTurnG: num(gd.MaxTurnG, 200),
        // LaunchTurnRate is the faster rate while the missile is still coming onto the aim bearing.
        launchTurn: num(gd.LaunchTurnRate, -1),
        // Acceleration is in g. The boost is g × 9.81 × 1.94384 × 1.2 knots per second.
        accelKt: num(gd.Acceleration, 6) * 10,
        minRangeNm: num(gd.MinLaunchRange, 0), maxRangeNm: num(gd.MaxLaunchRange, 10),
        seekerFov: csvNum(gd.SeekerFOV)[0] || 45, rangeGateNm: num(gd.RangeGate, 0),
        seaSkimFt: num(gd.SeaSkimmingAlt, 0),
        // Distances are nautical miles. Altitudes are feet. TerminalDiveDistance defaults to 0.3 nm.
        skimStartNm: num(gd.SeaSkimmingStartDistToTarget, 0),
        skimDescent: num(gd.SeaSkimmingMaxDescentAngle, 30),
        skimNose: num(gd.SeaSkimmingNoseUp, 0),
        loftAngle: num(gd.MaxLoftAngle, 30),
        finalNm: num(gd.FinalFlightPhaseDistToTarget, 0),
        finalFt: num(gd.FinalFlightPhaseAlt, 0),
        approachNm: gd.TerminalApproachDist == null || gd.TerminalApproachDist === '' ? null : num(gd.TerminalApproachDist, 0),
        // Absent, the vertical rate is the horizontal one. Inside the approach it replaces pitch.
        vertTurn: gd.TerminalVerticalTurnRate == null || gd.TerminalVerticalTurnRate === '' ? null : num(gd.TerminalVerticalTurnRate, 0),
        termFt: num(gd.TerminalAlt, -1),
        diveNm: num(gd.TerminalDiveDistance, 0.3),
        selectivePop: bool(gd.SelectivePopUp, false),
        popNm: num(gd.TerminalPopUpDist, -1),
        popFt: num(gd.TerminalPopUpHeight, 1000),
        popAngle: num(gd.TerminalPopUpAngle, 60),
        seekerNm: Math.max(num(gd.SeekerActiveRange, 0), num(gd.SeekerPassiveRange, 0)) || 5,
        seekerGain: num(gd.SeekerGain, 0),
        seekerPower: num(gd.SeekerOutputPower, 0),
        reliability: num(gd.SeekerReliability, 0.9) * num(gd.WarheadReliability, 0.95), flightTime: num(gd.MaxFlightTime, 0),
        loftAlt: num(gd.MaxLoftAlt, 0), initialFlight: num(gd.InitialFlightPhaseDuration, 3),
        antiChaff: num(gd.AntiCountermeasuresBonus, 1), antiJam: num(gd.AntiJammerBonus, 1),
        // guns / torpedoes
        muzzle: num(ph.MuzzleVelocity, 800), maxRangeM: num(ph.MaxRange, 0) || num(gd.MaxLaunchRange, 0) * NM, cep: num(ph.CircularErrorProbable, 25),
        grav: num(ph.GravityFactor, 1), maxAaM: num(ph.MaxAARange, -1),
        ...rcsExtents((ini.SensorData || {}).RCS, g.FrontalArea, g.SideArea, 0.2),
        massKg: num(g.Mass, 0), fuelKg: num(g.Fuel, 0),
        // One incoming weapon of this value counts toward the target's saturation.
        saturation: num(g.SaturationValue, 1),
        maxMissileSat: num(g.MaximumMissileValue, 2),
        maxTorpedoSat: num(g.MaximumTorpedoValue, 1),
        // MissileEvasiveness is a weave in deg/s. Absent, it falls back to CIWSDefenceBonus, then 0.
        evadeDeg: Math.max(0, num(g.MissileEvasiveness, num(g.CIWSDefenceBonus, 0))),
        // OnRailWarmup is keyed by the launcher SystemName. The timer starts once the mount is aimed.
        railWarmup: railWarmup(ini),
        frontalM2: num(g.FrontalArea, 0), sideM2: num(g.SideArea, 0), bottomM2: num(g.BottomArea, 0),
        pen: w.Penetration || 'Minor', warhead: w.WarheadType || '0',
        // chaff / noisemaker
        spoof: num((ini.ECM || {}).SpoofChance, 0.3), reactionNm: num((ini.ECM || {}).ReactionRange, 2.7),
        effectS: num((ini.ECM || {}).DefensiveEffectTime, 60), lifeS: num((ini.NoisemakerData || {}).LifeTime, 0),
      };
      if (type === 'Sonobuoy') {
        const onboard = ini.OnBoardSystems || {};
        const sonar = this.sensors?.[onboard.Sonar] || {};
        spec.lifeS = num(g.LifeTime, 3600);
        spec.passiveKm = num(sonar.PassiveRange, 0);
        spec.activeKm = num(sonar.ActiveRange, 0);
        spec.activeOnly = bool(sonar.IsActiveOnly, false) || (spec.activeKm > 0 && !sonar.PassiveRange);
        spec.linkNm = num(onboard.TransmitterRange, 30);
        spec.minAltFt = num(gd.MinLaunchAltitude, 200);
        spec.maxAltFt = num(gd.MaxLaunchAltitude, 1000);
        spec.sonarFt = num(onboard.SonarDepth, 0);
        spec.sonar = { ...sonarRecord(sonar), buoy: true };
        spec.chuteKt = num(ph.ParachuteEndVelocity, 100);
        spec.chuteSlow = num(ph.ParachuteSlowDown, 0.99);
        spec.chuteDelay = num(ph.ParachuteDeployDelay, 0);
      }
      if (type === 'Projectile') spec.maxRangeNm = spec.maxRangeM / NM;
      if (type === 'Torpedo') {
        const runs = csvNum(gd.SpeedSettingRanges).filter((n) => n > 0);
        if (!gd.MaxLaunchRange && runs.length) spec.maxRangeNm = Math.max(...runs);
        spec.runKt = num(gd.TerminalVelocity, num(gd.MaxVelocity, num(gd.SearchVelocity, 40)));
        spec.depthM = num(gd.DefaultDepth, 100) * FT;
        spec.maxDepthM = num(gd.MaxDepth, 0) * FT;
        spec.seekerFrac = num(gd.FractionOfRangeToActivateSeeker, 0);
        // SearchMode: 0 none, 1 snake, 2 circle, 3 spiral. Defaults match AmmunitionParameters.
        const speeds = csvNum(gd.SpeedSettings), ranges = csvNum(gd.SpeedSettingRanges);
        spec.speedKts = speeds.length ? speeds : [spec.runKt];
        spec.speedRangesNm = ranges.length ? ranges : [spec.maxRangeNm];
        spec.searchMode = num(gd.SearchMode, 0);
        spec.searchKt = num(gd.SearchVelocity, spec.runKt);
        spec.circleDps = num(gd.CircleDegreesPerSecond, 5);
        spec.circleStraight = num(gd.CircleMoveFwdAfterCircleInSeconds, 5);
        spec.snakeDeg = num(gd.SnakeSearchAngle, 30);
        spec.snakeCycle = Math.max(0.1, num(gd.SnakeSearchTurnCycleTime, 6));
        const spiral = csvNum(gd.SpiralSearchParams);
        spec.spiralCeilM = (spiral[0] || 0) * FT;
        spec.spiralFloorM = (spiral[1] || 0) * FT;
        spec.spiralRadiusNm = Math.max(0.01, num(gd.SpiralSearchRadius, 0.25));
        spec.spiralDeg = num(gd.SpiralSearchAngle, 6);
        // ReattackMode 0 runs straight at max speed. 1 circles at ReattackCircleDegreesPerSecond.
        spec.reattackMode = num(gd.ReattackMode, 0);
        spec.reattackDps = num(gd.ReattackCircleDegreesPerSecond, 10);
        // AircraftDropLaunch opens the chute after 0.5 s. End speed and damping are Physics keys.
        spec.chuteKt = num(ph.ParachuteEndVelocity, 100);
        spec.chuteSlow = num(ph.ParachuteSlowDown, 0.985);
        const fastest = Math.max(0, ...spec.speedKts);
        spec.maxKt = gd.MaxVelocity ? Math.max(num(gd.MaxVelocity, 0), fastest) : (fastest || spec.runKt);
      }
    }
    this.cache.set('spec:' + key, spec);
    return spec;
  }

  // ---------------------------------------------------------------- vessels --
  async vessel(id, variantRef) {
    const ini = await this._get(`vessels/${id}.json`);
    let variants = null;
    try { variants = await this._get(`vessels/${id}_variants.json`); } catch { /* optional */ }
    return this.buildVessel(id, ini, variants, variantRef);
  }

  async buildVessel(id, ini, variants, variantRef) {
    const g = ini.General || {}, p = ini.Physics || {}, sd = ini.SensorData || {}, ai = ini.AI || {};
    const variant = variants && variantRef ? { ...(variants.Default || {}), ...(variants[variantRef] || {}) } : {};
    const vmax = num(p.MaxForwardVelocity, 10), vback = num(p.MaxBackwardVelocity, 3);
    const authoredTelegraph = csvNum(p.TelegraphVelocities || '');
    const spec = {
      id, kind: 'ship', // MissionLoader promotes to 'sub' for Submarine entries
      name: this.displayName(id, variantRef), nation: variant.Nation || '',
      length: num(g.Length, 100), beam: num(g.Beam, 15), disp: num(p.Displacement, 1000),
      telegraph: authoredTelegraph.length >= 3
        ? authoredTelegraph
        : [-vback, 0, 1, 2, 3, 4, 5].map((n, i) => (i < 2 ? n : (n * vmax) / 5)),
      // VesselLoader defaults: RudderTurnRate 0.5, RudderForce 1. Primary/secondary force are constants 1 and 2.
      vmaxKt: vmax, rudderRate: num(p.RudderTurnRate, 0.5), rudderForce: num(p.RudderForce, 1),
      // applyTiltAndPitchForces. TiltFactor scales a turn of 10°/s into the compartment offset.
      tilt: num(p.TiltFactor, 1),
      // PitchFactor and LiftFactor. Positive pitch is discarded by setTiltAndPitch.
      // Lift ramps between LiftVelocityInKnots and stops above MaxSeaStateForPitchAndLift.
      pitchFactor: num(p.PitchFactor, 0), lift: num(p.LiftFactor, 0),
      liftKt: liftBandKt(p.LiftVelocityInKnots), pitchSea: num(p.MaxSeaStateForPitchAndLift, 100),
      // applyMainThrust. HorsePower is the power plant, else the Physics default of 10000.
      shaftHp: num((ini.MainPowerSystem || {}).HorsePower, num(p.HorsePower, 10000)),
      maxAccel: num(p.MaxAccelerationFactor, 1),
      minAccel: num(p.MinAccelerationFactor, 0.2),
      linearDrag: clampDrag(num(p.LinearDrag, 0.98)),
      // Submarine surfaced telegraph is the submerged ladder times MaxForward/MaxForwardSurfaced.
      // Reverse on the surface uses MaxBackwardVelocitySurfaced, not that coefficient.
      surfKt: (g.UnitType || '') === 'Submarine' ? num(p.MaxForwardVelocitySurfaced, 12) : 0,
      surfBackKt: (g.UnitType || '') === 'Submarine' ? num(p.MaxBackwardVelocitySurfaced, 3) : 0,
      accel: num(p.MaxAccelerationFactor, 0.5),
      ...rcsExtents(sd.RCS, g.FrontalArea, g.SideArea), visIdNm: num(sd.VisualIdentificationRange, 5), lowMag: bool(sd.LowMagneticHull, false),
      // SimpleObjectParameters defaults are 2 and 2. A missile value above this is already handled.
      missilesToSaturate: num(ai.MissilesToSaturate, 2),
      torpedoesToSaturate: num(ai.TorpedoesToSaturate, 2),
      // WeaponSystems.TorpedoLaunchDelay. Absent, tubes are not held apart by a ship-wide wait.
      torpedoDelay: num((ini.WeaponSystems || {}).TorpedoLaunchDelay, 0),
      // SensorData defaults: BaseNoise 100, FlowNoise 1, CavitationNoise 10, reflection 25.
      // Creep speed is the third TelegraphVelocities entry (index 2). Absent telegraph → 0.
      noise: hullNoise(sd, p, ini),
      visFront: (g.UnitType || 'Vessel') === 'Submarine' ? 0.4 : (g.UnitType || 'Vessel') === 'Vessel' ? 0.61 : 0.5,
      // Surfaced when the sail is out of the water: y > -(SailUnderWater − TrimDepth), both in feet.
      sailUnderM: (g.UnitType || '') === 'Submarine' ? (num(p.SailUnderWater, 30) - num(p.TrimDepth, 0)) * FT : 0,
      // PeriscopeDepth default is 40 ft. Masts retract once the keel is past this, plus a 0.01 unity margin.
      periscopeM: (g.UnitType || '') === 'Submarine' ? num(p.PeriscopeDepth, 40) * FT : 0,
      // SnorkelMastSystem. Absent on nuclear boats. The default cap is 8 kt.
      snorkelKt: ini.SnorkelMastSystem ? num(ini.SnorkelMastSystem.MaxForwardVelocity, 8) : 0,
      // applyDepth. Rates are the Physics ini. MaxDepthChangeUsingTanks is feet; the loader scales it by 0.00453571.
      dive: (g.UnitType || '') === 'Submarine' ? {
        crushFt: num(p.CrushDepth, 2000),
        maxPitch: num(p.MaxPitchAngle, 30),
        pitchRate: num(p.PitchChangeRate, 2),
        ballastRate: num(p.BallastTankChangeRate, 0.05),
        maxTankFt: num(p.MaxDepthChangeUsingTanks, 10),
        bowUnderFt: num(p.BowUnderWater, 20),
        trimFt: num(p.TrimDepth, 0),
        // applyTilt. The bank is the turn rate in degrees per second, halved and clamped, times this angle.
        maxRoll: num(p.MaxRollAngle, 30),
        rollRate: num(p.RollChangeRate, 2),
      } : null,
      // ObjectBaseLoader measures the LOD0 mesh top, then subtracts trim. Box colliders stand in for that mesh.
      visibleM: visibleTopM(ini, (g.UnitType || '') === 'Submarine'),
      role: csv(ai.Role), hullNo: (variant.HullnumberTexture || '').replace(/^.*_/, '').toUpperCase(),
      livery: variant.LiveryTexture || '', flag: variant.FlagTexture || '',
      modelKey: modelKey(ini),
      sensors: [], weapons: [], ammo: {},
      defense: { chaff: [], ciws: [], noise: [], ecm: [], decoy: [] },
    };
    // sensors -----------------------------------------------------------------
    const nS = num((ini.SensorSystems || {}).NumberOfSensorSystems, 0);
    for (let i = 1; i <= nS; i++) {
      const s = ini['SensorSystem' + i]; if (!s) continue;
      const lib = this.sensors?.[s.SystemName] || {};
      const sonar = (s.Type || lib.Kind) === 'Sonar';
      const rec = {
        idx: i, kind: s.Type || lib.Kind, name: s.SystemName, role: lib.Role || '', cls: lib.Type || '',
        maxRangeKm: num(lib.MaxRange, 0), minRangeKm: num(lib.MinRange, 0), minAlt: num(lib.MinAltitude, 0), maxAlt: num(lib.MaxAltitude, 0),
        frequency: lib.Frequency || '', gain: num(lib.Gain, 0), peakPower: num(lib.PeakPower, 0),
        bands: String(lib.Frequencies || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
        // The vessel section overrides the library. Max range is never shorter than the identification range.
        vidMult: num(s.VIDRangeMultiplier, num(lib.VIDRangeMultiplier, 1)),
        maxMult: Math.max(num(s.MaxRangeMultiplier, num(lib.MaxRangeMultiplier, 1)), num(s.VIDRangeMultiplier, num(lib.VIDRangeMultiplier, 1))),
        lookDown: num(s.LookDownMultiplier, num(lib.LookDownMultiplier, 1)),
        nightVision: num(s.NightVisionLevel, num(lib.NightVisionLevel, 0)),
        mount: s.MountPosition ? csvNum(s.MountPosition) : null,
        heightM: mountHeightM(ini, s), illuminator: lib.Type === 'Targeting',
        // Radar.IsDetectableTarget: only a set CanDetectPeriscope flag sees a raised mast. RadarOffset is feet above the mount.
        peri: bool(lib.CanDetectPeriscope, false),
        offsetM: num(s.RadarOffset, 0) * FT,
        ...fcSensor(lib),
        activeKm: num(lib.ActiveRange, 0), passiveKm: num(lib.PassiveRange, 0),
        ...(sonar ? sonarRecord(lib) : {}),
      };
      rec.weaponChannels += num(s.AdditionalWeaponChannels, 0);
      // LoadCable. Speeds are knots; cable length is metres; Depth is feet.
      if (sonar && s.CableLength) rec.tow = {
        minKt: num(s.MinDeploySpeed, 1), maxKt: num(s.MaxDeploySpeed, 40),
        cableM: num(s.CableLength, 50), depthM: num(s.Depth, 100) * FT,
        maxAltFt: num(s.MaxDeployAltitude, 60000),
        clipOn: bool(s.ClipOn, false),
      };
      spec.sensors.push(rec);
      if (lib.Kind === 'ECM') spec.defense.ecm.push({ name: s.SystemName, jam: num(lib.JamChance, 0), ecmType: lib.Type || 'Defensive' });
      if ((rec.heightM || 0) > spec.visibleM) spec.visibleM = rec.heightM;
    }
    // weapons -----------------------------------------------------------------
    const nW = num((ini.WeaponSystems || {}).NumberOfWeaponSystems, 0);
    for (let i = 1; i <= nW; i++) {
      const w = ini['WeaponSystem' + i]; if (!w) continue;
      const lib = this.weapons?.[w.SystemName] || {};
      const mag = ini[w.AssociatedMagazine] || null;
      const ammoList = [];
      if (mag) for (let a = 1; a <= num(mag.NumberOfAmmunitionTypes, 0); a++) ammoList.push({ id: mag['Ammunition' + a], count: num(mag['Ammunition' + a + '_Count'], 0) });
      // AK-630 names its round on the mount and has no AssociatedMagazine. The stock is RoundsLoaded.
      else if (w.Type === 'CIWS' && w.Ammunition) ammoList.push({ id: w.Ammunition, count: num(lib.RoundsLoaded, 0) });
      // A canister launcher has no magazine. Each container holds NumberOfAttachments of its Ammunition.
      else for (const round of launcherCanisterAmmo(ini, w, lib)) ammoList.push(round);
      const arcs = csvNum(w.FiringArcs);
      spec.weapons.push({
        idx: i, kind: w.Type, system: w.SystemName, magazine: w.AssociatedMagazine || '',
        arcs: arcs.length === 2 ? arcs : [-180, 180], arcSet: arcs.length === 2,
        reloadS: num(lib.ReloadTime, 10), fireRate: num(lib.FireRate, 60), train: num(lib.HorizontalDegreesPerSecond, 0),
        // BurstCount above 1 splits FireRate into a faster cyclic gap and a pause. The record default pause is 1 s.
        burstN: num(lib.BurstCount, 0), burstDelay: num(lib.BurstDelay, 1),
        // NumberOfGuns is the barrel count. FireSequential alternates them; otherwise one cycle fires every barrel.
        guns: Math.max(1, num(w.NumberOfGuns, 1)), sequential: bool(lib.FireSequential, false),
        // WeaponSystemRecord defaults. A missing salvo is one round; the gap is one second.
        preLaunch: num(lib.PreLaunchDelay, 0),
        salvoN: Math.max(1, num(lib.SalvoFireAmount, 1)),
        salvoDt: num(lib.SalvoFireTime, 1),
        maxReaction: num(w.MaxReactiontime, num(w.MaxReactionTime, 0)),
        // SharedLaunchInterval is per SystemName. A missing key does not share a clock.
        sharedLaunch: w.SharedLaunchInterval == null || w.SharedLaunchInterval === '' ? null : num(w.SharedLaunchInterval, 5),
        dmgMult: num(lib.DamageMultiplier, 1),
        elevRate: num(lib.VerticalDegreesPerSecond, 0),
        elevArc: csvNum(w.ElevationArc).length === 2 ? csvNum(w.ElevationArc) : null,
        // alignToTarget adds AdditionalFixVerticalLaunchAngle when the containers can elevate.
        mountRot: bool(w.IsMountRotatable, false),
        containersRot: bool(w.AreContainersRotatable, false),
        addLaunchDeg: num(w.AdditionalFixVerticalLaunchAngle, 0),
        // A tube with LaunchAngle is fixed on the ship. It does not train onto the target.
        tubeDeg: w.LaunchAngle == null || w.LaunchAngle === '' ? null : num(w.LaunchAngle, 0),
        // RoundsMax defaults to RoundsLoaded. That is the ready rack, not the magazine.
        ready: (lib.RoundsMax == null || lib.RoundsMax === '' || num(lib.RoundsMax, -1) < 0) ? num(lib.RoundsLoaded, 0) : num(lib.RoundsMax, 0),
        ammo: ammoList,
        // CalculateHorizon overwrites with each associated sensor, so the last one is the director that remains.
        directors: directorIdxs(w),
      });
      for (const a of ammoList) spec.ammo[a.id] = (spec.ammo[a.id] || 0) + a.count; // pooled stock per ammunition type
      if (w.Type === 'Chaff') spec.defense.chaff.push({ ammoId: w.Ammunition, count: num(lib.RoundsLoaded, 0), reloadS: num(lib.ReloadTime, 60) });
      if (w.Type === 'CIWS') spec.defense.ciws.push({
        ammoId: ammoList[0]?.id || '',
        // MissileInterceptChance is a percent. MK15 authors 40.
        arcs: arcs.length === 2 ? arcs : null, arcSet: arcs.length === 2,
        elevArc: csvNum(w.ElevationArc).length === 2 ? csvNum(w.ElevationArc) : null,
        pk: num(lib.MissileInterceptChance, 0) / 100,
        pkAir: num(lib.AircraftInterceptChance, 0),
        reactionS: num(lib.ReactionTime, 0),
        fireRate: num(lib.FireRate, 0),
        burstS: num(lib.BurstTime, 1),
        train: num(lib.HorizontalDegreesPerSecond, 100),
        volleyMax: num(lib.VolleyMaxRounds, 0),
        // AK-630 fires RangingBurstRounds outside VolleyRange, then waits out the interval.
        // A mount with no ranging burst keeps the hold-fire range instead.
        ranging: num(lib.RangingBurstRounds, 0),
        rangeInterval: Math.max(0.5, num(lib.RangingBurstInterval, 4)),
        volleyM: num(lib.VolleyRange, 0),
        dmgMult: num(lib.DamageMultiplier, 1),
        fcMode: lib.FireControlMode || 'Director',
        cooldownS: num(lib.VolleyCooldown, 3),
        // RoundsLoaded is the drum. ReloadTime is how long FinishReload waits once that drum is empty.
        ready: (lib.RoundsMax == null || lib.RoundsMax === '' || num(lib.RoundsMax, -1) < 0) ? num(lib.RoundsLoaded, 0) : num(lib.RoundsMax, 0),
        reloadS: num(lib.ReloadTime, 900),
      });
      if (w.Type === 'Noisemaker') spec.defense.noise.push({ ammoId: ammoList[0]?.id || '', reloadS: num(lib.ReloadTime, 30) });
    }
    const nDecoy = num(ini.DecoySystems?.NumberOfDecoySystems, 0);
    for (let i = 1; i <= nDecoy; i++) {
      const d = ini['DecoySystem' + i];
      if (!d) continue;
      // CableLength is metres. Depth is feet. Speeds are knots.
      spec.defense.decoy.push({
        name: d.SystemName || 'Decoy',
        ammoId: d.Countermeasure || '',
        cableM: num(d.CableLength, 50),
        depthM: num(d.Depth, 100) * FT,
        minKt: num(d.MinDeploySpeed, 1),
        maxKt: num(d.MaxDeploySpeed, 40),
      });
    }
    // resolve ammo specs so the sim never awaits ------------------------------
    spec.ammoSpecs = {};
    await Promise.all(Object.keys(spec.ammo).map(async (a) => { const s = await this.ammo(a); if (s) spec.ammoSpecs[a] = s; }));
    for (const a of Object.keys(spec.ammo)) if (!spec.ammoSpecs[a]) delete spec.ammo[a];
    for (const c of spec.defense.chaff) {
      const a = await this.ammo(c.ammoId);
      if (!a) continue;
      spec.ammoSpecs[c.ammoId] = a;
      c.reactionNm = a.reactionNm; c.spoof = a.spoof; c.effectS = a.effectS;
    }
    for (const n of spec.defense.noise) {
      const a = spec.ammoSpecs[n.ammoId];
      if (a) { n.lifeS = a.lifeS || 360; n.spoof = a.spoof; }
    }
    for (const d of spec.defense.decoy) {
      const a = await this.ammo(d.ammoId);
      if (!a) continue;
      spec.ammoSpecs[d.ammoId] = a;
      d.spoof = a.spoof;
    }
    for (const g of spec.defense.ciws) g.maxRangeNm = spec.ammoSpecs[g.ammoId]?.maxRangeNm || 1;
    // max hit points (see TUNING in SimWorld)
    spec.hp = 1.1 * Math.pow(Math.max(spec.disp, 50), 0.6);
    const deck = ini.FlightDeck;
    spec.airGroup = Object.entries(ini.AirGroup || {}).filter(([, v]) => /,/.test(v)).map(([id, v]) => {
      const [loadout, count] = v.split(',');
      return { id, loadout: loadout.trim() || 'Default', count: num(count, 0) };
    });
    spec.flightDeck = deck ? {
      capacity: num(deck.AircraftCapacity, spec.airGroup.reduce((n, g) => n + g.count, 0)),
      crew: num(deck.GroundCrewCount, 1),
      spots: num(deck.DeckParkSlots, 1),
      launchDelay: num(deck.LaunchDelay, 50),
    } : null;
    return spec;
  }

  // --------------------------------------------------------------- aircraft --
  /** Loadouts the flight deck can select. The ship's air-group loadout stays first. */
  async loadoutChoices(id, preferred = 'Default') {
    const ini = await this._get(`aircraft/${id}.json`);
    const avail = String(ini.WeaponSystems?.AvailableLoadouts || '').split(',').map((s) => s.trim()).filter(Boolean);
    const names = [];
    const add = (n) => { if (n && ini['WeaponSystem1' + n] && !names.includes(n)) names.push(n); };
    add(preferred || 'Default');
    if (!names.length) add('Default');
    for (const n of avail) add(n);
    add('Ferry');
    return names;
  }

  /** @param {{loadout?: string, year?: number}} [opts] mission LoadoutVariant + Environment year */
  async aircraft(id, { loadout = '', year = 1985 } = {}) {
    const ini = await this._get(`aircraft/${id}.json`);
    const g = ini.General || {}, pf = ini.Performance || {}, ph = ini.Physics || {}, sd = ini.SensorData || {};
    const cruise = csvNum(pf.SpeedAndRange_Cruise)[0] || 0.8;
    const maxKt = num(ph.MaxSpeedAtSeaLevel, num(pf.MaxSpeedAtSeaLevel, 450));
    const helo = /heli|rotor/i.test(g.UnitType || '') || !!ini.Rotors;
    const climbMps = ph.ClimbRate != null ? num(ph.ClimbRate, 0) * FT : num(pf.MaxClimbRate, 100) * FT;
    const name = loadout || 'Default';
    const fitted = ini['WeaponSystem1' + name] || ini.WeaponSystem1Default || {};
    const stores = stationLoads(ini, name, year);
    const metas = await Promise.all(stores.map((s) => this.ammo(s.id)));
    let extraFuel = 0, extraMass = 0;
    stores.forEach((s, i) => { extraFuel += (metas[i]?.fuelKg || 0) * s.n; extraMass += (metas[i]?.massKg || 0) * s.n; });
    let maxRangeNm = num(ph.MaxRange, num(pf.MaxRange, 0));
    // LoadoutSummary helicopter planning: extra tank fuel stretches MaxRange, store mass shortens it.
    const internalFuel = num(ph.MaxFuel, 0);
    if (helo && internalFuel > 0 && num(ph.MaxRange, 0) > 0) {
      const empty = Math.max(1, num(ph.EmptyMass, 1));
      maxRangeNm = num(ph.MaxRange, 0) * ((internalFuel + extraFuel) / internalFuel) / (1 + extraMass / empty);
    }
    const spec = {
      id, kind: 'air', name: this.displayName(id), nation: '', helo,
      span: num(pf.WingSpan, num(ph.RotorDiameter, 12)), length: num(pf.Length, 0) || num(ph.Length, 0) || num(pf.WingSpan, 12) * 0.9,
      frontalM2: num(g.FrontalArea, 0), sideM2: num(g.SideArea, 0), bottomM2: num(g.BottomArea, 0),
      emptyKg: num(pf.EmptyMass, num(ph.EmptyMass, 5000)),
      hp: Math.max(2, num(pf.EmptyMass, num(ph.EmptyMass, 5000)) / 4000 + 2),
      cruiseKt: pf.SpeedAndRange_Cruise ? Math.min(maxKt, cruise * 661) : maxKt * 0.8, maxKt,
      ceilingFt: num(pf.Ceiling, num(ph.Ceiling, 10000)), climbMps,
      maxRangeNm, fuelKg: internalFuel, loadout: name, visFront: helo ? 0.5 : 0.3,
      readyUpMin: num(fitted.ReadyUpTime, 15),
      ...rcsExtents(sd.RCS, g.FrontalArea, g.SideArea, 5), visIdNm: num(sd.VisualIdentificationRange, 4),
      modelKey: modelKey(ini), role: csv(ini.AI?.Role),
      missilesToSaturate: num(ini.AI?.MissilesToSaturate, 2),
      torpedoesToSaturate: num(ini.AI?.TorpedoesToSaturate, 2),
      sensors: [], weapons: [], ammo: aircraftStores(ini, name, year), ammoSpecs: {},
    };
    const nS = num((ini.SensorSystems || {}).NumberOfSensorSystems, 0);
    for (let i = 1; i <= nS; i++) {
      const s = ini['SensorSystem' + i]; if (!s) continue;
      const lib = this.sensors?.[s.SystemName] || {};
      const sonar = (s.Type || lib.Kind) === 'Sonar';
      const rec = {
        idx: i, kind: s.Type || lib.Kind, name: s.SystemName, role: lib.Role || '', cls: lib.Type || '',
        maxRangeKm: num(lib.MaxRange, 0), minRangeKm: num(lib.MinRange, 0), minAlt: num(lib.MinAltitude, 0), maxAlt: num(lib.MaxAltitude, 0),
        frequency: lib.Frequency || '', gain: num(lib.Gain, 0), peakPower: num(lib.PeakPower, 0),
        bands: String(lib.Frequencies || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
        vidMult: num(lib.VIDRangeMultiplier, 1), maxMult: num(lib.MaxRangeMultiplier, 1), lookDown: num(lib.LookDownMultiplier, 1), nightVision: num(lib.NightVisionLevel, 0),
        madNm: num(lib.MaxDetectionRange, 0), madAltFt: num(s.MaxDeployAltitude, 1000),
        madMinKt: num(s.MinDeploySpeed, 0), madMaxKt: num(s.MaxDeploySpeed, 0), towed: bool(s.HasTowedArray, false),
        ...fcSensor(lib),
        ...(sonar ? sonarRecord(lib) : {}),
      };
      if (sonar && s.CableLength) rec.tow = {
        minKt: num(s.MinDeploySpeed, 0), maxKt: num(s.MaxDeploySpeed, 0),
        cableM: num(s.CableLength, 50), depthM: num(s.Depth, 100) * FT,
        maxAltFt: num(s.MaxDeployAltitude, 60000),
        clipOn: bool(s.ClipOn, false),
      };
      spec.sensors.push(rec);
    }
    await Promise.all(Object.keys(spec.ammo).map(async (a) => { const s = await this.ammo(a); if (s) spec.ammoSpecs[a] = s; }));
    for (const a of Object.keys(spec.ammo)) if (!spec.ammoSpecs[a]) delete spec.ammo[a];
    return spec;
  }

  // ------------------------------------------------------------ land units --
  async land(id) {
    let ini;
    try { ini = await this._get(`land_units/${id}.json`); }
    catch { ini = await this._get(`land_units/${id}_launcher.json`); }
    const g = ini.General || {}, sd = ini.SensorData || {};
    const spec = {
      id, kind: 'land', name: this.displayName(id), nation: '', hull: '',
      length: num(g.Length, 14), beam: num(g.Width, num(g.Beam, 4)), draft: 0,
      disp: num(g.Displacement, 20), vmaxKt: num(g.MaxForwardVelocity, 0),
      telegraph: [0], rudderRate: 0, rudderForce: 0,
      role: csv(ini.AI?.Role),
      missilesToSaturate: num(ini.AI?.MissilesToSaturate, 2),
      torpedoesToSaturate: num(ini.AI?.TorpedoesToSaturate, 2),
      ...rcsExtents(sd.RCS, g.FrontalArea, g.SideArea, 8), visIdNm: num(sd.VisualIdentificationRange, 6),
      radarHeight: num(g.RadarHeight, 8), modelKey: modelKey(ini),
      sensors: [], weapons: [], ammo: {}, ammoSpecs: {}, hp: 40,
    };
    const ns = num(ini.SensorSystems?.NumberOfSensorSystems, 0);
    for (let i = 1; i <= ns; i++) {
      const s = ini['SensorSystem' + i]; if (!s) continue;
      const lib = this.sensors?.[s.SystemName] || {};
      spec.sensors.push({
        idx: i, kind: s.Type || lib.Kind, name: s.SystemName, role: lib.Role || '', cls: lib.Type || '',
        maxRangeKm: num(lib.MaxRange, 0), minRangeKm: num(lib.MinRange, 0), minAlt: num(lib.MinAltitude, 0), maxAlt: num(lib.MaxAltitude, 0),
        frequency: lib.Frequency || '', gain: num(lib.Gain, 0), peakPower: num(lib.PeakPower, 0),
        bands: String(lib.Frequencies || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
        vidMult: num(lib.VIDRangeMultiplier, 1), maxMult: num(lib.MaxRangeMultiplier, 1), lookDown: num(lib.LookDownMultiplier, 1), nightVision: num(lib.NightVisionLevel, 0),
        ...fcSensor(lib),
      });
    }
    const nw = num(ini.WeaponSystems?.NumberOfWeaponSystems, 0);
    for (let i = 1; i <= nw; i++) {
      const w = ini['WeaponSystem' + i]; if (!w || /chaff/i.test(w.Type || '')) continue;
      const magName = w.AssociatedMagazine; const mag = magName && ini[magName];
      const landLib = this.weapons?.[w.SystemName] || {};
      const ammoList = [];
      if (mag) {
        const nt = num(mag.NumberOfAmmunitionTypes, 0);
        for (let a = 1; a <= nt; a++) {
          const aid = mag['Ammunition' + a]; if (!aid || /chaff/i.test(aid)) continue;
          ammoList.push({ id: aid, count: num(mag['Ammunition' + a + '_Count'], 0) });
        }
      } else {
        for (const round of launcherCanisterAmmo(ini, w, landLib)) ammoList.push(round);
      }
      if (!ammoList.length) continue;
      spec.weapons.push({
        idx: i, name: w.SystemName || w.Type, type: w.Type, kind: w.Type, ciws: false,
        directors: directorIdxs(w),
        arcs: csvNum(w.FiringArcs).length === 2 ? csvNum(w.FiringArcs) : [-180, 180],
        arcSet: csvNum(w.FiringArcs).length === 2,
        reloadS: num(landLib.ReloadTime, num(w.ReloadTime, 30)), fireRate: num(landLib.FireRate, num(w.FireRate, 0.05)),
        train: num(landLib.HorizontalDegreesPerSecond, 0),
        burstN: num(landLib.BurstCount, 0), burstDelay: num(landLib.BurstDelay, 1),
        guns: Math.max(1, num(w.NumberOfGuns, 1)), sequential: bool(landLib.FireSequential, false),
        maxReaction: num(w.MaxReactiontime, num(w.MaxReactionTime, 0)),
        dmgMult: num(landLib.DamageMultiplier, 1),
        elevRate: num(landLib.VerticalDegreesPerSecond, 0),
        elevArc: csvNum(w.ElevationArc).length === 2 ? csvNum(w.ElevationArc) : null,
        containersRot: bool(w.AreContainersRotatable, false),
        addLaunchDeg: num(w.AdditionalFixVerticalLaunchAngle, 0),
        // A tube with LaunchAngle is fixed on the ship. It does not train onto the target.
        tubeDeg: w.LaunchAngle == null || w.LaunchAngle === '' ? null : num(w.LaunchAngle, 0),
        ready: (landLib.RoundsMax == null || landLib.RoundsMax === '' || num(landLib.RoundsMax, -1) < 0) ? num(landLib.RoundsLoaded, 0) : num(landLib.RoundsMax, 0),
        ammo: ammoList,
      });
      for (const a of ammoList) spec.ammo[a.id] = (spec.ammo[a.id] || 0) + a.count;
    }
    await Promise.all(Object.keys(spec.ammo).map(async (a) => { const s = await this.ammo(a); if (s) spec.ammoSpecs[a] = s; }));
    for (const a of Object.keys(spec.ammo)) if (!spec.ammoSpecs[a]) delete spec.ammo[a];
    return spec;
  }
}

/**
 * LOD0 renderer top, in metres above the origin. The loader uses mesh bounds; the tallest
 * box collider is the same measurement we can read from the ini. TrimPercent defaults to 1,
 * so only TrimDepth is removed, and a submarine then drops another 0.0335 Unity.
 */
function visibleTopM(ini, sub) {
  const M = 1852 / 27.559496;
  let top = 0;
  for (const name of Object.values(ini.Colliders || {})) {
    if (typeof name !== 'string') continue;
    const box = ini[name];
    if (!box || typeof box !== 'object' || !box.Position) continue;
    const pos = csvNum(box.Position);
    const scale = csvNum(box.Scale || '');
    const y = (pos[1] || 0) + Math.abs(scale[1] || 0) / 2;
    if (y > top) top = y;
  }
  let unity = top - num((ini.Physics || {}).TrimDepth, 0) * 0.00453571;
  if (sub) unity -= 0.0335;
  if (!(unity > 0)) unity = 0.046;
  return unity * M;
}

/** Authored fire-control gain, or −1 so the radar profile is derived from range resolution. */
function fcSensor(lib) {
  const present = (key) => lib[key] != null && lib[key] !== '';
  const res = num(lib.RangeResolution, 0);
  const resForTrack = res > 0 ? res : 100;
  return {
    fcGain: present('FCSolutionGainRate') ? num(lib.FCSolutionGainRate, -1) : -1,
    fcMin: present('FCMinSolution') ? num(lib.FCMinSolution, -1) : -1,
    rangeRes: res,
    beamDeg: num(lib.BeamWidth, 0),
    fcTracks: present('FCTracksRounds') ? bool(lib.FCTracksRounds, false) : (lib.Type === 'Targeting' && resForTrack <= 40),
    weaponChannels: num(lib.WeaponChannels, 0),
    targetChannels: num(lib.TargetChannels, 0),
  };
}

/** AssociatedSensors is a comma list of SensorSystemN. The launcher walks it in order. */
function directorIdxs(w) {
  return String(w.AssociatedSensors || '').split(',').map((s) => {
    const m = /SensorSystem(\d+)/.exec(s.trim());
    return m ? Number(m[1]) : 0;
  }).filter((n) => n > 0);
}

// Mount positions in the vessel ini are Unity units. 27.559496 of those = 1 nm.
function mountHeightM(ini, s) {
  const M = 1852 / 27.559496;
  let y = 0, found = false;
  const take = (str) => { const p = csvNum(str); if (Number.isFinite(p[1])) { y += p[1]; found = true; } };
  if (s.MountPosition) take(s.MountPosition);
  else if (s.Mount && ini[s.Mount]) {
    if (ini[s.Mount].Position) take(ini[s.Mount].Position);
    if (s.Radar && ini[s.Radar]?.Position) take(ini[s.Radar].Position);
  }
  return found ? Math.max(1, y * M) : 0;
}

/** One station entry. Sonobuoy stations expand to the position list; tanks stay as stores, not weapons. */
function stationLoads(ini, loadout, year) {
  const out = [];
  const nSys = num(ini.WeaponSystems?.NumberOfWeaponSystems, 0);
  for (let i = 1; i <= nSys; i++) {
    const base = ini['WeaponSystem' + i] || {};
    if (/chaff/i.test(base.Type || '')) continue;
    const fitted = ini['WeaponSystem' + i + (loadout || 'Default')] || ini['WeaponSystem' + i + 'Default'] || {};
    for (const [k, v] of Object.entries(fitted)) {
      if (!/^Station\d+$/.test(k)) continue;
      const parts = String(v).split('|');
      const raw = parts[0].trim();
      if (!raw || /empty|none/i.test(raw)) continue;
      const id = resolveStore(ini, raw, year);
      if (!id) continue;
      let n = 1;
      if (parts[1] && /sonobuoy/i.test(parts[1])) {
        const posKey = /active/i.test(parts[1]) ? 'SonobuoysActivePositions' : 'SonobuoysPositions';
        n = String(base[posKey] || '').split('|').map((s) => s.trim()).filter(Boolean).length || 1;
      }
      out.push({ id, n, tank: /tank/i.test(raw) || /tank/i.test(id) });
    }
  }
  return out;
}

/**
 * WeaponContainer.init when the launcher has no magazine.
 * NumberOfContainers must be set or the mount builds no containers.
 * Each container then loads NumberOfAttachments of ContainerN_Ammunition, else Ammunition.
 * The library default attachment count is 1. Vessel specs have no mission year, so a
 * DateBased_ name takes the latest listed round.
 */
function launcherCanisterAmmo(ini, w, lib) {
  const kind = String(w.Type || '').toLowerCase();
  if (kind !== 'missile' && kind !== 'torpedo' && kind !== 'rbu' && kind !== 'noisemaker') return [];
  if (w.NumberOfContainers == null || w.NumberOfContainers === '') return [];
  const containers = num(w.NumberOfContainers, 1);
  const attachments = num(lib.NumberOfAttachments, 1);
  if (!(containers > 0) || !(attachments > 0)) return [];
  const counts = new Map();
  for (let c = 1; c <= containers; c++) {
    let named = w['Container' + c + '_Ammunition'];
    if (named == null || named === '') named = w.Ammunition;
    const id = canisterAmmoId(ini, named);
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + attachments);
  }
  return [...counts.entries()].map(([id, count]) => ({ id, count }));
}

function canisterAmmoId(ini, raw) {
  const name = String(raw ?? '').trim();
  if (!name || name.toLowerCase() === 'none') return '';
  if (name.startsWith('DateBased_')) return resolveStore(ini, name, 9999);
  return name;
}

/** Ammunition launcher sections. Only a positive OnRailWarmup holds the round on the rail. */
function railWarmup(ini) {
  const out = {};
  for (const [name, body] of Object.entries(ini || {})) {
    if (!body || typeof body !== 'object' || body.OnRailWarmup == null || body.OnRailWarmup === '') continue;
    const t = num(body.OnRailWarmup, 0);
    if (t > 0) out[name] = t;
  }
  return out;
}

function resolveStore(ini, raw, year) {
  const aliases = ini.WeaponSystems || {};
  if (!aliases[raw]) return raw;
  let pick = '';
  for (const part of String(aliases[raw]).split('|')) {
    const bits = part.split(',');
    if (bits.length >= 2 && Number.isFinite(+bits[0])) { if (year >= +bits[0]) pick = bits.slice(1).join(','); }
    else pick = part;
  }
  return pick.trim() || raw;
}

/** Hardpoint stations for one loadout, plus gun magazines. DateBased_* aliases follow the mission year. */
function aircraftStores(ini, loadout, year) {
  const counts = {};
  const n = num(ini.WeaponSystems?.NumberOfWeaponSystems, 0);
  for (let i = 1; i <= n; i++) {
    const base = ini['WeaponSystem' + i] || {};
    if (/chaff/i.test(base.Type || '')) continue;
    const mag = base.AssociatedMagazine && ini[base.AssociatedMagazine];
    if (mag) {
      const nt = num(mag.NumberOfAmmunitionTypes, 0);
      for (let a = 1; a <= nt; a++) {
        const aid = mag['Ammunition' + a];
        if (!aid || /chaff/i.test(aid)) continue;
        counts[aid] = (counts[aid] || 0) + num(mag['Ammunition' + a + '_Count'], 0);
      }
    }
  }
  for (const s of stationLoads(ini, loadout, year)) if (!s.tank) counts[s.id] = (counts[s.id] || 0) + s.n;
  return counts;
}
