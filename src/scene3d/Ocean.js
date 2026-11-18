// Ocean — polar-grid ocean centred under the camera; Gerstner-style sine waves
// evaluated from *world* coordinates so the surface never swims when the mesh follows the camera.
import * as THREE from 'three';

const VERT = /* glsl */`
uniform float uTime, uAmp;
varying vec3 vWorld; varying vec3 vNormal; varying float vDist;
const int N = 5;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec2 p = w.xz;
  float h = 0.0; vec2 grad = vec2(0.0);
  // dir.x, dir.y, wavelength, steepness-weight
  vec4 W[N];
  W[0] = vec4( 0.92, 0.39, 180.0, 1.00);
  W[1] = vec4(-0.55, 0.83,  92.0, 0.70);
  W[2] = vec4( 0.30,-0.95,  41.0, 0.45);
  W[3] = vec4(-0.85,-0.52,  19.0, 0.28);
  W[4] = vec4( 0.60, 0.80,   8.5, 0.14);
  for(int i=0;i<N;i++){
    float k = 6.2831853 / W[i].z;
    float c = sqrt(9.81 / k);
    float f = k * (dot(W[i].xy, p) - c * uTime);
    float a = uAmp * W[i].w * W[i].z / 180.0;
    h += a * sin(f);
    grad += W[i].xy * (a * k * cos(f));
  }
  w.y += h;
  vNormal = normalize(vec3(-grad.x, 1.0, -grad.y));
  vWorld = w.xyz;
  vec4 mv = viewMatrix * w;
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform vec3 uSun, uCam, uDeep, uShallow, uHaze, uSky;
varying vec3 vWorld; varying vec3 vNormal; varying float vDist;
void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCam - vWorld);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 base = mix(uDeep, uShallow, pow(1.0 - ndv, 2.0) * 0.55 + clamp(vWorld.y * 0.12 + 0.2, 0.0, 0.5));
  vec3 refl = uSky;
  vec3 R = reflect(-V, N);
  float spec = pow(max(dot(R, normalize(uSun)), 0.0), 380.0) * 6.0 + pow(max(dot(R, normalize(uSun)), 0.0), 40.0) * 0.25;
  vec3 col = mix(base, refl, clamp(fres, 0.0, 1.0)) + vec3(1.0, 0.92, 0.78) * spec;
  // foam on crests
  float foam = smoothstep(0.55, 1.1, vWorld.y / max(0.001, 1.0)) * 0.0;
  col += foam;
  float fog = 1.0 - exp(-pow(vDist / 90000.0, 1.6));
  col = mix(col, uHaze, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

export class Ocean {
  constructor() {
    this.uniforms = {
      uTime: { value: 0 }, uAmp: { value: 0.6 },
      uSun: { value: new THREE.Vector3(0.5, 0.6, -0.4).normalize() }, uCam: { value: new THREE.Vector3() },
      uDeep: { value: new THREE.Color(0x06223a) }, uShallow: { value: new THREE.Color(0x14596e) },
      uHaze: { value: new THREE.Color(0xa9bccd) }, uSky: { value: new THREE.Color(0x7fa3c7) },
    };
    this.mesh = new THREE.Mesh(this._grid(), new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG }));
    this.mesh.frustumCulled = false;
  }

  _grid() {
    const rings = 150, seg = 256, r0 = 3, rMax = 260000;
    const growth = Math.pow(rMax / r0, 1 / (rings - 1));
    const pos = new Float32Array((rings + 1) * (seg + 1) * 3);
    let o = 0;
    for (let i = 0; i <= rings; i++) {
      const r = i === 0 ? 0 : r0 * Math.pow(growth, i - 1);
      for (let j = 0; j <= seg; j++) { const a = (j / seg) * Math.PI * 2; pos[o++] = Math.cos(a) * r; pos[o++] = 0; pos[o++] = Math.sin(a) * r; }
    }
    const idx = [];
    for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + seg + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  /** sea state 0-9 → wave amplitude */
  setSeaState(s) { this.uniforms.uAmp.value = 0.12 + Math.min(9, s) * 0.55; }

  /** Height of the surface at world (x, z) — mirrors the vertex shader for buoyancy. */
  heightAt(x, z, t) {
    const W = [[0.92, 0.39, 180, 1], [-0.55, 0.83, 92, 0.7], [0.3, -0.95, 41, 0.45], [-0.85, -0.52, 19, 0.28], [0.6, 0.8, 8.5, 0.14]];
    let h = 0;
    for (const [dx, dz, L, s] of W) { const k = 2 * Math.PI / L, c = Math.sqrt(9.81 / k); h += this.uniforms.uAmp.value * s * L / 180 * Math.sin(k * (dx * x + dz * z - c * t)); }
    return h;
  }

  update(t, camera) {
    this.uniforms.uTime.value = t;
    this.uniforms.uCam.value.copy(camera.position);
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
  }
}
