// Source collection for the daily digest (execution guide §4). Every item gets a stable source id
// (gong:…, drive:…, sfdc:…, web:…, clip:…) that cards must cite; the catalog maps ids to links.
import { MODEL } from '../coach.js';
import { addDays } from '../engagement.js';
import { parseServiceAccount, serviceAccountToken } from '../integrations/google.js';
import { DRIVE_CATEGORIES, sizeBand } from './defaults.js';

const safeUrl = (u) => (/^https:\/\//i.test(String(u ?? '')) ? String(u) : null);
const DOC_CHARS = 12_000;

// ---------- Gong ----------

async function gongPage(cfg, body) {
  const res = await fetch(`${cfg.base}/v2/calls/extensive`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.accessKey}:${cfg.secret}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 404) return { calls: [] }; // no calls match the filter
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gong ${res.status}: ${data.errors?.join('; ') || data.message || 'request failed'}`);
  return data;
}

/**
 * External calls from the last 14 days. The last 7 days feed the cards (briefs, key points, highlights:
 * what prospects actually say); tracker hits are counted per week so the plan can follow the trend.
 */
export async function fetchGong(cfg, now) {
  const since = new Date(now.getTime() - 14 * 864e5);
  const split = now.getTime() - 7 * 864e5;
  const calls = [];
  const trackers = { current: {}, previous: {} };
  let cursor;
  let seen = 0;
  do {
    const data = await gongPage(cfg, {
      filter: { fromDateTime: since.toISOString(), toDateTime: now.toISOString(), ...(cfg.workspaceId ? { workspaceId: cfg.workspaceId } : {}) },
      contentSelector: { exposedFields: { content: { brief: true, keyPoints: true, highlights: true, callOutcome: true, trackers: true } } },
      ...(cursor ? { cursor } : {}),
    });
    for (const c of data.calls || []) {
      seen++;
      const m = c.metaData || {};
      if (m.scope && m.scope !== 'External') continue;
      const content = c.content || {};
      const recent = new Date(m.started || now).getTime() >= split;
      const bucket = recent ? trackers.current : trackers.previous;
      for (const t of content.trackers || []) if (t.count > 0) bucket[t.name] = (bucket[t.name] || 0) + t.count;
      if (!recent || (!content.brief && !content.keyPoints?.length)) continue;
      calls.push({
        id: `gong:${m.id}`,
        title: m.title || 'Customer call',
        url: safeUrl(m.url),
        minutes: Math.round((m.duration || 0) / 60),
        outcome: content.callOutcome?.name || null,
        brief: content.brief || '',
        keyPoints: (content.keyPoints || []).map((k) => k.text).filter(Boolean),
        highlights: (content.highlights || []).flatMap((h) => (h.items || []).map((i) => `${h.title}: ${i.text}`)),
        trackers: (content.trackers || []).filter((t) => t.count > 0).map((t) => t.name),
      });
    }
    cursor = data.records?.cursor;
  } while (cursor && seen < cfg.maxCalls);
  // The longest conversations usually carry the richest material; 15 keeps the prompt focused.
  return { calls: calls.sort((a, b) => b.minutes - a.minutes).slice(0, 15), trackers };
}

/** Trackers whose hits rose week over week, biggest rise first. */
export function trendingTrackers(trackers, names) {
  const wanted = names.length ? new Map(names.map((n) => [n.toLowerCase(), n])) : null;
  const all = new Set([...Object.keys(trackers.current), ...Object.keys(trackers.previous)]);
  return [...all]
    .filter((t) => !wanted || wanted.has(t.toLowerCase()))
    .map((name) => ({ name, current: trackers.current[name] || 0, previous: trackers.previous[name] || 0 }))
    .sort((a, b) => (b.current - b.previous) - (a.current - a.previous) || b.current - a.current);
}

// ---------- Google Drive: the Approved library ----------

const FOLDER = 'application/vnd.google-apps.folder';
const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

export function categoryOf(name) {
  return DRIVE_CATEGORIES.find(([, re]) => re.test(name))?.[0] || 'other';
}

/** "Last reviewed: 2026-09-01" in the description, or a lastReviewed file property. */
export function reviewedDate(file) {
  const prop = file.properties?.lastReviewed || file.appProperties?.lastReviewed;
  if (prop && /^\d{4}-\d{2}-\d{2}/.test(prop)) return prop.slice(0, 10);
  return String(file.description || '').match(/reviewed\s*(?:on)?\s*:?\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || null;
}

async function listChildren(cfg, headers, folderId) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink,description,properties,owners(displayName,emailAddress))',
      pageSize: '100', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`${cfg.apiBase}/files?${params}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Drive ${res.status}: ${data.error?.message || 'list failed'}`);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

/**
 * Only files in the Approved folder (and its subfolders, one level) are eligible. Each must carry an owner
 * and a last-reviewed date; files without one, or reviewed too long ago, drop out (guide §4 and §10).
 */
export async function fetchApprovedLibrary(cfg, now) {
  if (!/^[\w-]+$/.test(cfg.approvedFolderId)) throw new Error('Invalid GOOGLE_DRIVE_APPROVED_FOLDER_ID');
  const sa = parseServiceAccount(cfg.serviceAccount, 'GOOGLE_DRIVE_SERVICE_ACCOUNT');
  const headers = { Authorization: `Bearer ${await serviceAccountToken(sa, 'https://www.googleapis.com/auth/drive.readonly', cfg.tokenUrl)}` };
  const top = await listChildren(cfg, headers, cfg.approvedFolderId);
  const candidates = [];
  for (const f of top) {
    if (f.mimeType === FOLDER) {
      const category = categoryOf(f.name);
      for (const child of await listChildren(cfg, headers, f.id)) if (child.mimeType !== FOLDER) candidates.push({ ...child, category });
    } else {
      candidates.push({ ...f, category: categoryOf(f.name) });
    }
  }
  const cutoff = addDays(now.toISOString().slice(0, 10), -cfg.maxReviewAgeDays);
  const docs = [];
  const skipped = [];
  for (const f of candidates) {
    const reviewed = reviewedDate(f);
    const owner = f.properties?.owner || f.owners?.[0]?.displayName || f.owners?.[0]?.emailAddress || null;
    if (!reviewed) { skipped.push({ title: f.name, reason: 'no last-reviewed date' }); continue; }
    if (reviewed < cutoff) { skipped.push({ title: f.name, reason: `review expired (${reviewed})` }); continue; }
    if (!owner) { skipped.push({ title: f.name, reason: 'no owner' }); continue; }
    let text = '';
    const exportType = EXPORTS[f.mimeType];
    if (exportType || /^text\//.test(f.mimeType || '')) {
      const url = exportType
        ? `${cfg.apiBase}/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(exportType)}`
        : `${cfg.apiBase}/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`;
      const r = await fetch(url, { headers });
      if (r.ok) text = await r.text();
    }
    if (!text.trim()) { skipped.push({ title: f.name, reason: 'no readable text (use a Google Doc, Slides, Sheet or text file)' }); continue; }
    docs.push({
      id: `drive:${f.id}`, type: 'drive', title: f.name, url: safeUrl(f.webViewLink), category: f.category, owner, reviewed,
      // Long docs are cut to keep the prompt bounded; the model is told when that happens.
      text: text.length > DOC_CHARS ? `${text.slice(0, DOC_CHARS)}\n[document continues; truncated]` : text,
    });
  }
  return { docs, skipped };
}

// ---------- Salesforce / HubSpot win and loss (from the synced crm_deals table) ----------

/**
 * Closed deals, anonymized: segment, size band, reason, competitor and use case, never the account or deal name.
 * With fewer than `minDeals` closed in the last 7 days, widens to 28 days and groups by segment (guide §4).
 */
export function fetchWinLoss(db, now, minDeals) {
  const today = now.toISOString().slice(0, 10);
  const query = (days) => db.prepare(`SELECT external_id, amount, close_date, is_won, reason, competitor, segment, use_case
    FROM crm_deals WHERE is_closed = 1 AND close_date > ? AND close_date <= ? ORDER BY close_date DESC`).all(addDays(today, -days), today);
  let deals = query(7);
  let grouped = false;
  if (deals.length < minDeals) { deals = query(28); grouped = true; }
  const items = [];
  if (!grouped) {
    for (const d of deals.slice(0, 6)) {
      items.push({
        id: `sfdc:${d.external_id}`, type: 'sfdc', title: `${d.is_won ? 'Closed won' : 'Closed lost'}: ${d.segment || 'segment not set'}, ${sizeBand(d.amount)}`,
        outcome: d.is_won ? 'won' : 'lost', segment: d.segment, band: sizeBand(d.amount), reason: d.reason, competitor: d.competitor, useCase: d.use_case,
      });
    }
  } else if (deals.length) {
    const bySegment = new Map();
    for (const d of deals) {
      const key = d.segment || 'Segment not set';
      const g = bySegment.get(key) || { won: 0, lost: 0, reasons: {}, competitors: {} };
      d.is_won ? g.won++ : g.lost++;
      if (d.reason) g.reasons[d.reason] = (g.reasons[d.reason] || 0) + 1;
      if (d.competitor) g.competitors[d.competitor] = (g.competitors[d.competitor] || 0) + 1;
      bySegment.set(key, g);
    }
    let i = 0;
    for (const [segment, g] of bySegment) {
      const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`);
      items.push({
        id: `sfdc:segment-${++i}`, type: 'sfdc', title: `Last 4 weeks, ${segment}: ${g.won} won, ${g.lost} lost`,
        outcome: 'summary', segment, won: g.won, lost: g.lost, reasons: top(g.reasons), competitors: top(g.competitors),
      });
    }
  }
  return { items, grouped, total: deals.length };
}

// ---------- Web: a short, human-picked list of sources ----------

/**
 * Claude searches the allowed news domains and reads the fixed pages (e.g. the product what's-new page).
 * Notes come back with inline [web:N] ids taken from the citations, so cards can cite them.
 */
export async function researchWeb(anthropic, cfg, { focus, personas, now }) {
  const tools = [];
  if (cfg.domains.length) tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 8, allowed_domains: cfg.domains });
  if (cfg.pages.length) tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: cfg.pages.length + 2 });
  if (!tools.length) return { notes: '', sources: [] };
  const today = now.toISOString().slice(0, 10);
  let messages = [{
    role: 'user',
    content: `Today is ${today}. Research material for next week's sales enablement digest. Our buyers: ${personas.join(', ')}.
${focus ? `This week's market focus: ${focus}.\n` : ''}${cfg.domains.length ? `
1. Search for market news from the last 14 days that our buyers will be talking about, and for congresses or industry events in the next 6 weeks (name, dates, location). Use only the search tool's allowed sites.` : ''}${cfg.pages.length ? `
2. Read each of these pages and list what is new, with release dates:
${cfg.pages.map((p) => `- ${p}`).join('\n')}` : ''}

Write plain factual notes, a few sentences per item. Only include facts from the pages you read.`,
  }];
  let response;
  for (let turn = 0; turn < 5; turn++) {
    response = await anthropic.beta.messages.create({
      model: MODEL, max_tokens: 16000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low' }, tools, messages,
    });
    if (response.stop_reason !== 'pause_turn') break;
    messages = [...messages, { role: 'assistant', content: response.content }]; // long research pauses; resume it
  }
  if (response.stop_reason === 'refusal') throw new Error('web research was declined');
  const byUrl = new Map();
  const idFor = (url, title) => {
    const safe = safeUrl(url);
    if (!safe) return null;
    if (!byUrl.has(safe)) byUrl.set(safe, { id: `web:${byUrl.size + 1}`, type: 'web', title: title || safe, url: safe });
    return byUrl.get(safe).id;
  };
  let notes = '';
  for (const block of response.content) {
    if (block.type !== 'text') continue;
    const ids = [...new Set((block.citations || []).map((c) => idFor(c.url, c.title)).filter(Boolean))];
    notes += block.text + (ids.length ? ` [${ids.join(', ')}]` : '');
  }
  return { notes: notes.trim(), sources: [...byUrl.values()] };
}

// ---------- Clip of the week (manager-approved only) ----------

export function nextApprovedClip(db, weekId) {
  const clip = db.prepare(`SELECT * FROM digest_clips WHERE approved_by IS NOT NULL AND (used_week_id IS NULL OR used_week_id = ?)
    ORDER BY (used_week_id = ?) DESC, id DESC LIMIT 1`).get(weekId, weekId);
  return clip ? { id: `clip:${clip.id}`, type: 'clip', clipId: clip.id, title: clip.title, url: safeUrl(clip.url), why: clip.why_it_works, skill: clip.skill } : null;
}
