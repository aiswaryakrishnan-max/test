// Daily GTM digest pipeline (execution guide §5, steady-state calendar):
//   Wednesday   plan next week's topics from rotations and Gong trends; the enablement lead edits them
//   Thursday    Claude drafts all five days from approved sources; validators flag problems
//   Friday      reviewers approve (competitor and win/loss cards always need a human)
//   Sunday 8pm  approved cards are queued; any day not approved gets a short fallback card
//   Mon-Fri     the day's card goes to each rep's Chat DM at DIGEST_SEND_TIME in their local time
import { timingSafeEqual } from 'node:crypto';
import { getClient } from '../coach.js';
import { HttpError } from '../errors.js';
import { addDays, dayOf, notify, weekStart } from '../engagement.js';
import { config } from '../integrations/config.js';
import { logRun } from '../integrations/crm.js';
import { sign } from '../integrations/secrets.js';
import { deliverCard, loadCard, mirrorToSpace, recordAnswer } from './chat.js';
import { draftDay, sourcePack } from './compose.js';
import { DAYS, DAY_INFO, competitorNames } from './defaults.js';
import { weekPage } from './page.js';
import { buildPlan, rotations, updatePlan } from './plan.js';
import { fetchApprovedLibrary, fetchGong, fetchWinLoss, nextApprovedClip, researchWeb } from './sources.js';
import { isSensitive, validateCard } from './validate.js';
import { renderVisualPng } from './visuals.js';

const DELIVERABLE = "('queued', 'approved', 'fallback')";

// ---------- Storage helpers ----------

const parseWeek = (row) => row && { ...row, plan: JSON.parse(row.plan), sources: JSON.parse(row.sources) };
export const getWeek = (db, week) => parseWeek(db.prepare('SELECT * FROM digest_weeks WHERE week = ?').get(week));
const getWeekById = (db, id) => parseWeek(db.prepare('SELECT * FROM digest_weeks WHERE id = ?').get(id));
const parseCard = (row) => row && { ...row, image: undefined, hasImage: !!row.image, content: JSON.parse(row.content), issues: JSON.parse(row.issues) };
const weekCards = (db, weekId) => db.prepare('SELECT * FROM digest_cards WHERE week_id = ?').all(weekId).map(parseCard)
  .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));

function saveCard(db, weekId, day, { status, content, issues = [], sensitive = false, image = null }) {
  db.prepare(`INSERT INTO digest_cards (week_id, day, status, content, issues, sensitive, image, approved_by, approved_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, datetime('now'))
    ON CONFLICT (week_id, day) DO UPDATE SET status = excluded.status, content = excluded.content, issues = excluded.issues,
      sensitive = excluded.sensitive, image = excluded.image, approved_by = NULL, approved_at = NULL, updated_at = datetime('now')`)
    .run(weekId, day, status, JSON.stringify(content), JSON.stringify(issues), sensitive ? 1 : 0, image);
  return db.prepare('SELECT id FROM digest_cards WHERE week_id = ? AND day = ?').get(weekId, day).id;
}

/** Monday of the week the pipeline is preparing: next week from Wednesday on (and on Sunday). */
export const upcomingWeek = (today = dayOf()) => addDays(weekStart(today), 7);

// ---------- Wednesday: plan ----------

export async function planWeek(db, { week = upcomingWeek(), now = new Date(), cfg = config.digest() } = {}) {
  const existing = getWeek(db, week);
  if (existing) return existing;
  let trackers = null;
  let note = '';
  if (cfg.gong.enabled) {
    try { trackers = (await fetchGong(cfg.gong, now)).trackers; } catch (err) { note = ` (Gong trends unavailable: ${err.message})`; }
  }
  const plan = buildPlan({ week, cfg, trackers });
  db.prepare('INSERT INTO digest_weeks (week, plan) VALUES (?, ?)').run(week, JSON.stringify(plan));
  logRun(db, 'digest_plan', note ? 'error' : 'ok', `Planned week of ${week}: ${plan.persona}, ${plan.competitor}, ${plan.useCase}${note}`);
  return getWeek(db, week);
}

// ---------- Thursday: draft ----------

function validationContext(db, catalog, cfg) {
  const accountNames = db.prepare('SELECT DISTINCT account FROM crm_deals WHERE account IS NOT NULL').all().map((r) => r.account);
  const caseText = Object.values(catalog).filter((s) => s.category === 'case_study').map((s) => (s.text || '').toLowerCase()).join('\n');
  // Approved references: listed in config, or named in an approved, published case study.
  const allowedNames = accountNames.filter((n) => cfg.referenceCustomers.includes(n.toLowerCase()) || (n.length >= 4 && caseText.includes(n.toLowerCase())));
  return { catalog, accountNames, allowedNames, competitors: competitorNames(rotations(cfg).competitors) };
}

async function renderImage(day, content, issues, cfg) {
  if (!cfg.renderImages || day === 'fri' || issues.some((i) => i.level === 'error' && i.path.startsWith('visual'))) return null;
  try {
    return await renderVisualPng(day, content);
  } catch (err) {
    issues.push({ level: 'warn', path: 'visual', message: `Image not rendered (${err.message.split('\n')[0]}); the card goes out without it` });
    return null;
  }
}

async function collect(db, week, { now, cfg, anthropic }) {
  const errors = [];
  const attempt = async (name, enabled, fn, fallback) => {
    if (!enabled) return fallback;
    try { return await fn(); } catch (err) { errors.push(err.message.startsWith(name) ? err.message : `${name}: ${err.message}`); return fallback; }
  };
  const [gong, library, web] = await Promise.all([
    attempt('Gong', cfg.gong.enabled, () => fetchGong(cfg.gong, now), { calls: [], trackers: null }),
    attempt('Drive', cfg.drive.enabled, () => fetchApprovedLibrary(cfg.drive, now), { docs: [], skipped: [] }),
    attempt('Web', cfg.web.enabled, () => researchWeb(anthropic, cfg.web, { focus: week.plan.focus, personas: rotations(cfg).personas, now }), { notes: '', sources: [] }),
  ]);
  const winLoss = fetchWinLoss(db, now, cfg.minDealsForWeek);
  const clip = nextApprovedClip(db, week.id);
  const catalog = {};
  for (const d of library.docs) catalog[d.id] = { type: 'drive', title: d.title, url: d.url, category: d.category, owner: d.owner, reviewed: d.reviewed, ...(d.category === 'case_study' ? { text: d.text } : {}) };
  // Gong call titles usually name the account, so the catalog (shown under each card) uses a neutral label.
  for (const c of gong.calls) catalog[c.id] = { type: 'gong', title: `Gong call (${c.minutes} min${c.outcome ? `, ${c.outcome}` : ''})`, url: c.url };
  for (const w of winLoss.items) { const { id, ...rest } = w; catalog[id] = rest; }
  for (const s of web.sources) catalog[s.id] = { type: 'web', title: s.title, url: s.url };
  if (clip) catalog[clip.id] = { type: 'clip', title: clip.title, url: clip.url };
  return { gong: gong.calls, docs: library.docs, skipped: library.skipped, winLoss, web, clip, catalog, errors };
}

function earlierSummary(cards) {
  return ['mon', 'tue', 'wed', 'thu'].map((d) => cards[d]).filter(Boolean).map((c) => `- ${DAY_INFO[c.day].name}: "${c.content.headline}". Quiz: ${c.content.quiz?.[0]?.question || 'none'} Sources: ${[...new Set((c.content.quiz || []).map((q) => q.source_id))].join(', ')}`).join('\n');
}

/** Draft all five days (or just `days`) for a planned week. */
export async function draftWeek(db, weekId, { now = new Date(), cfg = config.digest(), days = DAYS } = {}) {
  const anthropic = getClient();
  if (!anthropic) throw new HttpError(400, 'Set ANTHROPIC_API_KEY: Claude drafts the cards');
  const week = getWeekById(db, weekId);
  if (!week) throw new HttpError(404, 'Week not found');
  const src = await collect(db, week, { now, cfg, anthropic });
  if (!src.docs.length && !src.gong.length && !src.web.notes) {
    const msg = `No approved sources for the week of ${week.week}${src.errors.length ? `: ${src.errors.join('; ')}` : ''}`;
    logRun(db, 'digest_draft', 'error', msg);
    throw new HttpError(422, msg);
  }
  const catalog = days.length === DAYS.length ? src.catalog : { ...week.sources, ...src.catalog };
  db.prepare("UPDATE digest_weeks SET sources = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(catalog), week.id);
  const ctx = validationContext(db, catalog, cfg);
  const pack = sourcePack(src);
  const recentTerms = db.prepare(`SELECT c.content FROM digest_cards c JOIN digest_weeks w ON w.id = c.week_id
    WHERE c.day = 'mon' AND w.week < ? AND w.week >= ? AND c.status != 'fallback'`).all(week.week, addDays(week.week, -56))
    .flatMap((r) => (JSON.parse(r.content).terms || []).map((t) => t.term));
  const cards = Object.fromEntries(weekCards(db, week.id).map((c) => [c.day, c]));

  const draft = async (day) => {
    const validate = (card) => validateCard(day, card, ctx);
    const { card } = await draftDay(anthropic, day, { pack, plan: week.plan, recentTerms, earlier: day === 'fri' ? earlierSummary(cards) : '' }, validate);
    if (day === 'fri') {
      card.clip = src.clip ? { title: src.clip.title, url: src.clip.url, why: src.clip.why, skill: src.clip.skill } : null;
    }
    const issues = validate(card);
    const image = await renderImage(day, card, issues, cfg);
    const id = saveCard(db, week.id, day, { status: 'draft', content: card, issues, sensitive: isSensitive(day, card, ctx.competitors), image });
    cards[day] = parseCard(db.prepare('SELECT * FROM digest_cards WHERE id = ?').get(id));
  };
  const wanted = DAYS.filter((d) => days.includes(d));
  // Monday first so the shared source pack is cached, then Tue-Thu together, then Friday's recap of the week.
  if (wanted.includes('mon')) await draft('mon');
  await Promise.all(wanted.filter((d) => ['tue', 'wed', 'thu'].includes(d)).map(draft));
  if (wanted.includes('fri')) await draft('fri');
  if (src.clip && wanted.includes('fri')) db.prepare('UPDATE digest_clips SET used_week_id = ? WHERE id = ?').run(week.id, src.clip.clipId);

  const term = cards.mon?.content.terms?.[0]?.term;
  const question = cards.tue?.content.discovery?.[0]?.question;
  const challenge = `Use one new term${term ? ` (try "${term}")` : ''} and one discovery question${question ? ` (try "${question}")` : ''} on a live call. Reply in the digest thread with what the customer said back.`;
  db.prepare("UPDATE digest_weeks SET challenge = ?, status = CASE WHEN status = 'queued' THEN status ELSE 'drafted' END, updated_at = datetime('now') WHERE id = ?").run(challenge, week.id);

  const errors = wanted.filter((d) => cards[d].issues.some((i) => i.level === 'error'));
  const skipped = src.skipped.length ? `; ${src.skipped.length} Drive files skipped (${src.skipped.slice(0, 3).map((s) => `${s.title}: ${s.reason}`).join('; ')})` : '';
  logRun(db, 'digest_draft', src.errors.length ? 'error' : 'ok',
    `Drafted ${wanted.length} card(s) for the week of ${week.week} from ${src.docs.length} Drive docs, ${src.gong.length} Gong calls, ${src.winLoss.items.length} Salesforce items, ${src.web.sources.length} web sources${errors.length ? `; validator errors on ${errors.join(', ')}` : ''}${src.errors.length ? `; source errors: ${src.errors.join('; ')}` : ''}${skipped}`);
  if (wanted.length === DAYS.length) {
    for (const r of db.prepare("SELECT id FROM users WHERE role IN ('admin', 'manager')").all()) {
      notify(db, r.id, 'digest', `Next week's daily digest (week of ${week.week}) is drafted and ready for review.`);
    }
  }
  return weekDetail(db, week.id);
}

// ---------- Friday: review ----------

export async function editCard(db, cardId, content, cfg = config.digest()) {
  const card = loadCard(db, cardId);
  if (!card) throw new HttpError(404, 'Card not found');
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new HttpError(400, 'content must be the card object');
  const ctx = validationContext(db, card.catalog, cfg);
  const issues = content.fallback ? [] : validateCard(card.day, content, ctx);
  const image = content.fallback ? null : await renderImage(card.day, content, issues, cfg);
  saveCard(db, card.week_id, card.day, { status: content.fallback ? 'fallback' : 'draft', content, issues, sensitive: isSensitive(card.day, content, ctx.competitors), image });
  return parseCard(db.prepare('SELECT * FROM digest_cards WHERE id = ?').get(cardId));
}

export async function approveCard(db, cardId, user, cfg = config.digest()) {
  let card = loadCard(db, cardId);
  if (!card) throw new HttpError(404, 'Card not found');
  if (card.status === 'fallback' && card.content.replaced_draft) {
    // Only swap the queued refresher for the draft once the draft passes; otherwise the day would go out empty.
    const draft = card.content.replaced_draft;
    const errors = validateCard(card.day, draft, validationContext(db, card.catalog, cfg)).filter((i) => i.level === 'error');
    if (errors.length) throw new HttpError(400, `The draft still has validator errors (${errors[0].path}: ${errors[0].message}). Edit it first; the refresher stays queued.`);
    card = { ...card, ...(await editCard(db, cardId, draft, cfg)) };
  }
  if (card.issues.some((i) => i.level === 'error')) throw new HttpError(400, 'Fix the validator errors (edit or regenerate the card) before approving');
  const week = getWeekById(db, card.week_id);
  db.prepare("UPDATE digest_cards SET status = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(week.status === 'queued' ? 'queued' : 'approved', user.id, cardId);
  return parseCard(db.prepare('SELECT * FROM digest_cards WHERE id = ?').get(cardId));
}

// ---------- Sunday: queue, with fallbacks ----------

function fallbackContent(db, week, day, replaced) {
  const old = db.prepare(`SELECT c.content, w.week FROM digest_cards c JOIN digest_weeks w ON w.id = c.week_id
    WHERE c.day = ? AND w.week < ? AND w.week >= ? AND c.status IN ('queued', 'approved') ORDER BY w.week DESC LIMIT 1`).get(day, week, addDays(week, -56));
  const base = { fallback: true, ...(replaced ? { replaced_draft: replaced } : {}) };
  if (old) {
    const c = JSON.parse(old.content);
    const headline = `Refresher: ${c.headline}`.split(/\s+/).slice(0, 12).join(' ');
    return { ...base, headline, from_week: old.week, say_it: c.say_it, quiz: (c.quiz || []).slice(0, day === 'fri' ? 3 : 1),
      body_points: [{ text: `Today's card is still in review, so here is a refresher from the week of ${old.week}.`, source_ids: [] }, ...(c.body_points || []).slice(0, 2)] };
  }
  return { ...base, headline: `${DAY_INFO[day].theme}: today's card is in review`, say_it: '', quiz: [],
    body_points: [{ text: 'Today\'s card is still in review. Take two minutes to practice a pitch or a role-play in PitchPulse instead.', source_ids: [] }] };
}

export async function queueWeek(db, week, { cfg = config.digest(), now = new Date() } = {}) {
  const w = getWeek(db, week) || await planWeek(db, { week, now, cfg });
  const cards = Object.fromEntries(weekCards(db, w.id).map((c) => [c.day, c]));
  const counts = { approved: 0, auto: 0, fallback: 0 };
  for (const day of DAYS) {
    const c = cards[day];
    if (c && (c.status === 'queued' || c.status === 'approved')) {
      db.prepare("UPDATE digest_cards SET status = 'queued' WHERE id = ?").run(c.id);
      counts.approved++;
    } else if (c && c.status === 'draft' && cfg.approval === 'sensitive' && !c.sensitive && !c.issues.some((i) => i.level === 'error')) {
      // After the pilot: spot-check mode auto-approves clean, non-sensitive cards.
      db.prepare("UPDATE digest_cards SET status = 'queued', approved_at = datetime('now') WHERE id = ?").run(c.id);
      counts.auto++;
    } else if (c?.status !== 'fallback') {
      saveCard(db, w.id, day, { status: 'fallback', content: fallbackContent(db, w.week, day, c && c.status !== 'rejected' ? c.content : null), issues: c?.issues || [] });
      counts.fallback++;
    }
  }
  db.prepare("UPDATE digest_weeks SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(w.id);
  logRun(db, 'digest_queue', counts.fallback ? 'error' : 'ok', `Queued the week of ${w.week}: ${counts.approved} approved, ${counts.auto} auto-approved, ${counts.fallback} fallback card(s)`);
  return weekDetail(db, w.id);
}

// ---------- Mon-Fri: delivery at each rep's local time ----------

export function localParts(now, timeZone) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' };
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: timeZone || undefined }).formatToParts(now); } catch { parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(now); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) };
}

export async function deliverDue(db, now = new Date(), cfg = config.digest()) {
  const pilot = new Set(cfg.pilotEmails);
  const canDm = !!config.chat().serviceAccount;
  const recipients = !canDm ? [] : db.prepare('SELECT u.id, u.email, u.timezone, c.space_name FROM chat_links c JOIN users u ON u.id = c.user_id').all()
    .filter((r) => !pilot.size || pilot.has(r.email.toLowerCase()));
  const cardFor = (date, weekday) => {
    const row = db.prepare(`SELECT c.id FROM digest_cards c JOIN digest_weeks w ON w.id = c.week_id
      WHERE w.week = ? AND c.day = ? AND c.status IN ${DELIVERABLE}`).get(weekStart(date), DAYS[weekday]);
    return row && loadCard(db, row.id);
  };
  let sent = 0;
  const failures = [];
  for (const r of recipients) {
    const local = localParts(now, r.timezone);
    if (local.weekday > 4 || local.time < cfg.sendTime) continue;
    const card = cardFor(local.date, local.weekday);
    if (!card || db.prepare('SELECT 1 FROM digest_deliveries WHERE card_id = ? AND user_id = ?').get(card.id, r.id)) continue;
    try { await deliverCard(db, card, r); sent++; } catch (err) { failures.push(`${r.email}: ${err.message}`); }
  }
  if (cfg.webhookUrl) {
    const local = localParts(now, process.env.TZ);
    const card = local.weekday <= 4 && local.time >= cfg.sendTime ? cardFor(local.date, local.weekday) : null;
    if (card) await mirrorToSpace(db, card, cfg.webhookUrl).catch((err) => failures.push(`team space: ${err.message}`));
  }
  if (sent || failures.length) logRun(db, 'digest_send', failures.length ? 'error' : 'ok', `Delivered ${sent} card(s)${failures.length ? `; ${failures.length} failed: ${failures.slice(0, 3).join('; ')}` : ''}`);
  return { sent, failed: failures.length };
}

// ---------- Metrics (guide §9) ----------

export function weekMetrics(db, weekId) {
  const cards = db.prepare('SELECT id, day FROM digest_cards WHERE week_id = ?').all(weekId);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const recipients = one(`SELECT COUNT(DISTINCT d.user_id) AS n FROM digest_deliveries d JOIN digest_cards c ON c.id = d.card_id WHERE c.week_id = ?`, weekId).n;
  const days = cards.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day)).map((c) => {
    const quiz = one("SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS n, COALESCE(SUM(correct), 0) AS correct FROM digest_answers WHERE card_id = ? AND source_card_id = ? AND interval = 'same'", c.id, c.id);
    const fb = one('SELECT COALESCE(SUM(useful), 0) AS useful, COUNT(*) - COALESCE(SUM(useful), 0) AS not_useful FROM digest_feedback WHERE card_id = ?', c.id);
    return {
      day: c.day,
      delivered: one('SELECT COUNT(*) AS n FROM digest_deliveries WHERE card_id = ?', c.id).n,
      engaged: one(`SELECT COUNT(DISTINCT user_id) AS n FROM (SELECT user_id FROM digest_events WHERE card_id = ? AND user_id IS NOT NULL
        UNION SELECT user_id FROM digest_answers WHERE card_id = ? UNION SELECT user_id FROM digest_feedback WHERE card_id = ?)`, c.id, c.id, c.id).n,
      views: one("SELECT COUNT(*) AS n FROM digest_events WHERE card_id = ? AND kind = 'view'", c.id).n,
      clicks: one("SELECT COUNT(*) AS n FROM digest_events WHERE card_id = ? AND kind = 'click'", c.id).n,
      quizUsers: quiz.users,
      quizScore: quiz.n ? Math.round((quiz.correct / quiz.n) * 100) : null,
      useful: fb.useful,
      notUseful: fb.not_useful,
    };
  });
  const score = (interval) => {
    const r = one(`SELECT COUNT(*) AS n, COALESCE(SUM(a.correct), 0) AS correct FROM digest_answers a JOIN digest_cards c ON c.id = a.source_card_id
      WHERE c.week_id = ? AND a.interval = ?`, weekId, interval);
    return { answers: r.n, score: r.n ? Math.round((r.correct / r.n) * 100) : null };
  };
  const replies = one('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM digest_challenge_replies WHERE week_id = ?', weekId);
  return {
    recipients,
    days,
    retention: { firstTime: score('same'), oneWeek: score('1w'), fourWeeks: score('4w') },
    challenge: { replies: replies.n, users: replies.users, share: recipients ? Math.round((replies.users / recipients) * 100) : null,
      latest: db.prepare('SELECT r.text, u.name, r.created_at FROM digest_challenge_replies r JOIN users u ON u.id = r.user_id WHERE r.week_id = ? ORDER BY r.id DESC LIMIT 10').all(weekId) },
  };
}

function weekDetail(db, weekId) {
  const week = getWeekById(db, weekId);
  const sources = Object.fromEntries(Object.entries(week.sources).map(([id, s]) => { const { text, ...rest } = s; return [id, rest]; }));
  return { ...week, sources, cards: weekCards(db, weekId), metrics: weekMetrics(db, weekId), fullCardUrl: `${config.appUrl()}/digest/${weekId}` };
}

// ---------- Scheduler ----------

export function scheduleDigest(db) {
  if (!config.chat().enabled && !config.digest().webhookUrl) return null; // nowhere to deliver
  const failed = new Set(); // a failed step waits for an admin instead of retrying every 5 minutes
  let running = false;
  const once = async (key, fn) => {
    if (failed.has(key)) return;
    try { await fn(); } catch (err) { failed.add(key); console.error(`[digest] ${key}:`, err.message); }
  };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const today = dayOf(now);
      const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
      const hour = now.getHours();
      const next = upcomingWeek(today);
      if (dow >= 3 && dow <= 5 && hour >= 7 && !getWeek(db, next)) await once(`plan:${next}`, () => planWeek(db, { week: next, now }));
      const planned = getWeek(db, next);
      if (dow >= 4 && dow <= 5 && hour >= 7 && planned?.status === 'planned') await once(`draft:${next}`, () => draftWeek(db, planned.id, { now }));
      // Only weeks that were planned get queued, so a fresh install doesn't send "in review" cards.
      const upcoming = getWeek(db, next);
      if (dow === 0 && hour >= 20 && upcoming && upcoming.status !== 'queued') await once(`queue:${next}`, () => queueWeek(db, next, { now }));
      const current = getWeek(db, weekStart(today));
      if (dow >= 1 && dow <= 5 && current && current.status !== 'queued') await once(`queue:${current.week}`, () => queueWeek(db, current.week, { now })); // missed Sunday
      await deliverDue(db, now).catch((err) => console.error('[digest] delivery:', err.message));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 5 * 60e3);
  timer.unref();
  tick();
  return timer;
}

// ---------- Routes ----------

export function registerDigest({ db, route }) {
  const LEADS = ['admin', 'manager'];
  const weekOr404 = (id) => { const w = getWeekById(db, id); if (!w) throw new HttpError(404, 'Week not found'); return w; };
  const cardOr404 = (id) => { const c = loadCard(db, id); if (!c) throw new HttpError(404, 'Card not found'); return c; };

  route('GET', '/api/digest/weeks', LEADS, () => ({
    upcoming: upcomingWeek(),
    weeks: db.prepare('SELECT id, week, status, plan, challenge, updated_at FROM digest_weeks ORDER BY week DESC LIMIT 12').all().map((w) => ({
      ...w, plan: JSON.parse(w.plan),
      cards: db.prepare('SELECT day, status FROM digest_cards WHERE week_id = ?').all(w.id),
    })),
  }));
  route('POST', '/api/digest/weeks', ['admin'], async ({ body }) => {
    const week = body.week ? weekStart(String(body.week)) : upcomingWeek();
    return weekDetail(db, (await planWeek(db, { week })).id);
  });
  route('GET', '/api/digest/weeks/:id', LEADS, ({ params }) => weekDetail(db, weekOr404(params.id).id));
  route('PATCH', '/api/digest/weeks/:id/plan', ['admin'], ({ params, body }) => {
    const w = weekOr404(params.id);
    db.prepare("UPDATE digest_weeks SET plan = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(updatePlan(w.plan, body)), w.id);
    return weekDetail(db, w.id);
  });
  route('POST', '/api/digest/weeks/:id/draft', ['admin'], ({ params, body }) => {
    const days = body.day ? [String(body.day)].filter((d) => DAYS.includes(d)) : DAYS;
    if (!days.length) throw new HttpError(400, 'Unknown day');
    return draftWeek(db, weekOr404(params.id).id, { days });
  });
  route('POST', '/api/digest/weeks/:id/queue', ['admin'], ({ params }) => queueWeek(db, weekOr404(params.id).week));

  route('PUT', '/api/digest/cards/:id', ['admin'], ({ params, body }) => editCard(db, cardOr404(params.id).id, body.content));
  route('POST', '/api/digest/cards/:id/approve', LEADS, ({ params, user }) => approveCard(db, params.id, user));
  route('POST', '/api/digest/cards/:id/reject', LEADS, ({ params }) => {
    cardOr404(params.id);
    db.prepare("UPDATE digest_cards SET status = 'rejected', approved_by = NULL, approved_at = NULL WHERE id = ?").run(params.id);
    return parseCard(db.prepare('SELECT * FROM digest_cards WHERE id = ?').get(params.id));
  });
  route('POST', '/api/digest/cards/:id/test', LEADS, async ({ params, user }) => {
    const card = cardOr404(params.id);
    const link = db.prepare('SELECT space_name FROM chat_links WHERE user_id = ?').get(user.id);
    if (!link) throw new HttpError(400, 'Message the PitchPulse Chat app once so it can DM you, then try again');
    await deliverCard(db, card, { id: user.id, space_name: link.space_name });
    return { ok: true };
  });

  // Clip of the week: anyone nominates, a manager approves (guide §4)
  route('GET', '/api/digest/clips', LEADS, () => db.prepare(`SELECT c.*, n.name AS nominated_by_name, a.name AS approved_by_name FROM digest_clips c
    JOIN users n ON n.id = c.nominated_by LEFT JOIN users a ON a.id = c.approved_by ORDER BY c.id DESC LIMIT 30`).all());
  route('POST', '/api/digest/clips', [], ({ body, user }) => {
    for (const k of ['url', 'title', 'why_it_works', 'skill']) if (!String(body[k] || '').trim()) throw new HttpError(400, `${k} is required`);
    if (!/^https:\/\//.test(body.url)) throw new HttpError(400, 'url must be an https link to the Gong call or clip');
    const id = Number(db.prepare('INSERT INTO digest_clips (url, title, why_it_works, skill, nominated_by) VALUES (?, ?, ?, ?, ?)')
      .run(String(body.url).trim(), String(body.title).trim(), String(body.why_it_works).trim(), String(body.skill).trim(), user.id).lastInsertRowid);
    return { id };
  });
  route('POST', '/api/digest/clips/:id/approve', LEADS, ({ params, user }) => {
    if (!db.prepare('UPDATE digest_clips SET approved_by = ? WHERE id = ?').run(user.id, params.id).changes) throw new HttpError(404, 'Clip not found');
    return { ok: true };
  });

  // Reps
  route('POST', '/api/digest/answers', [], ({ body, user }) => {
    const card = cardOr404(Number(body.cardId));
    if (!['queued', 'approved', 'fallback'].includes(card.status) && user.role === 'rep') throw new HttpError(404, 'Card not found');
    const r = recordAnswer(db, user.id, { cardId: card.id, index: Number(body.questionIndex), choice: Number(body.choice) });
    if (!r) throw new HttpError(400, 'Invalid answer');
    return r;
  });
  route('PUT', '/api/me/timezone', [], ({ body, user }) => {
    const tz = String(body.timezone || '');
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new HttpError(400, 'Unknown time zone'); }
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(tz, user.id);
    return { timezone: tz };
  });

  // The full web card; reviewers can preview drafts with ?preview=1
  route('GET', '/digest/:id', null, ({ params, user, res, query }) => {
    if (!user) { res.writeHead(302, { Location: `/#/digest/${params.id}` }); return res.end(); }
    const week = weekOr404(params.id);
    const preview = query.get('preview') === '1' && user.role !== 'rep';
    const cards = weekCards(db, week.id).filter((c) => preview || ['queued', 'fallback'].includes(c.status));
    const day = query.get('day');
    const viewed = cards.find((c) => c.day === day);
    if (viewed && !preview) db.prepare("INSERT INTO digest_events (user_id, card_id, kind) VALUES (?, ?, 'view')").run(user.id, viewed.id);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(weekPage({ week, cards, title: process.env.DIGEST_TITLE || 'GTM weekly digest', preview }));
  });

  // Card images for Chat: public (Chat's servers fetch them), but only at a signed URL.
  route('GET', '/integrations/digest/image/:id', null, ({ params, query, res }) => {
    const row = db.prepare('SELECT id, image, updated_at FROM digest_cards WHERE id = ?').get(params.id);
    const want = Buffer.from(row ? sign(`img:${row.id}:${row.updated_at}`) : 'x');
    const got = Buffer.from(String(query.get('sig') || ''));
    if (!row?.image || want.length !== got.length || !timingSafeEqual(want, got)) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(Buffer.from(row.image));
  });
}

