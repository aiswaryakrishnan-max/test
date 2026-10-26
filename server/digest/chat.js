// The daily card in Google Chat (execution guide §7): rendered visual on top, headline, two or three
// lines, the "say it" line, the quiz as buttons, recall questions from 1 and 4 weeks ago, and buttons
// to the full card, the battle card or the Gong clip, plus "Useful / Not useful".
import { addDays, awardXp, dayOf } from '../engagement.js';
import { config } from '../integrations/config.js';
import { sendChatMessage } from '../integrations/googlechat.js';
import { sign } from '../integrations/secrets.js';
import { DAY_INFO } from './defaults.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const CHALLENGE_XP = 20;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const action = (fn, params) => ({ action: { function: fn, parameters: Object.entries(params).map(([key, value]) => ({ key, value: String(value) })) } });
const link = (text, url) => ({ text, onClick: { openLink: { url } } });

export const loadCard = (db, id) => {
  const row = db.prepare('SELECT c.*, w.week, w.challenge, w.sources AS week_sources FROM digest_cards c JOIN digest_weeks w ON w.id = c.week_id WHERE c.id = ?').get(id);
  return row && { ...row, content: JSON.parse(row.content), issues: JSON.parse(row.issues), catalog: JSON.parse(row.week_sources) };
};

export function imageUrl(card) {
  const base = config.appUrl();
  if (!card.image || !base.startsWith('https://')) return null; // Chat fetches images from a public https URL
  return `${base}/integrations/digest/image/${card.id}?sig=${sign(`img:${card.id}:${card.updated_at}`)}`;
}

/** The question shown 1 and 4 weeks after a card went to this rep, from the same weekday. */
export function recallItems(db, card, userId) {
  const items = [];
  for (const [interval, days] of [['1w', 7], ['4w', 28]]) {
    const past = db.prepare(`SELECT c.id, c.content FROM digest_cards c JOIN digest_weeks w ON w.id = c.week_id
      JOIN digest_deliveries d ON d.card_id = c.id AND d.user_id = ?
      WHERE w.week = ? AND c.day = ?`).get(userId, addDays(card.week, -days), card.day);
    const quiz = past && JSON.parse(past.content).quiz;
    if (!quiz?.length) continue;
    const index = card.day === 'fri' ? (days / 7) % quiz.length : 0;
    items.push({ interval, sourceCardId: past.id, index, q: quiz[index] });
  }
  return items;
}

function questionWidgets(db, card, userId, { sourceCardId, index, interval, q, label }) {
  const answer = db.prepare('SELECT choice, correct FROM digest_answers WHERE user_id = ? AND card_id = ? AND source_card_id = ? AND question_index = ?')
    .get(userId, card.id, sourceCardId, index);
  const head = label ? `<font color="#80868b">${esc(label)}</font><br>` : '';
  if (answer) {
    const verdict = answer.correct ? '✅ <b>Correct.</b>' : `❌ <b>Not quite.</b> The answer was <b>${LETTERS[q.answer_index]}</b>.`;
    return [{ textParagraph: { text: `${head}<b>${esc(q.question)}</b><br>${verdict} ${esc(q.explanation)}` } }];
  }
  return [
    { textParagraph: { text: `${head}<b>${esc(q.question)}</b><br>${q.options.map((o, i) => `<b>${LETTERS[i]}.</b> ${esc(o)}`).join('<br>')}` } },
    { buttonList: { buttons: q.options.map((_, i) => ({ text: LETTERS[i], onClick: action('digest_answer', { k: card.id, s: sourceCardId, q: index, iv: interval, c: i }) })) } },
  ];
}

export function fullCardUrl(card) {
  return `${config.appUrl()}/digest/${card.week_id}?day=${card.day}#${card.day}`;
}

/** The Chat message for one rep (answers and feedback make it personal, so it is rebuilt on every click). */
export function chatMessage(db, card, userId, { interactive = true } = {}) {
  const c = card.content;
  const info = DAY_INFO[card.day];
  const top = [];
  const img = imageUrl(card);
  if (img) top.push({ image: { imageUrl: img, altText: `${info.theme}: ${c.headline}` } });
  top.push({ textParagraph: { text: `<font color="${info.color}"><b>${info.name.toUpperCase()} · ${esc(info.theme)}</b></font><br><b>${esc(c.headline)}</b>` } });
  if (c.body_points?.length) top.push({ textParagraph: { text: c.body_points.map((p) => `• ${esc(p.text)}`).join('<br>') } });
  if (card.day === 'mon' && card.challenge) top.push({ textParagraph: { text: `🎯 <b>This week's challenge:</b> ${esc(card.challenge)}` } });
  const sections = [{ widgets: top }];
  if (c.say_it) sections.push({ header: '🗣️ Say it on your next call', widgets: [{ textParagraph: { text: `<i>“${esc(c.say_it)}”</i>` } }] });

  if (interactive) {
    (c.quiz || []).forEach((q, i) => {
      sections.push({
        header: card.day === 'fri' ? `🧠 Weekly recap ${i + 1}/${c.quiz.length}` : '🧠 One question',
        widgets: questionWidgets(db, card, userId, { sourceCardId: card.id, index: i, interval: 'same', q }),
      });
    });
    const recalls = recallItems(db, card, userId);
    if (recalls.length) {
      sections.push({
        header: '🔁 Recall',
        collapsible: true,
        uncollapsibleWidgetsCount: 1,
        widgets: [
          { textParagraph: { text: `${recalls.length} question${recalls.length > 1 ? 's' : ''} from earlier weeks. Tap to expand.` } },
          ...recalls.flatMap((r) => questionWidgets(db, card, userId, { ...r, label: r.interval === '1w' ? 'From last week' : 'From four weeks ago' })),
        ],
      });
    }
  }

  const buttons = [link('Open full card', fullCardUrl(card))];
  const battle = card.day === 'wed' && Object.entries(card.catalog).find(([id, s]) => s.category === 'battle_card' && s.url && JSON.stringify(c).includes(id));
  if (battle) buttons.push(link('Open battle card', battle[1].url));
  if (card.day === 'fri' && c.clip?.url) buttons.push(link('Watch clip', c.clip.url));
  const footer = [{ buttonList: { buttons } }];
  if (interactive) {
    const fb = db.prepare('SELECT useful FROM digest_feedback WHERE user_id = ? AND card_id = ?').get(userId, card.id);
    footer.push(fb
      ? { textParagraph: { text: `<font color="#80868b">Thanks, you marked this ${fb.useful ? 'useful' : 'not useful'}.</font>` } }
      : { buttonList: { buttons: [{ text: '👍 Useful', onClick: action('digest_feedback', { k: card.id, u: 1 }) }, { text: '👎 Not useful', onClick: action('digest_feedback', { k: card.id, u: 0 }) }] } });
  }
  sections.push({ widgets: footer });
  return {
    text: `${info.short}: ${c.headline}`,
    cardsV2: [{ cardId: `digest-${card.id}`, card: { header: { title: '📚 GTM daily digest', subtitle: `${info.name} · ${info.theme} · 2 min` }, sections } }],
  };
}

export async function deliverCard(db, card, recipient) {
  const sent = await sendChatMessage(recipient.space_name, chatMessage(db, card, recipient.id));
  db.prepare('INSERT OR IGNORE INTO digest_deliveries (card_id, user_id, message_name, thread_name) VALUES (?, ?, ?, ?)')
    .run(card.id, recipient.id, sent?.name || null, sent?.thread?.name || null);
}

/** Optional mirror to a team space through an incoming webhook (links only; webhooks can't take clicks). */
export async function mirrorToSpace(db, card, webhookUrl) {
  if (db.prepare("SELECT 1 FROM digest_events WHERE card_id = ? AND kind = 'mirror'").get(card.id)) return;
  const msg = chatMessage(db, card, 0, { interactive: false });
  const url = new URL(webhookUrl);
  url.searchParams.set('threadKey', `digest-week-${card.week_id}`); // one thread per week, for challenge replies
  url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(msg) });
  if (!res.ok) throw new Error(`Chat webhook ${res.status}`);
  db.prepare("INSERT INTO digest_events (card_id, kind) VALUES (?, 'mirror')").run(card.id);
}

export function recordAnswer(db, userId, { cardId, sourceCardId = cardId, index, interval = 'same', choice }) {
  const source = loadCard(db, sourceCardId);
  const q = source?.content.quiz?.[index];
  if (!q || !Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return null;
  const correct = choice === q.answer_index ? 1 : 0;
  db.prepare(`INSERT OR IGNORE INTO digest_answers (user_id, card_id, source_card_id, question_index, interval, choice, correct)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, cardId, sourceCardId, index, ['same', '1w', '4w'].includes(interval) ? interval : 'same', choice, correct);
  return { correct: !!correct, answer_index: q.answer_index, explanation: q.explanation };
}

const isDm = (space = {}) => space.type === 'DM' || space.spaceType === 'DIRECT_MESSAGE' || space.singleUserBotDm === true;

/** Digest clicks and challenge replies arriving at the Chat app endpoint; returns null for anything else. */
export function handleDigestEvent(db, event, user) {
  if (event.type === 'CARD_CLICKED') {
    const fn = event.common?.invokedFunction || event.action?.actionMethodName;
    if (!fn?.startsWith('digest_')) return null;
    const p = { ...(event.common?.parameters || {}) };
    for (const x of event.action?.parameters || []) p[x.key] = x.value;
    const card = loadCard(db, Number(p.k));
    if (!card || !db.prepare('SELECT 1 FROM digest_deliveries WHERE card_id = ? AND user_id = ?').get(card.id, user.id)) {
      return { actionResponse: { type: 'NEW_MESSAGE' }, text: 'That card is no longer available.' };
    }
    if (fn === 'digest_answer') {
      recordAnswer(db, user.id, { cardId: card.id, sourceCardId: Number(p.s), index: Number(p.q), interval: p.iv, choice: Number(p.c) });
    } else if (fn === 'digest_feedback') {
      db.prepare(`INSERT INTO digest_feedback (user_id, card_id, useful) VALUES (?, ?, ?)
        ON CONFLICT (user_id, card_id) DO UPDATE SET useful = excluded.useful, created_at = datetime('now')`).run(user.id, card.id, String(p.u) === '1' ? 1 : 0);
    }
    db.prepare("INSERT INTO digest_events (user_id, card_id, kind) VALUES (?, ?, 'click')").run(user.id, card.id);
    return { actionResponse: { type: 'UPDATE_MESSAGE' }, ...chatMessage(db, card, user.id) };
  }

  if (event.type === 'MESSAGE' && isDm(event.space)) {
    const raw = String(event.message?.argumentText ?? event.message?.text ?? '').trim();
    const thread = event.message?.thread?.name;
    let weekId = thread ? db.prepare(`SELECT c.week_id FROM digest_deliveries d JOIN digest_cards c ON c.id = d.card_id
      WHERE d.user_id = ? AND d.thread_name = ?`).get(user.id, thread)?.week_id : null;
    const keyword = /^challenge\b[\s:,-]*/i.test(raw);
    if (!weekId && keyword) {
      weekId = db.prepare(`SELECT c.week_id FROM digest_deliveries d JOIN digest_cards c ON c.id = d.card_id
        WHERE d.user_id = ? ORDER BY d.sent_at DESC LIMIT 1`).get(user.id)?.week_id;
    }
    if (!weekId) return null;
    const text = raw.replace(/^challenge\b[\s:,-]*/i, '').trim();
    if (!text) return { text: 'Tell me what the customer said back when you used this week\'s term or discovery question, e.g. "challenge: they said their MLR review takes three rounds".' };
    const first = !db.prepare('SELECT 1 FROM digest_challenge_replies WHERE week_id = ? AND user_id = ?').get(weekId, user.id);
    db.prepare('INSERT INTO digest_challenge_replies (week_id, user_id, text) VALUES (?, ?, ?)').run(weekId, user.id, text.slice(0, 2000));
    if (first) awardXp(db, user.id, CHALLENGE_XP, 'Digest challenge reply', dayOf());
    return { text: `✅ Logged for this week's challenge${first ? ` (+${CHALLENGE_XP} XP)` : ''}. Thanks for sharing what the customer said.` };
  }
  return null;
}
