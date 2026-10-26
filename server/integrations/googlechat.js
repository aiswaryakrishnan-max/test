// Google Chat app: reps take the Daily Challenge without leaving Chat.
//  - Interaction endpoint: POST /integrations/google-chat (configure as an HTTP endpoint Chat app).
//  - Every morning the app DMs each linked rep today's challenge as an interactive card.
//  - Answers go through the same engine as the web app, so XP, streaks and badges stay in sync.
import { HttpError } from '../errors.js';
import {
  DAILY_CHALLENGE_SIZE, answerDailyQuestion, answeredToday, dayOf, getOrCreateDailyChallenge,
  levelInfo, streakInfo, totalXp, weekStart, xpOnDay,
} from '../engagement.js';
import { config } from './config.js';
import { logRun } from './crm.js';
import { parseServiceAccount, serviceAccountToken } from './google.js';
import { verifyJwt } from './jwt.js';
import { handleDigestEvent } from '../digest/chat.js';

const CHAT_ISSUER = 'chat@system.gserviceaccount.com';
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- Request verification ----------

/**
 * Google Chat signs every request with a bearer JWT. Two audience modes exist:
 *  - project number: self-signed by chat@system.gserviceaccount.com (x509 certs)
 *  - HTTP endpoint URL: a Google OIDC ID token whose email is chat@system.gserviceaccount.com
 */
export async function verifyChatRequest(req, audience = config.chat().audience) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'Missing bearer token');
  const token = auth.slice(7);
  if (/^\d+$/.test(audience)) {
    return verifyJwt(token, {
      keysUrl: process.env.GOOGLE_CHAT_CERTS_URL || `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`,
      issuers: [CHAT_ISSUER],
      audience,
    });
  }
  const claims = await verifyJwt(token, {
    keysUrl: process.env.GOOGLE_OIDC_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    audience,
  });
  if (claims.email !== CHAT_ISSUER || claims.email_verified === false) throw new HttpError(401, 'Token was not issued for Google Chat');
  return claims;
}

// ---------- Cards ----------

function card(id, header, sections) {
  return { cardsV2: [{ cardId: id, card: { header, sections } }] };
}

function action(fn, params) {
  return { action: { function: fn, parameters: Object.entries(params).map(([key, value]) => ({ key, value: String(value) })) } };
}

function statsLine(db, userId, day) {
  const s = streakInfo(db, userId, day);
  return `🔥 <b>${s.current}</b>-day streak · ⭐ ${xpOnDay(db, userId, day)} XP today · Level ${levelInfo(totalXp(db, userId)).level}`;
}

/** Sections for the next unanswered question, or a completion summary. */
function challengeSections(db, user, day) {
  const challenge = getOrCreateDailyChallenge(db, user.id, day);
  const answered = answeredToday(db, user.id, day, challenge.question_ids);
  const nextId = challenge.question_ids.find((id) => !answered.has(id));
  if (!nextId) {
    const fresh = db.prepare('SELECT correct_count FROM daily_challenges WHERE user_id = ? AND day = ?').get(user.id, day);
    return [{
      widgets: [
        { textParagraph: { text: `🎉 <b>Challenge complete: ${fresh?.correct_count ?? 0}/${challenge.question_ids.length} correct.</b><br>${statsLine(db, user.id, day)}<br>See you tomorrow!` } },
        { buttonList: { buttons: [{ text: 'Practice a pitch in PitchPulse', onClick: { openLink: { url: `${config.appUrl()}/#/practice` } } }] } },
      ],
    }];
  }
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(nextId);
  const options = JSON.parse(q.options);
  const idx = challenge.question_ids.indexOf(nextId);
  return [{
    header: `Question ${idx + 1} of ${challenge.question_ids.length} · ${esc(q.topic)}`,
    widgets: [
      { textParagraph: { text: `<b>${esc(q.prompt)}</b><br><br>${options.map((o, i) => `<b>${LETTERS[i]}.</b> ${esc(o)}`).join('<br>')}` } },
      { buttonList: { buttons: options.map((_, i) => ({ text: LETTERS[i], onClick: action('answer', { q: q.id, c: i, d: day }) })) } },
    ],
  }];
}

export function challengeCard(db, user, day, intro) {
  const sections = challengeSections(db, user, day);
  if (intro) sections.unshift({ widgets: [{ textParagraph: { text: intro } }] });
  return card(`challenge-${day}`, { title: '⚡ PitchPulse Daily Challenge', subtitle: '3 questions · about 2 minutes' }, sections);
}

function resultCard(db, user, day, result) {
  const verdict = result.correct
    ? `✅ <b>Correct!</b>${result.xpGained ? ` <font color="#5b4ef0">+${result.xpGained} XP</font>` : ''}`
    : `❌ <b>Not quite.</b> The answer was <b>${LETTERS[result.answer_index]}</b>.${result.xpGained ? ` <font color="#5b4ef0">+${result.xpGained} XP</font>` : ''}`;
  const badges = (result.newBadges || []).map((b) => `<br>${b.icon} Badge unlocked: <b>${esc(b.name)}</b>`).join('');
  const sections = [{ widgets: [{ textParagraph: { text: `${verdict}<br>${esc(result.explanation)}${badges}` } }] }, ...challengeSections(db, user, day)];
  return card(`challenge-${day}`, { title: '⚡ PitchPulse Daily Challenge', subtitle: '3 questions · about 2 minutes' }, sections);
}

function textReply(text) { return { text }; }

// ---------- Event handling ----------

const isDm = (space = {}) => space.type === 'DM' || space.spaceType === 'DIRECT_MESSAGE' || space.singleUserBotDm === true;

function eventParams(event) {
  const fn = event.common?.invokedFunction || event.action?.actionMethodName;
  const params = { ...(event.common?.parameters || {}) };
  for (const p of event.action?.parameters || []) params[p.key] = p.value;
  return { fn, params };
}

function leaderboardText(db, day) {
  const rows = db.prepare(`SELECT u.name, COALESCE(SUM(x.amount), 0) AS xp FROM users u
    LEFT JOIN xp_events x ON x.user_id = u.id AND x.day >= ? WHERE u.role = 'rep' GROUP BY u.id ORDER BY xp DESC LIMIT 5`).all(weekStart(day));
  return `🏆 *This week's leaderboard*\n${rows.map((r, i) => `${['🥇', '🥈', '🥉', '4.', '5.'][i]} ${r.name}: ${r.xp} XP`).join('\n')}`;
}

const HELP = 'Hi! I bring your PitchPulse Daily Challenge and the daily GTM digest into Chat. Try:\n• *quiz*: today\'s questions\n• *challenge: …*: tell me what a customer said when you used this week\'s term or question\n• *streak*: your streak & XP\n• *leaderboard*: this week\'s top reps\n• *help*: this message';

export function handleChatEvent(db, event, day = dayOf()) {
  const email = String(event.user?.email || '').toLowerCase();
  const user = email ? db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email) : null;

  if (event.type === 'REMOVED_FROM_SPACE') {
    if (user && isDm(event.space)) db.prepare('DELETE FROM chat_links WHERE user_id = ?').run(user.id);
    return {};
  }
  if (!user) {
    return textReply(`I couldn't find a PitchPulse account for ${email || 'you'}. Ask your enablement admin to add you, then message me again.`);
  }
  // Remember the rep's DM so we can deliver the challenge proactively each morning.
  if (isDm(event.space) && event.space?.name) {
    db.prepare(`INSERT INTO chat_links (user_id, space_name) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET space_name = excluded.space_name`).run(user.id, event.space.name);
  }

  const digest = handleDigestEvent(db, event, user); // daily digest clicks and challenge replies
  if (digest) return digest;

  switch (event.type) {
    case 'ADDED_TO_SPACE':
      if (!isDm(event.space)) return textReply('Thanks for adding PitchPulse! Message me directly to take your Daily Challenge, or type *leaderboard* here.');
      return { text: `Welcome, ${user.name.split(' ')[0]}! 👋 I'll send your Daily Challenge here every morning.`, ...challengeCard(db, user, day) };

    case 'MESSAGE': {
      const text = String(event.message?.argumentText ?? event.message?.text ?? '').trim().toLowerCase();
      if (/^(streak|stats|xp|me)\b/.test(text)) return textReply(statsLine(db, user.id, day).replace(/<\/?b>/g, '*'));
      if (/^(leaderboard|top|rank)/.test(text)) return textReply(leaderboardText(db, day));
      if (/^(help|\?)/.test(text)) return textReply(HELP);
      return challengeCard(db, user, day);
    }

    case 'CARD_CLICKED': {
      const { fn, params } = eventParams(event);
      if (fn !== 'answer') return challengeCard(db, user, day);
      // A card from a previous day: answer today's challenge instead of yesterday's.
      if (params.d && params.d !== day) {
        return { actionResponse: { type: 'UPDATE_MESSAGE' }, ...challengeCard(db, user, day, 'That card has expired. Here is today\'s challenge:') };
      }
      try {
        const result = answerDailyQuestion(db, user.id, Number(params.q), Number(params.c), day);
        return { actionResponse: { type: 'UPDATE_MESSAGE' }, ...resultCard(db, user, day, result) };
      } catch (err) {
        if (err.status === 409 || err.status === 400) return { actionResponse: { type: 'UPDATE_MESSAGE' }, ...challengeCard(db, user, day) };
        throw err;
      }
    }
    default:
      return {};
  }
}

// ---------- Proactive messages (service account) ----------

async function chatAccessToken() {
  const cfg = config.chat();
  return serviceAccountToken(parseServiceAccount(cfg.serviceAccount, 'GOOGLE_CHAT_SERVICE_ACCOUNT'), 'https://www.googleapis.com/auth/chat.bot', cfg.tokenUrl);
}

export async function sendChatMessage(spaceName, message) {
  const res = await fetch(`${config.chat().apiBase}/${spaceName}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await chatAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Chat API ${res.status}: ${data.error?.message || 'unknown error'}`);
  }
  return res.json();
}

/** DM today's challenge to every linked rep who hasn't finished it yet. */
export async function sendDailyChallenges(db, day = dayOf()) {
  const links = db.prepare(`SELECT u.id, u.name, u.email, c.space_name FROM chat_links c JOIN users u ON u.id = c.user_id`).all();
  let sent = 0;
  const failures = [];
  for (const link of links) {
    const done = db.prepare('SELECT completed_at FROM daily_challenges WHERE user_id = ? AND day = ?').get(link.id, day)?.completed_at;
    if (done) continue;
    const s = streakInfo(db, link.id, day);
    const intro = s.current
      ? `Good morning ${esc(link.name.split(' ')[0])}! Keep your <b>${s.current}-day streak</b> 🔥 going:`
      : `Good morning ${esc(link.name.split(' ')[0])}! ${DAILY_CHALLENGE_SIZE} quick questions to start a new streak:`;
    try {
      await sendChatMessage(link.space_name, challengeCard(db, link, day, intro));
      sent++;
    } catch (err) {
      failures.push(`${link.email}: ${err.message}`);
      if (/404|403/.test(err.message)) db.prepare('DELETE FROM chat_links WHERE user_id = ?').run(link.id); // app removed / DM gone
    }
  }
  logRun(db, 'chat_challenge', failures.length ? 'error' : 'ok', `Sent ${sent} challenge(s)${failures.length ? `; ${failures.length} failed: ${failures.slice(0, 3).join('; ')}` : ''}`);
  return { sent, failed: failures.length };
}

export function scheduleChatChallenges(db) {
  const cfg = config.chat();
  if (!cfg.enabled || !cfg.serviceAccount) return null;
  let lastRun = null;
  const tick = () => {
    const now = new Date();
    const day = dayOf(now);
    if (now.getHours() >= cfg.hour && lastRun !== day) {
      lastRun = day;
      sendDailyChallenges(db, day).catch((err) => console.error('[google-chat]', err.message));
    }
  };
  const timer = setInterval(tick, 5 * 60e3);
  timer.unref();
  tick();
  return timer;
}

export function registerGoogleChat({ db, route, today }) {
  route('POST', '/integrations/google-chat', null, async ({ req, body }) => {
    if (!config.chat().enabled) throw new HttpError(404, 'Google Chat is not configured');
    await verifyChatRequest(req);
    return handleChatEvent(db, body, today());
  });

  route('POST', '/api/integrations/google-chat/send', ['admin'], () => sendDailyChallenges(db, today()));
}
