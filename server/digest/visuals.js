// Visuals per pillar (execution guide §6/§7), drawn as SVG/HTML from the card's visual spec.
// The same markup is used on the full web card and, rendered to PNG, at the top of the Chat card.
import { DAY_INFO } from './defaults.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function wrap(text, max) {
  const lines = [];
  let line = '';
  for (const w of String(text ?? '').split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + w).length > max) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

// Shared design (colors and styles from the team's digest template).
export const BASE_CSS = `
  :root {
    color-scheme: light dark;
    --paper: #F3F3FA; --card: #FFFFFF; --ink: #171936; --muted: #575B7D; --line: #D9DBEC;
    ${Object.entries(DAY_INFO).map(([d, i]) => `--${d}: ${i.color}; --${d}-t: ${i.tint};`).join(' ')}
    --good: #188A5E; --bad: #D93F4C;
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    --sans: "Avenir Next", "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not(.light) {
      --paper: #0E0F23; --card: #171936; --ink: #ECEDFB; --muted: #A5A9CF; --line: #2A2D58;
      ${Object.entries(DAY_INFO).map(([d, i]) => `--${d}: ${i.dark}; --${d}-t: ${i.darkTint};`).join(' ')}
      --good: #4CCB9A; --bad: #FF7A85;
    }
  }
  ${Object.keys(DAY_INFO).map((d) => `.d-${d} { --accent: var(--${d}); --tint: var(--${d}-t); } .t-${d} { --tabcol: var(--${d}); --tabtint: var(--${d}-t); }`).join('\n  ')}
  figure.visual { margin: 0 0 8px; background: var(--tint); border-radius: 10px; padding: 14px 14px 10px; }
  figure.visual svg { width: 100%; height: auto; display: block; }
  figure.visual figcaption { font-size: 13.5px; color: var(--muted); padding: 8px 4px 2px; max-width: 75ch; }
  svg text { font-family: var(--sans); fill: var(--ink); }
  svg .mut { fill: var(--muted); }
  svg .ax { stroke: var(--muted); stroke-width: 1.2; fill: none; }
  svg .grid { stroke: var(--line); stroke-width: 1; }
  svg .curve-new { stroke: var(--accent); stroke-width: 3; fill: none; }
  svg .curve-old { stroke: var(--muted); stroke-width: 3; fill: none; }
  svg .node { fill: var(--card); stroke: var(--accent); stroke-width: 2; }
  svg .arrow { stroke: var(--ink); stroke-width: 2; fill: none; }
  svg .loop { stroke: var(--bad); stroke-width: 2.4; fill: none; stroke-dasharray: 6 4; }
  svg .flag { fill: var(--bad); }
  svg .layer-top { fill: var(--card); stroke: var(--accent); stroke-width: 3; }
  svg .layer-bot { fill: var(--card); stroke: var(--muted); stroke-width: 2; stroke-dasharray: 6 4; }
  svg .chip { fill: var(--tint); stroke: var(--accent); stroke-width: 1.5; }
  .flow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0 4px; padding: 8px 4px 2px; }
  .flow .box { background: var(--card); border: 1.5px solid var(--accent); border-radius: 8px; padding: 8px 12px; font-size: 14px; font-weight: 600; color: var(--ink); font-family: var(--sans); }
  .flow .arr { color: var(--muted); font-size: 18px; }
`;

const MARKERS = `<defs>
  <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--ink)"/></marker>
  <marker id="ahr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--bad)"/></marker>
</defs>`;

/** Monday: annotated chart (line or step), e.g. survival curves explaining OS, PFS and hazard ratio. */
export function chartSvg(v) {
  const series = (v.series || []).filter((s) => (s.points || []).length >= 2);
  if (!series.length) return '';
  const all = series.flatMap((s) => s.points);
  const [x0, x1] = [Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.x))];
  const yMax = Math.max(...all.map((p) => p.y));
  const yMin = Math.min(0, ...all.map((p) => p.y));
  const L = 64, R = 612, T = 24, B = 252;
  const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (R - L);
  const Y = (y) => B - ((y - yMin) / (yMax - yMin || 1)) * (B - T);
  const fmt = (n) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
  const path = (pts) => pts.sort((a, b) => a.x - b.x).map((p, i) => (i === 0 ? `M${X(p.x)},${Y(p.y)}` : v.style === 'step' ? ` H${X(p.x)} V${Y(p.y)}` : ` L${X(p.x)},${Y(p.y)}`)).join('');
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const y = yMin + ((yMax - yMin) * i) / 4;
    out += `<line class="grid" x1="${L}" x2="${R}" y1="${Y(y)}" y2="${Y(y)}"/><text x="${L - 8}" y="${Y(y) + 4}" text-anchor="end" font-size="12" class="mut">${fmt(y)}</text>`;
    const x = x0 + ((x1 - x0) * i) / 4;
    out += `<text x="${X(x)}" y="${B + 18}" text-anchor="middle" font-size="12" class="mut">${fmt(x)}</text>`;
  }
  out += `<text x="${(L + R) / 2}" y="${B + 38}" text-anchor="middle" font-size="12.5" class="mut">${esc(v.x_label)}</text>`;
  out += `<text x="14" y="${(T + B) / 2}" text-anchor="middle" font-size="12.5" class="mut" transform="rotate(-90 14 ${(T + B) / 2})">${esc(v.y_label)}</text>`;
  out += `<line class="ax" x1="${L}" x2="${L}" y1="${T}" y2="${B}"/><line class="ax" x1="${L}" x2="${R}" y1="${B}" y2="${B}"/>`;
  for (const s of [...series].sort((a, b) => a.highlight - b.highlight)) {
    out += `<path class="${s.highlight ? 'curve-new' : 'curve-old'}" d="${path([...s.points])}"/>`;
    const last = [...s.points].sort((a, b) => a.x - b.x).at(-1);
    out += `<text x="${X(last.x) - 4}" y="${Y(last.y) - 8}" text-anchor="end" font-size="14" font-weight="700" ${s.highlight ? 'style="fill:var(--accent)"' : 'class="mut"'}>${esc(s.label)}</text>`;
  }
  (v.annotations || []).slice(0, 3).forEach((a, i) => {
    out += `<text x="${L + 12}" y="${T + 18 + i * 18}" font-size="13" font-weight="${i === 0 ? 700 : 400}" ${i ? 'class="mut"' : ''}>${esc(a)}</text>`;
  });
  return `<svg viewBox="0 0 640 310" role="img" aria-label="${esc(v.title)}">${out}</svg>`;
}

/** Tuesday: the buyer's workflow with friction points and a rework loop. */
export function workflowSvg(v) {
  const steps = (v.steps || []).slice(0, 5);
  if (!steps.length) return '';
  const gap = 48;
  const w = Math.min(150, (660 - gap * (steps.length - 1)) / steps.length);
  const x = (i) => 10 + i * (w + gap);
  let out = MARKERS;
  steps.forEach((s, i) => {
    out += `<rect class="node" x="${x(i)}" y="78" width="${w}" height="54" rx="10"/>`;
    const lines = wrap(s.label, Math.floor(w / 8.5)).slice(0, 2);
    lines.forEach((l, j) => { out += `<text x="${x(i) + w / 2}" y="${(s.detail ? 100 : 110 - (lines.length - 1) * 8) + j * 16}" text-anchor="middle" font-size="15" font-weight="600">${esc(l)}</text>`; });
    if (s.detail) out += `<text x="${x(i) + w / 2}" y="122" text-anchor="middle" font-size="${s.detail.length > w / 6.2 ? 10 : 11.5}" class="mut">${esc(s.detail.length > w / 4.8 ? `${s.detail.slice(0, Math.floor(w / 4.8) - 1)}…` : s.detail)}</text>`;
    if (i < steps.length - 1) out += `<path class="arrow" d="M${x(i) + w + 2},105 H${x(i + 1) - 4}" marker-end="url(#ah)"/>`;
  });
  if (v.loop_from >= 0 && v.loop_to >= 0 && v.loop_from < steps.length && v.loop_to < steps.length && v.loop_from !== v.loop_to) {
    const a = x(v.loop_from) + w / 2;
    const b = x(v.loop_to) + w / 2;
    out += `<path class="loop" d="M${a},76 C${a},32 ${b},32 ${b},74" marker-end="url(#ahr)"/>`;
    if (v.loop_label) out += `<text x="${(a + b) / 2}" y="16" text-anchor="middle" font-size="13" font-weight="600" style="fill:var(--bad)">${esc(v.loop_label)}</text>`;
  }
  for (const f of (v.friction || []).slice(0, 3)) {
    if (f.step < 0 || f.step >= steps.length) continue;
    const cx = x(f.step) + w / 2;
    out += `<circle class="flag" cx="${cx}" cy="150" r="6"/>`;
    wrap(f.text, Math.max(16, Math.floor(w / 7.5))).forEach((l, j) => { out += `<text x="${cx}" y="${172 + j * 16}" text-anchor="middle" font-size="12.5">${esc(l)}</text>`; });
  }
  return `<svg viewBox="0 0 680 222" role="img" aria-label="Workflow: ${esc(steps.map((s) => s.label).join(', '))}">${out}</svg>`;
}

/** Wednesday: where we sit relative to the competitor's tool. */
export function layersSvg(v) {
  let out = MARKERS.replace(/id="ah"/, 'id="ah2"');
  out += `<rect class="layer-top" x="20" y="14" width="640" height="106" rx="14"/>`;
  out += `<text x="40" y="44" font-size="19" font-weight="700" style="font-family:var(--serif)">${esc(v.top_title)}</text>`;
  let cx = 40;
  for (const chip of (v.chips || []).slice(0, 6)) {
    const cw = Math.max(80, String(chip).length * 7.4 + 26);
    if (cx + cw > 646) break;
    out += `<rect class="chip" x="${cx}" y="62" width="${cw}" height="34" rx="17"/><text x="${cx + cw / 2}" y="84" text-anchor="middle" font-size="13">${esc(chip)}</text>`;
    cx += cw + 10;
  }
  out += `<path class="arrow" d="M340,124 V158" marker-end="url(#ah2)"/>`;
  if (v.link_label) out += `<text x="352" y="146" font-size="13" class="mut">${esc(v.link_label)}</text>`;
  out += `<rect class="layer-bot" x="20" y="164" width="640" height="52" rx="14"/><text x="40" y="195" font-size="16" font-weight="600">${esc(v.bottom_title)}</text>`;
  return `<svg viewBox="0 0 680 230" role="img" aria-label="${esc(`${v.top_title}, above ${v.bottom_title}`)}">${out}</svg>`;
}

/** Thursday: the use-case flow. */
export function flowHtml(v) {
  return `<div class="flow">${(v.chips || []).map((c) => `<span class="box">${esc(c)}</span>`).join('<span class="arr" aria-hidden="true">&rarr;</span>')}</div>`;
}

/** The figure for a day's card (Friday's stat tiles are part of the page body instead). */
export function visualFigure(day, card) {
  const v = card.visual;
  if (!v) return '';
  const body = { mon: chartSvg, tue: workflowSvg, wed: layersSvg, thu: flowHtml }[day]?.(v) || '';
  if (!body) return '';
  const caption = day === 'mon' && v.illustrative ? `Illustrative, not real data. ${v.caption || ''}` : v.caption || '';
  return `<figure class="visual">${body}${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`;
}

export function visualDocument(day, card) {
  const fig = visualFigure(day, card);
  if (!fig) return null;
  return `<!DOCTYPE html><html class="light"><head><meta charset="utf-8"><style>${BASE_CSS}
    body { margin: 0; background: transparent; font-family: var(--sans); } .d-${day} { width: 680px; padding: 0; }</style></head>
    <body><div class="d-${day}">${fig}</div></body></html>`;
}

/**
 * PNG of the visual for the top of the Chat card. Uses playwright-core with a local Chromium
 * (DIGEST_CHROMIUM_PATH) when installed; returns null otherwise so cards go out without an image.
 */
export async function renderVisualPng(day, card) {
  const html = visualDocument(day, card);
  if (!html) return null;
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { return null; }
  const browser = await chromium.launch({ executablePath: process.env.DIGEST_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 600 }, deviceScaleFactor: 2 });
    await page.setContent(html);
    return await (await page.$('figure')).screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}
