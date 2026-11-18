// StageManager3D — single WebGLRenderer, scene graph, camera rig (orbit around a followed unit
// or free-fly over the water), and world→scene synchronisation of SimWorld units.
import * as THREE from 'three';
import { Ocean } from './Ocean.js';
import { Sky } from './Sky.js';
import { Effects, Trail, wakeTexture } from './Effects.js';
import { buildShipModel, buildAircraftModel, buildMissileModel, makeNavLights } from './Models.js';
import { loadModelTemplate } from './ModelLibrary.js';
import { D2R, KT, NM } from '../core/Units.js';
import { madOnlyContact, sonarUncertain, navLightsOn } from '../core/SimWorld.js';

// camera.ini distances that the game stores in Unity units. 27.559496 units = 1 nm.
const UNITY_M = NM / 27.559496;
const PIVOT_MIN = 0.1 * UNITY_M;
const PIVOT_MAX = 50 * UNITY_M;
// FlybyCam: ships sit 0.1 nm ahead, aircraft 0.2 nm; the camera jumps forward again past the reset.
const FLYBY = {
  fast: { start: 0.2 * NM, reset: 0.4 * NM, pitch: 1 * D2R, side: 2 * D2R },
  slow: { start: 0.1 * NM, reset: 0.2 * NM, pitch: 3 * D2R, side: 20 * D2R },
};

/** sim (x east, y north, z up) → three (x, y up, -z) */
const toThree = (u, out = new THREE.Vector3()) => out.set(u.x, u.z, -u.y);

export class StageManager3D {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.95;
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 600000);
    this.ocean = new Ocean(); this.scene.add(this.ocean.mesh);
    this.sky = new Sky(); this.scene.add(this.sky.mesh, this.sky.sun, this.sky.sun.target, this.sky.hemi, this.sky.amb);
    this.scene.fog = new THREE.FogExp2(0xa9bccd, 0.000012);
    this.fx = new Effects(this.scene);
    this.actors = new Map();
    this.modelTemplates = new Map();
    this.wakeTex = wakeTexture();
    // camera.ini + CameraBase/FreeCamera: pitch ±85°, turn 5° per Unity mouse-axis unit, smooth 0.1s,
    // free move 100 m/s (Shift ×100, Ctrl ×0.01), FOV 30–80, height 20 ft … 26880 ft.
    this.rig = {
      mode: 'follow', az: 215 * D2R, el: 14 * D2R, dist: 380,
      yaw: 0, pitch: 0, target: new THREE.Vector3(), freePos: new THREE.Vector3(), follow: null,
      rawX: 0, rawY: 0, smX: 0, smY: 0, panX: 0, panY: 0, keys: new Set(), acceptKeys: true,
      flyPos: new THREE.Vector3(), flyReset: 0.2 * NM,
    };
    this.pickables = [];
    this.raycaster = new THREE.Raycaster();
    this.tmp = new THREE.Vector3();
    this.clock = 0;
    this._bindInput();
    new ResizeObserver(() => this.resize()).observe(host); this.resize();
  }

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- input --
  _bindInput() {
    const el = this.renderer.domElement; let drag = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: 0, btn: e.button }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      // FollowCamRotation / free look are Mouse0. Unity "Mouse X" axis sensitivity defaults to 0.1.
      if (drag.btn === 0) { this.rig.rawX += dx * 0.1; this.rig.rawY += dy * 0.1; }
    });
    el.addEventListener('pointerup', (e) => { if (drag && drag.moved < 5) this.onClick?.(e, drag.btn); drag = null; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const mode = this.rig.mode;
      if (mode === 'free') this.camera.fov = Math.max(30, Math.min(80, this.camera.fov + Math.sign(e.deltaY) * 2));
      else if (mode === 'flyby') this.camera.fov = Math.max(30, Math.min(80, this.camera.fov + Math.sign(e.deltaY) * (e.shiftKey ? 3 : 1)));
      else if (mode === 'smooth') this.rig.dist = Math.max(PIVOT_MIN, Math.min(PIVOT_MAX, this.rig.dist * Math.exp(e.deltaY * 0.0012)));
      else this.rig.dist = Math.max(25, Math.min(120000, this.rig.dist * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
    addEventListener('keydown', (e) => { if (!e.repeat) this.rig.keys.add(e.key.toLowerCase()); if (e.key === 'Shift') this.rig.keys.add('shift'); if (e.key === 'Control') this.rig.keys.add('control'); });
    addEventListener('keyup', (e) => { this.rig.keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') this.rig.keys.delete('shift'); if (e.key === 'Control') this.rig.keys.delete('control'); });
    addEventListener('blur', () => this.rig.keys.clear());
  }

  setMode(mode) {
    const r = this.rig;
    if (mode === r.mode) return;
    if (mode === 'free') {
      r.freePos.copy(this.camera.position);
      const look = r.target.clone().sub(this.camera.position);
      const len = look.length() || 1;
      r.yaw = Math.atan2(-look.x, -look.z);
      r.pitch = Math.asin(Math.max(-1, Math.min(1, look.y / len)));
    } else if (mode === 'flyby') this._placeFlyby();
    else if (r.follow) {
      toThree(r.follow, r.target); r.target.y += 8;
      const off = this.camera.position.clone().sub(r.target);
      const lim = mode === 'smooth' ? [PIVOT_MIN, PIVOT_MAX] : [25, 120000];
      r.dist = Math.max(lim[0], Math.min(lim[1], off.length()));
      r.el = Math.asin(Math.max(-1, Math.min(1, off.y / Math.max(r.dist, 1))));
      const worldAz = Math.atan2(off.x, off.z);
      r.az = mode === 'smooth' ? worldAz + r.follow.heading * D2R : worldAz;
    }
    r.mode = mode;
    this.onMode?.(mode);
  }

  /** NDC ray → picked unit id or water point {x,y} in sim coords */
  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    let best = null, bestD = 1e12;
    for (const a of this.actors.values()) {
      if (!a.root.visible || a.unit.kind === 'shell') continue;
      const c = a.root.position, ray = this.raycaster.ray;
      const to = this.tmp.copy(c).sub(ray.origin), t = to.dot(ray.direction); if (t < 0) continue;
      const d = to.addScaledVector(ray.direction, -t).length();
      const rad = Math.max(a.radius, t * 0.012); // keep far units clickable
      if (d < rad && t < bestD) { best = a.unit.id; bestD = t; }
    }
    const dir = this.raycaster.ray.direction, o = this.raycaster.ray.origin;
    let water = null;
    if (dir.y < -1e-4) { const t = -o.y / dir.y; water = { x: o.x + dir.x * t, y: -(o.z + dir.z * t) }; }
    return { unitId: best, water };
  }

  /** Fetch glbs for these Resources paths before the first sync. Failures stay procedural. */
  async preloadModels(keys) {
    await Promise.all([...keys].map(async (k) => {
      if (this.modelTemplates.has(k)) return;
      const tpl = await loadModelTemplate(k);
      if (tpl) this.modelTemplates.set(k, tpl);
    }));
  }

  _modelFor(u) {
    const tpl = u.spec.modelKey && this.modelTemplates.get(u.spec.modelKey);
    if (!tpl) return null;
    const g = tpl.clone(true);
    // Prefabs are normalized (hull ~2 units on Z). Scale so that axis matches the INI length.
    // The Unity pivot sits on the waterline, so no extra draft offset.
    g.rotation.y = Math.PI;
    const target = u.kind === 'air' ? Math.max(u.spec.length || 0, u.spec.span || 12) : (u.spec.length || 1);
    const box = new THREE.Box3().setFromObject(g);
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 1e-4);
    g.scale.setScalar(target / span);
    g.userData.draft = Math.max(0, -box.min.y * (target / span));
    g.userData.fromAsset = true;
    g.userData.spinners = [];
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    return g;
  }

  // ------------------------------------------------------------ actors --
  _makeActor(u) {
    const root = new THREE.Group(); let model, radius = 20;
    const shipped = (u.kind === 'ship' || u.kind === 'sub' || u.kind === 'air' || u.kind === 'land') ? this._modelFor(u) : null;
    if (shipped) { model = shipped; radius = Math.max((u.spec.length || 20) * 0.55, u.kind === 'air' ? 16 : 12); }
    else if (u.kind === 'ship' || u.kind === 'sub') { model = buildShipModel(u.spec); radius = Math.max(u.spec.length * 0.55, 12); }
    else if (u.kind === 'air') { model = buildAircraftModel(u.spec); radius = 20; }
    else if (u.kind === 'land') { model = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 14), new THREE.MeshStandardMaterial({ color: 0x6d6550, roughness: 0.8 })); radius = 16; }
    else if (u.kind === 'missile') { model = buildMissileModel(u.spec); radius = 15; }
    else if (u.kind === 'buoy') { model = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 6), new THREE.MeshBasicMaterial({ color: 0x7fd4ff })); radius = 4; }
    else { model = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 6), new THREE.MeshBasicMaterial({ color: 0xfff2b0 })); radius = 5; }
    root.add(model);
    let nav = null;
    if (u.kind === 'ship' || u.kind === 'sub' || u.kind === 'air') {
      nav = makeNavLights(u.spec || {}, u.kind);
      root.add(nav);
    }
    const a = { unit: u, root, model, radius, trail: null, wake: null, sink: 0, smokeT: 0, nav };
    if (u.kind === 'missile' || u.kind === 'shell') { a.trail = new Trail(u.kind === 'shell' ? 0xffd27a : 0xe8eef2, u.kind === 'shell' ? 14 : 70); this.scene.add(a.trail.line); }
    if (u.kind === 'ship') {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.wakeTex, transparent: true, depthWrite: false, opacity: 0.9 }));
      w.geometry.rotateX(-Math.PI / 2); this.scene.add(w); a.wake = w;
    }
    this.scene.add(root); this.actors.set(u.id, a);
    return a;
  }

  /** Sync all sim units. `visible(u)` implements fog of war. */
  sync(world, visible, dt) {
    this.clock += dt;
    for (const u of world.units.values()) {
      let a = this.actors.get(u.id);
      if (!u.active && u.kind !== 'air' && u.kind !== 'ship' && u.kind !== 'sub' && u.kind !== 'land') continue;
      if (!a) a = this._makeActor(u);
      else if (!a.model.userData.fromAsset && u.spec.modelKey && this.modelTemplates.has(u.spec.modelKey)) {
        const shipped = this._modelFor(u);
        if (shipped) { a.root.remove(a.model); a.model = shipped; a.root.add(shipped); a.radius = Math.max((u.spec.length || 20) * 0.55, 12); }
      }
      const ct = u.team === world.playerTeam ? null : world.contacts[world.playerTeam]?.get(u.id);
      // A MAD-only track is an uncertain fix. The hull stays hidden until another sensor sees it.
      const show = (u.alive || a.sink < 1) && u.active && visible(u) && !madOnlyContact(ct) && !sonarUncertain(ct);
      a.root.visible = show; if (a.wake) a.wake.visible = show && u.alive;
      if (a.nav) a.nav.visible = show && navLightsOn(u);
      if (a.trail) a.trail.line.visible = show;
      if (!show) continue;
      toThree(u, this.tmp); a.root.position.copy(this.tmp);
      if (u.kind === 'ship' || u.kind === 'sub') {
        const h = this.ocean.heightAt(u.x, -u.y, this.clock) * 0.5;
        a.root.position.y = h + (u.kind === 'sub' ? (u.z || 0) : (u.heave || 0));
        if (!u.alive) { a.sink += dt / 40; a.root.position.y -= a.sink * u.spec.length * 0.25; a.root.rotation.z = Math.min(0.6, a.sink * 1.2); }
        a.root.rotation.set(0, -u.heading * D2R, 0, 'YXZ');
        if (u.alive) {
          const amp = this.ocean.uniforms.uAmp.value;
          const listed = u.kind === 'ship' ? u.roll : u.roll * 0.5;
          a.root.rotation.z = listed * D2R + Math.sin(this.clock * 0.7 + u.id) * 0.012 * amp;
          const bob = Math.cos(this.clock * 0.5 + u.id) * 0.008 * amp;
          a.root.rotation.x = ((u.kind === 'sub' || u.kind === 'ship') ? (u.pitch || 0) : 0) * D2R + bob;
        }
        if (a.wake) {
          const L = u.spec.length, sp = Math.abs(u.speed), k = Math.min(1, sp / 8);
          const len = L * (1.0 + 2.6 * k), wid = u.spec.beam * (1.3 + 1.2 * k);
          const hx = Math.sin(u.heading * D2R), hz = -Math.cos(u.heading * D2R), back = L * 0.5 + len * 0.5;
          a.wake.scale.set(wid, 1, len);
          a.wake.position.set(this.tmp.x - hx * back, 0.3, this.tmp.z - hz * back);
          a.wake.rotation.set(0, -u.heading * D2R, 0);
          a.wake.material.opacity = Math.min(0.85, sp / 4);
          if (u.kind === 'sub' && -(u.z || 0) > 2) a.wake.visible = false;
        }
        // spinning radars
        for (const [piv, rps] of a.model.userData.spinners || []) piv.rotation.y += rps * dt * 2;
        // fire / smoke when damaged
        if (u.alive && u.hp < u.maxHp * 0.5) {
          a.smokeT -= dt;
          if (a.smokeT <= 0) { a.smokeT = 0.25; this.fx.smoke(this.tmp.clone().add(new THREE.Vector3(0, u.spec.length * 0.08, 0)), u.spec.length * 0.08, 9); }
        }
        if (!u.alive && a.sink > 0.5 && a.sink < 1.0) { a.smokeT -= dt; if (a.smokeT <= 0) { a.smokeT = 0.5; this.fx.smoke(this.tmp.clone(), 12, 8); } }
        if (!u.alive && a.sink >= 1) { a.root.visible = false; }
      } else if (u.kind === 'land') {
        a.root.position.y = 0;
        a.root.rotation.set(0, -u.heading * D2R, 0);
      } else if (u.kind === 'air') {
        a.root.rotation.set(u.pitch * D2R, -u.heading * D2R, -u.roll * D2R, 'YXZ');
        for (const [piv, rps] of a.model.userData.spinners || []) piv.rotation.y += rps * dt * 2;
      } else if (u.kind === 'missile') {
        a.root.rotation.set(u.pitch * D2R, -u.heading * D2R, 0, 'YXZ');
        a.model.userData.flame && (a.model.userData.flame.visible = true);
        a.trail.push(this.tmp);
        if (Math.random() < dt * 8) this.fx.smoke(this.tmp.clone(), 3, 5);
      } else if (u.kind === 'shell') {
        a.trail.push(this.tmp, 20);
      }
    }
    // remove actors of deleted units
    for (const [id, a] of this.actors) {
      if (world.units.has(id)) continue;
      this.scene.remove(a.root); if (a.trail) this.scene.remove(a.trail.line); if (a.wake) this.scene.remove(a.wake); this.actors.delete(id);
    }
    this.fx.update(dt);
  }

  // ------------------------------------------------------------ camera --
  follow(u) {
    this.rig.follow = u;
    if (!u) return;
    const len = u.spec.length || (u.kind === 'air' ? 12 : 40);
    const near = u.kind === 'land' ? 36 : u.kind === 'air' ? Math.max(24, len * 2.2) : 120;
    this.rig.dist = Math.max(near, len * (u.kind === 'land' ? 2.4 : u.kind === 'air' ? 3.4 : 2.8));
    if (this.rig.mode === 'flyby') this._placeFlyby();
  }

  /** FlybyCamera.setInitialPositionAndRotation: sit ahead of the bow and look back. */
  _placeFlyby() {
    const u = this.rig.follow;
    if (!u) return;
    const fast = u.kind === 'air' || u.kind === 'missile';
    const cfg = fast ? FLYBY.fast : FLYBY.slow;
    const ang = u.heading * D2R + (Math.random() < 0.5 ? -1 : 1) * cfg.side;
    toThree(u, this.rig.target); this.rig.target.y += 8;
    this.rig.flyPos.set(
      this.rig.target.x + Math.sin(ang) * cfg.start,
      this.rig.target.y + Math.sin(cfg.pitch) * cfg.start,
      this.rig.target.z - Math.cos(ang) * cfg.start,
    );
    this.rig.flyReset = cfg.reset;
  }

  _look(dt) {
    const r = this.rig;
    const maxP = 85 * D2R;
    let axisX = r.rawX, axisY = r.rawY;
    r.rawX = 0; r.rawY = 0;
    const pan = r.acceptKeys && r.mode === 'free';
    if (pan && r.keys.has('arrowleft')) r.panX = Math.max(-0.5, r.panX - dt * 0.5);
    else if (pan && r.keys.has('arrowright')) r.panX = Math.min(0.5, r.panX + dt * 0.5);
    else r.panX *= Math.pow(0.1, dt);
    if (pan && r.keys.has('arrowup')) r.panY = Math.max(-0.5, r.panY - dt * 0.5);
    else if (pan && r.keys.has('arrowdown')) r.panY = Math.min(0.5, r.panY + dt * 0.5);
    else r.panY *= Math.pow(0.1, dt);
    if (Math.abs(r.panX) < 0.001) r.panX = 0;
    if (Math.abs(r.panY) < 0.001) r.panY = 0;
    axisX += r.panX; axisY += r.panY;
    const a = 1 - Math.exp(-dt / 0.1);
    r.smX += (axisX - r.smX) * a; r.smY += (axisY - r.smY) * a;
    const deg = 5 * D2R;
    if (r.mode === 'free') { r.yaw -= r.smX * deg; r.pitch = Math.max(-maxP, Math.min(maxP, r.pitch - r.smY * deg)); }
    else if (r.mode !== 'flyby') { r.az -= r.smX * deg; r.el = Math.max(-maxP, Math.min(maxP, r.el + r.smY * deg)); }
  }

  _fly(dt) {
    const r = this.rig;
    if (!r.acceptKeys) return;
    const k = r.keys;
    let mul = 1;
    if (k.has('shift')) mul *= 100;
    if (k.has('control')) mul *= 0.01;
    const step = 100 * mul * dt;
    const cp = Math.cos(r.pitch), sp = Math.sin(r.pitch), sy = Math.sin(r.yaw), cy = Math.cos(r.yaw);
    const forward = this.tmp.set(-sy * cp, sp, -cy * cp);
    const right = new THREE.Vector3(cy, 0, -sy);
    if (k.has('w')) r.freePos.addScaledVector(forward, step);
    if (k.has('s')) r.freePos.addScaledVector(forward, -step);
    if (k.has('d')) r.freePos.addScaledVector(right, step);
    if (k.has('a')) r.freePos.addScaledVector(right, -step);
    if (k.has('r')) r.freePos.y += step;
    if (k.has('f')) r.freePos.y -= step;
  }

  render(dt) {
    const r = this.rig;
    this._look(dt);
    const minY = 20 * 0.3048, maxY = 26880 * 0.3048;
    if (r.mode === 'free') {
      this._fly(dt);
      const wave = this.ocean.heightAt(r.freePos.x, r.freePos.z, this.clock);
      r.freePos.y = Math.max(wave + minY, Math.min(maxY, r.freePos.y));
      const cp = Math.cos(r.pitch), forward = this.tmp.set(-Math.sin(r.yaw) * cp, Math.sin(r.pitch), -Math.cos(r.yaw) * cp);
      this.camera.position.copy(r.freePos);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(r.freePos.clone().add(forward));
    } else if (r.mode === 'flyby') {
      if (r.follow) { toThree(r.follow, r.target); r.target.y += 8; }
      if (r.flyPos.distanceTo(r.target) > r.flyReset) this._placeFlyby();
      const wave = this.ocean.heightAt(r.flyPos.x, r.flyPos.z, this.clock);
      if (r.flyPos.y < wave + minY) r.flyPos.y = wave + minY;
      this.camera.position.copy(r.flyPos);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(r.target);
    } else if (r.mode === 'smooth' && r.follow) {
      toThree(r.follow, r.target); r.target.y += 8;
      const yaw = -r.follow.heading * D2R + r.az;
      const cx = Math.cos(r.el);
      const dir = this.tmp.set(Math.sin(yaw) * cx, Math.sin(r.el), Math.cos(yaw) * cx);
      this.camera.position.copy(r.target).addScaledVector(dir, r.dist);
      const wave = this.ocean.heightAt(this.camera.position.x, this.camera.position.z, this.clock);
      if (this.camera.position.y < wave + minY) this.camera.position.y = wave + minY;
      const span = PIVOT_MAX - PIVOT_MIN;
      const wanted = 30 + ((r.dist - PIVOT_MIN) / span) * 50;
      const t = Math.max(0, Math.min(1, 10 * dt));
      this.camera.fov += (wanted - this.camera.fov) * (t * t * (3 - 2 * t));
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(r.target);
      if (r.follow.kind === 'air') {
        const camAz = Math.atan2(this.camera.position.x - r.target.x, this.camera.position.z - r.target.z);
        const bowAz = Math.atan2(Math.sin(r.follow.heading * D2R), -Math.cos(r.follow.heading * D2R));
        let delta = Math.abs(Math.atan2(Math.sin(camAz - bowAz), Math.cos(camAz - bowAz)));
        delta = Math.min(delta, Math.abs(Math.PI - delta));
        const fade = 20 * D2R;
        if (delta < fade) this.camera.rotateZ(-(r.follow.roll || 0) * D2R * (1 - delta / fade));
      }
    } else {
      if (r.follow) { toThree(r.follow, r.target); r.target.y += 8; }
      const cx = Math.cos(r.el), dir = this.tmp.set(Math.sin(r.az) * cx, Math.sin(r.el), Math.cos(r.az) * cx);
      this.camera.position.copy(r.target).addScaledVector(dir, r.dist);
      const wave = this.ocean.heightAt(this.camera.position.x, this.camera.position.z, this.clock);
      if (this.camera.position.y < wave + minY) this.camera.position.y = wave + minY;
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(r.target);
    }
    const camDist = this.camera.position.distanceTo(r.target) || r.dist;
    this.camera.near = Math.max(0.5, camDist * 0.01); this.camera.far = 600000; this.camera.updateProjectionMatrix();
    this.ocean.update(this.clock, this.camera); this.sky.update(this.camera);
    this.renderer.render(this.scene, this.camera);
  }
}
