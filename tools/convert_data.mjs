// Converts the user's *locally installed* Sea Power data files (plain-text INI,
// moddable by design) into JSON under ./data for the web engine.
//   node tools/convert_data.mjs ["<Sea Power install dir>"]
// Output is gitignored: it is derived from the user's own copy and must not be
// redistributed.
import fs from 'node:fs';
import path from 'node:path';
import { parseIni } from '../src/core/IniParser.js';
import { extractBriefing } from './briefing.mjs';

const GAME = process.argv[2] || process.env.SEAPOWER_DIR || 'D:/Steam_new/steamapps/common/Sea Power';
const SRC = path.join(GAME, 'Sea Power_Data', 'StreamingAssets', 'original');
const OUT = path.resolve(import.meta.dirname, '..', 'data');
if (!fs.existsSync(SRC)) { console.error('Not found: ' + SRC); process.exit(1); }

const rd = (p) => fs.readFileSync(p, 'utf8');
const wr = (rel, obj) => { const p = path.join(OUT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); };
const iniFiles = (dir) => fs.readdirSync(path.join(SRC, dir)).filter((f) => f.endsWith('.ini'));

// ---- language (en) names ----------------------------------------------------
const lang = {};
for (const f of ['vessel_names.ini', 'aircraft_names.ini', 'ammunition_names.ini', 'land_units_names.ini', 'nations.ini']) {
  const p = path.join(SRC, 'language_en', f);
  if (fs.existsSync(p)) lang[f.replace('.ini', '')] = parseIni(rd(p));
}
wr('lang_en.json', lang);

// ---- unit classes: vessels / aircraft / ammunition / land_units ---------------
function convertUnits(dir, extra) {
  const index = {};
  for (const f of iniFiles(dir)) {
    const id = f.slice(0, -4);
    const ini = parseIni(rd(path.join(SRC, dir, f)));
    if (id.endsWith('_variants')) { wr(`${dir}/${id}.json`, ini); continue; }
    wr(`${dir}/${id}.json`, ini);
    const g = ini.General || {};
    index[id] = extra(ini, g);
  }
  wr(`${dir}/index.json`, index);
  return Object.keys(index).length;
}
const N = {};
N.vessels = convertUnits('vessels', (ini, g) => ({
  length: +g.Length || 0, beam: +g.Beam || 0, role: (ini.AI || {}).Role || '', disp: +((ini.Physics || {}).Displacement) || 0,
  vmax: +((ini.Physics || {}).MaxForwardVelocity) || 0, type: g.UnitType || 'Vessel',
}));
N.aircraft = convertUnits('aircraft', (ini, g) => ({ type: g.UnitType || 'Aircraft' }));
N.ammunition = convertUnits('ammunition', (ini, g) => ({ type: g.Type || '', target: g.TargetType || '' }));
N.land_units = convertUnits('land_units', (ini, g) => ({ type: g.UnitType || '' }));

// ---- shared system libraries --------------------------------------------------
for (const f of ['sensors', 'weapons', 'combatsystems', 'modules']) wr(`systems/${f}.json`, parseIni(rd(path.join(SRC, 'systems', `${f}.ini`))));

// ---- missions (recursive; .ini containing Taskforce vessels) -------------------
const missions = [];
function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(p, r); continue; }
    if (!e.name.endsWith('.ini') || e.name === '_info.ini') continue;
    const ini = parseIni(rd(p));
    const mission = ini.Mission;
    if (!mission && !ini.Environment) continue;
    const L = ini.Language_en || ini.Language_cn || {};
    const id = r.replace(/\.ini$/, '');
    const m = {
      id, name: L.Name || e.name.replace(/\.ini$/, ''), description: L.Description || '',
      category: rel.split('/')[0] || '', type: (ini.General || {}).Type || '',
      nVessels: Object.keys(ini).filter((k) => /^Taskforce\d+Vessel\d+$/.test(k)).length,
      nAircraft: Object.keys(ini).filter((k) => /^Taskforce\d+(Aircraft|Squadron)/.test(k)).length,
      date: (ini.Environment || {}).Date, lat: (ini.Environment || {}).MapCenterLatitude, lon: (ini.Environment || {}).MapCenterLongitude,
    };
    missions.push(m);
    // strip the multi-language blocks from the stored mission to keep it small
    for (const k of Object.keys(ini)) if (k.startsWith('Language_') && k !== 'Language_en') delete ini[k];
    const startPage = (ini.Language_en || {}).Taskforce1StartmessageFreeContentPath;
    if (startPage) ini.briefing = extractBriefing(SRC, startPage);
    wr(`missions/${id.replace(/[\\/]/g, '__')}.json`, ini);
  }
}
walk(path.join(SRC, 'missions'), '');
wr('missions/index.json', missions);

// ---- terrain config + environment ----------------------------------------------
for (const f of ['environment', 'config']) wr(`${f}.json`, parseIni(rd(path.join(SRC, `${f}.ini`))));

console.log('Converted ->', OUT);
console.log(N, 'missions:', missions.length, 'with vessels:', missions.filter((m) => m.nVessels).length);
