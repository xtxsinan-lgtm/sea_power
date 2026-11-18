// main.js — bootstrap & orchestration: data catalog → mission → SimWorld ↔ 3D stage / HUD / tactical map.
import { UnitCatalog } from './core/UnitCatalog.js';
import { loadMission } from './core/MissionLoader.js';
import { StageManager3D } from './scene3d/StageManager3D.js';
import { TacticalMap } from './ui/TacticalMap.js';
import { NM, KT, FT, dist2, bearing, wrap360, wrap180, clamp, R2D } from './core/Units.js';
import { FORM_PATTERNS, FORM_SPACING, trackMarks, SUB_DEPTHS } from './core/SimWorld.js';

// SeaPower.GameTime static constructor list, capped by original config.ini MaxTimeCompression=100.
const TIME_SCALES = [0.1, 0.2, 0.5, 1, 2, 3, 5, 10, 20, 30, 50, 100];
const fmtScale = (s) => `${s}×`;
const ROE_LABEL = { tight: 'Weapons Tight', hold: 'Weapons Hold', free: 'Weapons Free' };
const LOADOUT_LABEL = {
  Default: 'Default', Ferry: 'Ferry', Empty: 'Empty', ASW: 'ASW',
  ASWHunter: 'ASW Hunter', ASWHunterLight: 'ASW Hunter (Light)', ASWKiller: 'ASW Killer',
  ASWBomb: 'ASW Bombs', ASWLongRange: 'ASW Long Range', Transport: 'Transport',
};
// language_en/ui.ini Navigate_Change_Speed_* . Speeds stay n·Vmax/5, Back Full is MaxBackwardVelocity.
const SHIP_ORDERS = [
  { n: -1, short: 'Back', name: 'Back Full' },
  { n: 0, short: 'Stop', name: 'All Stop' },
  { n: 1, short: '1/3', name: 'Ahead 1/3' },
  { n: 2, short: '2/3', name: 'Ahead 2/3' },
  { n: 3, short: 'Std', name: 'Ahead Standard' },
  { n: 4, short: 'Full', name: 'Ahead Full' },
  { n: 5, short: 'Flank', name: 'Ahead Flank' },
];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtT = (t) => { t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':'); };

class App {
  constructor() {
    this.stage = new StageManager3D($('#webgl-stage'));
    this.map = new TacticalMap($('#map-canvas'));
    this.world = null; this.selId = null; this.targetId = null;
    this.scale = 1; this.paused = false; this.hudT = 0; this.ctlKey = ''; this.deckOpen = false; this.selectedAmmo = null; this.mapFrame = null;
    this.slots = Array(10).fill(null); this.formSig = ''; this._rudderAt = 0;
    this.params = new URLSearchParams(location.search);
    this.catalog = new UnitCatalog(async (p) => { const r = await fetch('data/' + p); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); });
    this._bind();
    this.boot();
    window.__APP = this;
    let last = performance.now();
    const frame = (now) => { const dt = Math.min(0.1, (now - last) / 1000); last = now; this.tick(dt); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }

  async boot() {
    try {
      await this.catalog.init();
      this.missions = (await this.catalog.loadJson('missions/index.json')).filter((m) => m.nVessels);
    } catch (e) {
      $('#menu-sub').innerHTML = `<span class="bad">Game data not found (${esc(e.message)}).</span> Run <code>node tools/convert_data.mjs</code> first.`; return;
    }
    const groups = {};
    for (const m of this.missions) (groups[m.category || 'Other'] ||= []).push(m);
    const order = ['Tutorials', 'Intro', 'NATO', 'Warsaw Pact', 'PLAN', 'Other', 'Campaign Scenarios', 'Demo'];
    $('#mission-list').innerHTML = Object.keys(groups).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((g) => `<h4>${esc(g)}</h4>` + groups[g].map((m) => `<div class="m" data-id="${esc(m.id)}"><span>${esc(m.name)}</span><small>${m.nVessels} ships · ${m.nAircraft} air</small></div>`).join('')).join('');
    $('#menu-sub').textContent = `${this.missions.length} missions available`;
    this.pickMission(this.params.get('mission') || 'Tutorials/Officer_Training_1');
    if (this.params.has('mission')) this.start();
  }

  pickMission(id) {
    this.chosen = id;
    document.querySelectorAll('#mission-list .m').forEach((e) => e.classList.toggle('sel', e.dataset.id === id));
  }

  async start() {
    if (!this.chosen) return;
    const m = this.missions.find((x) => x.id === this.chosen);
    $('#menu-sub').textContent = 'Loading ' + m.name + '…';
    const mission = await this.catalog.loadJson('missions/' + m.id.replace(/[\\/]/g, '__') + '.json');
    // clear old actors
    for (const a of this.stage.actors.values()) { this.stage.scene.remove(a.root); a.trail && this.stage.scene.remove(a.trail.line); a.wake && this.stage.scene.remove(a.wake); }
    this.stage.actors.clear();
    const world = await loadMission(this.catalog, mission);
    const modelKeys = [...new Set([...world.units.values()].map((u) => u.spec.modelKey).filter(Boolean))];
    if (modelKeys.length) {
      $('#menu-sub').textContent = `Loading ${modelKeys.length} models…`;
      await this.stage.preloadModels(modelKeys);
    }
    world.revealAll = this.params.has('reveal');
    this.world = world;
    this.world.on((e) => this.onEvent(e));
    const env = this.world.meta.env;
    this.stage.ocean.setSeaState(+env.SeaState || 2);
    const wth = this.world.weather;
    const night = this.stage.sky.setFromSun(wth.sunAlt ?? 40, wth.hourAngle ?? 0);
    this.stage.renderer.toneMappingExposure = 0.95 + 0.9 * night;
    $('#mission-name').textContent = this.world.meta.name || m.name;
    $('#log').innerHTML = '';
    const first = this.world.byKey[this.world.playerKey];
    this.select(first?.id ?? null, true);
    this.targetId = null; this.map.fit(this.world);
    $('#menu').classList.add('hidden');
    this.briefAt = 0;
    this.renderBrief();
    this.toast(this.world.meta.description.slice(0, 160));
    this.paused = false;
  }

  // ------------------------------------------------------------- selection --
  get sel() { return this.world?.get(this.selId); }
  select(id, camera = false) {
    this.selId = id; const u = this.sel;
    if (u && camera && u.kind !== 'missile') this.stage.follow(u);
    this.ctlKey = '';
  }

  /** Left click a hostile contact to put the camera on it and watch the weapon arrive. */
  watch(u) {
    if (!u || u.kind === 'shell') return;
    this.targetId = u.id;
    this.stage.follow(u);
    this.stage.setMode('follow');
    this.ctlKey = '';
  }
  cycle(team, dir = 1) {
    const list = [...this.world.all()].filter((u) => (u.kind === 'ship' || u.kind === 'air' || u.kind === 'sub') && u.team === team && u.active && (team === 1 || this.visible(u)));
    if (!list.length) return null;
    const i = list.findIndex((u) => u.id === this.selId);
    return list[(i + dir + list.length) % list.length];
  }
  visible = (u) => this.world.playerSees(u);

  onEvent(e) {
    if (e.msg) {
      const d = document.createElement('div'); d.className = e.type; d.innerHTML = `<span class="t">${fmtT(e.t)}</span>${esc(e.msg)}`;
      const log = $('#log'); log.prepend(d); while (log.children.length > 120) log.lastChild.remove();
    }
    const A = (id) => this.stage.actors.get(id);
    if (e.type === 'hit') { const p = { x: e.x, y: e.z ?? 6, z: -e.y }; this.stage.fx.explosion(p, 1.1); }
    if (e.type === 'splash') this.stage.fx.splash({ x: e.x, z: -e.y }, 1);
    if (e.type === 'miss' && e.x != null) this.stage.fx.splash({ x: e.x, z: -e.y }, 2);
    if (e.type === 'kill') { const a = A(e.id); if (a) this.stage.fx.explosion(a.root.position, 2.5); }
    if (e.type === 'end') this.toast(e.msg, 6000);
  }

  renderBrief() {
    const pages = this.world?.meta.briefing || [];
    const el = $('#brief');
    if (!pages.length) { el.classList.add('hidden'); return; }
    const page = pages[Math.max(0, Math.min(pages.length - 1, this.briefAt))];
    el.classList.remove('hidden');
    $('#brief-text').textContent = page.text;
    $('#brief-actions').innerHTML = (page.buttons || []).map((b, i) => `<button data-brief="${i}">${esc(b.content)}</button>`).join('');
  }

  briefGo(i) {
    const pages = this.world?.meta.briefing || [];
    const page = pages[this.briefAt];
    const b = page?.buttons?.[i];
    if (!b) return;
    if (b.trigger && this.world.runTrigger?.(b.trigger)) this.toast(b.trigger);
    if (b.open) {
      const at = pages.findIndex((p) => p.file === b.open);
      if (at >= 0) this.briefAt = at;
    }
    this.renderBrief();
  }

  /** InputHandler repeats RudderLeft/RudderRight at most every 0.5s of real time. Aircraft keep a course step. */
  nudgeRudder(u, dir) {
    if (u.kind === 'air') { this.world.orderCourse(u, u.course + dir * 5); return; }
    const now = performance.now();
    if (now - this._rudderAt < 500) return;
    this._rudderAt = now;
    this.world.turnRudder(u, dir);
    this.ctlKey = '';
  }

  toast(msg, ms = 3500) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('show'), ms);
  }

  // --------------------------------------------------------------- orders --
  orderTo(pt, append) {
    const u = this.sel; if (!u || u.team !== 1 || !u.alive || u.rtb || !['ship', 'air', 'sub'].includes(u.kind)) return;
    if (append || (u.waypoints.length && u.wpIdx < u.waypoints.length && append)) u.waypoints.push({ x: pt.x, y: pt.y, z: u.kind === 'air' ? u.ordAlt : 0 });
    else { u.waypoints = [{ x: pt.x, y: pt.y, z: u.kind === 'air' ? u.ordAlt : 0 }]; u.wpIdx = 0; }
    u.course = bearing(u, u.waypoints[u.wpIdx]);
    if (u.telegraph <= 0 && u.kind !== 'air') { u.telegraph = 3; }
  }

  fireAt(ammoId, count = 1) {
    const u = this.sel, t = this.world.get(this.targetId);
    if (!u || !t) return this.toast('Select a target contact first (click / right-click an enemy)');
    if (u.roe === 'hold') return this.toast('Weapons Hold');
    const n = this.world.orderSalvo(u, ammoId, t, count);
    if (!n) this.toast('Cannot fire: out of range, no ammo, or invalid target');
  }

  // ----------------------------------------------------------------- input --
  _bind() {
    $('#unit-list').addEventListener('click', (e) => {
      if (e.target.closest('[data-form-pattern]')) { this.world?.cyclePattern(); this.formSig = ''; return; }
      if (e.target.closest('[data-form-spacing]')) { this.world?.cycleSpacing(); this.formSig = ''; return; }
      const el = e.target.closest('.item'); if (el) this.select(+el.dataset.id, false);
    });
    $('#unit-list').addEventListener('dblclick', (e) => {
      const el = e.target.closest('.item'); if (!el) return;
      this.select(+el.dataset.id, true);
      this.stage.setMode('follow');
    });
    $('#unit-list').addEventListener('dragstart', (e) => { const el = e.target.closest('.item'); if (el) e.dataTransfer.setData('text/plain', el.dataset.id); });
    $('#unit-list').addEventListener('dragover', (e) => { const head = e.target.closest('.form-head'); if (head) { e.preventDefault(); head.classList.add('over'); } });
    $('#unit-list').addEventListener('dragleave', (e) => { e.target.closest?.('.form-head')?.classList.remove('over'); });
    $('#unit-list').addEventListener('drop', (e) => {
      const head = e.target.closest('.form-head'); if (!head) return;
      e.preventDefault(); head.classList.remove('over');
      const u = this.world?.get(+e.dataTransfer.getData('text/plain'));
      if (u) { this.world.setFormation(u, head.dataset.form === '1'); this.formSig = ''; }
    });
    $('#contact-list').addEventListener('click', (e) => { const el = e.target.closest('.item'); if (el) this.watch(this.world?.get(+el.dataset.id)); });
    $('#control').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return; const u = this.sel; if (!u) return;
      if (b.dataset.tele != null) { this.world.orderTelegraph(u, +b.dataset.tele); this.ctlKey = ''; }
      if (b.dataset.air) { this.toast(this.world.toggleAirSearch(u) ? (u.airSearchOn ? 'Air radar on' : 'Air radar off') : 'No air-search radar'); this.ctlKey = ''; }
      if (b.dataset.surf) { this.toast(this.world.toggleSurfaceSearch(u) ? (u.surfSearchOn ? 'Surface radar on' : 'Surface radar off') : (u.orderText || 'No surface-search radar')); this.ctlKey = ''; }
      if (b.dataset.scope) { this.toast(this.world.togglePeriscope(u) ? u.orderText : (u.orderText || 'No periscope')); this.ctlKey = ''; }
      if (b.dataset.esm) { this.toast(this.world.toggleEsm(u) ? u.orderText : (u.orderText || 'No ESM mast')); this.ctlKey = ''; }
      if (b.dataset.snorkel) { this.toast(this.world.toggleSnorkel(u) ? u.orderText : (u.orderText || 'No snorkel')); this.ctlKey = ''; }
      if (b.dataset.emcon) { this.world.toggleEmcon(u); this.toast(u.emcon ? 'EMCON — search radars off' : 'EMCON cleared'); this.ctlKey = ''; }
      if (b.dataset.active) { this.toast(this.world.toggleActiveSonar(u) ? (u.activeSonarOn ? 'Active sonar on' : 'Active sonar off') : 'No active sonar'); this.ctlKey = ''; }
      if (b.dataset.roe) { this.world.setRoe(u, b.dataset.roe); this.toast(ROE_LABEL[u.roe]); this.ctlKey = ''; }
      if (b.dataset.course) { this.world.orderCourse(u, wrap360(u.course + +b.dataset.course)); this.ctlKey = ''; }
      if (b.dataset.rudder != null) {
        const d = +b.dataset.rudder;
        if (d === 0) { this.world.releaseVid(u); u.helm = true; u.rudderSet = 0; } else this.world.turnRudder(u, d);
        this.ctlKey = '';
      }
      if (b.dataset.vid) {
        const t = this.world.get(this.targetId);
        this.toast(this.world.orderIdentify(u, t) ? u.orderText : 'Cannot VID that contact');
        this.ctlKey = '';
      }
      if (b.dataset.pick) { this.selectedAmmo = b.dataset.pick; this.ctlKey = ''; }
      if (b.dataset.cease) this.ceaseFire();
      if (b.dataset.fire) this.fireAt(b.dataset.fire, +b.dataset.n || 1);
      if (b.dataset.noise) { this.toast(this.world.deployNoisemaker(u) ? 'Noisemaker deployed' : 'Noisemaker not ready'); this.ctlKey = ''; }
      if (b.dataset.decoy) {
        const d = u.decoy?.[0];
        this.world.toggleDecoy(u);
        this.toast(d?.wanted ? 'Towed decoy ordered out' : 'Towed decoy stowed');
        this.ctlKey = '';
      }
      if (b.dataset.buoy) { this.toast(this.world.dropSonobuoys(u) ? (u.layBuoys ? 'Descending to drop altitude' : 'Sonobuoys laid') : 'No sonobuoys'); this.ctlKey = ''; }
      if (b.dataset.alt) { this.world.orderAltitude(u, Math.max(30, (u.ordAlt ?? u.z) + +b.dataset.alt * FT)); this.ctlKey = ''; }
      if (b.dataset.depth != null) { this.world.orderDepth(u, +b.dataset.depth); this.ctlKey = ''; }
      if (b.dataset.altset) { this.world.orderAltitude(u, +b.dataset.altset * FT); this.ctlKey = ''; }
      if (b.dataset.stop) { this.world.orderCourse(u, u.heading); this.ctlKey = ''; }
      if (b.dataset.cam) this.stage.follow(u);
    });
    document.querySelector('[data-act=time-dec]').addEventListener('click', () => this.stepTime(-1));
    document.querySelector('[data-act=time-inc]').addEventListener('click', () => this.stepTime(1));
    document.querySelector('[data-act=time-stop]').addEventListener('click', () => this.stopTime());
    document.querySelector('[data-act=pause]').addEventListener('click', () => (this.paused = !this.paused));
    document.querySelector('[data-act=map]').addEventListener('click', () => this.toggleMapVisible());
    const camOrder = ['follow', 'free', 'flyby', 'smooth'];
    const camLabel = { follow: 'Follow', free: 'Free', flyby: 'Flyby', smooth: 'Smooth' };
    document.querySelector('[data-act=cam]').addEventListener('click', () => {
      const i = camOrder.indexOf(this.stage.rig.mode);
      this.stage.setMode(camOrder[(i + 1) % camOrder.length]);
    });
    this.stage.onMode = (m) => { const b = document.querySelector('[data-act=cam]'); b.textContent = camLabel[m] || 'Follow'; b.classList.toggle('on', m !== 'follow'); };
    document.querySelector('[data-act=menu]').addEventListener('click', () => $('#menu').classList.remove('hidden'));
    document.querySelector('[data-act=reveal]').addEventListener('click', () => { if (this.world) this.world.revealAll = !this.world.revealAll; });
    document.querySelector('[data-act=deck]').addEventListener('click', () => this.toggleDeck());
    $('#deck').addEventListener('click', (e) => {
      const ship = this.deckShip();
      if (!ship || !this.world) return;
      const opt = e.target.closest('[data-opt]');
      if (opt) {
        const bin = ship.deck?.bins[+opt.dataset.bin];
        const choice = bin?.options?.[+opt.dataset.opt];
        if (choice) { bin.pick = +opt.dataset.opt; bin.spec = choice.spec; bin.loadout = choice.name; this.deckSig = ''; this.renderDeck(); }
        return;
      }
      const b = e.target.closest('[data-launch]'); if (!b) return;
      if (this.world.requestLaunch(ship, +b.dataset.launch)) this.toast('Preparing to launch');
      this.ctlKey = '';
    });
    $('#mission-list').addEventListener('click', (e) => { const m = e.target.closest('.m'); if (m) this.pickMission(m.dataset.id); });
    $('#mission-list').addEventListener('dblclick', (e) => { const m = e.target.closest('.m'); if (m) { this.pickMission(m.dataset.id); this.start(); } });
    $('#start').addEventListener('click', () => this.start());
    $('#map-fit').addEventListener('click', () => this.centerMap());
    $('#map-max').addEventListener('click', () => this.toggleMap());
    $('#map-close').addEventListener('click', () => this.hideMap());
    $('#map-toggle').addEventListener('click', () => this.toggleMapVisible());
    this.bindMapFrame();
    $('#brief-actions').addEventListener('click', (e) => { const el = e.target.closest('[data-brief]'); if (el) this.briefGo(+el.dataset.brief); });

    this.stage.onClick = (e, btn) => {
      if (!this.world) return;
      const p = this.stage.pick(e);
      this.handleClick(p.unitId, p.water, btn, e.shiftKey);
    };
    this.map.onClick = (id, w, e) => this.handleClick(id, w, e.button, e.shiftKey);
    this.map.onHover = (id) => {
      if (!this.selectedAmmo || id == null) return;
      const u = this.world?.get(id);
      if (!u || !u.alive || u.team === 1 || u.kind === 'shell' || u.kind === 'missile') return;
      if (this.targetId !== u.id) { this.targetId = u.id; this.ctlKey = ''; }
    };
    addEventListener('keydown', (e) => {
      if (!this.world || e.target.tagName === 'INPUT' || !$('#menu').classList.contains('hidden')) return;
      const u = this.sel; const k = e.key.toLowerCase();
      const free = this.stage.rig.mode === 'free';
      if (k === ' ') { this.paused = !this.paused; e.preventDefault(); }
      else if (e.key === 'F1') { e.preventDefault(); this.stage.setMode('follow'); }
      else if (e.key === 'F2') { e.preventDefault(); this.stage.setMode('free'); }
      else if (e.key === 'F3') { e.preventDefault(); this.stage.setMode('flyby'); }
      else if (e.key === 'F4') { e.preventDefault(); this.stage.setMode('smooth'); }
      else if (k === 'backspace') { e.preventDefault(); document.body.classList.toggle('hud-off'); }
      else if (k === 'm') this.resetMap();
      else if (k === 'tab') { e.preventDefault(); this.toggleMap(); }
      else if (k === 'c' && !e.ctrlKey && !e.altKey) this.centerMap();
      else if (k === 'i' && !e.ctrlKey && !e.altKey) this.stopTime();
      else if (k === '=' || k === '+') this.stepTime(1);
      else if (k === '-' || k === '_') this.stepTime(-1);
      else if (k === 'delete' && u && u.team === 1) { if (u.waypoints.length) u.waypoints.pop(); this.ctlKey = ''; }
      else if (e.shiftKey && k === 'f') { e.preventDefault(); this.toggleDeck(); }
      else if (k === 'l' && !e.ctrlKey && u?.deck) { if (this.world.requestLaunch(u)) this.toast('Preparing to launch'); this.ctlKey = ''; }
      else if (k === 't' && !e.ctrlKey && u?.kind === 'air' && u.team === 1) { this.world.returnToBase(u); this.toast(u.rtb ? 'Return to base' : 'No home base'); this.ctlKey = ''; }
      else if (k === 't' && !e.ctrlKey) { const n = this.cycle(2, 1); if (n) { this.targetId = n.id; this.ctlKey = ''; } }
      else if ((k === 'arrowleft' || k === 'arrowright') && e.shiftKey) { e.preventDefault(); const n = this.cycle(1, k === 'arrowleft' ? -1 : 1); if (n) this.select(n.id, true); }
      else if (e.shiftKey && k === 'w' && !free && u && u.team === 1) { e.preventDefault(); this.world.cycleRoe(u); this.ctlKey = ''; this.toast(ROE_LABEL[u.roe]); }
      else if (e.shiftKey && k === 'e' && u && u.team === 1) { this.world.toggleEmcon(u); this.ctlKey = ''; this.toast(u.emcon ? 'EMCON — search radars off' : 'EMCON cleared'); }
      else if (e.shiftKey && k === 'a' && u && u.team === 1) { this.ctlKey = ''; this.toast(this.world.toggleAirSearch(u) ? (u.airSearchOn ? 'Air radar on' : 'Air radar off') : 'No air-search radar'); }
      else if (e.shiftKey && k === 's' && u && u.team === 1) { this.ctlKey = ''; this.toast(this.world.toggleSurfaceSearch(u) ? (u.surfSearchOn ? 'Surface radar on' : 'Surface radar off') : 'No surface-search radar'); }
      else if (k === 'x' && !e.ctrlKey && !e.altKey && u && u.team === 1) { e.preventDefault(); this.ceaseFire(); }
      else if (/^[0-9]$/.test(k) && !e.altKey) { e.preventDefault(); this.slot(k === '0' ? 9 : +k - 1, e.ctrlKey); }
      else if (!free && u && u.team === 1 && u.alive) {
        if (k === 'w' && !e.shiftKey) this.world.orderTelegraph(u, u.telegraph + 1);
        else if (k === 's') this.world.orderTelegraph(u, u.telegraph - 1);
        else if (k === 'a') this.nudgeRudder(u, -1);
        else if (k === 'd') this.nudgeRudder(u, 1);
        else if (k === 'r' && u.kind === 'sub') this.world.cycleDepth(u, e.shiftKey ? -1 : 1);
        else if (k === 'p' && u.kind === 'sub') this.toast(this.world.togglePeriscope(u) ? u.orderText : (u.orderText || 'No periscope'));
        else if (k === 'g' && u.kind === 'sub') this.toast(this.world.toggleEsm(u) ? u.orderText : (u.orderText || 'No ESM mast'));
        else if (k === 'r' && u.kind === 'air') this.world.orderAltitude(u, Math.min((u.spec.ceilingFt || 20000) * FT, (u.ordAlt ?? u.z) + 2000 * FT));
        else if (k === 'f' && u.kind === 'air') this.world.orderAltitude(u, Math.max(30, (u.ordAlt ?? u.z) - 2000 * FT));
        else if (k === 'f') this.autoFire();
        this.ctlKey = '';
      }
    });
    addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'a' || k === 'd') this._rudderAt = 0;
    });
  }

  ceaseFire() {
    const u = this.sel;
    if (!u || u.team !== 1) return;
    this.world.noteCease(u, performance.now());
    this.targetId = null;
    this.selectedAmmo = null;
    this.ctlKey = '';
  }

  autoFire() {
    const u = this.sel, t = this.world.get(this.targetId);
    if (!u || !t) return this.toast('No target selected (T cycles contacts)');
    const opts = this.world.firableAmmo(u, t).sort((a, b) => b.spec.maxRangeNm - a.spec.maxRangeNm);
    if (!opts.length) return this.toast('Nothing in range to engage ' + t.name);
    this.fireAt(opts[0].id, opts[0].spec.type === 'Missile' ? 1 : 3);
  }

  handleClick(unitId, water, btn, shift) {
    const hit = unitId != null ? this.world.get(unitId) : null;
    if (btn === 2) {
      if (hit && hit.team !== 1 && hit.kind !== 'shell') {
        this.targetId = hit.id; this.ctlKey = '';
        if (this.selectedAmmo && this.sel?.team === 1) this.fireAt(this.selectedAmmo, 1);
      }
      else if (water) this.orderTo(water, shift);
      return;
    }
    if (hit && hit.kind !== 'missile' && hit.kind !== 'torpedo' && hit.kind !== 'buoy') {
      if (hit.team === 1) this.select(hit.id, true); else this.watch(hit);
    }
  }

  stepTime(dir) {
    let i = TIME_SCALES.indexOf(this.scale);
    if (i < 0) i = Math.max(0, TIME_SCALES.findIndex((s) => s >= this.scale));
    this.scale = TIME_SCALES[Math.min(TIME_SCALES.length - 1, Math.max(0, i + dir))];
    this.paused = false;
  }

  stopTime() { this.scale = 1; this.paused = false; }

  toggleMap() {
    const el = $('#minimap');
    el.classList.remove('off');
    el.classList.toggle('big');
    if (el.classList.contains('big')) this.clearMapFrame();
    else this.applyMapFrame();
    this.syncMapChrome();
  }

  hideMap() {
    $('#minimap').classList.add('off');
    this.syncMapChrome();
  }

  toggleMapVisible() {
    $('#minimap').classList.toggle('off');
    this.syncMapChrome();
  }

  syncMapChrome() {
    const el = $('#minimap');
    const big = el.classList.contains('big');
    const max = $('#map-max');
    max.textContent = big ? '–' : '▢';
    max.title = big ? 'Restore' : 'Fullscreen (Tab)';
    max.setAttribute('aria-label', big ? 'Minimize map' : 'Maximize map');
    $('#map-toggle').classList.toggle('on', !el.classList.contains('off'));
    document.querySelector('[data-act=map]').classList.toggle('on', !el.classList.contains('off'));
  }

  resetMap() {
    const el = $('#minimap');
    el.classList.remove('big', 'off');
    this.mapFrame = null;
    this.clearMapFrame();
    this.centerMap();
    this.syncMapChrome();
    requestAnimationFrame(() => this.map.setRangeNm(30));
  }

  // Tutorial window 5: drag the title bar to move the display, drag its edges to resize.
  bindMapFrame() {
    const el = $('#minimap');
    const minW = 220, minH = 180;
    const begin = (e, onMove) => {
      if (el.classList.contains('big')) return;
      el.classList.add('dragging');
      const move = (ev) => onMove(ev);
      const up = () => {
        el.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    };
    $('#map-title').addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect();
      const origin = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height };
      begin(e, (ev) => {
        const l = Math.max(0, Math.min(window.innerWidth - 80, origin.l + ev.clientX - origin.x));
        const t = Math.max(40, Math.min(window.innerHeight - 36, origin.t + ev.clientY - origin.y));
        this.mapFrame = { l, t, w: origin.w, h: origin.h };
        this.applyMapFrame();
      });
    });
    el.querySelectorAll('.map-edge').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const edge = handle.dataset.edge;
        const r = el.getBoundingClientRect();
        const origin = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height };
        begin(e, (ev) => {
          const dx = ev.clientX - origin.x, dy = ev.clientY - origin.y;
          let l = origin.l, t = origin.t, w = origin.w, h = origin.h;
          if (edge.includes('e')) w = origin.w + dx;
          if (edge.includes('s')) h = origin.h + dy;
          if (edge.includes('w')) w = origin.w - dx;
          if (edge.includes('n')) h = origin.h - dy;
          w = Math.max(minW, Math.min(window.innerWidth - 8, w));
          h = Math.max(minH, Math.min(window.innerHeight - 8, h));
          if (edge.includes('w')) l = origin.l + origin.w - w;
          if (edge.includes('n')) t = origin.t + origin.h - h;
          l = Math.max(0, Math.min(l, window.innerWidth - 80));
          t = Math.max(40, Math.min(t, window.innerHeight - 36));
          this.mapFrame = { l, t, w, h };
          this.applyMapFrame();
        });
      });
    });
  }

  applyMapFrame() {
    const f = this.mapFrame; if (!f) return;
    const el = $('#minimap');
    el.style.left = f.l + 'px';
    el.style.top = f.t + 'px';
    el.style.width = f.w + 'px';
    el.style.height = f.h + 'px';
    el.style.bottom = 'auto';
    el.style.right = 'auto';
  }

  clearMapFrame() {
    const el = $('#minimap');
    el.style.left = el.style.top = el.style.width = el.style.height = el.style.bottom = el.style.right = '';
  }

  centerMap() {
    const u = this.sel; if (!u) return;
    this.map.cx = u.x; this.map.cy = u.y;
  }

  slot(i, store) {
    if (store) {
      const u = this.sel;
      if (u && u.team === 1 && u.kind !== 'missile') { this.slots[i] = u.id; this.toast(`Slot ${i + 1}: ${u.name}`); }
      return;
    }
    const u = this.world.get(this.slots[i]);
    if (u && u.active) this.select(u.id, true);
  }

  // ------------------------------------------------------------------ loop --
  tick(dt) {
    this.stage.rig.acceptKeys = !$('#menu') || $('#menu').classList.contains('hidden');
    if (!this.world) { this.stage.render(dt); return; }
    const w = this.world;
    w.timeScale = this.scale;
    if (!this.paused && !w.over) {
      let sim = dt * this.scale; const h = this.scale > 8 ? 0.5 : 0.2;
      let n = 0; while (sim > 1e-6 && n++ < 200) { const s = Math.min(h, sim); w.step(s); sim -= s; }
      if (w.timeScale < this.scale) this.scale = w.timeScale;
    }
    this.stage.sync(w, this.visible, this.paused ? 0 : dt * Math.min(this.scale, 4));
    this.stage.render(dt);
    this.hudT -= dt;
    if (this.hudT <= 0) { this.hudT = 0.12; this.updateHud(); }
    const picked = this.sel?.spec.ammoSpecs?.[this.selectedAmmo] || null;
    this.map.draw(w, this.sel, this.targetId, this.visible, picked);
  }

  updateHud() {
    const w = this.world;
    $('#clock').textContent = fmtT(w.t) + (this.paused ? ' · PAUSED' : this.scale !== 1 ? ` · ${fmtScale(this.scale)}` : '');
    const timeBtn = document.querySelector('[data-act=time-stop]');
    timeBtn.textContent = fmtScale(this.scale);
    timeBtn.classList.toggle('on', this.scale === 1 && !this.paused);
    document.querySelector('[data-act=pause]').classList.toggle('on', this.paused);
    document.querySelector('[data-act=reveal]').classList.toggle('on', w.revealAll);
    // unit list
    const mine = [...w.units.values()].filter((u) => u.team === 1 && (u.kind === 'ship' || u.kind === 'sub' || u.kind === 'air') && u.active);
    const formSig = `${w._form.pattern}:${w._form.spacingKey}|` + mine.map((u) => u.id + (u.formation ? ':' + u.formation.index : ':x') + (u.id === this.selId ? '!' : '')).join('|');
    if (formSig !== this.formSig) {
      this.formSig = formSig;
      const row = (u) => `<div class="item ${u.id === this.selId ? 'sel' : ''}" draggable="true" data-id="${u.id}"><span class="dot t1"></span><span class="nm">${esc(u.hull ? u.hull + ' ' : '')}${esc(u.name)}</span><span class="hp"><i style="width:${Math.max(0, u.hp / u.maxHp * 100)}%;background:${u.alive ? '' : '#555'}"></i></span></div>`;
      const formed = mine.filter((u) => u.formation);
      const free = mine.filter((u) => !u.formation);
      const pat = FORM_PATTERNS.find(([id]) => id === w._form.pattern)?.[1] || 'Loose';
      const sp = FORM_SPACING.find(([id]) => id === w._form.spacingKey);
      const spLabel = sp ? `${sp[2]} ${sp[1]} nm` : '1 nm';
      $('#unit-list').innerHTML = `<div class="form-head" data-form="1">Formation 1 <button type="button" class="form-cyc" data-form-pattern>${pat}</button><button type="button" class="form-cyc" data-form-spacing>${spLabel}</button></div>${formed.map(row).join('') || '<div class="d">—</div>'}<div class="form-head" data-form="0">Independent</div>${free.map(row).join('') || '<div class="d">—</div>'}`;
    }
    // contacts
    const cs = [];
    for (const [id, c] of w.contacts[1]) { const u = w.get(id); if (!u) continue; if (!c.live && !w.revealAll) continue; cs.push({ u, c }); }
    if (w.revealAll) for (const u of w.units.values()) if (u.team !== 1 && u.alive && u.active && (u.kind === 'ship' || u.kind === 'air' || u.kind === 'sub') && !cs.find((x) => x.u.id === u.id)) cs.push({ u, c: { level: 2 } });
    const me = this.sel;
    const at = (row) => (Number.isFinite(row.c.x) ? row.c : row.u);
    cs.sort((a, b) => (me ? dist2(me, at(a)) - dist2(me, at(b)) : 0));
    $('#contact-list').innerHTML = cs.slice(0, 40).map(({ u, c }) => {
      const ident = c.level >= 2 || w.revealAll;
      const cls = u.team === 2 ? 't2' : u.team === 0 ? 't0' : 'tu';
      const marks = trackMarks(c.sources);
      const nm = ident ? esc(u.name) : `Track ${c.track || '?'} ${marks}`.trim();
      const there = Number.isFinite(c.x) ? c : u;
      return `<div class="item ${u.id === this.targetId ? 'tgt' : ''}" data-id="${u.id}"><span class="dot ${ident ? cls : (c.hostile ? 't2' : 'tu')}"></span><span class="nm">${nm}${ident && marks ? ' ' + marks : ''}</span><span class="d">${me ? (dist2(me, there) / NM).toFixed(1) + ' nm' : ''}</span></div>`;
    }).join('') || '<div class="item"><span class="nm d">no contacts</span></div>';
    this.updateControl();
    this.renderDeck();
  }

  updateControl() {
    const u = this.sel, w = this.world, el = $('#control');
    if (!u) { el.innerHTML = '<div class="sub">No unit selected</div>'; return; }
    const t = w.get(this.targetId);
    const tgtOk = t && t.alive;
    const chaffKey = (u.chaff || []).map((c) => c.left + ':' + Math.ceil(c.cool)).join(',');
    const noiseKey = (u.noise || []).map((n) => Math.ceil(n.cool)).join(',');
    const decoyKey = (u.decoy || []).map((d) => (d.on ? '1' : '0') + (d.wanted ? '1' : '0')).join(',');
    const ciwsReload = Math.max(0, ...(u.ciws || []).map((g) => g.reload || 0));
    const ciwsReady = (u.ciws || []).reduce((s, g) => s + (g.readyCap > 0 ? Math.max(0, g.ready) : (u.ammo[g.ammoId] || 0)), 0);
    const ct = tgtOk ? w.contacts[u.team]?.get(t.id) : null;
    const key = [u.id, u.alive, u.telegraph, Math.round(u.course), Math.round(u.speed / KT), Math.round(u.heading), Math.round(u.rudderSet || 0), u.helm ? 1 : 0, Object.values(u.ammo).join('.'), this.targetId, tgtOk && Math.round(dist2(u, t) / NM * 10), ct?.level, u.vidId || 0, Math.round(u.hp), Math.round(u.cooldown), Math.round((u.ordAlt ?? 0) / 10), Math.round(-(u.z || 0) / FT), u.depthPreset ?? '', Math.round(u.fuelNm || 0), u.airSearchOn, u.surfSearchOn, u.activeSonarOn ? 1 : 0, u.periscopeUp ? 1 : 0, u.esmUp ? 1 : 0, u.snorkelUp ? 1 : 0, u.emcon, u.roe, u.rtb, u.avoidCav ? 1 : 0, Math.round(u.demandedKt || 0), u.orderText || '', this.selectedAmmo, chaffKey, noiseKey, decoyKey, Math.ceil(ciwsReload), ciwsReady].join('|');
    if (key === this.ctlKey) return; this.ctlKey = key;
    const kt = u.speed / KT;
    const kindLabel = u.kind === 'air' ? 'Aircraft' : u.kind === 'land' ? 'Land unit' : (u.spec.role?.join('/') || u.kind);
    let html = `<h2>${esc(u.hull ? u.hull + ' ' : '')}${esc(u.name)}</h2><div class="sub">${esc(kindLabel)} · ${u.alive ? `integrity ${Math.round(u.hp / u.maxHp * 100)}%` : '<span class="bad">DESTROYED</span>'}</div>`;
    if (u.team !== 1) { el.innerHTML = html + '<div class="sub">Hostile / unknown contact — right-click to designate as target.</div>'; return; }
    const fuel = u.kind === 'air' && u.fuelNm > 0 ? `<b>Range</b><span>${u.fuelNm.toFixed(0)} nm</span>` : '';
    const status = u.orderText ? `<div class="sub">${esc(u.orderText)}</div>` : '';
    const order = SHIP_ORDERS.find((o) => o.n === u.telegraph);
    const bellKt = u.avoidCav && Number.isFinite(u.demandedKt) ? u.demandedKt : w.speedForTelegraph(u);
    const avoid = u.avoidCav ? ', avoiding cavitation' : '';
    const ordered = u.kind === 'air' ? `${w.speedForTelegraph(u).toFixed(0)} kt` : `${order ? order.name + ' · ' : ''}${bellKt.toFixed(0)} kt${avoid}`;
    const rudder = Math.round(u.rudderSet || 0);
    const rudderText = rudder === 0 ? 'amidships' : `${Math.abs(rudder)}° ${rudder < 0 ? 'port' : 'stbd'}`;
    const headText = u.kind === 'air'
      ? `${u.heading.toFixed(0)}° <span class="d">→ ${u.course.toFixed(0)}°</span>`
      : `${u.heading.toFixed(0)}° <span class="d">${u.helm ? 'helm' : 'course ' + u.course.toFixed(0) + '° ·'} ${rudderText}</span>`;
    const keel = u.kind === 'sub' ? `<b>Keel</b><span>${Math.max(0, -(u.z || 0) / FT).toFixed(0)} ft</span>` : '';
    html += `<div class="grid2"><b>Speed</b><span>${kt.toFixed(1)} kt <span class="d">(ordered ${ordered})</span></span><b>Heading</b><span>${headText}</span>${keel}${u.kind === 'air' ? `<b>Altitude</b><span>${(u.z / FT).toFixed(0)} ft <button data-alt="-2000">▼</button><button data-alt="2000">▲</button><button data-altset="10000">10,000</button></span>${fuel}` : ''}</div>${status}`;
    if (u.alive) {
      const tele = u.kind === 'air'
        ? [0, 1, 2, 3, 4, 5].map((n) => n - 1).map((n, i) => `<button data-tele="${n}" class="${n === u.telegraph ? 'cur' : ''}">${['0', 'LOW', 'MED', 'CRZ', 'HI', 'MAX'][i]}</button>`).join('')
        : '<span class="spd">Spd:</span>' + SHIP_ORDERS.map((o) => `<button data-tele="${o.n}" title="${o.name}" class="${o.n === u.telegraph ? 'cur' : ''}">${o.short}</button>`).join('');
      html += '<div class="tele">' + tele + '</div>';
      if (u.kind === 'sub') {
        html += '<div class="tele">' + SUB_DEPTHS.map(([n, name]) => `<button data-depth="${n}" class="${u.depthPreset === n ? 'cur' : ''}">${name}</button>`).join('') + '</div>';
        const scope = (u.spec.sensors || []).some((s) => s.kind === 'Periscope');
        const esm = (u.spec.sensors || []).some((s) => s.kind === 'ESM');
        const snork = (u.spec.snorkelKt || 0) > 0;
        html += '<div class="tele">'
          + (scope ? `<button data-scope="1" class="${u.periscopeUp ? 'cur' : ''}">Scope</button>` : '')
          + (esm ? `<button data-esm="1" class="${u.esmUp ? 'cur' : ''}">ESM</button>` : '')
          + (snork ? `<button data-snorkel="1" class="${u.snorkelUp ? 'cur' : ''}">Snorkel</button>` : '')
          + '</div>';
      }
      html += u.kind === 'air'
        ? `<div class="tele"><button data-course="-20">⟲ 20</button><button data-course="-5">◀ 5</button><button data-stop="1">Hold</button><button data-course="5">5 ▶</button><button data-course="20">20 ⟳</button><button data-cam="1">Cam</button></div>`
        : `<div class="tele"><button data-rudder="-1" title="Rudder left 5° (A)">Port</button><button data-rudder="0" title="Rudder amidships">Amidships</button><button data-rudder="1" title="Rudder right 5° (D)">Stbd</button><button data-stop="1" title="Officers hold the current heading">Hold</button><button data-cam="1">Cam</button></div>`;
      const hasAir = w.hasSearchRadar(u, 'air'), hasSurf = w.hasSearchRadar(u, 'surf'), hasPing = w.hasActiveSonar(u);
      html += `<div class="tele"><button data-air="1" class="${u.airSearchOn ? 'cur' : ''}" ${hasAir ? '' : 'disabled'}>Air</button><button data-surf="1" class="${u.surfSearchOn ? 'cur' : ''}" ${hasSurf ? '' : 'disabled'}>Surf</button><button data-active="1" class="${u.activeSonarOn ? 'cur' : ''}" ${hasPing ? '' : 'disabled'}>Active</button><button data-emcon="1" class="${u.emcon ? 'cur' : ''}">EMCON</button></div>`;
      html += `<div class="tele"><button data-roe="tight" class="${u.roe === 'tight' ? 'cur' : ''}" title="Self-defence only">Tight</button><button data-roe="hold" class="${u.roe === 'hold' ? 'cur' : ''}" title="No ordered fire">Hold</button><button data-roe="free" class="${u.roe === 'free' ? 'cur' : ''}" title="Engage any hostile">Free</button></div>`;
    }
    if (u.alive && (u.chaff?.length || u.ciws?.length || u.noise?.length || u.decoy?.length)) {
      html += '<h3>Missile defense</h3>';
      if (u.chaff?.length) {
        const left = u.chaff.reduce((s, c) => s + Math.max(0, c.left), 0);
        const cool = Math.max(0, ...u.chaff.map((c) => c.cool));
        html += `<div class="weap"><span class="nm">Chaff <span class="d">auto</span></span><span class="rng">${cool > 0 ? Math.ceil(cool) + ' s' : 'ready'}</span><span class="cnt">${left}</span></div>`;
      }
      if (u.ciws?.length) {
        const ciwsLabel = u.roe === 'hold' ? 'hold' : ciwsReload > 0 ? `${Math.ceil(ciwsReload)} s` : 'ready';
        html += `<div class="weap"><span class="nm">CIWS <span class="d">auto</span></span><span class="rng">${ciwsLabel}</span><span class="cnt">${ciwsReady}</span></div>`;
      }
      for (const n of u.noise || []) {
        const cnt = u.ammo[n.ammoId] || 0;
        const ready = n.cool <= 0 && cnt > 0;
        html += `<div class="weap"><span class="nm">Noisemaker <span class="d">manual</span></span><span class="cnt">${cnt}</span><button data-noise="1" ${ready ? '' : 'disabled'}>${n.cool > 0 ? Math.ceil(n.cool) + ' s' : 'Deploy'}</button></div>`;
      }
      for (const d of u.decoy || []) {
        const state = d.on ? 'streamed' : d.wanted ? `${d.minKt}–${d.maxKt} kt` : 'stowed';
        html += `<div class="weap"><span class="nm">Nixie <span class="d">towed</span></span><span class="rng">${state}</span><button data-decoy="1">${d.wanted ? 'Stow' : 'Stream'}</button></div>`;
      }
    }
    const defensiveAmmo = new Set([...(u.ciws || []).map((g) => g.ammoId), ...(u.noise || []).map((n) => n.ammoId)]);
    if (u.alive && Object.keys(u.ammo).some((id) => !defensiveAmmo.has(id))) {
      const ct = tgtOk ? w.contacts[1].get(t.id) : null;
      const named = tgtOk && (w.revealAll || !ct || ct.level >= 2);
      const tgtLabel = named ? t.name : `Track ${ct?.track || '?'}`;
      const canVid = tgtOk && ct && ct.level < 2 && (u.kind === 'ship' || u.kind === 'air') && !u.rtb;
      html += `<h3>Weapons · target: ${tgtOk ? `<span class="${t.team === 2 ? 'bad' : ''}">${esc(tgtLabel)} ${(dist2(u, t) / NM).toFixed(1)} nm</span>` : '<span class="d">none (hover the map · right-click fires)</span>'} <button data-vid="1" title="Close to visual range" ${canVid ? '' : 'disabled'}>VID</button></h3>`;
      html += `<button data-cease="1" title="Cease fire (X)">Cease fire</button>`;
      const buoyN = Object.entries(u.ammo).filter(([id, n]) => n > 0 && u.spec.ammoSpecs[id]?.type === 'Sonobuoy').reduce((s, [, n]) => s + n, 0);
      if (u.kind === 'air' && buoyN) html += `<div class="weap"><span class="nm">Sonobuoys</span><span class="cnt">${buoyN}</span><button data-buoy="1" ${u.rtb ? 'disabled' : ''}>Drop</button></div>`;
      for (const [id, n] of Object.entries(u.ammo)) {
        if (defensiveAmmo.has(id)) continue;
        const a = u.spec.ammoSpecs[id]; if (!a || a.type === 'Sonobuoy') continue;
        const can = u.roe !== 'hold' && tgtOk && n > 0 && w.firableAmmo(u, t).some((o) => o.id === id);
        const isMsl = a.type === 'Missile';
        html += `<div class="weap"><button data-pick="${id}" title="${esc(a.name)}" class="nm ${this.selectedAmmo === id ? 'on' : ''}">${esc(a.short || a.name)} <span class="d">${a.target}</span></button><span class="rng">${a.minRangeNm ? a.minRangeNm.toFixed(0) + '–' : ''}${a.maxRangeNm.toFixed(0)} nm</span><span class="cnt">${n}</span><button data-fire="${id}" data-n="1" ${can ? '' : 'disabled'}>Fire</button>${isMsl ? `<button data-fire="${id}" data-n="2" ${can && n > 1 ? '' : 'disabled'}>×2</button>` : `<button data-fire="${id}" data-n="5" ${can ? '' : 'disabled'}>×5</button>`}</div>`;
      }
    }
    el.innerHTML = html;
  }

  deckShip() {
    const u = this.sel;
    if (!u) return null;
    if (u.deck) return u;
    if (u.homeId) return this.world.get(u.homeId);
    return [...this.world.units.values()].find((s) => s.deck && s.team === 1) || null;
  }

  toggleDeck() {
    this.deckOpen = !this.deckOpen;
    document.querySelector('[data-act=deck]').classList.toggle('on', this.deckOpen);
    this.renderDeck();
  }

  renderDeck() {
    const el = $('#deck');
    if (!this.deckOpen || !this.world) { el.classList.add('hidden'); return; }
    const ship = this.deckShip();
    el.classList.remove('hidden');
    if (!ship?.deck) { $('#deck-body').innerHTML = '<div class="sub">This unit has no flight deck.</div>'; return; }
    const clock = (s) => { const m = Math.max(0, Math.floor(s / 60)); const sec = Math.max(0, Math.floor(s - m * 60)); return `${m}:${String(sec).padStart(2, '0')}`; };
    const phase = { ready: 'Preparing', launch: 'Launching', rearm: 'Rearming' };
    const busy = ship.deck.jobs.some((j) => j.phase === 'ready' || j.phase === 'launch');
    const sig = ship.id + '|' + ship.deck.bins.map((b) => `${b.count}:${b.pick ?? 0}`).join(',') + '|' + busy;
    if (sig !== this.deckSig) {
      this.deckSig = sig;
      const bins = ship.deck.bins.map((b, i) => {
        const stores = Object.entries(b.spec.ammo || {});
        const torps = stores.filter(([id]) => /torpedo/i.test(b.spec.ammoSpecs?.[id]?.type || '')).reduce((n, [, c]) => n + c, 0);
        const buoys = stores.filter(([id]) => /sonobuoy/i.test(b.spec.ammoSpecs?.[id]?.type || '')).reduce((n, [, c]) => n + c, 0);
        const storeText = [
          torps ? `${torps} torpedoes` : '',
          buoys ? `${buoys} sonobuoys` : '',
          !torps && !buoys ? 'no weapons' : '',
          `${b.spec.maxRangeNm.toFixed(0)} nm`,
        ].filter(Boolean).join(' · ');
        const opts = (b.options || []).map((o, n) => `<button data-bin="${i}" data-opt="${n}" class="${n === (b.pick ?? 0) ? 'on' : ''}">${esc(LOADOUT_LABEL[o.name] || o.name)}</button>`).join('');
        return `<div class="row"><span>${esc(b.spec.name)}</span><span>×${b.count} <button data-launch="${i}" ${b.count && !busy ? '' : 'disabled'}>Launch</button></span></div><div class="tele">${opts}</div><div class="d">${esc(storeText)}</div>`;
      }).join('');
      $('#deck-body').innerHTML = `<div class="sub">${esc(ship.name)}</div>${bins}<div id="deck-jobs"></div>`;
    }
    const jobs = ship.deck.jobs.map((j) => `<div class="job">${phase[j.phase] || j.phase} ${esc(j.spec.name)} ${clock(j.left)}</div>`).join('');
    const jobsEl = $('#deck-jobs');
    if (jobsEl) jobsEl.innerHTML = jobs || '<div class="d">Hangar idle</div>';
  }
}

new App();
