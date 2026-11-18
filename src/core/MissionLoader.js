// MissionLoader — builds a SimWorld from a converted mission (.ini → JSON).
// Unit placement keys: Taskforce{N}{Vessel|Submarine|Aircraft|Helicopter|LandUnit}{i},
// Neutral{Vessel|Submarine|Aircraft}{i}. RelativePositionInNM = "east,alt|depth,north"
// (aircraft altitude in feet). Waypoints: "e,alt,n/SetTelegraph,2/…" (NM, ft).
import { SimWorld } from './SimWorld.js';
import { NM, FT } from './Units.js';
import { num, csv } from './IniParser.js';

const KEY_RE = /^(Taskforce(\d+)|Neutral)(Vessel|Submarine|Aircraft|Helicopter|LandUnit)(\d+)$/;

function parseWaypoints(str, isAir) {
  if (!str) return [];
  const out = [];
  for (const part of str.split('/')) {
    const p = part.split(',').map((s) => s.trim());
    if (/^SetTelegraph$/i.test(p[0]) && out.length) { out[out.length - 1].telegraph = +p[1]; continue; }
    if (p.length >= 3 && Number.isFinite(parseFloat(p[0])) && Number.isFinite(parseFloat(p[2]))) {
      const alt = parseFloat(p[1]);
      out.push({ x: parseFloat(p[0]) * NM, y: parseFloat(p[2]) * NM, z: isAir && Number.isFinite(alt) ? alt * FT : 0 });
    }
  }
  return out;
}

/** @param {import('./UnitCatalog.js').UnitCatalog} catalog */
export async function loadMission(catalog, mission, { seed = 7 } = {}) {
  const world = new SimWorld({ seed, catalog });
  const m = mission.Mission || {};
  const playerTf = +(m.PlayerTaskforce || 'Taskforce1').replace(/\D/g, '') || 1;
  world.playerTeam = 1;
  const teamOf = (tf) => (tf === 0 ? 0 : tf === playerTf ? 1 : 2);
  const year = parseInt(String(mission.Environment?.Date || '1985').split(',')[0], 10) || 1985;
  const jobs = [];
  for (const key of Object.keys(mission)) {
    const k = KEY_RE.exec(key); if (!k) continue;
    const sec = mission[key];
    const tf = k[1] === 'Neutral' ? 0 : +k[2];
    const cls = k[3];
    const pos = (sec.RelativePositionInNM || '0,0,0').split(',');
    jobs.push((async () => {
      try {
        let spec;
        if (cls === 'Aircraft' || cls === 'Helicopter') {
          spec = await catalog.aircraft(sec.Type, { loadout: sec.LoadoutVariant || '', year });
        } else if (cls === 'LandUnit') {
          spec = await catalog.land(sec.Type);
        } else {
          spec = await catalog.vessel(sec.Type, sec.VariantReference);
          if (cls === 'Submarine') spec = { ...spec, kind: 'sub' };
        }
        const isAir = spec.kind === 'air';
        const altFt = isAir ? parseFloat(pos[1]) || 0 : 0;
        return {
          key, spec, team: teamOf(tf), x: parseFloat(pos[0]) * NM, y: parseFloat(pos[2]) * NM, z: altFt * FT,
          heading: parseFloat(sec.Heading) || 0, telegraph: parseInt(sec.Telegraph ?? '0', 10), disabled: /true/i.test(sec.Disabled || ''),
          waypoints: parseWaypoints(sec.Waypoints, isAir), isAir,
        };
      } catch (e) { console.warn('skip', key, sec.Type, e.message); return null; }
    })());
  }
  const placed = (await Promise.all(jobs)).filter(Boolean);
  const byKey = {};
  for (const p of placed) {
    const u = world.addUnit({ spec: p.spec, team: p.team, x: p.x, y: p.y, z: p.z, heading: p.heading, telegraph: p.telegraph, waypoints: p.waypoints, active: !p.disabled, alt: p.isAir ? p.z : null });
    u.course = p.heading; u.key = p.key; byKey[p.key] = u;
    if (p.team === 2) world.hadEnemies = true;
  }
  await Promise.all(Object.values(byKey).map((u) => world.fitDeck(u, year)));
  world.buildFormations();
  world.byKey = byKey;
  world.playerKey = (() => { const first = Object.keys(byKey).filter((k) => byKey[k].team === 1 && byKey[k].kind === 'ship'); return first[0]; })();
  world.noEnemyAi = /true/i.test(mission.Debug?.DisableEnemyAIPlayer || '');
  world.meta = { name: mission.Language_en?.Name || '', description: mission.Language_en?.Description || '', env: mission.Environment || {}, objectives: mission.Taskforce1_Objectives || {}, briefing: mission.briefing || [] };
  world.setWeather(mission.Environment || {});
  world.triggers.push(buildTriggerRunner(mission, byKey, world));
  return world;
}

function applyTrigger(world, byKey, sec) {
  if (sec.Action_SetEnabledStatus && sec.Action_Units) {
    const on = /true/i.test(sec.Action_SetEnabledStatus);
    for (const k of csv(sec.Action_Units)) if (byKey[k]) byKey[k].active = on;
  }
  if (sec.Action_UnitRevealToTaskforce && sec.Action_Units) {
    for (const k of csv(sec.Action_Units)) {
      const u = byKey[k]; if (!u) continue;
      u.revealed = true;
      world.contacts[world.playerTeam].set(u.id, { id: u.id, level: 2, x: u.x, y: u.y, z: u.z, heading: u.heading, speed: u.speed, t: world.t, live: true, kind: u.kind });
    }
  }
  if (/true/i.test(sec.Action_EndMission || '')) {
    const win = /taskforce1/i.test(sec.Action_Victory || '');
    world.over = { winner: win ? world.playerTeam : 2 };
    world.emit('end', { msg: win ? 'Tutorial complete' : 'Mission ended' });
  }
}

/** Time conditions fire on their own. Named triggers wait for the briefing's ExecuteTriggerCommand. */
function buildTriggerRunner(mission, byKey, world) {
  const trigs = Object.keys(mission).filter((k) => /^Trigger\d+$/.test(k)).map((k) => ({ key: k, sec: mission[k], done: false }));
  world.runTrigger = (name) => {
    const t = trigs.find((x) => x.sec.Name === name && !x.done);
    if (!t) return false;
    t.done = true;
    applyTrigger(world, byKey, t.sec);
    return true;
  };
  return (w) => {
    for (const t of trigs) {
      if (t.done || /true/i.test(t.sec.Disabled || '')) continue;
      const kind = t.sec.Condition_Condition1_Type;
      if (kind !== 'Time') continue;
      if (w.t < num(t.sec.Condition_Condition1_Time, 0)) continue;
      t.done = true;
      applyTrigger(w, byKey, t.sec);
    }
  };
}
