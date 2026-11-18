// Procedural models. The game's meshes live inside Unity asset bundles; until an
// asset-extraction step exists, ships are lofted from the INI's Length/Beam/Displacement
// and dressed by class heuristics. Model frame: forward = -Z, up = +Y, starboard = +X, waterline y = 0.
import * as THREE from 'three';

const M = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0.15, ...o });
const mats = {};
const mat = (key, c, o) => (mats[key] ||= M(c, o));
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** Hull from stations; returns BufferGeometry */
function loftHull(L, B, draft, free, { bowSharp = 1, sternW = 0.6, flare = 0.06, deckSheer = 0.02 } = {}) {
  const NS = 36, ring = [];
  const prof = (s) => {
    let hb = 1;
    if (s > 0.62) hb = Math.pow(Math.max(0, 1 - Math.pow((s - 0.62) / 0.38, 1.7 * bowSharp)), 0.8);
    if (s < 0.14) hb = sternW + (1 - sternW) * Math.sqrt(s / 0.14);
    return hb;
  };
  const pts = (s) => {
    const hb = (B / 2) * prof(s), fl = 1 + flare * Math.max(0, s - 0.5) * 2;
    const dk = free + L * deckSheer * Math.pow(s, 4) + L * 0.004 * Math.pow(1 - s, 2);
    const dr = draft * (s > 0.9 ? 1 - (s - 0.9) * 4 : 1);
    return [[0, -dr], [hb * 0.55, -dr * 0.92], [hb * 0.9, -dr * 0.5], [hb, 0], [hb * fl, dk * 0.55], [hb * fl * 0.98, dk], [0, dk]];
  };
  const verts = [], idx = [];
  for (let i = 0; i <= NS; i++) {
    const s = i / NS, z = -(s - 0.5) * L, p = pts(s);
    // port side (reverse) then starboard so the ring is one closed loop keel→deck→keel
    const loop = [...p.map(([x, y]) => [x, y]), ...p.slice(0, -1).reverse().slice(0).map(([x, y]) => [-x, y])];
    loop.pop(); // drop duplicate keel centre
    ring.push(loop.length);
    for (const [x, y] of loop) verts.push(x, y, z);
  }
  const n = ring[0];
  for (let i = 0; i < NS; i++) for (let j = 0; j < n; j++) {
    const a = i * n + j, b = i * n + ((j + 1) % n), c = (i + 1) * n + j, d = (i + 1) * n + ((j + 1) % n);
    idx.push(a, c, b, b, c, d);
  }
  // stern transom cap (fan around centre of ring 0)
  const cpos = verts.length / 3; verts.push(0, -draft * 0.3, -(0 - 0.5) * L);
  for (let j = 0; j < n; j++) idx.push(cpos, j, (j + 1) % n);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

const box = (w, h, d, m, x, y, z, parent) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y + h / 2, z); parent.add(o); return o; };
const cyl = (r, h, m, x, y, z, parent, seg = 10) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m); o.position.set(x, y + h / 2, z); parent.add(o); return o; };

function mast(parent, x, y, z, h, radarW, spin) {
  const m = mat('mast', 0x666d73);
  cyl(Math.max(0.25, h * 0.012), h, m, x, y, z, parent, 6);
  const bar = box(radarW, radarW * 0.18, radarW * 0.06, mat('radar', 0x8a9096), x, y + h, z, parent);
  if (spin) { const pivot = new THREE.Group(); pivot.position.set(x, y + h + radarW * 0.1, z); parent.add(pivot); parent.remove(bar); bar.position.set(0, 0, 0); pivot.add(bar); parent.userData.spinners = (parent.userData.spinners || []).concat([[pivot, spin]]); }
}

function turret(parent, x, y, z, size, dirZ) {
  const m = mat('gun', 0x7b8288);
  const t = box(size, size * 0.55, size * 1.1, m, x, y, z, parent);
  const b = cyl(size * 0.07, size * 1.7, m, x, y + size * 0.3, z + dirZ * size * 1.1, parent, 6);
  b.rotation.x = Math.PI / 2; b.position.y = y + size * 0.4;
}

// ---------------------------------------------------------------- classes --
function classify(spec) {
  const id = spec.id;
  if (spec.kind === 'sub') return 'sub';
  if (/^civ_fv|sampan|dhow|raft|boat/.test(id) || spec.length < 30) return 'small';
  if (/^civ_|^all_/.test(id)) return /tanker|oil|ao_|bulk|freighter|roro|car|container|ms_/.test(id) ? 'merchant' : 'merchant';
  if (/_cv|_cvn|_cva|_cvl|_lha|_lph|_lhd|kuznetsov|kiev|_cvs/.test(id) || (spec.length > 220 && /AirCarrier|Carrier/i.test(spec.role.join()))) return 'carrier';
  if (/_ao|_ae|_aoe|_as_|_ar_|_ag_|_ata|_atf/.test(id)) return 'auxiliary';
  return 'warship';
}

export function buildShipModel(spec) {
  const L = spec.length, B = spec.beam, cls = classify(spec);
  const g = new THREE.Group(); g.userData.spinners = [];
  const seed = hashStr(spec.id);
  const rnd = (n) => ((seed >> (n * 3)) & 255) / 255;
  const navy = spec.id.startsWith('wp_') ? 0x7f8c8f : spec.id.startsWith('usn_') ? 0x8a9298 : 0x858d93;
  let hullGeom, hullMat, draft = Math.min(B * 0.32, L * 0.05 + 1), free = L * 0.055 + 0.6;

  if (cls === 'sub') {
    const r = B / 2, geo = new THREE.CapsuleGeometry(r, L - B, 8, 16); geo.rotateX(Math.PI / 2);
    const h = new THREE.Mesh(geo, mat('sub', 0x20262b, { roughness: 0.5 })); h.position.y = -r * 0.55; g.add(h);
    const sail = box(B * 0.28, B * 0.7, L * 0.14, mat('sub', 0x20262b), 0, r * 0.15, -L * 0.12, g);
    cyl(0.1, B * 0.5, mat('mast', 0x666d73), 0, sail.position.y + B * 0.35, sail.position.z, g, 5);
    g.userData.draft = r;
    return g;
  }

  if (cls === 'merchant' || cls === 'small' || cls === 'auxiliary') {
    const hue = [0xb23a2f, 0x2c4f7c, 0x2d6a4f, 0x8b8f93, 0x6b3a2a, 0x39424a][Math.floor(rnd(1) * 6)];
    hullMat = mat('mh' + hue, hue);
    if (cls === 'small') { draft = B * 0.25; free = Math.max(0.8, B * 0.18); }
    hullGeom = loftHull(L, B, draft, free, { bowSharp: cls === 'small' ? 1 : 0.55, sternW: 0.85, flare: 0.04, deckSheer: 0.012 });
    const hull = new THREE.Mesh(hullGeom, hullMat); g.add(hull);
    const white = mat('white', 0xe6e8ea);
    if (cls === 'small') {
      box(B * 0.5, B * 0.45, L * 0.25, white, 0, free, L * 0.1, g);
      cyl(0.12, B * 0.9, mat('mast', 0x666d73), 0, free + B * 0.45, L * 0.1, g, 5);
    } else {
      const aft = L * 0.34;
      box(B * 0.72, L * 0.07, L * 0.12, white, 0, free, aft, g);
      box(B * 0.6, L * 0.04, L * 0.08, white, 0, free + L * 0.07, aft, g);
      cyl(B * 0.1, L * 0.07, mat('funnel', hue), 0, free + L * 0.11, aft + L * 0.04, g);
      mast(g, 0, free + L * 0.11, aft - L * 0.02, L * 0.05, B * 0.2, 2.0);
      // cargo: containers or deck gear
      const cm = [mat('c1', 0xa1392e), mat('c2', 0x2c6b9a), mat('c3', 0xcf9b2e), mat('c4', 0x3d7a4f)];
      for (let i = 0; i < 9; i++) for (let k = 0; k < 2; k++) {
        const c = cm[(i * 3 + k + (seed & 3)) % 4];
        box(B * 0.34, B * 0.17, L * 0.065, c, (k ? 1 : -1) * B * 0.19, free, -L * 0.2 + i * L * 0.07 - L * 0.12 + (aft - L * 0.34), g);
      }
    }
    g.userData.draft = draft; return g;
  }

  // warship / carrier
  hullMat = mat('navy' + navy, navy, { roughness: 0.6 });
  if (cls === 'carrier') { free = L * 0.075; draft = Math.min(B * 0.18, 11); }
  hullGeom = loftHull(L, B * (cls === 'carrier' ? 0.62 : 1), draft, free, { bowSharp: cls === 'carrier' ? 0.7 : 1.1, sternW: cls === 'carrier' ? 0.85 : 0.6, flare: cls === 'carrier' ? 0.0 : 0.08 });
  g.add(new THREE.Mesh(hullGeom, hullMat));
  const boot = mat('boot', 0x1b2024);
  const sh = new THREE.Mesh(new THREE.BoxGeometry(B * 0.9, 0.5, L * 0.5), boot); sh.position.set(0, -0.2, 0); sh.visible = false; g.add(sh);
  const steel = mat('steel' + navy, navy + 0x0a0a0a), dark = mat('dark', 0x4b5258);

  if (cls === 'carrier') {
    const deckW = B * 1.0;
    const fl = box(deckW, 0.9, L * 0.96, mat('flight', 0x474d52, { roughness: 0.9 }), 0, free - 0.4, -L * 0.005, g);
    fl.scale.x = 1; // angled deck illusion: white lines
    const line = box(0.6, 0.05, L * 0.8, mat('line', 0xe8e0c0), 0, free + 0.52, -L * 0.02, g);
    line.rotation.y = 0.14;
    const isl = box(B * 0.12, L * 0.11, L * 0.07, steel, B * 0.34, free + 0.5, -L * 0.04, g);
    box(B * 0.15, L * 0.02, L * 0.1, steel, B * 0.34, free + L * 0.11 + 0.5, -L * 0.04, g);
    mast(g, B * 0.34, free + L * 0.13, -L * 0.06, L * 0.1, B * 0.2, 1.4);
    mast(g, B * 0.34, free + L * 0.13, L * 0.0, L * 0.06, B * 0.12, 0);
    void isl;
    g.userData.draft = draft; return g;
  }

  const bridgeZ = -L * 0.12, deckY = free;
  box(B * 0.62, L * 0.06, L * 0.30, steel, 0, deckY, L * 0.06 - 0.0 * L, g);          // main deckhouse
  box(B * 0.5, L * 0.05, L * 0.12, steel, 0, deckY + L * 0.06, bridgeZ + 0.0, g);       // bridge
  box(B * 0.52, L * 0.012, L * 0.125, dark, 0, deckY + L * 0.11, bridgeZ, g);            // bridge wing top
  mast(g, 0, deckY + L * 0.11, bridgeZ + L * 0.015, L * 0.12, B * 0.45, 1.6);              // search radar
  mast(g, 0, deckY + L * 0.06, L * 0.18, L * 0.09, B * 0.3, 0);                           // aft mast
  cyl(B * 0.13, L * 0.07, dark, 0, deckY + L * 0.06, L * 0.1, g, 10);                    // funnel
  turret(g, 0, deckY, -L * 0.3, Math.max(2.2, L * 0.03), -1);                              // forward gun
  turret(g, 0, deckY, L * 0.33, Math.max(1.8, L * 0.024), 1);                              // aft gun
  if (L > 90) box(B * 0.45, 0.4, L * 0.1, mat('helo', 0x555b60), 0, deckY, L * 0.43, g);   // helo pad
  g.userData.draft = draft;
  return g;
}

export function buildAircraftModel(spec) {
  const g = new THREE.Group(); g.userData.spinners = [];
  const grey = mat('air', 0x9aa1a6);
  const s = spec.span || 12, L = spec.length || s * 0.9;
  if (spec.helo) {
    // Seasprite-style: cabin, tail boom, four-blade main rotor, tail rotor, wheeled gear.
    // Dimensions follow the spec when the ini has them; otherwise a ~12 m light helicopter.
    const L = Math.max(11, spec.length || 12);
    const rotorD = Math.max(L * 0.95, s);
    const paint = mat('heloBody', 0x6d767c);
    const dark = mat('heloDark', 0x242a30);
    const glass = mat('heloGlass', 0x9ec4d6, { roughness: 0.12, metalness: 0.35 });
    const blade = mat('heloBlade', 0x1a1f24);
    box(1.85, 1.45, L * 0.40, paint, 0, 0.62, -L * 0.02, g);
    box(1.05, 0.72, L * 0.16, paint, 0, 0.78, -L * 0.26, g);
    box(1.45, 0.48, L * 0.20, glass, 0, 1.45, -L * 0.10, g);
    box(1.55, 0.42, L * 0.20, paint, 0, 1.85, L * 0.02, g);
    box(0.42, 0.36, L * 0.46, paint, 0, 1.25, L * 0.36, g);
    box(0.14, 1.05, 0.62, paint, 0, 1.35, L * 0.56, g);
    box(1.35, 0.08, 0.22, paint, 0, 2.25, L * 0.54, g);
    cyl(0.22, 0.28, dark, 0.72, 0.15, 0.15, g, 10);
    cyl(0.22, 0.28, dark, -0.72, 0.15, 0.15, g, 10);
    cyl(0.16, 0.24, dark, 0, 0.35, L * 0.42, g, 8);
    cyl(0.08, 0.85, dark, 0, 2.15, -L * 0.02, g, 8);
    const rotor = new THREE.Group();
    rotor.position.set(0, 3.05, -L * 0.02);
    g.add(rotor);
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();
      pivot.rotation.y = i * Math.PI / 2;
      rotor.add(pivot);
      const bld = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, rotorD * 0.46), blade);
      bld.position.set(0, 0, -rotorD * 0.25);
      pivot.add(bld);
    }
    const tailHub = new THREE.Group();
    tailHub.position.set(0.2, 1.95, L * 0.56);
    tailHub.rotation.z = Math.PI / 2;
    g.add(tailHub);
    for (let i = 0; i < 2; i++) {
      const pivot = new THREE.Group();
      pivot.rotation.y = i * Math.PI / 2;
      tailHub.add(pivot);
      const bld = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 1.15), blade);
      bld.position.set(0, 0, -0.55);
      pivot.add(bld);
    }
    g.userData.spinners.push([rotor, 8], [tailHub, 22]);
    return g;
  }
  cyl(Math.max(0.6, L * 0.045), L, grey, 0, 0, 0, g, 8).rotation.x = Math.PI / 2;
  g.children[0].position.y = 0;
  const wing = box(s, 0.12, L * 0.28, grey, 0, 0, L * 0.05, g); wing.geometry = new THREE.BoxGeometry(s, 0.12, L * 0.22);
  const tailp = box(s * 0.36, 0.1, L * 0.12, grey, 0, 0, L * 0.4, g); void tailp;
  box(0.15, L * 0.16, L * 0.16, grey, 0, 0, L * 0.4, g);
  return g;
}

/** Port red, starboard green, masthead and stern white. Root frame: bow is -Z, starboard +X. */
export function makeNavLights(spec, kind) {
  const g = new THREE.Group();
  g.name = 'navlights';
  const L = spec.length || (kind === 'air' ? 12 : 40);
  const B = spec.beam || spec.span || L * 0.15;
  const lamp = (color, x, y, z, s) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(s, 8, 6),
      new THREE.MeshBasicMaterial({ color }),
    );
    m.position.set(x, y, z);
    g.add(m);
  };
  const s = Math.max(0.35, L * 0.004);
  if (kind === 'air') {
    const y = 0.4;
    lamp(0xff2a2a, -B * 0.48, y, 0, s);
    lamp(0x3dff6a, B * 0.48, y, 0, s);
    lamp(0xfff4d0, 0, y, L * 0.42, s);
    return g;
  }
  const y = Math.max(1.6, L * 0.035);
  lamp(0xff2a2a, -B * 0.48, y, -L * 0.02, s);
  lamp(0x3dff6a, B * 0.48, y, -L * 0.02, s);
  lamp(0xfff4d0, 0, y + L * 0.07, -L * 0.4, s * 0.85);
  lamp(0xfff4d0, 0, y * 0.55, L * 0.46, s);
  return g;
}

export function buildMissileModel(spec) {
  const g = new THREE.Group();
  const body = cyl(0.25, 5, mat('msl', 0xdde1e4), 0, 0, 0, g, 8); body.rotation.x = Math.PI / 2; body.position.y = 0;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.28, 3.5, 8), new THREE.MeshBasicMaterial({ color: 0xffb347 }));
  flame.rotation.x = -Math.PI / 2; flame.position.z = 4.2; g.add(flame);
  g.userData.flame = flame;
  return g;
}
