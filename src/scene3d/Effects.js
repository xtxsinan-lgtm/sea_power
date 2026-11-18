// Billboard effects: explosions, splashes, smoke, missile trails, ship wakes.
import * as THREE from 'three';

function radialTex(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [o, col] of stops) g.addColorStop(o, col);
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Effects {
  constructor(scene) {
    this.scene = scene; this.items = [];
    this.texFire = radialTex([[0, 'rgba(255,250,200,1)'], [0.25, 'rgba(255,170,60,0.9)'], [0.7, 'rgba(160,50,10,0.35)'], [1, 'rgba(0,0,0,0)']]);
    this.texSmoke = radialTex([[0, 'rgba(60,60,60,0.65)'], [0.6, 'rgba(70,70,70,0.3)'], [1, 'rgba(90,90,90,0)']]);
    this.texSplash = radialTex([[0, 'rgba(255,255,255,0.95)'], [0.55, 'rgba(235,245,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    this.group = new THREE.Group(); scene.add(this.group);
  }

  _sprite(tex, add) {
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending });
    const s = new THREE.Sprite(m); this.group.add(s); return s;
  }

  _add(sprite, life, size0, size1, opa0, rise = 0, vel = null) {
    this.items.push({ s: sprite, life, age: 0, size0, size1, opa0, rise, vel });
  }

  explosion(p, scale = 1) {
    for (let i = 0; i < 6; i++) {
      const s = this._sprite(this.texFire, true); s.position.set(p.x + (Math.random() - 0.5) * 8 * scale, p.y + Math.random() * 6 * scale, p.z + (Math.random() - 0.5) * 8 * scale);
      this._add(s, 0.9 + Math.random() * 0.7, 6 * scale, 26 * scale, 1, 3);
    }
    for (let i = 0; i < 8; i++) {
      const s = this._sprite(this.texSmoke, false); s.position.set(p.x + (Math.random() - 0.5) * 10 * scale, p.y + 4, p.z + (Math.random() - 0.5) * 10 * scale);
      this._add(s, 6 + Math.random() * 6, 8 * scale, 38 * scale, 0.9, 6, new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3));
    }
  }

  splash(p, scale = 1) {
    const s = this._sprite(this.texSplash, false); s.position.set(p.x, 3 * scale, p.z);
    this._add(s, 2.2, 3 * scale, 22 * scale, 0.9, 6 * scale);
  }

  smoke(p, size = 8, life = 8) {
    const s = this._sprite(this.texSmoke, false); s.position.copy(p);
    this._add(s, life, size, size * 4, 0.8, 5, new THREE.Vector3(3, 0, 1));
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]; it.age += dt;
      const k = it.age / it.life;
      if (k >= 1) { this.group.remove(it.s); it.s.material.dispose(); this.items.splice(i, 1); continue; }
      const sz = it.size0 + (it.size1 - it.size0) * Math.sqrt(k);
      it.s.scale.set(sz, sz, 1); it.s.material.opacity = it.opa0 * (1 - k) * (k < 0.08 ? k / 0.08 : 1);
      it.s.position.y += it.rise * dt * (1 - k);
      if (it.vel) it.s.position.addScaledVector(it.vel, dt);
    }
  }
}

/** Fixed-length polyline trail (missile smoke / shell tracer). */
export class Trail {
  constructor(color = 0xe8eef2, n = 60) {
    this.n = n; this.pts = []; this.pos = new Float32Array(n * 3);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })); this.line.frustumCulled = false;
  }
  push(v, minStep = 6) {
    const last = this.pts[this.pts.length - 1];
    if (last && last.distanceTo(v) < minStep) return;
    this.pts.push(v.clone()); if (this.pts.length > this.n) this.pts.shift();
    for (let i = 0; i < this.n; i++) { const p = this.pts[Math.min(i, this.pts.length - 1)]; this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z; }
    this.line.geometry.attributes.position.needsUpdate = true;
  }
}

export function wakeTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 256;
  const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.beginPath(); x.moveTo(32, 0); x.lineTo(64, 256); x.lineTo(0, 256); x.closePath(); x.fill();
  const t = new THREE.CanvasTexture(c); return t;
}
