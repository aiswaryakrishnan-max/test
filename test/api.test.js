import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seed, DEMO_PASSWORD } from '../server/seed.js';
import { addDays, dayOf, levelInfo, pickDailyQuestions, streakInfo, weekStart } from '../server/engagement.js';
import { scoreWithRubric } from '../server/coach.js';
import { sendDailyReminders } from '../server/reminders.js';

delete process.env.ANTHROPIC_API_KEY; // always use the offline rubric in tests

let server;
let base;
let db;

before(async () => {
  db = openDb(':memory:');
  seed(db);
  server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body, csrf = true } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(csrf ? { 'X-Requested-With': 'pitchpulse' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
}

test('rejects bad credentials and unauthenticated requests', async () => {
  const res = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email: 'rep@pitchpulse.dev', password: 'nope' }) });
  assert.equal(res.status, 401);
  assert.equal((await fetch(`${base}/api/today`)).status, 401);
});

test('mutations require the CSRF header', async () => {
  const rep = await login('rep@pitchpulse.dev');
  const r = await rep('/api/me', { method: 'PATCH', body: { daily_goal_xp: 80 }, csrf: false });
  assert.equal(r.status, 403);
});

test('daily challenge: answer all questions, earn XP, streak counts today', async () => {
  const rep = await login('jordan@pitchpulse.dev'); // seeded with no current streak
  const { data: t } = await rep('/api/today');
  assert.equal(t.challenge.questions.length, 3);
  assert.equal(t.streak.activeToday, false);
  assert.ok(t.questions === undefined);
  // Answer keys must not leak before answering
  assert.ok(t.challenge.questions.every((q) => q.answer_index === undefined));

  let last;
  for (const q of t.challenge.questions) {
    const correct = db.prepare('SELECT answer_index FROM questions WHERE id = ?').get(q.id).answer_index;
    last = await rep('/api/daily/answer', { method: 'POST', body: { questionId: q.id, choice: correct } });
    assert.equal(last.status, 200);
    assert.equal(last.data.correct, true);
  }
  assert.equal(last.data.completed, true);
  assert.equal(last.data.correctCount, 3);
  assert.ok(last.data.newBadges.some((b) => b.code === 'perfect_day'));

  const dup = await rep('/api/daily/answer', { method: 'POST', body: { questionId: t.challenge.questions[0].id, choice: 0 } });
  assert.equal(dup.status, 409);

  const { data: after } = await rep('/api/today');
  assert.equal(after.challenge.completed, true);
  assert.equal(after.streak.activeToday, true);
  assert.equal(after.xpToday, 3 * 10 + 20 + 15);
});

test('cannot answer a question outside today\'s challenge', async () => {
  const rep = await login('taylor@pitchpulse.dev');
  const { data: t } = await rep('/api/today');
  const other = db.prepare(`SELECT id FROM questions WHERE id NOT IN (${t.challenge.questions.map((q) => q.id).join(',')}) LIMIT 1`).get();
  const r = await rep('/api/daily/answer', { method: 'POST', body: { questionId: other.id, choice: 0 } });
  assert.equal(r.status, 400);
});

test('module completion awards XP once and requires 60%', async () => {
  const rep = await login('casey@pitchpulse.dev');
  const mod = db.prepare('SELECT id, xp FROM modules ORDER BY id DESC LIMIT 1').get();
  const qs = db.prepare('SELECT answer_index, options FROM questions WHERE module_id = ? ORDER BY id').all(mod.id);
  const wrong = qs.map((q) => (q.answer_index + 1) % JSON.parse(q.options).length);
  const fail = await rep(`/api/modules/${mod.id}/complete`, { method: 'POST', body: { answers: wrong } });
  assert.equal(fail.data.passed, false);
  assert.equal(fail.data.xpGained, 0);

  const right = qs.map((q) => q.answer_index);
  const pass = await rep(`/api/modules/${mod.id}/complete`, { method: 'POST', body: { answers: right } });
  assert.equal(pass.data.passed, true);
  assert.equal(pass.data.xpGained, mod.xp);
  const again = await rep(`/api/modules/${mod.id}/complete`, { method: 'POST', body: { answers: right } });
  assert.equal(again.data.xpGained, 0);
});

test('pitch practice scores with rubric and rewards XP once per day per scenario', async () => {
  const rep = await login('rep@pitchpulse.dev');
  const pitch = `Dana, you mentioned wanting to close the books in under 5 days instead of 12. Northwind Freight cut their close
    from 11 days to 4 within a month using us — that's a 60% time saving for their finance team. What's the biggest bottleneck in your
    close today? If it's useful, could we book 30 minutes next Tuesday to walk through how they did it as a next step?`;
  const r1 = await rep('/api/scenarios/1/attempt', { method: 'POST', body: { pitch } });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.source, 'rubric');
  assert.ok(r1.data.score >= 70, `expected strong score, got ${r1.data.score}`);
  assert.ok(r1.data.xpGained > 0);
  const r2 = await rep('/api/scenarios/1/attempt', { method: 'POST', body: { pitch } });
  assert.equal(r2.data.xpGained, 0);

  const short = await rep('/api/scenarios/1/attempt', { method: 'POST', body: { pitch: 'Buy our product.' } });
  assert.equal(short.status, 400);
});

test('rubric penalises a pitch with no question, numbers or next step', () => {
  const weak = scoreWithRubric(['Quantify savings', 'Ask a discovery question', 'Propose a next meeting'], 'Our product is great and has many features that everyone loves and you should consider it because it is good.');
  assert.ok(weak.score < 50);
  assert.ok(weak.improvements.length >= 3);
});

test('role checks: reps cannot reach manager endpoints; managers only see their team', async () => {
  const rep = await login('rep@pitchpulse.dev');
  assert.equal((await rep('/api/manager/team')).status, 403);
  assert.equal((await rep('/api/content/tips', { method: 'POST', body: { text: 'x' } })).status, 403);

  const mgr = await login('manager@pitchpulse.dev');
  const { data } = await mgr('/api/manager/team');
  assert.equal(data.reps.length, 3);
  assert.ok(data.reps.every((r) => r.team === 'Enterprise East'));
  const casey = db.prepare("SELECT id FROM users WHERE email = 'casey@pitchpulse.dev'").get();
  assert.equal((await mgr('/api/manager/nudge', { method: 'POST', body: { userId: casey.id } })).status, 403);
});

test('manager nudge, kudos and assignment create notifications', async () => {
  const mgr = await login('manager@pitchpulse.dev');
  const sam = db.prepare("SELECT id FROM users WHERE email = 'sam@pitchpulse.dev'").get();
  assert.equal((await mgr('/api/manager/nudge', { method: 'POST', body: { userId: sam.id } })).status, 200);
  assert.equal((await mgr('/api/manager/kudos', { method: 'POST', body: { userId: sam.id, message: 'Great week!' } })).status, 200);
  const a = await mgr('/api/manager/assign', { method: 'POST', body: { moduleId: 4, dueDate: addDays(dayOf(), 5) } });
  assert.equal(a.data.notified, 3);

  const samApi = await login('sam@pitchpulse.dev');
  const { data: inbox } = await samApi('/api/notifications');
  assert.deepEqual(new Set(inbox.map((n) => n.kind)), new Set(['nudge', 'kudos', 'assignment']));
  const { data: today } = await samApi('/api/today');
  assert.ok(today.assignments.some((x) => x.module_id === 4));
});

test('content studio: manager publishes a module whose questions join the daily pool', async () => {
  const mgr = await login('manager@pitchpulse.dev');
  const before = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
  const r = await mgr('/api/content/modules', {
    method: 'POST',
    body: {
      title: 'Negotiation basics', topic: 'Negotiation', summary: 'Trade, don’t give.', body: '## Intro\nAlways trade.',
      questions: [{ prompt: 'Concessions should be…', options: ['Given', 'Traded'], answer_index: 1, explanation: 'Trade.' }],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions').get().n, before + 1);
  const bad = await mgr('/api/content/modules', { method: 'POST', body: { title: 't', topic: 't', summary: 's', body: 'b', questions: [{ prompt: 'p', options: ['a', 'b'], answer_index: 5 }] } });
  assert.equal(bad.status, 400);
});

test('leaderboard ranks reps by weekly XP and flags the current user', async () => {
  const rep = await login('rep@pitchpulse.dev');
  const { data } = await rep('/api/leaderboard?period=week');
  assert.ok(data.reps.length >= 5);
  for (let i = 1; i < data.reps.length; i++) assert.ok(data.reps[i - 1].xp >= data.reps[i].xp);
  assert.equal(data.reps.filter((r) => r.me).length, 1);
  assert.ok(data.teams.length === 2);
});

test('daily reminders target only reps with no activity today', async () => {
  const day = dayOf();
  const inactive = db.prepare("SELECT u.id FROM users u WHERE role = 'rep' AND NOT EXISTS (SELECT 1 FROM xp_events x WHERE x.user_id = u.id AND x.day = ?)").all(day).length;
  assert.equal(await sendDailyReminders(db, day), inactive);
});

// ---------- Engine unit tests ----------

test('streaks: active yesterday keeps streak alive but at risk', () => {
  const d = openDb(':memory:');
  d.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('a@b.c', 'A', 'x:y', 'rep')").run();
  const today = '2026-03-10';
  for (const day of ['2026-03-06', '2026-03-08', '2026-03-09']) d.prepare("INSERT INTO xp_events (user_id, amount, reason, day) VALUES (1, 10, 't', ?)").run(day);
  const s = streakInfo(d, 1, today);
  assert.deepEqual(s, { current: 2, longest: 2, activeToday: false, atRisk: true });
  d.prepare("INSERT INTO xp_events (user_id, amount, reason, day) VALUES (1, 10, 't', ?)").run(today);
  assert.equal(streakInfo(d, 1, today).current, 3);
  assert.equal(streakInfo(d, 1, '2026-03-12').current, 0);
});

test('spaced repetition: recently missed questions are prioritised, fresh correct ones are not', () => {
  const d = openDb(':memory:');
  d.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('a@b.c', 'A', 'x:y', 'rep')").run();
  for (let i = 1; i <= 6; i++) d.prepare("INSERT INTO questions (topic, prompt, options, answer_index) VALUES ('t', ?, '[\"a\",\"b\"]', 0)").run(`q${i}`);
  const today = '2026-03-10';
  const ans = (q, correct, day) => d.prepare("INSERT INTO answers (user_id, question_id, correct, context, day) VALUES (1, ?, ?, 'daily', ?)").run(q, correct, day);
  ans(1, 0, '2026-03-09'); // missed yesterday -> top priority
  ans(2, 1, '2026-03-09'); // correct yesterday -> not due
  ans(3, 1, '2026-03-09');
  ans(4, 1, '2026-03-09');
  const picked = pickDailyQuestions(d, 1, today, 3, () => 0);
  assert.equal(picked[0], 1);
  assert.deepEqual(new Set(picked.slice(1)), new Set([5, 6]));
});

test('levels and week boundaries', () => {
  assert.equal(levelInfo(0).level, 1);
  assert.equal(levelInfo(99).level, 1);
  assert.equal(levelInfo(100).level, 2);
  assert.equal(levelInfo(300).level, 3);
  assert.equal(weekStart('2026-10-07'), '2026-10-05'); // Wednesday -> Monday
  assert.equal(weekStart('2026-10-05'), '2026-10-05');
  assert.equal(weekStart('2026-10-11'), '2026-10-05'); // Sunday
});

test('role-play works offline with the scripted buyer and rubric scorecard', async () => {
  const { extensions } = await import('../server/extensions.js');
  const d = openDb(':memory:');
  seed(d, { history: false });
  const srv = createServer(createApp(d, { extensions }));
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const login = await fetch(`${url}/api/login`, { method: 'POST', body: JSON.stringify({ email: 'rep@pitchpulse.dev', password: DEMO_PASSWORD }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (path, body) => (await fetch(url + path, {
      method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Requested-With': 'pitchpulse', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })).json();
    const rp = await call('/api/roleplays', { scenarioId: 2, difficulty: 'skeptical' });
    assert.equal(rp.source, 'scripted');
    assert.match(rp.transcript[0].text, /Marcus/);
    const early = await call(`/api/roleplays/${rp.id}/message`, { text: "Let's book a meeting next week." });
    assert.equal(early.ended, false, 'buyer should not agree to a next step before any discovery');
    await call(`/api/roleplays/${rp.id}/message`, { text: 'I understand the budget concern. What is procurement comparing us against?' });
    await call(`/api/roleplays/${rp.id}/message`, { text: 'What happens if the reporting delays continue another quarter?' });
    const close = await call(`/api/roleplays/${rp.id}/message`, { text: 'If you can commit to a two-year term, can we schedule a call with procurement on Thursday as a next step?' });
    assert.equal(close.ended, true);
    const end = await call(`/api/roleplays/${rp.id}/end`, {});
    assert.equal(end.status, 'completed');
    assert.equal(end.feedback.source, 'rubric');
    assert.ok(end.feedback.skills.discovery.score >= 5);
    assert.equal(end.feedback.skills.next_steps.score, 9);
    assert.ok(end.xpGained > 0);
  } finally { srv.close(); }
});

test('JWT key loader understands x509 certificate maps (Google Chat project-number mode)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fetchKeys, signJwt, verifyJwt } = await import('../server/integrations/jwt.js');
  const dir = mkdtempSync(join(tmpdir(), 'pp-x509-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=chat'], { stdio: 'ignore' });
  } catch { return; } // openssl not installed: skip
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ kid1: readFileSync(join(dir, 'c.pem'), 'utf8') }));
  try {
    const keys = await fetchKeys('https://certs.test/x509', { force: true });
    assert.ok(keys.has('kid1'));
    const now = Math.floor(Date.now() / 1000);
    const tok = signJwt({ iss: 'chat@system.gserviceaccount.com', aud: '42', exp: now + 60 }, readFileSync(join(dir, 'k.pem'), 'utf8'), 'kid1');
    const claims = await verifyJwt(tok, { keysUrl: 'https://certs.test/x509', issuers: ['chat@system.gserviceaccount.com'], audience: '42' });
    assert.equal(claims.aud, '42');
  } finally { globalThis.fetch = realFetch; }
});
