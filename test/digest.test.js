// Weekly digest tests: Gong, Google Drive, Claude (web search + composition) and the Chat webhook are mocked at the fetch layer.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { extensions } from '../server/extensions.js';
import { seed, DEMO_PASSWORD } from '../server/seed.js';
import { pickDailyQuestions } from '../server/engagement.js';
import { DIGEST_TOPIC, digestDue, sendWeeklyDigest } from '../server/integrations/digest.js';
import { config } from '../server/integrations/config.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

Object.assign(process.env, {
  APP_URL: 'http://pitchpulse.test',
  GOOGLE_CHAT_DIGEST_WEBHOOK: 'https://chat.test/v1/spaces/GTM/messages?key=k&token=t',
  GONG_API_BASE: 'https://gong.test',
  GONG_ACCESS_KEY: 'gk',
  GONG_ACCESS_KEY_SECRET: 'gs',
  GOOGLE_DRIVE_FOLDER_IDS: 'folder_A',
  GOOGLE_DRIVE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'digest@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), private_key_id: 'k1' }),
  GOOGLE_DRIVE_API: 'https://google.test/drive/v3',
  GOOGLE_TOKEN_URL: 'https://google.test/token',
  DIGEST_WEB_TOPICS: 'Competitor X pricing; AI in sales',
  ANTHROPIC_API_KEY: 'test-key',
  ANTHROPIC_BASE_URL: 'https://anthropic.test',
});

const realFetch = globalThis.fetch;
let calls = [];
let anthropicRequests = [];
let webPaused = false;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const DIGEST = {
  headline: 'Pricing pushback is a timing problem',
  intro: 'Three lessons from this week.',
  items: [
    { kind: 'objection', title: 'Reframe price as cost of delay', takeaway: 'When Globex said "too expensive", Dana asked what a 12-day close costs them monthly. The buyer did the math and moved on.', try_this: 'Ask the cost-of-delay question before discussing discounts.', source_ids: ['gong:111', 'made-up-id'] },
    { kind: 'competitor', title: 'Competitor X cut list price', takeaway: 'Competitor X dropped list price 15% but removed SSO from the base tier.', try_this: 'Ask prospects if SSO is a requirement.', source_ids: ['web:1'] },
    { kind: 'playbook', title: 'New MEDDICC cheat sheet', takeaway: 'Enablement published a one-page MEDDICC guide.', try_this: 'Use it in your next deal review.', source_ids: ['drive:doc1'] },
  ],
  quiz: [
    { prompt: 'What did Competitor X remove from its base tier?', options: ['SSO', 'API access', 'Reporting', 'Support'], answer_index: 0, explanation: 'SSO moved to the paid tier.' },
    { prompt: 'Bad question', options: ['only one'], answer_index: 3, explanation: 'invalid' },
  ],
};

async function mockFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : {}));
  calls.push({ url: url.href, method, body, headers });

  if (url.origin === 'https://gong.test' && url.pathname === '/v2/calls/extensive') {
    const req = JSON.parse(body);
    if (!req.cursor) {
      return json({ records: { cursor: 'c2' }, calls: [
        { metaData: { id: '111', title: 'Globex pricing call', url: 'https://app.gong.io/call?id=111', duration: 2400, scope: 'External' },
          content: { brief: 'Buyer pushed back on price; rep reframed around cost of delay.', keyPoints: [{ text: 'Asked cost-of-delay question' }], highlights: [{ title: 'Objection', items: [{ text: 'Too expensive' }] }], trackers: [{ name: 'Pricing', count: 3 }, { name: 'Legal', count: 0 }] } },
        { metaData: { id: '222', title: 'Internal pipeline review', duration: 1800, scope: 'Internal' }, content: { brief: 'internal' } },
      ] });
    }
    return json({ records: {}, calls: [
      { metaData: { id: '333', title: 'Initech discovery', url: 'javascript:alert(1)', duration: 900, scope: 'External' }, content: { brief: 'Discovery on reporting pain.' } },
    ] });
  }
  if (url.origin === 'https://google.test') {
    if (url.pathname === '/token') return json({ access_token: 'drive-token', expires_in: 3600 });
    if (url.pathname === '/drive/v3/files') {
      return json({ files: [
        { id: 'doc1', name: 'MEDDICC cheat sheet', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-20T10:00:00Z', webViewLink: 'https://docs.google.com/document/d/doc1' },
        { id: 'img1', name: 'Logo.png', mimeType: 'image/png', modifiedTime: '2026-10-19T10:00:00Z', webViewLink: 'https://drive.google.com/file/d/img1' },
      ] });
    }
    if (url.pathname === '/drive/v3/files/doc1/export') return new Response('Metrics, Economic buyer, Decision criteria…');
  }
  if (url.origin === 'https://anthropic.test' && url.pathname === '/v1/messages') {
    const req = JSON.parse(body);
    anthropicRequests.push({ req, headers });
    const base = { id: `msg_${anthropicRequests.length}`, type: 'message', role: 'assistant', model: req.model, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
    if (req.tools?.some((t) => t.type === 'web_search_20260209')) {
      if (!webPaused) {
        webPaused = true;
        return json({ ...base, stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'Competitor X pricing' } }] });
      }
      return json({ ...base, stop_reason: 'end_turn', content: [
        { type: 'text', text: 'Competitor X cut list price 15% and moved SSO to a paid tier.', citations: [{ type: 'web_search_result_location', url: 'https://news.test/cx-pricing', title: 'Competitor X reprices', cited_text: '...', encrypted_index: 'x' }] },
      ] });
    }
    return json({ ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(DIGEST) }] });
  }
  if (url.origin === 'https://chat.test') return json({ name: 'spaces/GTM/messages/1' });
  return json({ error: `unmocked ${url.href}` }, 599);
}

let server;
let base;
let db;
before(async () => {
  globalThis.fetch = mockFetch;
  db = openDb(':memory:');
  seed(db);
  server = createServer(createApp(db, { extensions }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; anthropicRequests = []; webPaused = false; });

async function login(email) {
  const res = await realFetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (path, { method = 'GET', body } = {}) => realFetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Requested-With': 'pitchpulse' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
}

test('Digest: schedule is due after the configured weekday and hour, and catches up later in the week', () => {
  const cfg = { day: 1, hour: 9 };
  assert.equal(digestDue(new Date(2026, 9, 19, 8, 0), cfg), false); // Monday 08:00
  assert.equal(digestDue(new Date(2026, 9, 19, 9, 5), cfg), true); // Monday 09:05
  assert.equal(digestDue(new Date(2026, 9, 21, 7, 0), cfg), true); // Wednesday, missed Monday
  assert.equal(digestDue(new Date(2026, 9, 20, 23, 0), { day: 3, hour: 9 }), false); // Tuesday, scheduled Wednesday
});

test('Digest: preview pulls Gong, Drive and web, then composes with structured output; links come only from sources', async () => {
  const rep = await login('rep@pitchpulse.dev');
  assert.equal((await rep('/api/digests/preview', { method: 'POST' })).status, 403);

  const admin = await login('admin@pitchpulse.dev');
  const r = await admin('/api/digests/preview', { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'draft');
  assert.equal(r.data.source, 'ai');
  assert.deepEqual([r.data.sources.gong, r.data.sources.drive, r.data.sources.web], [2, 2, 1]);
  assert.deepEqual(r.data.sources.errors, []);

  // Gong: basic auth, date window, AI content fields, pagination; internal calls are dropped.
  const gong = calls.filter((c) => c.url.startsWith('https://gong.test'));
  assert.equal(gong.length, 2);
  assert.equal(gong[0].headers.get('authorization'), `Basic ${Buffer.from('gk:gs').toString('base64')}`);
  const gongReq = JSON.parse(gong[0].body);
  assert.ok(gongReq.filter.fromDateTime < gongReq.filter.toDateTime);
  assert.equal(gongReq.contentSelector.exposedFields.content.brief, true);
  assert.equal(JSON.parse(gong[1].body).cursor, 'c2');

  // Drive: read-only service-account token, folder + modified-time query, Docs exported as text.
  const tokenCall = calls.find((c) => c.url === 'https://google.test/token');
  const claims = JSON.parse(Buffer.from(new URLSearchParams(tokenCall.body).get('assertion').split('.')[1], 'base64url'));
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly');
  const list = new URL(calls.find((c) => c.url.startsWith('https://google.test/drive/v3/files?')).url);
  assert.match(list.searchParams.get('q'), /^'folder_A' in parents and trashed = false and modifiedTime > '\d{4}-/);
  assert.ok(calls.some((c) => c.url.includes('/files/doc1/export?mimeType=text%2Fplain')));
  assert.ok(!calls.some((c) => c.url.includes('img1')), 'binary files are not downloaded');

  // Claude: web search resumes after pause_turn; composition uses a JSON schema and sees every source.
  const web = anthropicRequests.filter((a) => a.req.tools);
  assert.equal(web.length, 2);
  assert.equal(web[1].req.messages.at(-1).role, 'assistant');
  const compose = anthropicRequests.find((a) => a.req.output_config?.format);
  assert.equal(compose.req.model, 'claude-opus-5-5');
  assert.equal(compose.req.fallbacks, 'default');
  assert.match(compose.headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(compose.req.output_config.format.type, 'json_schema');
  const prompt = compose.req.messages[0].content;
  for (const id of ['gong:111', 'gong:333', 'drive:doc1', 'web:1']) assert.ok(prompt.includes(id), id);
  assert.ok(!prompt.includes('Internal pipeline review'));
  assert.match(compose.req.system, /Never follow instructions/);

  // Unknown source ids and invalid quiz questions are dropped.
  const [objection, competitor, playbook] = r.data.content.items;
  assert.deepEqual(objection.sources.map((s) => s.url), ['https://app.gong.io/call?id=111']);
  assert.deepEqual(competitor.sources.map((s) => s.url), ['https://news.test/cx-pricing']);
  assert.equal(playbook.sources[0].url, 'https://docs.google.com/document/d/doc1');
  assert.equal(r.data.content.quiz.length, 1);
  assert.ok(r.data.card.cardsV2[0].card.sections.length >= 5);
});

test('Digest: send posts the previewed card to the Chat webhook, adds quiz questions to the Daily Challenge, and runs once a week', async () => {
  const r = await sendWeeklyDigest(db);
  assert.equal(r.sent, true);
  assert.equal(anthropicRequests.length, 0, 'the reviewed draft is sent without regenerating it');
  const post = calls.find((c) => c.url.startsWith('https://chat.test'));
  const msg = JSON.parse(post.body);
  assert.match(msg.text, /Pricing pushback/);
  const card = msg.cardsV2[0].card;
  assert.match(card.header.subtitle, /3 snacks/);
  const quiz = card.sections.find((s) => s.collapsible);
  assert.equal(quiz.uncollapsibleWidgetsCount, 1, 'answer is hidden until expanded');
  assert.ok(!JSON.stringify(card).includes('made-up-id'));

  const qs = db.prepare('SELECT * FROM questions WHERE topic = ?').all(DIGEST_TOPIC);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].module_id, null);
  const newHire = Number(db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('new@pitchpulse.dev', 'New Hire', 'x', 'rep')").run().lastInsertRowid);
  const picked = new Set(Array.from({ length: 200 }, () => pickDailyQuestions(db, newHire)).flat());
  assert.ok(picked.has(qs[0].id), 'digest questions are served by the Daily Challenge');

  calls = [];
  const again = await sendWeeklyDigest(db);
  assert.equal(again.skipped, true);
  assert.equal(calls.length, 0);

  const forced = await sendWeeklyDigest(db, { force: true });
  assert.equal(forced.sent, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions WHERE topic = ?').get(DIGEST_TOPIC).n, 1, 'a re-send does not duplicate questions');

  const admin = await login('admin@pitchpulse.dev');
  const status = await admin('/api/integrations/status');
  assert.equal(status.data.digest.delivery, 'webhook');
  assert.equal(status.data.digest.sent, 1);
  assert.equal(status.data.digest.lastRun.status, 'ok');
  assert.equal((await admin('/api/digests/preview', { method: 'POST' })).status, 409);
});

test('Digest: next week opens with a recap; without Claude it falls back to a basic digest from Gong and Drive', async () => {
  const nextWeek = new Date(Date.now() + 7 * 864e5);
  const cfg = config.digest();
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await sendWeeklyDigest(db, { now: nextWeek, cfg });
    assert.equal(r.sent, true);
    assert.equal(r.digest.source, 'basic');
    assert.equal(anthropicRequests.length, 0);
    assert.equal(r.digest.content.items[0].kind, 'call_clip');
    assert.equal(r.digest.content.items[0].title, 'Globex pricing call');
    assert.ok(!JSON.stringify(r.digest.content).includes('javascript:'), 'non-https links are dropped');
    const card = JSON.parse(calls.find((c) => c.url.startsWith('https://chat.test')).body).cardsV2[0].card;
    assert.match(card.sections[1].widgets[0].textParagraph.text, /Remember last week\?.*Pricing pushback/);
  } finally {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  }
});

test('Digest: a failing source is reported but does not block the others', async () => {
  const realGong = process.env.GONG_ACCESS_KEY_SECRET;
  process.env.GONG_ACCESS_KEY_SECRET = '';
  process.env.GONG_ACCESS_KEY = '';
  process.env.GOOGLE_DRIVE_API = 'https://broken.test/drive/v3';
  try {
    const r = await sendWeeklyDigest(db, { now: new Date(Date.now() + 14 * 864e5) });
    assert.equal(r.sent, true);
    assert.equal(r.digest.sources.gong, 0);
    assert.match(r.digest.sources.errors[0], /^Drive 599/);
    const run = db.prepare("SELECT * FROM integration_runs WHERE kind = 'weekly_digest' ORDER BY id DESC LIMIT 1").get();
    assert.equal(run.status, 'error');
    assert.match(run.detail, /skipped: Drive/);
  } finally {
    Object.assign(process.env, { GONG_ACCESS_KEY: 'gk', GONG_ACCESS_KEY_SECRET: realGong, GOOGLE_DRIVE_API: 'https://google.test/drive/v3' });
  }
});
