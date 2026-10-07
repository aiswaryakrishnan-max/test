// Integration tests with every external provider mocked at the fetch layer:
// OIDC IdP, HubSpot, Salesforce, Google OAuth + Calendar, Google Chat, and the Anthropic API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { extensions } from '../server/extensions.js';
import { seed, DEMO_PASSWORD } from '../server/seed.js';
import { signJwt } from '../server/integrations/jwt.js';
import { syncCrm, dealFocus } from '../server/integrations/crm.js';
import { sendDailyChallenges } from '../server/integrations/googlechat.js';
import { dayOf } from '../server/engagement.js';

// ---------- Environment ----------
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

Object.assign(process.env, {
  APP_URL: 'http://pitchpulse.test',
  APP_SECRET: 'test-secret',
  OIDC_ISSUER: 'https://idp.test',
  OIDC_CLIENT_ID: 'pp-client',
  OIDC_CLIENT_SECRET: 'pp-secret',
  SSO_PROVIDER_NAME: 'Acme SSO',
  SSO_ALLOWED_DOMAINS: 'pitchpulse.dev,newco.com',
  GOOGLE_CLIENT_ID: 'gcal-client',
  GOOGLE_CLIENT_SECRET: 'gcal-secret',
  GOOGLE_AUTH_URL: 'https://google.test/auth',
  GOOGLE_TOKEN_URL: 'https://google.test/token',
  GOOGLE_CALENDAR_API: 'https://google.test/calendar/v3',
  GOOGLE_CHAT_AUDIENCE: '123456789',
  GOOGLE_CHAT_CERTS_URL: 'https://google.test/chat-certs',
  GOOGLE_CHAT_API: 'https://google.test/chat/v1',
  GOOGLE_CHAT_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'pp-bot@proj.iam.gserviceaccount.com', private_key: PRIV_PEM, private_key_id: 'sa-key' }),
  HUBSPOT_ACCESS_TOKEN: 'hs-token',
  HUBSPOT_API_BASE: 'https://hubspot.test',
  SALESFORCE_DOMAIN: 'https://acme.my.salesforce.test',
  SALESFORCE_CLIENT_ID: 'sf-id',
  SALESFORCE_CLIENT_SECRET: 'sf-secret',
  ANTHROPIC_API_KEY: 'test-key',
  ANTHROPIC_BASE_URL: 'https://anthropic.test',
});

// ---------- Mock providers ----------
const realFetch = globalThis.fetch;
const calls = [];
const idp = { lastAuthorize: null, claims: {} };
const anthropic = { requests: [], reply: 'Hi, Dana here. I have 15 minutes. What is this about?' };

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function mockFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const method = (init.method || input.method || 'GET').toUpperCase();
  const rawBody = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  const body = typeof rawBody === 'string' ? rawBody : rawBody instanceof URLSearchParams ? rawBody.toString() : rawBody ? String(rawBody) : '';
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : {}));
  calls.push({ url: url.href, method, body, headers });
  const form = () => new URLSearchParams(body);

  // OIDC identity provider
  if (url.origin === 'https://idp.test') {
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/authorize', token_endpoint: 'https://idp.test/token', jwks_uri: 'https://idp.test/jwks' });
    }
    if (url.pathname === '/jwks') return json({ keys: [JWK] });
    if (url.pathname === '/token') {
      const f = form();
      const a = idp.lastAuthorize;
      const pkceOk = createHash('sha256').update(f.get('code_verifier')).digest('base64url') === a.get('code_challenge');
      if (!pkceOk || f.get('client_secret') !== 'pp-secret') return json({ error: 'invalid_grant' }, 400);
      const now = Math.floor(Date.now() / 1000);
      const idToken = signJwt({ iss: 'https://idp.test', aud: 'pp-client', iat: now, exp: now + 300, nonce: a.get('nonce'), ...idp.claims }, PRIV_PEM, 'test-key');
      return json({ access_token: 'at', id_token: idToken, token_type: 'Bearer' });
    }
  }

  // Google OAuth, Calendar, Chat
  if (url.origin === 'https://google.test') {
    if (url.pathname === '/token') {
      const f = form();
      if (f.get('grant_type') === 'authorization_code') return json({ access_token: 'cal-at', refresh_token: 'cal-refresh-SECRET', expires_in: 3600 });
      if (f.get('grant_type') === 'refresh_token') return json({ access_token: 'cal-at-2', expires_in: 3600 });
      if (f.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer') return json({ access_token: 'chat-bot-token', expires_in: 3600 });
    }
    if (url.pathname === '/calendar/v3/calendars/primary/events') {
      const at = (h) => new Date(Date.now() + h * 3600e3).toISOString();
      return json({ items: [
        { id: 'e1', summary: 'Northwind pricing call', start: { dateTime: at(3) }, end: { dateTime: at(4) }, attendees: [{ email: 'rep@pitchpulse.dev', self: true }, { email: 'cfo@northwindfreight.com' }] },
        { id: 'e2', summary: 'Team standup', start: { dateTime: at(5) }, end: { dateTime: at(5.5) }, attendees: [{ email: 'rep@pitchpulse.dev', self: true }, { email: 'sam@pitchpulse.dev' }] },
        { id: 'e3', summary: 'Declined vendor call', start: { dateTime: at(6) }, attendees: [{ email: 'rep@pitchpulse.dev', self: true, responseStatus: 'declined' }, { email: 'x@vendor.com' }] },
        { id: 'e4', summary: 'All-day offsite', start: { date: '2030-01-01' }, attendees: [{ email: 'y@client.com' }] },
      ] });
    }
    if (url.pathname === '/chat-certs') return json({ keys: [JWK] });
    if (url.pathname.startsWith('/chat/v1/spaces/')) return json({ name: `${url.pathname.slice(9)}/msg1` });
  }

  // HubSpot
  if (url.origin === 'https://hubspot.test') {
    if (headers.get('authorization') !== 'Bearer hs-token') return json({ message: 'unauthorized' }, 401);
    if (url.pathname === '/crm/v3/owners') return json({ results: [{ id: '11', email: 'Rep@PitchPulse.dev' }, { id: '12', email: 'stranger@other.com' }] });
    if (url.pathname === '/crm/v3/pipelines/deals') {
      return json({ results: [{ stages: [
        { id: 'appt', label: 'Appointment Scheduled', metadata: { isClosed: 'false', probability: '0.2' } },
        { id: 'won', label: 'Closed Won', metadata: { isClosed: 'true', probability: '1.0' } },
        { id: 'lost', label: 'Closed Lost', metadata: { isClosed: 'true', probability: '0.0' } },
      ] }] });
    }
    if (url.pathname === '/crm/v3/objects/deals') {
      if (!url.searchParams.get('after')) {
        return json({ results: [
          { id: 'd1', properties: { dealname: 'Globex – New', amount: '50000', dealstage: 'appt', closedate: '2099-01-10T00:00:00Z', hubspot_owner_id: '11' } },
          { id: 'd2', properties: { dealname: 'Initech – Renewal', amount: '20000', dealstage: 'won', closedate: '2026-09-01T00:00:00Z', hubspot_owner_id: '11' } },
        ], paging: { next: { after: 'p2' } } });
      }
      return json({ results: [{ id: 'd3', properties: { dealname: 'Umbrella', amount: '9000', dealstage: 'lost', closedate: '2026-08-01T00:00:00Z', hubspot_owner_id: '12' } }] });
    }
  }

  // Salesforce
  if (url.origin === 'https://acme.my.salesforce.test') {
    if (url.pathname === '/services/oauth2/token') return json({ access_token: 'sf-at', instance_url: 'https://acme.my.salesforce.test' });
    if (url.pathname.endsWith('/query') && url.searchParams.get('q')) {
      return json({ done: false, nextRecordsUrl: '/services/data/v61.0/query/01gNEXT', records: [
        { Id: '006A', Name: 'Hooli Expansion', Amount: 120000, StageName: 'Negotiation/Review', CloseDate: '2099-02-01', IsClosed: false, IsWon: false, Owner: { Email: 'sam@pitchpulse.dev' }, Account: { Name: 'Hooli' } },
      ] });
    }
    if (url.pathname.endsWith('/query/01gNEXT')) {
      return json({ done: true, records: [
        { Id: '006B', Name: 'Pied Piper', Amount: 40000, StageName: 'Closed Won', CloseDate: '2026-09-15', IsClosed: true, IsWon: true, Owner: { Email: 'sam@pitchpulse.dev' }, Account: { Name: 'Pied Piper' } },
      ] });
    }
  }

  // Anthropic Messages API
  if (url.origin === 'https://anthropic.test' && url.pathname === '/v1/messages') {
    const req = JSON.parse(body);
    anthropic.requests.push({ req, headers });
    const isGrading = !!req.output_config?.format;
    const text = isGrading ? JSON.stringify({
      score: 82, summary: 'Solid discovery.', strengths: ['Asked about impact'], improvements: ['Quantify value'],
      skills: Object.fromEntries(['discovery', 'listening', 'value', 'objection_handling', 'next_steps'].map((k) => [k, { score: 8, comment: 'ok' }])),
      key_points_covered: ['Ask a discovery question'], key_points_missed: [], best_moment: 'What does a slow close cost you?', missed_opportunity: 'x', better_line: 'y',
    }) : anthropic.reply;
    return json({
      id: `msg_${anthropic.requests.length}`, type: 'message', role: 'assistant', model: req.model,
      content: [{ type: 'thinking', thinking: '', signature: `sig${anthropic.requests.length}` }, { type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
    });
  }
  return json({ error: `unmocked ${url.href}` }, 599);
}

// ---------- App ----------
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

async function login(email) {
  const res = await realFetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

function client(cookie) {
  return async (path, { method = 'GET', body } = {}) => {
    const r = await realFetch(base + path, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Requested-With': 'pitchpulse' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* redirects */ }
    return { status: r.status, data, location: r.headers.get('location'), cookie: r.headers.get('set-cookie') };
  };
}
const anon = client('');

// ---------- SSO ----------
async function ssoRoundTrip(claims) {
  idp.claims = claims;
  const start = await anon('/auth/sso/start');
  assert.equal(start.status, 302);
  const authorize = new URL(start.location);
  assert.equal(authorize.origin + authorize.pathname, 'https://idp.test/authorize');
  idp.lastAuthorize = authorize.searchParams;
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://pitchpulse.test/auth/sso/callback');
  return anon(`/auth/sso/callback?code=abc&state=${authorize.searchParams.get('state')}`);
}

test('SSO: auth config advertises the provider', async () => {
  const { data } = await anon('/api/auth/config');
  assert.deepEqual(data, { sso: { enabled: true, name: 'Acme SSO' }, passwordLogin: true });
});

test('SSO: first sign-in provisions a rep, verifies PKCE + signed ID token, sets a session', async () => {
  const cb = await ssoRoundTrip({ sub: 'idp|new-1', email: 'new.hire@newco.com', email_verified: true, name: 'New Hire' });
  assert.equal(cb.status, 302);
  assert.equal(cb.location, '/');
  const me = await client(cb.cookie.split(';')[0])('/api/me');
  assert.equal(me.data.email, 'new.hire@newco.com');
  assert.equal(me.data.role, 'rep');
  assert.equal(me.data.name, 'New Hire');
});

test('SSO: existing users are matched by email and keep their role', async () => {
  const cb = await ssoRoundTrip({ sub: 'idp|mgr', email: 'manager@pitchpulse.dev', email_verified: true });
  const me = await client(cb.cookie.split(';')[0])('/api/me');
  assert.equal(me.data.role, 'manager');
  assert.equal(db.prepare("SELECT sso_subject FROM users WHERE email = 'manager@pitchpulse.dev'").get().sso_subject, 'idp|mgr');
});

test('SSO: rejects disallowed domains, unverified email, replayed state and bad nonce', async () => {
  let cb = await ssoRoundTrip({ sub: 'x', email: 'eve@evil.com', email_verified: true });
  assert.match(decodeURIComponent(cb.location), /evil\.com are not allowed/);
  assert.equal(cb.cookie, null);

  cb = await ssoRoundTrip({ sub: 'y', email: 'someone@newco.com', email_verified: false });
  assert.match(decodeURIComponent(cb.location), /not verified/);

  // Replaying a consumed state fails
  const replay = await anon(`/auth/sso/callback?code=abc&state=${idp.lastAuthorize.get('state')}`);
  assert.match(decodeURIComponent(replay.location), /expired or invalid/);

  // Token minted with a different nonce than the one we sent
  idp.claims = { sub: 'z', email: 'z@newco.com', nonce: 'attacker-nonce' };
  const start = await anon('/auth/sso/start');
  idp.lastAuthorize = new URL(start.location).searchParams;
  const bad = await anon(`/auth/sso/callback?code=abc&state=${idp.lastAuthorize.get('state')}`);
  assert.match(decodeURIComponent(bad.location), /nonce/);
});

test('SSO-only mode disables password sign-in', async () => {
  process.env.SSO_ONLY = 'true';
  try {
    const r = await anon('/api/login', { method: 'POST', body: { email: 'rep@pitchpulse.dev', password: DEMO_PASSWORD } });
    assert.equal(r.status, 403);
    assert.equal((await anon('/api/auth/config')).data.passwordLogin, false);
  } finally { delete process.env.SSO_ONLY; }
});

// ---------- CRM ----------
test('CRM: HubSpot sync pages through deals, maps stages and links owners by email', async () => {
  const r = await syncCrm(db, { ...(await import('../server/integrations/config.js')).config.crm(), provider: 'hubspot' });
  assert.equal(r.deals, 3);
  assert.equal(r.linked, 2);
  const rep = db.prepare("SELECT id FROM users WHERE email = 'rep@pitchpulse.dev'").get();
  const won = db.prepare("SELECT * FROM crm_deals WHERE provider = 'hubspot' AND external_id = 'd2'").get();
  assert.equal(won.user_id, rep.id);
  assert.equal(won.is_won, 1);
  assert.equal(won.stage, 'Closed Won');
  const lost = db.prepare("SELECT * FROM crm_deals WHERE provider = 'hubspot' AND external_id = 'd3'").get();
  assert.equal(lost.user_id, null);
  assert.equal(lost.is_closed, 1);
  // Re-sync is idempotent
  await syncCrm(db, { ...(await import('../server/integrations/config.js')).config.crm(), provider: 'hubspot' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crm_deals WHERE provider = 'hubspot'").get().n, 3);
});

test('CRM: Salesforce sync uses client credentials and follows nextRecordsUrl', async () => {
  process.env.CRM_PROVIDER = 'salesforce';
  try {
    const admin = client(await login('admin@pitchpulse.dev'));
    const r = await admin('/api/integrations/crm/sync', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.data.deals, 2);
    assert.equal(r.data.linked, 2);
    const tokenCall = calls.find((c) => c.url.endsWith('/services/oauth2/token'));
    assert.equal(new URLSearchParams(tokenCall.body).get('grant_type'), 'client_credentials');
    const sam = db.prepare("SELECT id FROM users WHERE email = 'sam@pitchpulse.dev'").get();
    const focus = dealFocus(db, sam.id);
    assert.ok(focus);
    const status = await admin('/api/integrations/status');
    assert.equal(status.data.crm.provider, 'salesforce');
    assert.equal(status.data.crm.lastRun.status, 'ok');

    const mgr = client(await login('manager@pitchpulse.dev'));
    assert.equal((await mgr('/api/integrations/crm/sync', { method: 'POST' })).status, 403);
    const team = await mgr('/api/manager/team');
    assert.equal(team.data.hasCrm, true);
    assert.ok(team.data.reps.every((x) => 'winRate' in x.crm));
  } finally { delete process.env.CRM_PROVIDER; }
});

test('CRM: deal stage drives the recommended skill', async () => {
  const rep = client(await login('rep@pitchpulse.dev'));
  const { data } = await rep('/api/crm/deals');
  assert.ok(data.stats.openDeals >= 1);
  const { data: today } = await rep('/api/today');
  assert.ok(today.dealFocus.topic);
});

// ---------- Calendar ----------
test('Calendar: OAuth connect stores an encrypted refresh token and syncs only external meetings', async () => {
  const rep = client(await login('rep@pitchpulse.dev'));
  const start = await rep('/integrations/calendar/connect');
  assert.equal(start.status, 302);
  const auth = new URL(start.location);
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.match(auth.searchParams.get('scope'), /calendar\.events\.readonly/);

  // Another user can't complete this user's flow
  const other = client(await login('sam@pitchpulse.dev'));
  const hijack = await other(`/integrations/calendar/callback?code=c&state=${auth.searchParams.get('state')}`);
  assert.match(decodeURIComponent(hijack.location), /different user/);

  const start2 = await rep('/integrations/calendar/connect');
  const state = new URL(start2.location).searchParams.get('state');
  const cb = await rep(`/integrations/calendar/callback?code=c&state=${state}`);
  assert.equal(cb.location, '/#/today?calendar=connected');

  const conn = db.prepare("SELECT c.* FROM calendar_connections c JOIN users u ON u.id = c.user_id WHERE u.email = 'rep@pitchpulse.dev'").get();
  assert.ok(conn);
  assert.ok(!conn.refresh_token_enc.includes('cal-refresh-SECRET'), 'refresh token must be encrypted at rest');

  const { data } = await rep('/api/calendar/meetings');
  assert.equal(data.connected, true);
  const titles = data.meetings.map((m) => m.title);
  assert.ok(titles.includes('Northwind pricing call'));
  assert.ok(!titles.includes('Team standup'));
  assert.ok(!titles.includes('Declined vendor call'));
  const nw = data.meetings.find((m) => m.title === 'Northwind pricing call');
  assert.deepEqual(nw.domains, ['northwindfreight.com']);
  assert.equal(nw.deal?.account, 'Northwind Freight');

  const me = await rep('/api/me');
  assert.equal(me.data.integrations.calendar.connected, true);
  await rep('/api/calendar/disconnect', { method: 'POST' });
  assert.equal((await rep('/api/me')).data.integrations.calendar.connected, false);
});

// ---------- Google Chat ----------
function chatToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: 'chat@system.gserviceaccount.com', aud: '123456789', iat: now, exp: now + 300, ...overrides }, PRIV_PEM, 'test-key');
}
async function chatEvent(event, token = chatToken()) {
  const r = await realFetch(`${base}/integrations/google-chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(event),
  });
  return { status: r.status, data: await r.json() };
}

test('Google Chat: rejects unsigned, wrong-audience and wrong-issuer requests', async () => {
  const ev = { type: 'MESSAGE', user: { email: 'rep@pitchpulse.dev' }, space: { name: 'spaces/X', type: 'DM' }, message: { text: 'hi' } };
  assert.equal((await chatEvent(ev, 'not-a-jwt')).status, 401);
  assert.equal((await chatEvent(ev, chatToken({ aud: '999' }))).status, 401);
  assert.equal((await chatEvent(ev, chatToken({ iss: 'someone@else.com' }))).status, 401);
  assert.equal((await chatEvent(ev, chatToken({ exp: 1000 }))).status, 401);
});

test('Google Chat: DM links the rep and the Daily Challenge works through interactive cards', async () => {
  const user = { email: 'casey@pitchpulse.dev', name: 'users/1' };
  const space = { name: 'spaces/DM-CASEY', type: 'DM' };
  const added = await chatEvent({ type: 'ADDED_TO_SPACE', user, space });
  assert.equal(added.status, 200);
  assert.match(added.data.text, /Welcome, Casey/);
  const casey = db.prepare("SELECT id FROM users WHERE email = 'casey@pitchpulse.dev'").get();
  assert.equal(db.prepare('SELECT space_name FROM chat_links WHERE user_id = ?').get(casey.id).space_name, 'spaces/DM-CASEY');

  const day = dayOf();
  for (let i = 0; i < 3; i++) {
    const challenge = JSON.parse(db.prepare('SELECT question_ids FROM daily_challenges WHERE user_id = ? AND day = ?').get(casey.id, day).question_ids);
    const answered = db.prepare('SELECT question_id FROM daily_answers WHERE user_id = ? AND day = ?').all(casey.id, day).map((r) => r.question_id);
    const qid = challenge.find((id) => !answered.includes(id));
    const correct = db.prepare('SELECT answer_index FROM questions WHERE id = ?').get(qid).answer_index;
    const click = await chatEvent({
      type: 'CARD_CLICKED', user, space,
      common: { invokedFunction: 'answer', parameters: { q: String(qid), c: String(correct), d: day } },
    });
    assert.equal(click.data.actionResponse.type, 'UPDATE_MESSAGE');
    const text = JSON.stringify(click.data.cardsV2);
    assert.match(text, /Correct!/);
    if (i === 2) assert.match(text, /Challenge complete: 3\/3/);
  }
  const done = db.prepare('SELECT completed_at, correct_count FROM daily_challenges WHERE user_id = ? AND day = ?').get(casey.id, day);
  assert.ok(done.completed_at);
  assert.equal(done.correct_count, 3);

  // Legacy action format + duplicate click is handled gracefully
  const again = await chatEvent({ type: 'CARD_CLICKED', user, space, action: { actionMethodName: 'answer', parameters: [{ key: 'q', value: '1' }, { key: 'c', value: '0' }, { key: 'd', value: day }] } });
  assert.equal(again.status, 200);

  const streak = await chatEvent({ type: 'MESSAGE', user, space, message: { text: 'streak' } });
  assert.match(streak.data.text, /streak/);
  const lb = await chatEvent({ type: 'MESSAGE', user, space, message: { text: 'leaderboard' } });
  assert.match(lb.data.text, /leaderboard/);
});

test('Google Chat: unknown users get a helpful message; expired cards show today', async () => {
  const unknown = await chatEvent({ type: 'MESSAGE', user: { email: 'who@nowhere.com' }, space: { name: 'spaces/Q', type: 'DM' }, message: { text: 'hi' } });
  assert.match(unknown.data.text, /couldn't find a PitchPulse account/);
  const old = await chatEvent({ type: 'CARD_CLICKED', user: { email: 'taylor@pitchpulse.dev' }, space: { name: 'spaces/T', type: 'DM' }, common: { invokedFunction: 'answer', parameters: { q: '1', c: '0', d: '2020-01-01' } } });
  assert.match(JSON.stringify(old.data), /expired/);
});

test('Google Chat: morning send authenticates as the service account and DMs linked reps', async () => {
  const before = calls.length;
  const r = await sendDailyChallenges(db);
  assert.ok(r.sent >= 1);
  const newCalls = calls.slice(before);
  const tokenCall = newCalls.find((c) => c.url === 'https://google.test/token');
  const assertion = new URLSearchParams(tokenCall.body).get('assertion');
  const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/chat.bot');
  assert.equal(payload.iss, 'pp-bot@proj.iam.gserviceaccount.com');
  const post = newCalls.find((c) => c.url.includes('/chat/v1/spaces/') && c.method === 'POST');
  assert.equal(post.headers.get('authorization'), 'Bearer chat-bot-token');
  assert.ok(JSON.parse(post.body).cardsV2);
  // Casey already completed today's challenge, so she is skipped.
  assert.ok(!newCalls.some((c) => c.url.includes('DM-CASEY')));
});

// ---------- AI role-plays ----------
test('Role-play (Claude): buyer opens, history is replayed append-only, scorecard uses structured output', async () => {
  const rep = client(await login('rep@pitchpulse.dev'));
  const start = await rep('/api/roleplays', { method: 'POST', body: { scenarioId: 1, difficulty: 'tough' } });
  assert.equal(start.status, 200);
  assert.equal(start.data.source, 'ai');
  assert.equal(start.data.transcript[0].role, 'buyer');

  const first = anthropic.requests.at(-1);
  assert.equal(first.req.model, 'claude-opus-5-5');
  assert.equal(first.req.fallbacks, 'default');
  assert.match(first.headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.match(first.req.system, /busy and hard to impress/);
  assert.equal(first.req.thinking, undefined);

  anthropic.reply = 'Fair. What exactly would change for my team? [END_CALL]';
  const turn = await rep(`/api/roleplays/${start.data.id}/message`, { method: 'POST', body: { text: 'What does a 12-day close cost you each month?' } });
  assert.equal(turn.data.reply, 'Fair. What exactly would change for my team?');
  assert.equal(turn.data.ended, true);
  const second = anthropic.requests.at(-1).req.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  assert.deepEqual(second[1].content[0], { type: 'thinking', thinking: '', signature: 'sig1' }, 'prior assistant turn must be replayed verbatim');
  assert.equal(second[2].content, 'What does a 12-day close cost you each month?');

  await rep(`/api/roleplays/${start.data.id}/message`, { method: 'POST', body: { text: 'Can we book 30 minutes Thursday?' } });
  const end = await rep(`/api/roleplays/${start.data.id}/end`, { method: 'POST' });
  assert.equal(end.status, 200);
  assert.equal(end.data.status, 'completed');
  assert.equal(end.data.score, 82);
  assert.equal(end.data.feedback.source, 'ai');
  assert.ok(end.data.feedback.talk_ratio > 0);
  assert.equal(anthropic.requests.at(-1).req.output_config.format.type, 'json_schema');

  const closed = await rep(`/api/roleplays/${start.data.id}/message`, { method: 'POST', body: { text: 'hello?' } });
  assert.equal(closed.status, 409);
});

test('Role-play: meeting-based buyer is built from the calendar event and CRM deal; users cannot read others\' calls', async () => {
  const rep = client(await login('rep@pitchpulse.dev'));
  const repId = db.prepare("SELECT id FROM users WHERE email = 'rep@pitchpulse.dev'").get().id;
  const meeting = { id: Number(db.prepare(`INSERT INTO calendar_events (user_id, external_id, title, start_at, attendees, external_domains)
    VALUES (?, 'rp-1', 'Northwind QBR', ?, '["cfo@northwindfreight.com"]', '["northwindfreight.com"]')`).run(repId, new Date(Date.now() + 7200e3).toISOString()).lastInsertRowid) };
  const r = await rep('/api/roleplays', { method: 'POST', body: { meetingId: meeting.id, difficulty: 'skeptical' } });
  assert.equal(r.status, 200);
  assert.match(r.data.title, /^Prep: Northwind/);
  assert.match(r.data.situation, /Northwind Freight – Expansion/);
  const sam = client(await login('sam@pitchpulse.dev'));
  assert.equal((await sam(`/api/roleplays/${r.data.id}`)).status, 404);
  assert.equal((await sam('/api/roleplays', { method: 'POST', body: { meetingId: meeting.id } })).status, 404);
});
