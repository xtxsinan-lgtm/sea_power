// Sky dome (gradient + sun disc) that follows the camera, plus matching lights.
import * as THREE from 'three';

const VERT = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`;
const FRAG = `
uniform vec3 uSun, uZenith, uHorizon; varying vec3 vDir;
void main(){
  float h = clamp(vDir.y, -0.1, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.45));
  float s = max(dot(normalize(vDir), normalize(uSun)), 0.0);
  col += vec3(1.0,0.9,0.7) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.18);
  if (vDir.y < 0.0) col = mix(col, uHorizon, clamp(-vDir.y * 8.0, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor() {
    this.sunDir = new THREE.Vector3(0.45, 0.55, -0.55).normalize();
    this.uniforms = { uSun: { value: this.sunDir }, uZenith: { value: new THREE.Color(0x2f6aa8) }, uHorizon: { value: new THREE.Color(0xb7cbdc) } };
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = -1;
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.6); this.sun.position.copy(this.sunDir).multiplyScalar(500);
    this.hemi = new THREE.HemisphereLight(0xaac4e0, 0x1a3248, 1.1);
    this.amb = new THREE.AmbientLight(0xb7c6d4, 0.15);
  }
  /** Place the sun from the mission solar altitude and hour angle, then tint with the night bands. */
  setFromSun(altDeg, hourAngleDeg) {
    const alt = altDeg * Math.PI / 180;
    const az = hourAngleDeg * Math.PI / 180;
    const ce = Math.cos(alt);
    this.sunDir.set(Math.sin(az) * ce, Math.sin(alt), -Math.cos(az) * ce);
    if (this.sunDir.lengthSq() < 1e-8) this.sunDir.set(0, 1, 0);
    else this.sunDir.normalize();
    this.sun.position.copy(this.sunDir).multiplyScalar(500);
    const night = altDeg >= 5 ? 0 : altDeg <= -12 ? 1 : (5 - altDeg) / 17;
    this.setNight(night);
    return night;
  }
  setNight(n) { // 0 day … 1 night
    const d = 1 - n;
    this.uniforms.uZenith.value.setRGB(0.18 * d + 0.01, 0.42 * d + 0.015, 0.66 * d + 0.04);
    this.uniforms.uHorizon.value.setRGB(0.72 * d + 0.03, 0.8 * d + 0.04, 0.86 * d + 0.07);
    this.sun.intensity = 2.6 * d + 0.7 * n; this.hemi.intensity = 1.1 * d + 1.3 * n;
    this.amb.intensity = 0.12 + 2.4 * n;
  }
  update(camera) { this.mesh.position.copy(camera.position); this.sun.target.position.copy(camera.position); }
}
