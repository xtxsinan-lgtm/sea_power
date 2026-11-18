// Units & geometry. Sim frame: x = east (m), y = north (m), z = up (m).
// Heading is compass degrees (0 = north, clockwise). Game data uses knots for
// speeds, nautical miles for weapon ranges, km for sensor ranges, feet for altitudes.
export const NM = 1852;
export const KT = 0.514444;
export const FT = 0.3048;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export const kt2ms = (k) => k * KT;
export const ms2kt = (m) => m / KT;
export const wrap360 = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => { a = wrap360(a); return a > 180 ? a - 360 : a; };
export const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** compass bearing from a to b (deg) */
export const bearing = (a, b) => wrap360(Math.atan2(b.x - a.x, b.y - a.y) * R2D);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const hdgVec = (h) => ({ x: Math.sin(h * D2R), y: Math.cos(h * D2R) });

/** seeded PRNG so a mission replays identically */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** RCSValues from systems/sensors. Names are case-insensitive; a bare number is already m². */
const RCS_CLASS = {
  verytiny: 0.001, tiny: 0.01, verysmall: 0.1, small: 1, semismall: 10,
  meager: 50, medium: 100, semilarge: 1000, large: 10000, verylarge: 100000,
};
export function rcsToM2(v, fallback = 100) {
  if (v == null || v === '') return fallback;
  const key = String(v).toLowerCase().replace(/[\s_-]/g, '');
  if (key in RCS_CLASS) return RCS_CLASS[key];
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * SensorData broadside RCS, and the bow/stern value. FrontalArea / SideArea replaces the
 * 0.5 frontal-to-broadside factor when both areas are authored.
 */
export function rcsExtents(value, frontal, side, fallback = 100) {
  const rcs = rcsToM2(value, fallback);
  const f = Number(frontal), s = Number(side);
  const frac = f > 0 && s > 0 ? Math.min(1, Math.max(0.02, f / s)) : 0.5;
  return { rcs, rcsMin: frac * rcs };
}

/** Radio horizon (m) between antenna heights h1,h2 (m) with 4/3-earth refraction. */
export const radioHorizon = (h1, h2) => 4120 * (Math.sqrt(Math.max(h1, 0)) + Math.sqrt(Math.max(h2, 0)));

/** Geometric horizon (m). getRadarHorizon(..., visual: true) uses the true earth radius, not 4/3. */
const VISUAL_K = Math.sqrt(12742.018 / 1000) * 14.880938 * (1852 / 27.559496);
export const visualHorizon = (h1, h2) => VISUAL_K * (Math.sqrt(Math.max(h1, 0)) + Math.sqrt(Math.max(h2, 0)));
