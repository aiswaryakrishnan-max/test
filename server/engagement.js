// Gamification & daily-habit engine: XP, levels, streaks, badges,
// spaced-repetition daily challenges and readiness scoring.
import { tx } from './db.js';
import { HttpError, bad } from './errors.js';

export const DAILY_CHALLENGE_SIZE = 3;

export const XP = {
  dailyQuestionCorrect: 10,
  dailyComplete: 20,
  perfectDayBonus: 15,
  moduleComplete: null, // uses module.xp
  pitchBase: null,      // uses scenario.xp, scaled by score
  readTip: 5,
};

export const BADGES = {
  first_steps: { name: 'First Steps', icon: '🚀', description: 'Completed your first Daily Challenge' },
  streak_3: { name: 'On a Roll', icon: '🔥', description: '3-day streak' },
  streak_7: { name: 'Week Warrior', icon: '⚡', description: '7-day streak' },
  streak_30: { name: 'Unstoppable', icon: '🏆', description: '30-day streak' },
  perfect_day: { name: 'Perfect Day', icon: '🎯', description: 'Aced every Daily Challenge question' },
  scholar: { name: 'Scholar', icon: '📚', description: 'Completed 5 learning modules' },
  pitch_pro: { name: 'Pitch Pro', icon: '🎤', description: 'Scored 85+ on a pitch drill' },
  sharpshooter: { name: 'Sharpshooter', icon: '🏹', description: '50 correct answers' },
  goal_crusher: { name: 'Goal Crusher', icon: '💪', description: 'Hit your daily XP goal 5 times' },
};

/** Calendar day (YYYY-MM-DD) in the server's configured time zone. */
export function dayOf(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: process.env.TZ || undefined });
}

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 864e5);
}

/** Monday of the week containing `day`. */
export function weekStart(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

// ---------- XP & levels ----------

export function xpForLevel(level) {
  return 50 * level * (level - 1); // L1:0, L2:100, L3:300, L4:600, L5:1000 ...
}

export function levelInfo(totalXp) {
  let level = 1;
  while (xpForLevel(level + 1) <= totalXp) level++;
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, totalXp, intoLevel: totalXp - floor, levelSpan: next - floor };
}

export function awardXp(db, userId, amount, reason, day = dayOf()) {
  if (amount <= 0) return;
  db.prepare('INSERT INTO xp_events (user_id, amount, reason, day) VALUES (?, ?, ?, ?)').run(userId, amount, reason, day);
}

export function totalXp(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) AS xp FROM xp_events WHERE user_id = ?').get(userId).xp;
}

export function xpOnDay(db, userId, day) {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) AS xp FROM xp_events WHERE user_id = ? AND day = ?').get(userId, day).xp;
}

// ---------- Streaks ----------

function activeDays(db, userId) {
  return db.prepare('SELECT DISTINCT day FROM xp_events WHERE user_id = ? ORDER BY day DESC').all(userId).map((r) => r.day);
}

/**
 * Current streak = consecutive active days ending today, or ending yesterday
 * if the rep hasn't done anything yet today (streak is "at risk", not lost).
 */
export function streakInfo(db, userId, today = dayOf()) {
  const days = activeDays(db, userId);
  const set = new Set(days);
  const activeToday = set.has(today);
  let cursor = activeToday ? today : addDays(today, -1);
  let current = 0;
  while (set.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  // Longest streak across history
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of [...days].reverse()) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest, activeToday, atRisk: !activeToday && current > 0 };
}

/** Last 7 days of activity for a mini heatmap. */
export function weekActivity(db, userId, today = dayOf()) {
  const rows = db.prepare('SELECT day, SUM(amount) AS xp FROM xp_events WHERE user_id = ? AND day >= ? GROUP BY day')
    .all(userId, addDays(today, -6));
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.xp]));
  return Array.from({ length: 7 }, (_, i) => {
    const day = addDays(today, i - 6);
    return { day, xp: byDay[day] || 0 };
  });
}

// ---------- Badges ----------

export function evaluateBadges(db, userId, today = dayOf()) {
  const have = new Set(db.prepare('SELECT code FROM badges WHERE user_id = ?').all(userId).map((r) => r.code));
  const earned = [];
  const grant = (code) => {
    if (have.has(code)) return;
    db.prepare('INSERT INTO badges (user_id, code) VALUES (?, ?)').run(userId, code);
    have.add(code);
    earned.push({ code, ...BADGES[code] });
  };

  const dailyDone = db.prepare('SELECT COUNT(*) AS n FROM daily_challenges WHERE user_id = ? AND completed_at IS NOT NULL').get(userId).n;
  if (dailyDone >= 1) grant('first_steps');

  const perfect = db.prepare('SELECT COUNT(*) AS n FROM daily_challenges WHERE user_id = ? AND completed_at IS NOT NULL AND correct_count = ?')
    .get(userId, DAILY_CHALLENGE_SIZE).n;
  if (perfect >= 1) grant('perfect_day');

  const { current, longest } = streakInfo(db, userId, today);
  const best = Math.max(current, longest);
  if (best >= 3) grant('streak_3');
  if (best >= 7) grant('streak_7');
  if (best >= 30) grant('streak_30');

  const modules = db.prepare('SELECT COUNT(*) AS n FROM module_completions WHERE user_id = ?').get(userId).n;
  if (modules >= 5) grant('scholar');

  const bestPitch = db.prepare('SELECT COALESCE(MAX(score), 0) AS s FROM pitch_attempts WHERE user_id = ?').get(userId).s;
  if (bestPitch >= 85) grant('pitch_pro');

  const correct = db.prepare('SELECT COUNT(*) AS n FROM answers WHERE user_id = ? AND correct = 1').get(userId).n;
  if (correct >= 50) grant('sharpshooter');

  const goal = db.prepare('SELECT daily_goal_xp FROM users WHERE id = ?').get(userId).daily_goal_xp;
  const goalDays = db.prepare('SELECT COUNT(*) AS n FROM (SELECT day FROM xp_events WHERE user_id = ? GROUP BY day HAVING SUM(amount) >= ?)')
    .get(userId, goal).n;
  if (goalDays >= 5) grant('goal_crusher');

  return earned;
}

// ---------- Daily challenge (spaced repetition) ----------

/**
 * Pick questions using a lightweight Leitner scheme:
 *  - recently-missed questions come back first,
 *  - unseen questions next,
 *  - mastered questions resurface at growing intervals (2^box days).
 */
export function pickDailyQuestions(db, userId, today = dayOf(), n = DAILY_CHALLENGE_SIZE, rand = Math.random) {
  const questions = db.prepare('SELECT id FROM questions').all();
  const history = db.prepare('SELECT question_id, correct, day FROM answers WHERE user_id = ? ORDER BY id ASC').all(userId);
  const byQ = new Map();
  for (const h of history) {
    const s = byQ.get(h.question_id) || { box: 0, lastCorrect: null, lastDay: null };
    s.box = h.correct ? s.box + 1 : 0;
    s.lastCorrect = !!h.correct;
    s.lastDay = h.day;
    byQ.set(h.question_id, s);
  }
  const scored = questions.map(({ id }) => {
    const s = byQ.get(id);
    let priority;
    if (!s) priority = 2;
    else {
      const since = daysBetween(s.lastDay, today);
      if (!s.lastCorrect) priority = since >= 1 ? 3 : 1.5;
      else priority = since >= 2 ** s.box ? 1 : 0;
    }
    return { id, priority: priority + rand() * 0.5 };
  });
  scored.sort((a, b) => b.priority - a.priority);
  return scored.slice(0, n).map((q) => q.id);
}

export function getOrCreateDailyChallenge(db, userId, today = dayOf()) {
  let row = db.prepare('SELECT * FROM daily_challenges WHERE user_id = ? AND day = ?').get(userId, today);
  if (!row) {
    const ids = pickDailyQuestions(db, userId, today);
    db.prepare('INSERT INTO daily_challenges (user_id, day, question_ids) VALUES (?, ?, ?)').run(userId, today, JSON.stringify(ids));
    row = db.prepare('SELECT * FROM daily_challenges WHERE user_id = ? AND day = ?').get(userId, today);
  }
  return { ...row, question_ids: JSON.parse(row.question_ids) };
}

export function answeredToday(db, userId, day, questionIds) {
  const out = new Map();
  for (const r of db.prepare('SELECT question_id, correct, choice FROM daily_answers WHERE user_id = ? AND day = ?').all(userId, day)) {
    if (questionIds.includes(r.question_id)) out.set(r.question_id, r);
  }
  return out;
}

/** Record one Daily Challenge answer (web app or Google Chat) and award XP/badges. */
export function answerDailyQuestion(db, userId, qid, choice, day = dayOf()) {
  const challenge = getOrCreateDailyChallenge(db, userId, day);
  if (!challenge.question_ids.includes(qid)) throw bad("That question isn't part of today's challenge");
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(qid);
  if (!Number.isInteger(choice) || choice < 0 || choice >= JSON.parse(q.options).length) throw bad('Invalid choice');
  if (answeredToday(db, userId, day, [qid]).has(qid)) throw new HttpError(409, 'Already answered');

  const correct = choice === q.answer_index ? 1 : 0;
  return tx(db, () => {
    db.prepare('INSERT INTO answers (user_id, question_id, correct, context, day) VALUES (?, ?, ?, ?, ?)').run(userId, qid, correct, 'daily', day);
    db.prepare('INSERT INTO daily_answers (user_id, day, question_id, choice, correct) VALUES (?, ?, ?, ?, ?)').run(userId, day, qid, choice, correct);
    let xpGained = 0;
    if (correct) { awardXp(db, userId, XP.dailyQuestionCorrect, 'Daily Challenge answer', day); xpGained += XP.dailyQuestionCorrect; }

    const answered = answeredToday(db, userId, day, challenge.question_ids);
    let completed = false;
    let correctCount = null;
    if (answered.size === challenge.question_ids.length && !challenge.completed_at) {
      correctCount = [...answered.values()].filter((a) => a.correct).length;
      db.prepare("UPDATE daily_challenges SET completed_at = datetime('now'), correct_count = ? WHERE user_id = ? AND day = ?").run(correctCount, userId, day);
      awardXp(db, userId, XP.dailyComplete, 'Daily Challenge completed', day);
      xpGained += XP.dailyComplete;
      if (correctCount === challenge.question_ids.length) {
        awardXp(db, userId, XP.perfectDayBonus, 'Perfect Day bonus', day);
        xpGained += XP.perfectDayBonus;
      }
      completed = true;
    }
    const newBadges = evaluateBadges(db, userId, day);
    return {
      correct: !!correct, answer_index: q.answer_index, explanation: q.explanation,
      xpGained, completed, correctCount, newBadges, streak: streakInfo(db, userId, day),
    };
  });
}

// ---------- Readiness ----------

/**
 * Readiness (0-100) blends three signals managers care about:
 *  40% knowledge accuracy (last 30 days), 30% assigned-module completion,
 *  30% average pitch score (last 5 drills).
 * Missing signals are left out and the remaining weights re-normalised.
 */
export function readiness(db, userId, today = dayOf()) {
  const since = addDays(today, -30);
  const acc = db.prepare('SELECT AVG(correct) AS a, COUNT(*) AS n FROM answers WHERE user_id = ? AND day >= ?').get(userId, since);
  const user = db.prepare('SELECT team_id FROM users WHERE id = ?').get(userId);
  const assigned = db.prepare(`
    SELECT COUNT(DISTINCT a.module_id) AS total,
           COUNT(DISTINCT mc.module_id) AS done
    FROM assignments a
    LEFT JOIN module_completions mc ON mc.module_id = a.module_id AND mc.user_id = ?
    WHERE a.user_id = ? OR (a.team_id IS NOT NULL AND a.team_id = ?)`).get(userId, userId, user?.team_id ?? -1);
  const pitch = db.prepare('SELECT AVG(score) AS s, COUNT(*) AS n FROM (SELECT score FROM pitch_attempts WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)').get(userId);

  const parts = [];
  if (acc.n > 0) parts.push({ key: 'knowledge', weight: 0.4, value: acc.a * 100 });
  if (assigned.total > 0) parts.push({ key: 'completion', weight: 0.3, value: (assigned.done / assigned.total) * 100 });
  if (pitch.n > 0) parts.push({ key: 'pitch', weight: 0.3, value: pitch.s });
  const weight = parts.reduce((s, p) => s + p.weight, 0);
  const score = weight ? Math.round(parts.reduce((s, p) => s + p.value * p.weight, 0) / weight) : null;
  return {
    score,
    knowledge: acc.n ? Math.round(acc.a * 100) : null,
    completion: assigned.total ? Math.round((assigned.done / assigned.total) * 100) : null,
    pitch: pitch.n ? Math.round(pitch.s) : null,
  };
}

/** Accuracy per topic, weakest first — drives "focus areas". */
export function topicAccuracy(db, userIds) {
  if (!userIds.length) return [];
  const ph = userIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT q.topic, ROUND(AVG(a.correct) * 100) AS accuracy, COUNT(*) AS attempts
    FROM answers a JOIN questions q ON q.id = a.question_id
    WHERE a.user_id IN (${ph})
    GROUP BY q.topic ORDER BY accuracy ASC`).all(...userIds);
}

export function notify(db, userId, kind, message) {
  db.prepare('INSERT INTO notifications (user_id, kind, message) VALUES (?, ?, ?)').run(userId, kind, message);
}
