// ============================================================================
// IniParser — Sea Power's .ini dialect → { SectionName: { Key: "value" } }.
// Dialect: `[Section] #comment`, `Key=Value // comment`, full-line `#`/`;`/`//`
// comments. Sections may repeat (later keys win). Pure JS; used by both the
// Node converter (tools/convert_data.mjs) and the browser.
// ============================================================================

/** @param {string} text @returns {Record<string, Record<string,string>>} */
export function parseIni(text) {
  const out = {};
  let cur = (out['__root'] = {});
  for (let raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';' || line.startsWith('//')) continue;
    if (line[0] === '[') {
      const end = line.indexOf(']');
      if (end < 0) continue;
      const name = line.slice(1, end).trim();
      if (name.startsWith('---')) continue; // decorative "[---------- AI ----------]"
      cur = out[name] || (out[name] = {});
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1);
    const c = val.indexOf('//');
    if (c >= 0) val = val.slice(0, c);
    const h = val.indexOf(' #');
    if (h >= 0) val = val.slice(0, h);
    cur[key] = val.trim();
  }
  if (!Object.keys(out['__root']).length) delete out['__root'];
  return out;
}

export const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
export const bool = (v, d = false) => (v == null ? d : /^(true|1|yes)$/i.test(String(v).trim()));
export const csv = (v) => (v == null || v === '' ? [] : String(v).split(',').map((s) => s.trim()));
export const csvNum = (v) => csv(v).map((s) => parseFloat(s));
