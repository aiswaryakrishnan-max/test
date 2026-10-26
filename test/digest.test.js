// Daily digest pipeline: plan -> draft (Claude + validators) -> review -> queue (fallbacks) -> deliver
// at each rep's local time -> quiz, recall, feedback and challenge replies -> metrics.
// Gong, Google Drive, Claude, Google Chat and HubSpot are mocked at the fetch layer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { extensions } from '../server/extensions.js';
import { seed, DEMO_PASSWORD } from '../server/seed.js';
import { handleChatEvent } from '../server/integrations/googlechat.js';
import { syncCrm } from '../server/integrations/crm.js';
import { config } from '../server/integrations/config.js';
import { deliverDue, draftWeek, getWeek, localParts, planWeek, queueWeek, weekMetrics } from '../server/digest/index.js';
import { validateCard } from '../server/digest/validate.js';
import { buildPlan, rotationPick } from '../server/digest/plan.js';
import { sign } from '../server/integrations/secrets.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), private_key_id: 'k1' });

Object.assign(process.env, {
  APP_URL: 'http://pitchpulse.test',
  APP_SECRET: 'test-secret',
  GOOGLE_CHAT_AUDIENCE: '123456789',
  GOOGLE_CHAT_SERVICE_ACCOUNT: SA,
  GOOGLE_CHAT_API: 'https://google.test/chat/v1',
  GOOGLE_TOKEN_URL: 'https://google.test/token',
  GOOGLE_DRIVE_API: 'https://google.test/drive/v3',
  GOOGLE_DRIVE_APPROVED_FOLDER_ID: 'approved',
  GONG_API_BASE: 'https://gong.test',
  GONG_ACCESS_KEY: 'gk',
  GONG_ACCESS_KEY_SECRET: 'gs',
  DIGEST_WEB_DOMAINS: 'news.test',
  DIGEST_WEB_PAGES: 'https://prezent.test/whats-new',
  DIGEST_RENDER_IMAGES: 'false',
  DIGEST_TITLE: 'Prezent GTM weekly digest',
  ANTHROPIC_API_KEY: 'test-key',
  ANTHROPIC_BASE_URL: 'https://anthropic.test',
});

const WEEK = '2026-11-02';                       // delivery week (Mon Nov 2 to Fri Nov 6)
const THURSDAY = new Date('2026-10-29T12:00:00Z'); // drafting day
const ago = (days) => new Date(THURSDAY.getTime() - days * 864e5).toISOString();

// ---------- Fixture cards, as Claude would return them ----------
const quiz = (question, source_id, answer_index = 1) => ({ question, options: ['A wrong', 'The right one', 'Also wrong', 'Nope'], answer_index, explanation: 'Because the source says so.', source_id });
const CARDS = {
  mon: {
    headline: "Five terms you'll hear in every ESMO conversation this week",
    body_points: [{ text: 'ESMO 2026 runs this week and every readout becomes field slides within days.', source_ids: ['web:1'] }, { text: 'Hazard ratio below 1.0 favors the new drug.', source_ids: ['drive:gloss1'] }],
    say_it: 'With ESMO data landing this week, how long does it take your team to go from a readout to a field-ready deck?',
    terms: ['Overall survival', 'Progression-free survival', 'Objective response rate', 'Hazard ratio', 'Late-breaking abstract'].map((term) => ({ term, definition: `${term} defined.`, in_a_call: `Ask about ${term}?`, source_ids: ['drive:gloss1'] })),
    happening: [{ text: 'ESMO 2026 runs Oct 23 to 27 in Madrid.', source_ids: ['web:1'] }],
    why_it_matters: { text: 'Readouts turn into slides within days.', source_ids: ['web:1'] },
    events: [{ name: 'ASH 2026', dates: 'Dec 5 to 8, Orlando', why: 'Poster deadlines', source_ids: ['web:2'] }],
    visual: { title: 'Survival curves', style: 'step', x_label: 'Months', y_label: 'Event-free (%)', series: [{ label: 'New drug', highlight: true, points: [{ x: 0, y: 100 }, { x: 12, y: 66 }, { x: 24, y: 36 }] }, { label: 'Control', highlight: false, points: [{ x: 0, y: 100 }, { x: 12, y: 38 }, { x: 24, y: 10 }] }], annotations: ['Median is 8 months longer'], illustrative: true, caption: 'Each step is an event.' },
    quiz: [quiz('A PFS hazard ratio of 0.70 means?', 'drive:gloss1')],
  },
  tue: {
    headline: 'Medical Affairs: where the deck gets stuck',
    body_points: [{ text: 'Medical Affairs owns the scientific story.', source_ids: ['drive:persona1'] }, { text: 'Prospects say MLR review takes three rounds.', source_ids: ['gong:111'] }],
    say_it: 'Walk me through what happens between a data readout and the first deck your MSLs can use.',
    persona: { role: 'Medical Affairs leader', description: 'Owns the scientific story.', judged_on: ['Speed', 'Accuracy', 'Consistency'], source_ids: ['drive:persona1'] },
    pains: [{ text: 'Rework at MLR', source_ids: ['gong:111'] }],
    discovery: ['The lag', 'The rework', 'The sources', 'The agency bill'].map((label) => ({ label, question: `${label} question?`, listen_for: 'handoffs', our_answer: 'Publications to presentations.', source_ids: ['drive:persona1'] })),
    customer_language: [{ phrase: 'three rounds of MLR', meaning: 'Review is the bottleneck', source_ids: ['gong:111'] }],
    visual: { steps: [{ label: 'Data readout', detail: '' }, { label: 'Draft slides', detail: '' }, { label: 'MLR review', detail: 'medical, legal, regulatory' }, { label: 'Field-ready', detail: '' }], loop_from: 2, loop_to: 1, loop_label: 'rework loop', friction: [{ step: 1, text: 'Agency handoff' }], caption: 'A common pattern, not a measured one.' },
    quiz: [quiz('Strongest discovery question?', 'drive:persona1', 2)],
  },
  wed: {
    headline: '"We already have Copilot." Start in a different place.',
    body_points: [{ text: 'Copilot helps once you are inside PowerPoint.', source_ids: ['drive:battle1'] }, { text: 'Prezent is where the deck starts.', source_ids: ['drive:battle1'] }],
    say_it: 'Copilot is great once you are inside the deck. We help with the part before that.',
    objection: { quote: 'We already have Copilot.', acknowledge: 'Copilot is solid.', reframe: 'Where does the deck start?', prove: 'We build from your sources.', ask: 'How many hours before Copilot?', source_ids: ['drive:battle1', 'gong:111'] },
    second_objection: { quote: 'Our agency handles this', answer: 'Position us as the fast lane.', source_ids: ['drive:battle1'] },
    competitors: [{ category: 'AI assistants', examples: 'Microsoft Copilot, Google Gemini', question: 'Who checks the science before MLR?', strength: 'Strong editing inside PowerPoint', strength_source_ids: ['drive:battle1'] }],
    packaging: { text: 'Lead with overnight presentations for deadlines.', source_ids: ['drive:battle1'] },
    visual: { top_title: 'Prezent: where the deck starts', chips: ['Storyline', 'Brand rules', 'Sources'], bottom_title: 'PowerPoint with Copilot', link_label: 'export', caption: 'Our positioning.' },
    quiz: [quiz('Best first move when a prospect cites Copilot?', 'drive:battle1')],
  },
  thu: {
    headline: 'From manuscript to conference poster',
    body_points: [{ text: 'Upload a manuscript and get a print-ready poster.', source_ids: ['drive:release1'] }, { text: 'Literature reviews cite every claim.', source_ids: ['drive:release1'] }],
    say_it: 'Which congress poster is next for your team?',
    use_case: { name: 'Congress posters', buyer: 'Medical Affairs', trigger: 'A congress deadline', flow: ['Manuscript', 'AI Builder', 'Poster'], outcome: 'Print-ready in hours.', source_ids: ['drive:release1'] },
    releases: [{ when: 'Sep 24, 2026: Vivo 1.2', title: 'Literature reviews', items: ['Source-backed literature reviews'], source_ids: ['drive:release1'] }],
    more_use_cases: [{ name: 'MSL decks', buyer: 'Medical Affairs', trigger: 'New data', source_ids: ['drive:release1'] }],
    visual: { chips: ['Manuscript PDF', 'AI Builder', 'Print-ready poster'], caption: 'Poster features are beta.' },
    quiz: [quiz('Which sources does Literature Review search?', 'drive:release1', 3)],
  },
  fri: {
    headline: 'Why customers say yes, and the week in three questions',
    body_points: [{ text: 'A mid-market win came down to agency spend.', source_ids: ['sfdc:006A'] }, { text: 'Menarini saved 12,500 hours.', source_ids: ['drive:case1'] }],
    say_it: 'Teams like Menarini point to hours saved. Which matters more for your team?',
    proof_points: [{ figure: '12,500', label: 'hours saved', who: 'Menarini, Global Medical Affairs', source_id: 'drive:case1' }],
    win_reasons: [{ text: 'Lower agency spend', source_ids: ['drive:case1'] }],
    stories: [{ source_id: 'sfdc:006A', lesson: 'Quantify the agency bill early.' }],
    clip_why: 'Opens with the cost of delay.',
    quiz: [quiz('Which endpoint matures last?', 'drive:gloss1', 2), quiz('Where does Prezent sit vs Copilot?', 'drive:battle1', 0), quiz('Which opener uncovers pain?', 'drive:persona1')],
  },
};

// ---------- Mock providers ----------
const realFetch = globalThis.fetch;
const calls = [];
const claude = [];
let chatMessages = 0;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const reviewed = 'Owner: Enablement. Last reviewed: 2026-09-15';

const DRIVE = {
  approved: [
    { id: 'f-gloss', name: 'Glossary', mimeType: 'application/vnd.google-apps.folder' },
    { id: 'f-battle', name: 'Battle cards', mimeType: 'application/vnd.google-apps.folder' },
    { id: 'f-case', name: 'Case studies', mimeType: 'application/vnd.google-apps.folder' },
    { id: 'persona1', name: 'Persona: Medical Affairs', mimeType: 'application/vnd.google-apps.document', description: reviewed, owners: [{ displayName: 'PMM' }], webViewLink: 'https://docs.google.com/document/d/persona1' },
    { id: 'release1', name: 'Release notes Vivo', mimeType: 'application/vnd.google-apps.document', description: reviewed, owners: [{ displayName: 'Product' }], webViewLink: 'https://docs.google.com/document/d/release1' },
    { id: 'stale1', name: 'Old pricing', mimeType: 'application/vnd.google-apps.document', description: 'Last reviewed: 2024-01-01', owners: [{ displayName: 'PMM' }] },
    { id: 'noreview', name: 'Draft talk track', mimeType: 'application/vnd.google-apps.document', owners: [{ displayName: 'PMM' }] },
  ],
  'f-gloss': [{ id: 'gloss1', name: 'Oncology terms', mimeType: 'application/vnd.google-apps.document', properties: { lastReviewed: '2026-10-01' }, owners: [{ displayName: 'Medical' }], webViewLink: 'https://docs.google.com/document/d/gloss1' }],
  'f-battle': [{ id: 'battle1', name: 'Copilot battle card', mimeType: 'application/vnd.google-apps.document', description: reviewed, owners: [{ displayName: 'PMM' }], webViewLink: 'https://docs.google.com/document/d/battle1' }],
  'f-case': [{ id: 'case1', name: 'Menarini case study', mimeType: 'application/vnd.google-apps.document', description: reviewed, owners: [{ displayName: 'Marketing' }], webViewLink: 'https://docs.google.com/document/d/case1' }],
};
const DOC_TEXT = { gloss1: 'OS, PFS, ORR, HR definitions.', persona1: 'Medical Affairs persona.', release1: 'Vivo 1.2 shipped Sep 24, 2026.', battle1: 'Copilot: strong editing inside PowerPoint.', case1: 'Menarini Global Medical Affairs saved 12,500 hours and $1.1M in agency costs.' };

async function mockFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
  calls.push({ url: url.href, method: init.method || 'GET', body });

  if (url.origin === 'https://google.test') {
    if (url.pathname === '/token') return json({ access_token: 'g-token', expires_in: 3600 });
    if (url.pathname === '/drive/v3/files') return json({ files: DRIVE[url.searchParams.get('q').match(/'([\w-]+)' in parents/)[1]] || [] });
    const exp = url.pathname.match(/^\/drive\/v3\/files\/(\w+)\/export$/);
    if (exp) return new Response(DOC_TEXT[exp[1]] || '');
    if (url.pathname.startsWith('/chat/v1/spaces/')) {
      chatMessages++;
      const space = url.pathname.split('/')[4];
      return json({ name: `spaces/${space}/messages/m${chatMessages}`, thread: { name: `spaces/${space}/threads/t${chatMessages}` } });
    }
  }
  if (url.origin === 'https://gong.test') {
    return json({ records: {}, calls: [
      { metaData: { id: '111', title: 'Globex pricing call', url: 'https://app.gong.io/call?id=111', duration: 2400, scope: 'External', started: ago(2) },
        content: { brief: 'MLR review takes three rounds.', keyPoints: [{ text: 'Agency is slow' }], trackers: [{ name: 'MLR', count: 4 }, { name: 'Gamma', count: 3 }] } },
      { metaData: { id: '222', title: 'Older call', duration: 1800, scope: 'External', started: ago(10) }, content: { brief: 'x', trackers: [{ name: 'MLR', count: 1 }, { name: 'Budget', count: 5 }] } },
    ] });
  }
  if (url.origin === 'https://anthropic.test' && url.pathname === '/v1/messages') {
    const req = JSON.parse(body);
    claude.push(req);
    const msg = (content, stop_reason = 'end_turn') => json({ id: `msg_${claude.length}`, type: 'message', role: 'assistant', model: req.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    if (req.tools) {
      if (req.messages.length === 1) return msg([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'ESMO' } }], 'pause_turn');
      return msg([
        { type: 'text', text: 'ESMO 2026 runs Oct 23 to 27 in Madrid.', citations: [{ type: 'web_search_result_location', url: 'https://news.test/esmo', title: 'ESMO 2026', cited_text: '' }] },
        { type: 'text', text: ' ASH 2026 is Dec 5 to 8.', citations: [{ type: 'web_search_result_location', url: 'https://news.test/ash', title: 'ASH 2026', cited_text: '' }] },
      ]);
    }
    const instruction = req.messages[0].content[1].text;
    const day = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].findIndex((d) => instruction.startsWith(`Write ${d}'s card`));
    const key = ['mon', 'tue', 'wed', 'thu', 'fri'][day];
    let card = structuredClone(CARDS[key]);
    // Tuesday's first draft has an unsourced point; the validator sends it back once.
    if (key === 'tue' && req.messages.length === 1) card.body_points[0].source_ids = [];
    return msg([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(card) }]);
  }
  if (url.origin === 'https://hubspot.test') {
    if (url.pathname === '/crm/v3/owners') return json({ results: [] });
    if (url.pathname === '/crm/v3/pipelines/deals') return json({ results: [{ stages: [{ id: 'won', label: 'Closed Won', metadata: { isClosed: 'true', probability: '1.0' } }] }] });
    if (url.pathname === '/crm/v3/objects/deals') {
      assert.match(url.searchParams.get('properties'), /closed_won_reason/);
      assert.match(url.searchParams.get('properties'), /competitor__c/);
      return json({ results: [{ id: 'h1', properties: { dealname: 'Initech', amount: '40000', dealstage: 'won', closedate: '2026-10-27T00:00:00Z', closed_won_reason: 'Agency cost', competitor__c: 'Gamma', segment__c: 'Mid-market' } }] });
    }
  }
  return json({ error: `unmocked ${url.href}` }, 599);
}

// ---------- App ----------
let server;
let base;
let db;
let ids;
before(async () => {
  globalThis.fetch = mockFetch;
  db = openDb(':memory:');
  seed(db);
  server = createServer(createApp(db, { extensions }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ids = Object.fromEntries(db.prepare("SELECT email, id FROM users").all().map((u) => [u.email, u.id]));
  // Two reps in Chat, on opposite coasts.
  db.prepare("UPDATE users SET timezone = 'America/New_York' WHERE email = 'rep@pitchpulse.dev'").run();
  db.prepare("UPDATE users SET timezone = 'America/Los_Angeles' WHERE email = 'sam@pitchpulse.dev'").run();
  db.prepare("INSERT INTO chat_links (user_id, space_name) VALUES (?, 'spaces/DMREP'), (?, 'spaces/DMSAM')").run(ids['rep@pitchpulse.dev'], ids['sam@pitchpulse.dev']);
  // Closed deals in the drafting window; one account is a published reference (Menarini), one is not (Globex Pharma).
  const deal = db.prepare(`INSERT INTO crm_deals (provider, external_id, name, account, amount, stage, close_date, is_closed, is_won, reason, competitor, segment)
    VALUES ('salesforce', ?, ?, ?, ?, 'Closed', ?, 1, ?, ?, ?, ?)`);
  deal.run('006A', 'Globex Pharma expansion', 'Globex Pharma', 80000, '2026-10-27', 1, 'Agency cost', 'Gamma', 'Mid-market');
  deal.run('006B', 'Menarini renewal', 'Menarini', 300000, '2026-10-26', 1, 'Hours saved', null, 'Enterprise');
  deal.run('006C', 'Umbrella', 'Umbrella Bio', 20000, '2026-10-24', 0, 'No budget', 'Agencies', 'SMB');
});
after(() => { server.close(); globalThis.fetch = realFetch; });

async function login(email) {
  const res = await realFetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (path, { method = 'GET', body } = {}) => realFetch(base + path, {
    method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Requested-With': 'pitchpulse' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => { const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; } return { status: r.status, data, location: r.headers.get('location') }; });
}
const chatEvent = (email, extra) => handleChatEvent(db, { user: { email }, space: { name: email.startsWith('rep') ? 'spaces/DMREP' : 'spaces/DMSAM', type: 'DM' }, ...extra }, '2026-11-02');

// ---------- Tests ----------

test('Plan: rotations change weekly and Gong tracker trends pick the objection and a hot competitor', () => {
  const cfg = config.digest();
  assert.equal(rotationPick(['a', 'b', 'c'], '2026-01-05'), 'a');
  assert.equal(rotationPick(['a', 'b', 'c'], '2026-01-12'), 'b');
  assert.equal(rotationPick(['a', 'b', 'c'], '2025-12-29'), 'c');
  const plain = buildPlan({ week: WEEK, cfg });
  assert.equal(plain.objection, '');
  const trended = buildPlan({ week: WEEK, cfg, trackers: { current: { MLR: 4, Gamma: 3, Budget: 0 }, previous: { MLR: 1, Budget: 5 } } });
  assert.equal(trended.objection, 'MLR');
  assert.match(trended.competitor, /General AI deck builders/);
  assert.match(trended.competitorReason, /Gamma came up 3 times/);
});

test('Draft: approved sources only, every card validated, Tuesday repaired once, Friday gets the approved clip', async () => {
  const lead = await login('manager@pitchpulse.dev');
  const clip = await lead('/api/digest/clips', { method: 'POST', body: { url: 'https://app.gong.io/call?id=999&t=120', title: 'Cost-of-delay opener', why_it_works: 'Opens with impact', skill: 'Discovery' } });
  assert.equal((await lead(`/api/digest/clips/${clip.data.id}/approve`, { method: 'POST' })).status, 200);

  const week = await planWeek(db, { week: WEEK, now: THURSDAY });
  assert.equal(week.plan.objection, 'MLR', 'Gong trend: MLR rose from 1 to 4 hits');
  const r = await draftWeek(db, week.id, { now: THURSDAY });

  assert.deepEqual(r.cards.map((c) => [c.day, c.status]), [['mon', 'draft'], ['tue', 'draft'], ['wed', 'draft'], ['thu', 'draft'], ['fri', 'draft']]);
  for (const c of r.cards) assert.deepEqual(c.issues.filter((i) => i.level === 'error'), [], `${c.day}: ${JSON.stringify(c.issues)}`);
  assert.deepEqual(r.cards.map((c) => c.sensitive), [0, 0, 1, 0, 1], 'competitor (Wed) and win/loss (Fri) cards always need a human');

  // Sources: approved, reviewed, owned files only; stale and undated ones dropped.
  assert.ok(r.sources['drive:gloss1'] && r.sources['drive:case1'] && r.sources['gong:111'] && r.sources['sfdc:006A'] && r.sources['web:2'] && r.sources['clip:1']);
  assert.equal(r.sources['drive:case1'].category, 'case_study');
  assert.ok(!r.sources['drive:stale1'] && !r.sources['drive:noreview']);
  assert.ok(!r.sources['gong:222'], 'only last week\'s calls feed the cards');
  assert.ok(!JSON.stringify(r.sources).includes('Globex Pharma'), 'Salesforce sources are anonymized');
  const log = db.prepare("SELECT detail FROM integration_runs WHERE kind = 'digest_draft' ORDER BY id DESC").get().detail;
  assert.match(log, /2 Drive files skipped \(Old pricing: review expired \(2024-01-01\); Draft talk track: no last-reviewed date\)/);

  // Claude: research resumed after pause_turn; cards drafted with a fixed JSON format and a cached source pack.
  const research = claude.filter((q) => q.tools);
  assert.equal(research.length, 2);
  assert.deepEqual(research[0].tools.map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.deepEqual(research[0].tools[0].allowed_domains, ['news.test']);
  const drafts = claude.filter((q) => q.output_config?.format);
  assert.equal(drafts.length, 6, '5 days + 1 repair');
  assert.equal(drafts[0].model, 'claude-opus-5-5');
  assert.equal(drafts[0].fallbacks, 'default');
  assert.deepEqual(drafts[0].messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.match(drafts[0].messages[0].content[0].text, /<source id="drive:case1" type="drive" category="case_study"/);
  assert.match(drafts[0].system, /Use only the supplied sources/);
  const repair = drafts.find((q) => q.messages.length === 3);
  assert.match(repair.messages[2].content, /body_points\[0\]\.source_ids: No source/);
  const fri = drafts.find((q) => q.messages[0].content[1].text.startsWith("Write Friday's card"));
  assert.match(fri.messages[0].content[1].text, /Monday: "Five terms/);
  assert.match(drafts.find((q) => q.messages[0].content[1].text.startsWith("Write Wednesday's card")).messages[0].content[1].text, /Objection: MLR/);

  const friday = r.cards.find((c) => c.day === 'fri');
  assert.equal(friday.content.clip.title, 'Cost-of-delay opener');
  assert.match(r.challenge, /try "Overall survival".*Reply in the digest thread/);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE kind = 'digest'").get(), 'reviewers are notified');
});

test('Validators: unsourced facts, unknown ids, limits, account names, proof figures and competitor claims', () => {
  const catalog = { 'drive:case1': { type: 'drive', category: 'case_study', title: 'Case', text: 'Menarini saved 12,500 hours' }, 'drive:x': { type: 'drive', category: 'other' }, 'gong:1': { type: 'gong' } };
  const ctx = { catalog, accountNames: ['Globex Pharma', 'Menarini'], allowedNames: ['Menarini'] };
  const card = structuredClone(CARDS.fri);
  card.body_points[0].source_ids = ['sfdc:missing'];
  card.headline = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  card.say_it += ' Globex Pharma loved it.';
  card.proof_points[0].figure = '13,000';
  card.quiz = card.quiz.slice(0, 2);
  const msgs = validateCard('fri', card, ctx).filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`).join('\n');
  assert.match(msgs, /headline: Headline is 13 words/);
  assert.match(msgs, /Unknown source "sfdc:missing"/);
  assert.match(msgs, /say_it: Names customer account "Globex Pharma"/);
  assert.ok(!/Menarini"/.test(msgs), 'approved references may be named');
  assert.match(msgs, /"13,000" is not worded as published/);
  assert.match(msgs, /quiz: Needs exactly 3 questions/);

  const wed = structuredClone(CARDS.wed);
  wed.competitors[0].strength_source_ids = ['drive:x'];
  wed.competitors[0].question = 'Gamma is worse.';
  wed.visual.chips.push('Menarini');
  const w = validateCard('wed', wed, { ...ctx, catalog: { ...catalog, 'drive:battle1': { type: 'drive', category: 'battle_card' }, 'gong:111': { type: 'gong' } } }).map((i) => i.message).join('\n');
  assert.match(w, /must be a discovery question/);
  assert.match(w, /needs an approved battle card/);
  assert.match(w, /Names customer "Menarini" in the visual/);
});

test('Review: errors block approval; queue sends approved cards and a refresher fallback for the rest', async () => {
  const week = getWeek(db, WEEK);
  const cards = Object.fromEntries(db.prepare('SELECT id, day FROM digest_cards WHERE week_id = ?').all(week.id).map((c) => [c.day, c.id]));
  const admin = await login('admin@pitchpulse.dev');
  const rep = await login('rep@pitchpulse.dev');
  assert.equal((await rep(`/api/digest/cards/${cards.mon}/approve`, { method: 'POST' })).status, 403);

  const bad = structuredClone(CARDS.fri);
  bad.proof_points[0].figure = '13,000';
  const edited = await admin(`/api/digest/cards/${cards.fri}`, { method: 'PUT', body: { content: bad } });
  assert.ok(edited.data.issues.some((i) => i.level === 'error'));
  assert.equal((await admin(`/api/digest/cards/${cards.fri}/approve`, { method: 'POST' })).status, 400);

  for (const d of ['mon', 'tue', 'wed', 'thu']) assert.equal((await admin(`/api/digest/cards/${d === 'wed' ? cards[d] : cards[d]}/approve`, { method: 'POST' })).data.status, 'approved');
  const q = await admin(`/api/digest/weeks/${week.id}/queue`, { method: 'POST' });
  assert.deepEqual(q.data.cards.map((c) => c.status), ['queued', 'queued', 'queued', 'queued', 'fallback']);
  const fb = q.data.cards[4].content;
  assert.equal(fb.fallback, true);
  assert.match(fb.headline, /in review/);
  assert.equal(fb.replaced_draft.proof_points[0].figure, '13,000', 'the draft is kept so a reviewer can still fix and approve it');
  assert.match(db.prepare("SELECT detail FROM integration_runs WHERE kind = 'digest_queue'").get().detail, /4 approved, 0 auto-approved, 1 fallback/);
  const stillBad = await admin(`/api/digest/cards/${cards.fri}/approve`, { method: 'POST' });
  assert.equal(stillBad.status, 400);
  assert.match(stillBad.data.error, /refresher stays queued/);
  assert.equal(db.prepare('SELECT status FROM digest_cards WHERE id = ?').get(cards.fri).status, 'fallback');
});

test('Delivery: 8:30 in each rep\'s own time zone, once, with the card format from the guide', async () => {
  assert.deepEqual(localParts(new Date('2026-11-02T13:31:00Z'), 'America/New_York'), { date: '2026-11-02', time: '08:31', weekday: 0 });
  const early = await deliverDue(db, new Date('2026-11-02T13:31:00Z'));
  assert.equal(early.sent, 1, 'New York is at 8:31, Los Angeles at 5:31');
  const posts = calls.filter((c) => c.url.includes('/chat/v1/spaces/'));
  assert.match(posts.at(-1).url, /DMREP/);
  const card = JSON.parse(posts.at(-1).body).cardsV2[0].card;
  const text = JSON.stringify(card);
  assert.match(text, /MONDAY · Speak the language/);
  assert.match(text, /Five terms you'll hear/);
  assert.match(text, /This week's challenge/);
  assert.match(text, /Say it on your next call/);
  assert.match(text, /digest_answer/);
  assert.match(text, /Open full card/);
  assert.match(text, /http:\/\/pitchpulse.test\/digest\/\d+\?day=mon#mon/);
  assert.match(text, /👍 Useful/);
  assert.ok(!text.includes('"image"'), 'no image without a public https APP_URL');

  assert.equal((await deliverDue(db, new Date('2026-11-02T13:40:00Z'))).sent, 0, 'never twice');
  assert.equal((await deliverDue(db, new Date('2026-11-02T16:31:00Z'))).sent, 1, 'Los Angeles at 8:31');
  assert.equal((await deliverDue(db, new Date('2026-11-07T15:00:00Z'))).sent, 0, 'no cards on Saturday');
});

test('Chat: quiz buttons, feedback and challenge replies in the digest thread', () => {
  const monId = db.prepare("SELECT c.id FROM digest_cards c JOIN digest_weeks w ON w.id = c.week_id WHERE w.week = ? AND c.day = 'mon'").get(WEEK).id;
  const click = (fn, parameters) => chatEvent('rep@pitchpulse.dev', { type: 'CARD_CLICKED', common: { invokedFunction: fn, parameters } });
  const answered = click('digest_answer', { k: monId, s: monId, q: 0, iv: 'same', c: 1 });
  assert.equal(answered.actionResponse.type, 'UPDATE_MESSAGE');
  assert.match(JSON.stringify(answered), /Correct/);
  assert.ok(!JSON.stringify(answered).includes('"function":"digest_answer"'), 'answered questions lose their buttons');
  const again = click('digest_answer', { k: monId, s: monId, q: 0, iv: 'same', c: 0 });
  assert.match(JSON.stringify(again), /Correct/, 'first answer counts');
  assert.match(JSON.stringify(click('digest_feedback', { k: monId, u: 1 })), /marked this useful/);
  assert.match(JSON.stringify(chatEvent('casey@pitchpulse.dev', { type: 'CARD_CLICKED', common: { invokedFunction: 'digest_answer', parameters: { k: monId, s: monId, q: 0, c: 1 } } })), /no longer available/, 'only recipients can answer');

  const thread = db.prepare('SELECT thread_name FROM digest_deliveries WHERE card_id = ? AND user_id = ?').get(monId, ids['rep@pitchpulse.dev']).thread_name;
  const reply = chatEvent('rep@pitchpulse.dev', { type: 'MESSAGE', message: { text: 'They said MLR takes three rounds', thread: { name: thread } } });
  assert.match(reply.text, /Logged.*\+20 XP/);
  const keyword = chatEvent('sam@pitchpulse.dev', { type: 'MESSAGE', message: { text: 'challenge: asked about the agency bill, $80K per congress', thread: { name: 'spaces/DMSAM/threads/other' } } });
  assert.match(keyword.text, /Logged/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digest_challenge_replies').get().n, 2);
  const normal = chatEvent('rep@pitchpulse.dev', { type: 'MESSAGE', message: { text: 'streak' } });
  assert.match(normal.text, /streak/, 'other messages still reach the Daily Challenge bot');
});

test('Recall: the same weekday\'s question returns 1 week and 4 weeks later', async () => {
  const later = async (week) => {
    const w = await planWeek(db, { week, now: THURSDAY });
    db.prepare("INSERT INTO digest_cards (week_id, day, status, content) VALUES (?, 'mon', 'queued', ?)").run(w.id, JSON.stringify({ ...CARDS.mon, headline: `Card for ${week}` }));
    db.prepare("UPDATE digest_weeks SET status = 'queued' WHERE id = ?").run(w.id);
  };
  await later('2026-11-09');
  await later('2026-11-30');
  await deliverDue(db, new Date('2026-11-09T14:00:00Z'));
  const recall = JSON.parse(calls.filter((c) => c.url.includes('DMREP')).at(-1).body).cardsV2[0].card.sections.find((s) => s.header === '🔁 Recall');
  assert.ok(recall.collapsible);
  assert.match(JSON.stringify(recall), /From last week/);
  assert.ok(!JSON.stringify(recall).includes('four weeks ago'));

  const nov9 = db.prepare("SELECT c.id FROM digest_cards c JOIN digest_weeks w ON w.id = c.week_id WHERE w.week = '2026-11-09'").get().id;
  const first = db.prepare(`SELECT c.id FROM digest_cards c JOIN digest_weeks w ON w.id = c.week_id WHERE w.week = ? AND c.day = 'mon'`).get(WEEK).id;
  chatEvent('rep@pitchpulse.dev', { type: 'CARD_CLICKED', common: { invokedFunction: 'digest_answer', parameters: { k: nov9, s: first, q: 0, iv: '1w', c: 2 } } });
  assert.deepEqual({ ...db.prepare('SELECT interval, correct FROM digest_answers WHERE card_id = ? AND source_card_id = ?').get(nov9, first) }, { interval: '1w', correct: 0 });

  await deliverDue(db, new Date('2026-11-30T14:00:00Z'));
  const four = JSON.parse(calls.filter((c) => c.url.includes('DMREP')).at(-1).body).cardsV2[0].card.sections.find((s) => s.header === '🔁 Recall');
  assert.match(JSON.stringify(four), /From four weeks ago/);
});

test('Full card: reps see queued cards only, reviewers can preview drafts, views are counted', async () => {
  const week = getWeek(db, WEEK);
  const rep = await login('rep@pitchpulse.dev');
  const page = await rep(`/digest/${week.id}?day=mon`);
  assert.equal(page.status, 200);
  assert.match(page.data, /<h1>Prezent GTM weekly digest<\/h1>/);
  assert.match(page.data, /Week of Nov 2 to 6, 2026\./);
  assert.match(page.data, /This week's challenge:/);
  assert.match(page.data, /Tap a term to see how to use it/);
  assert.match(page.data, /Illustrative, not real data\./);
  assert.match(page.data, /class="loop"/, 'Tuesday workflow with rework loop');
  assert.match(page.data, /Four moves, in order/);
  assert.match(page.data, /<a href="https:\/\/docs.google.com\/document\/d\/gloss1"/);
  assert.match(page.data, /Refresher|in review/, 'Friday shows its fallback');
  assert.ok(!page.data.includes('Why customers say yes'), 'unapproved draft is hidden from reps');
  assert.ok(!page.data.includes('Globex'), 'no account names on the page');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM digest_events WHERE kind = 'view'").get().n, 1);

  const admin = await login('admin@pitchpulse.dev');
  const preview = await admin(`/digest/${week.id}?preview=1`);
  assert.match(preview.data, /Reviewer preview/);
  assert.match(preview.data, /is not worded as published/);
  assert.equal((await realFetch(`${base}/digest/${week.id}`, { redirect: 'manual' })).status, 302);
});

test('Images: served only at a signed URL', async () => {
  const id = db.prepare("SELECT id FROM digest_cards WHERE day = 'tue'").get().id;
  db.prepare("UPDATE digest_cards SET image = ? WHERE id = ?").run(Buffer.from([0x89, 0x50, 0x4e, 0x47]), id);
  const { updated_at } = db.prepare('SELECT updated_at FROM digest_cards WHERE id = ?').get(id);
  const ok = await realFetch(`${base}/integrations/digest/image/${id}?sig=${sign(`img:${id}:${updated_at}`)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal((await realFetch(`${base}/integrations/digest/image/${id}?sig=nope`)).status, 404);
});

test('Metrics: engagement, quiz score, retention at 1 and 4 weeks, challenge replies, usefulness', async () => {
  const week = getWeek(db, WEEK);
  const m = weekMetrics(db, week.id);
  assert.equal(m.recipients, 2);
  const mon = m.days.find((d) => d.day === 'mon');
  assert.deepEqual({ delivered: mon.delivered, quizUsers: mon.quizUsers, quizScore: mon.quizScore, useful: mon.useful }, { delivered: 2, quizUsers: 1, quizScore: 100, useful: 1 });
  assert.ok(mon.engaged >= 1 && mon.views === 1);
  assert.deepEqual(m.retention.oneWeek, { answers: 1, score: 0 });
  assert.deepEqual({ replies: m.challenge.replies, share: m.challenge.share }, { replies: 2, share: 100 });
  const admin = await login('admin@pitchpulse.dev');
  const detail = await admin(`/api/digest/weeks/${week.id}`);
  assert.equal(detail.data.metrics.recipients, 2);
  assert.ok(!JSON.stringify(detail.data.sources).includes('12,500 hours'), 'case study text stays server-side');
});

test('CRM: win/loss reason, competitor and segment are synced from the configured fields', async () => {
  Object.assign(process.env, { CRM_PROVIDER: 'hubspot', HUBSPOT_ACCESS_TOKEN: 't', HUBSPOT_API_BASE: 'https://hubspot.test', CRM_COMPETITOR_FIELD: 'competitor__c', CRM_SEGMENT_FIELD: 'segment__c' });
  try {
    await syncCrm(db);
    const d = db.prepare("SELECT reason, competitor, segment FROM crm_deals WHERE external_id = 'h1'").get();
    assert.deepEqual({ ...d }, { reason: 'Agency cost', competitor: 'Gamma', segment: 'Mid-market' });
  } finally {
    for (const k of ['CRM_PROVIDER', 'HUBSPOT_ACCESS_TOKEN', 'HUBSPOT_API_BASE', 'CRM_COMPETITOR_FIELD', 'CRM_SEGMENT_FIELD']) delete process.env[k];
  }
});

test('Queue with nothing drafted sends fallbacks; spot-check mode auto-approves clean, non-sensitive cards', async () => {
  const empty = await queueWeek(db, '2026-12-07', { now: THURSDAY });
  assert.deepEqual(empty.cards.map((c) => c.status), ['fallback', 'fallback', 'fallback', 'fallback', 'fallback']);
  assert.match(empty.cards[0].content.headline, /Refresher: /, 'Monday has an older card to refresh');

  const w = await planWeek(db, { week: '2026-12-14', now: THURSDAY });
  db.prepare("INSERT INTO digest_cards (week_id, day, status, content, issues, sensitive) VALUES (?, 'mon', 'draft', ?, '[]', 0), (?, 'wed', 'draft', ?, '[]', 1)")
    .run(w.id, JSON.stringify(CARDS.mon), w.id, JSON.stringify(CARDS.wed));
  const r = await queueWeek(db, '2026-12-14', { cfg: { ...config.digest(), approval: 'sensitive' } });
  assert.deepEqual(r.cards.slice(0, 3).map((c) => [c.day, c.status]), [['mon', 'queued'], ['tue', 'fallback'], ['wed', 'fallback']]);
});
