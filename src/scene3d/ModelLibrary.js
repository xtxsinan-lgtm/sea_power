// Loads extracted Sea Power prefabs (data/models/<Resources path>.glb).
// Missing files fall back to the procedural hulls in Models.js.
// Frame: glTF is Y-up, bow along +Z after the Unity → right-handed bake.
// The stage turns the model 180° so it faces -Z, matching the procedural hulls.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map();

export function modelFile(key) {
  return 'data/models/' + key.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replaceAll('/', '__') + '.glb';
}

/** @returns {Promise<import('three').Object3D|null>} a template to clone */
export function loadModelTemplate(key) {
  if (!key) return Promise.resolve(null);
  if (cache.has(key)) return cache.get(key);
  const p = loader.loadAsync(modelFile(key)).then((g) => g.scene).catch(() => null);
  cache.set(key, p);
  return p;
}
