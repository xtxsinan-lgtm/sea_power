// TacticalMap — 2D plot of the sim (north-up). Shows own units, fog-of-war contacts, missiles,
// waypoints and the selected unit's sensor/weapon rings. Mouse: drag=pan, wheel=zoom,
// click=select, right-click=order (water) / target (hostile).
import { NM, D2R, bearing, hdgVec, radioHorizon } from '../core/Units.js';
import { trackMarks, sonarUncertain } from '../core/SimWorld.js';

// A MAD-only track keeps its uncertainty after the bird goes quiet. Other sensors replace the fix.
function madPlot(ct) {
  const s = ct?.sources;
  return !!(ct?.madErr && ct.level < 2 && s?.m && !s.r && !s.e && !s.v && !s.s);
}

// Affiliation colors from original ui/minimap.ini (RGBA) and ui/Default/Settings_UI_Tactical.ini (ARGB).
const COL = { 1: '#0000ff', 2: '#ff0000', 0: '#009900', u: '#ff9900' };
const MAP_RANGE_NM = 30; // minimap.ini DefaultRange

export class TacticalMap {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.cx = 0; this.cy = 0; this.scale = 1 / 60; // px per metre... (set in fit)
    this.world = null; this.sel = null; this.targetId = null; this.hit = [];
    this._bind();
  }

  fit(world) {
    const pts = [...world.all()].filter((u) => u.team === 1);
    if (!pts.length) return;
    let x = 0, y = 0; for (const p of pts) { x += p.x; y += p.y; }
    this.cx = x / pts.length; this.cy = y / pts.length; this.setRangeNm(MAP_RANGE_NM);
  }

  setRangeNm(nm) { this.scale = (this.cv.clientWidth || 400) / (nm * NM); }

  w2s(x, y) { return [this.cv.width / 2 + (x - this.cx) * this.scale * this.dpr, this.cv.height / 2 - (y - this.cy) * this.scale * this.dpr]; }
  s2w(px, py) { return { x: this.cx + ((px * this.dpr) - this.cv.width / 2) / (this.scale * this.dpr), y: this.cy - ((py * this.dpr) - this.cv.height / 2) / (this.scale * this.dpr) }; }

  _bind() {
    const el = this.cv; let d = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => { d = { x: e.clientX, y: e.clientY, m: 0 }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (d) { const dx = e.clientX - d.x, dy = e.clientY - d.y; d.x = e.clientX; d.y = e.clientY; d.m += Math.abs(dx) + Math.abs(dy); this.cx -= dx / this.scale; this.cy += dy / this.scale; return; }
      const id = this._pick(px, py);
      if (id !== this.hoverId) { this.hoverId = id; this.onHover?.(id); }
    });
    el.addEventListener('pointerup', (e) => {
      if (d && d.m < 5) { const r = el.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; this.onClick?.(this._pick(px, py), this.s2w(px, py), e); }
      d = null;
    });
    el.addEventListener('wheel', (e) => { e.preventDefault(); const r = el.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const before = this.s2w(px, py); this.scale = Math.min(0.2, Math.max(1 / (4000 * NM / 30), this.scale * Math.exp(-e.deltaY * 0.0014))); const after = this.s2w(px, py); this.cx += before.x - after.x; this.cy += before.y - after.y; }, { passive: false });
  }

  _pick(px, py) {
    let best = null, bd = 14;
    for (const h of this.hit) { const d = Math.hypot(h.sx / this.dpr - px, h.sy / this.dpr - py); if (d < bd) { bd = d; best = h.id; } }
    return best;
  }

  draw(world, sel, targetId, visible, weapon) {
    const cv = this.cv; this.dpr = window.devicePixelRatio || 1;
    const W = Math.round(cv.clientWidth * this.dpr), H = Math.round(cv.clientHeight * this.dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const c = this.ctx; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
    c.fillStyle = '#0c3344'; c.fillRect(0, 0, W, H);
    const k = this.scale * this.dpr;
    // grid every N nm chosen by zoom
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
    const gridNm = steps.find((s) => s * NM * k > 70) || 500, g = gridNm * NM;
    c.lineWidth = 1; c.strokeStyle = 'rgba(120,160,190,0.14)'; c.fillStyle = 'rgba(150,185,210,0.45)'; c.font = `${10 * this.dpr}px "Cascadia Mono",Consolas,monospace`;
    const tl = this.s2w(0, 0), br = this.s2w(cv.clientWidth, cv.clientHeight);
    c.beginPath();
    for (let x = Math.floor(tl.x / g) * g; x < br.x; x += g) { const [sx] = this.w2s(x, 0); c.moveTo(sx, 0); c.lineTo(sx, H); }
    for (let y = Math.floor(br.y / g) * g; y < tl.y; y += g) { const [, sy] = this.w2s(0, y); c.moveTo(0, sy); c.lineTo(W, sy); }
    c.stroke();
    c.fillText(`grid ${gridNm} nm`, 8 * this.dpr, H - 8 * this.dpr);

    this.hit = [];
    // selected unit: rings
    if (sel?.alive) {
      const [sx, sy] = this.w2s(sel.x, sel.y);
      const rings = [];
      for (const s of sel.spec.sensors || []) if (s.kind === 'Radar' && s.maxRangeKm) rings.push([s.maxRangeKm * 1000, 'rgba(95,180,255,0.18)']);
      // Rings for the weapon selected on the bottom bar: yellow min, red max.
      if (weapon && sel.ammo?.[weapon.id] > 0) {
        if (weapon.minRangeNm > 0) rings.push([weapon.minRangeNm * NM, 'rgba(255,200,0,0.85)']);
        if (weapon.maxRangeNm > 0) rings.push([weapon.maxRangeNm * NM, 'rgba(255,0,0,0.75)']);
        const horizons = (sel.spec.sensors || []).filter((s) => s.illuminator && s.heightM > 0).map((s) => radioHorizon(s.heightM, 0));
        if (horizons.length) {
          rings.push([Math.max(...horizons), 'rgba(80,160,255,0.95)']);
          rings.push([Math.min(...horizons), 'rgba(80,210,120,0.95)']);
        }
      }
      if (sel.kind === 'air' && sel.fuelNm > 0) rings.push([sel.fuelNm * NM, 'rgba(80,160,255,0.9)']);
      const seen = new Set();
      for (const [r, col] of rings) { const key = Math.round(r / 500) + col; if (seen.has(key)) continue; seen.add(key); c.strokeStyle = col; c.beginPath(); c.arc(sx, sy, r * k, 0, 7); c.stroke(); }
      // waypoints
      if (sel.waypoints.length) {
        // WaypointsLineColor ARGB 100,0,0,220. The active waypoint is WaypointSelectedColor red.
        c.strokeStyle = 'rgba(0,0,220,0.39)'; c.setLineDash([6, 5]); c.beginPath(); c.moveTo(sx, sy);
        for (let i = sel.wpIdx; i < sel.waypoints.length; i++) { const [wx, wy] = this.w2s(sel.waypoints[i].x, sel.waypoints[i].y); c.lineTo(wx, wy); }
        c.stroke(); c.setLineDash([]);
        for (let i = sel.wpIdx; i < sel.waypoints.length; i++) {
          const [wx, wy] = this.w2s(sel.waypoints[i].x, sel.waypoints[i].y);
          c.strokeStyle = i === sel.wpIdx ? '#ff0000' : 'rgba(0,0,220,0.9)';
          c.strokeRect(wx - 3, wy - 3, 6, 6);
        }
      } else if (Math.abs(sel.course - sel.heading) > 2) { /* course line below */ }
    }
    // units
    const drawUnit = (u, ghost) => {
      const ct0 = u.team === world.playerTeam ? null : world.contacts[world.playerTeam]?.get(u.id);
      const madOnly = madPlot(ct0);
      const sonarOnly = sonarUncertain(ct0);
      const px = madOnly || sonarOnly ? ct0.x : u.x, py = madOnly || sonarOnly ? ct0.y : u.y;
      const [sx, sy] = this.w2s(px, py);
      if (sx < -30 || sy < -30 || sx > W + 30 || sy > H + 30) return;
      const ct = ct0;
      const err = sonarOnly ? ct.sonarErr : madOnly ? ct.madErr : null;
      if (err) {
        const origin = sonarOnly ? ct.sonarEar : world.units.get(ct.madOb);
        const brg = origin ? bearing(origin, { x: px, y: py }) : u.heading;
        const along = hdgVec(brg), cross = { x: along.y, y: -along.x };
        c.beginPath();
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          const ex = (along.x * Math.cos(a) * err.rngM + cross.x * Math.sin(a) * err.crossM) * k;
          const ey = -(along.y * Math.cos(a) * err.rngM + cross.y * Math.sin(a) * err.crossM) * k;
          if (i === 0) c.moveTo(sx + ex, sy + ey); else c.lineTo(sx + ex, sy + ey);
        }
        c.strokeStyle = 'rgba(255,153,0,0.55)'; c.stroke();
      }
      const known = u.team === world.playerTeam || world.revealAll || ct?.level >= 2;
      const col = !known ? (ct?.hostile ? COL[2] : COL.u) : u.team === 1 ? COL[1] : u.team === 2 ? COL[2] : COL[0];
      const s = (u.kind === 'missile' || u.kind === 'torpedo' ? 3 : u.kind === 'air' ? 5 : 6) * this.dpr;
      c.save(); c.translate(sx, sy); c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.6 * this.dpr; c.globalAlpha = ghost ? 0.5 : 1;
      if (u.kind === 'buoy') {
        const reach = u.falling ? 0 : ((u.activeKm || u.passiveKm || 0) * 1000) * k;
        c.strokeStyle = 'rgba(120,210,255,0.45)';
        if (reach > 0) { c.beginPath(); c.arc(0, 0, reach, 0, 7); c.stroke(); }
        c.beginPath(); c.arc(0, 0, 3.2 * this.dpr, 0, 7); c.stroke();
        c.restore();
        return;
      }
      if (u.kind === 'missile' || u.kind === 'torpedo') { c.rotate(u.heading * D2R); c.beginPath(); c.moveTo(0, -s * 1.6); c.lineTo(s, s); c.lineTo(-s, s); c.closePath(); c.fill(); }
      else {
        if (u.kind !== 'shell') {
          c.rotate(0);
          if (u.team === 2) { c.beginPath(); c.moveTo(0, -s * 1.3); c.lineTo(s * 1.3, 0); c.lineTo(0, s * 1.3); c.lineTo(-s * 1.3, 0); c.closePath(); c.stroke(); }
          else if (u.kind === 'air') { c.beginPath(); c.arc(0, 0, s, Math.PI, 0); c.stroke(); }
          else if (u.team === 0) { c.beginPath(); c.arc(0, 0, s, 0, 7); c.stroke(); }
          else c.strokeRect(-s, -s, s * 2, s * 2);
          if (u.kind !== 'sub' || true) { c.beginPath(); c.moveTo(0, 0); const hv = u.heading * D2R, spd = madOnly || sonarOnly ? 0 : u.speed, len = s * 2 + Math.min(40, spd * 2) * this.dpr * 0.4; c.lineTo(Math.sin(hv) * len, -Math.cos(hv) * len); c.stroke(); }
        }
      }
      c.restore();
      if (u.kind === 'ship' || u.kind === 'air' || u.kind === 'sub' || u.kind === 'land') {
        if (u.id === sel?.id) {
          // SelectionBracketsColor is opaque black, drawn as four corners so it still reads on the blue mark.
          const b = s * 2.4, g = s * 0.9;
          c.strokeStyle = '#000'; c.lineWidth = 1.6 * this.dpr;
          c.beginPath();
          c.moveTo(sx - b, sy - b + g); c.lineTo(sx - b, sy - b); c.lineTo(sx - b + g, sy - b);
          c.moveTo(sx + b - g, sy - b); c.lineTo(sx + b, sy - b); c.lineTo(sx + b, sy - b + g);
          c.moveTo(sx + b, sy + b - g); c.lineTo(sx + b, sy + b); c.lineTo(sx + b - g, sy + b);
          c.moveTo(sx - b + g, sy + b); c.lineTo(sx - b, sy + b); c.lineTo(sx - b, sy + b - g);
          c.stroke();
        }
        if (u.id === targetId) { c.strokeStyle = '#ffb02e'; c.lineWidth = 1.6 * this.dpr; c.setLineDash([3, 3]); c.beginPath(); c.arc(sx, sy, s * 2.8, 0, 7); c.stroke(); c.setLineDash([]); }
        if (this.dpr && (u.team === world.playerTeam || !ghost)) {
          const marks = trackMarks(ct?.sources);
          const label = known ? (u.hull || u.name.slice(0, 14)) : (ct?.track ? String(ct.track) : 'Unknown');
          c.fillStyle = known ? 'rgba(220,235,245,0.8)' : col;
          c.fillText(marks ? `${label} ${marks}` : label, sx + s * 1.8, sy - s * 1.4);
        }
      }
      this.hit.push({ id: u.id, sx, sy });
    };
    for (const u of world.units.values()) {
      if (!u.alive || !u.active || u.kind === 'shell') continue;
      if (visible(u)) drawUnit(u, false);
    }
    for (const cl of world.clouds || []) {
      const [cx, cy] = this.w2s(cl.x, cl.y);
      c.strokeStyle = cl.kind === 'noise' ? 'rgba(180,140,255,0.85)' : 'rgba(255,210,80,0.9)';
      c.beginPath(); c.arc(cx, cy, Math.max(4 * this.dpr, (cl.r || 200) * k), 0, 7); c.stroke();
    }
    // stale contacts (last known position)
    for (const [id, ct] of world.contacts[world.playerTeam]) {
      const u = world.units.get(id);
      if (!u || ct.live || world.revealAll) continue;
      drawUnit({ ...u, x: ct.x, y: ct.y, heading: ct.heading, speed: 0, id: u.id }, true);
    }
    // scale bar
    c.strokeStyle = '#9ec3dd'; c.lineWidth = 2; const nm = gridNm; c.beginPath(); c.moveTo(12 * this.dpr, 14 * this.dpr); c.lineTo(12 * this.dpr + nm * NM * k, 14 * this.dpr); c.stroke();
    c.fillStyle = '#9ec3dd'; c.fillText(`${nm} nm`, 16 * this.dpr + nm * NM * k, 18 * this.dpr);
  }
}
