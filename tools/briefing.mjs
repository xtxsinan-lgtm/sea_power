// Follows a mission's Free Content window chain (OpenFileCommand) and keeps the
// English page text plus Back / Next / ExecuteTriggerCommand buttons.
import fs from 'node:fs';
import path from 'node:path';

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n');

export function extractBriefing(srcRoot, startRel) {
  const map = new Map();
  const order = [];
  function load(rel) {
    rel = String(rel || '').replace(/\\/g, '/');
    if (!rel || map.has(rel)) return;
    const file = path.join(srcRoot, rel);
    if (!fs.existsSync(file)) return;
    const xml = fs.readFileSync(file, 'utf8');
    const texts = [...xml.matchAll(/<Run\b[^>]*\bText="([^"]*)"/g)].map((m) => decode(m[1]));
    const buttons = [];
    for (const chunk of xml.split('<Button').slice(1)) {
      const content = /Content="([^"]*)"/.exec(chunk)?.[1] || 'Next';
      const open = /OpenFileCommand\}"\s+CommandParameter="([^"]+)"/.exec(chunk)?.[1] || '';
      const trigger = /ExecuteTriggerCommand\}"\s+CommandParameter="([^"]+)"/.exec(chunk)?.[1] || '';
      buttons.push({ content, open: open.replace(/\\/g, '/'), trigger });
    }
    map.set(rel, { file: rel, text: texts.join('\n\n'), buttons });
    order.push(rel);
    for (const b of buttons) if (b.open) load(b.open);
  }
  load(startRel);
  return order.map((id) => map.get(id));
}
