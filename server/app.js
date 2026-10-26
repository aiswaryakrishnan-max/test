import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, destroySession, parseCookies, userForToken, verifyPassword } from './auth.js';
import { aiEnabled, scorePitch } from './coach.js';
import {
  BADGES, DAILY_CHALLENGE_SIZE, XP, addDays, answerDailyQuestion, answeredToday, awardXp, dayOf, daysBetween, evaluateBadges,
  getOrCreateDailyChallenge, levelInfo, notify, readiness, streakInfo, topicAccuracy,
  totalXp, weekActivity, weekStart, xpOnDay,
} from './engagement.js';
import { tx } from './db.js';
import { HttpError, bad, requireFields } from './errors.js';
import { sessionCookie } from './http.js';
import { config } from './integrations/config.js';
import { dealFocus, readinessVsResults, repCrmStats } from './integrations/crm.js';
import { sendSlack } from './reminders.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };


const dayIndex = (day) => Math.floor(new Date(`${day}T12:00:00Z`) / 864e5);

/**
 * Build the request handler. `opts.now` lets tests pin the clock.
 */
export function createApp(db, opts = {}) {
  const today = () => dayOf(opts.now ? opts.now() : new Date());
  const routes = [];
  const route = (method, path, roles, handler) => {
    const keys = [];
    const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; })}$`);
    routes.push({ method, re, keys, roles, handler });
  };

  // ---------- Auth ----------
  route('POST', '/api/login', null, ({ body, res }) => {
    requireFields(body, ['email', 'password']);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(body.email).toLowerCase().trim());
    if (process.env.SSO_ONLY === 'true') throw new HttpError(403, 'Password sign-in is disabled. Use single sign-on.');
    if (!user || !verifyPassword(String(body.password), user.password_hash)) throw new HttpError(401, 'Invalid email or password');
    const token = createSession(db, user.id);
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token));
    return { ok: true };
  });

  route('POST', '/api/logout', [], ({ token, res }) => {
    destroySession(db, token);
    res.setHeader('Set-Cookie', 'pp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  });

  route('GET', '/api/me', [], ({ user }) => {
    const xp = totalXp(db, user.id);
    const team = user.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(user.team_id)?.name : null;
    return {
      ...user, team, level: levelInfo(xp), aiCoach: aiEnabled(),
      integrations: {
        calendar: { enabled: config.calendar().enabled, connected: !!db.prepare('SELECT 1 FROM calendar_connections WHERE user_id = ?').get(user.id) },
        googleChat: { enabled: config.chat().enabled, linked: !!db.prepare('SELECT 1 FROM chat_links WHERE user_id = ?').get(user.id) },
        crm: { provider: config.crm().provider || null, hasDeals: !!db.prepare('SELECT 1 FROM crm_deals WHERE user_id = ?').get(user.id) },
        sso: { enabled: config.sso().enabled, name: config.sso().name },
      },
    };
  });

  route('PATCH', '/api/me', [], ({ user, body }) => {
    const goal = Number(body.daily_goal_xp);
    if (!Number.isInteger(goal) || goal < 10 || goal > 500) throw bad('daily_goal_xp must be an integer between 10 and 500');
    db.prepare('UPDATE users SET daily_goal_xp = ? WHERE id = ?').run(goal, user.id);
    return { ok: true, daily_goal_xp: goal };
  });

  // ---------- Today: the daily home screen ----------
  route('GET', '/api/today', [], ({ user }) => {
    const day = today();
    const challenge = getOrCreateDailyChallenge(db, user.id, day);
    const answered = answeredToday(db, user.id, day, challenge.question_ids);
    const questions = challenge.question_ids.map((id) => {
      const q = db.prepare('SELECT id, topic, prompt, options, answer_index, explanation FROM questions WHERE id = ?').get(id);
      if (!q) return null;
      const a = answered.get(id);
      return {
        id: q.id, topic: q.topic, prompt: q.prompt, options: JSON.parse(q.options),
        ...(a ? { answered: true, choice: a.choice, correct: !!a.correct, answer_index: q.answer_index, explanation: q.explanation } : { answered: false }),
      };
    }).filter(Boolean);

    const tips = db.prepare('SELECT id, text, author FROM tips ORDER BY id').all();
    const scenarios = db.prepare('SELECT id, title, objective, xp FROM scenarios ORDER BY id').all();
    const idx = dayIndex(day);
    const xpToday = xpOnDay(db, user.id, day);
    const xp = totalXp(db, user.id);

    // Recommend a module from the rep's weakest topic that they haven't completed.
    const weakest = topicAccuracy(db, [user.id]).find((t) => t.attempts >= 2 && t.accuracy < 80);
    const recommended = db.prepare(`
      SELECT m.id, m.title, m.topic, m.minutes, m.xp FROM modules m
      WHERE m.id NOT IN (SELECT module_id FROM module_completions WHERE user_id = ?)
      ORDER BY (m.topic = ?) DESC, m.id LIMIT 1`).get(user.id, weakest?.topic ?? '');

    return {
      day,
      streak: streakInfo(db, user.id, day),
      xpToday,
      dailyGoal: user.daily_goal_xp,
      level: levelInfo(xp),
      week: weekActivity(db, user.id, day),
      challenge: {
        size: DAILY_CHALLENGE_SIZE,
        completed: !!challenge.completed_at,
        correctCount: challenge.correct_count,
        questions,
      },
      tip: tips.length ? tips[idx % tips.length] : null,
      drill: scenarios.length ? scenarios[idx % scenarios.length] : null,
      assignments: openAssignments(user, day),
      recommended: recommended ? { ...recommended, reason: weakest ? `Boost your ${weakest.topic} accuracy (${weakest.accuracy}%)` : 'Next up in your library' } : null,
      teamPulse: teamPulse(user, day),
      dealFocus: dealFocus(db, user.id, day),
      unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(user.id).n,
    };
  });

  route('POST', '/api/daily/answer', [], ({ user, body }) => {
    requireFields(body, ['questionId', 'choice']);
    return answerDailyQuestion(db, user.id, Number(body.questionId), Number(body.choice), today());
  });

  route('POST', '/api/tips/:id/read', [], ({ user, params }) => {
    const day = today();
    const reason = `Tip read #${params.id}`;
    const already = db.prepare('SELECT 1 FROM xp_events WHERE user_id = ? AND day = ? AND reason = ?').get(user.id, day, reason);
    if (!already) awardXp(db, user.id, XP.readTip, reason, day);
    return { xpGained: already ? 0 : XP.readTip, newBadges: evaluateBadges(db, user.id, day) };
  });

  // ---------- Learning modules ----------
  function openAssignments(user, day) {
    return db.prepare(`
      SELECT a.id, a.due_date, m.id AS module_id, m.title, m.minutes, m.xp
      FROM assignments a JOIN modules m ON m.id = a.module_id
      WHERE (a.user_id = ? OR (a.team_id IS NOT NULL AND a.team_id = ?))
        AND m.id NOT IN (SELECT module_id FROM module_completions WHERE user_id = ?)
      ORDER BY a.due_date`).all(user.id, user.team_id ?? -1, user.id)
      .map((a) => ({ ...a, daysLeft: daysBetween(day, a.due_date), overdue: a.due_date < day }));
  }

  route('GET', '/api/modules', [], ({ user }) => {
    const day = today();
    const due = new Map(openAssignments(user, day).map((a) => [a.module_id, a]));
    return db.prepare(`
      SELECT m.id, m.title, m.topic, m.summary, m.minutes, m.xp,
             (SELECT COUNT(*) FROM questions q WHERE q.module_id = m.id) AS questionCount,
             mc.score, mc.completed_at
      FROM modules m LEFT JOIN module_completions mc ON mc.module_id = m.id AND mc.user_id = ?
      ORDER BY m.id`).all(user.id)
      .map((m) => ({ ...m, completed: !!m.completed_at, assignment: due.get(m.id) || null }));
  });

  route('GET', '/api/modules/:id', [], ({ user, params }) => {
    const m = db.prepare('SELECT * FROM modules WHERE id = ?').get(params.id);
    if (!m) throw new HttpError(404, 'Module not found');
    const questions = db.prepare('SELECT id, prompt, options FROM questions WHERE module_id = ? ORDER BY id').all(m.id)
      .map((q) => ({ ...q, options: JSON.parse(q.options) }));
    const completion = db.prepare('SELECT score, completed_at FROM module_completions WHERE user_id = ? AND module_id = ?').get(user.id, m.id);
    return { ...m, questions, completion: completion || null };
  });

  route('POST', '/api/modules/:id/complete', [], ({ user, params, body }) => {
    const m = db.prepare('SELECT * FROM modules WHERE id = ?').get(params.id);
    if (!m) throw new HttpError(404, 'Module not found');
    const questions = db.prepare('SELECT * FROM questions WHERE module_id = ? ORDER BY id').all(m.id);
    const answers = Array.isArray(body.answers) ? body.answers.map(Number) : [];
    if (answers.length !== questions.length) throw bad(`Expected ${questions.length} answers`);

    const day = today();
    return tx(db, () => {
      const results = questions.map((q, i) => {
        const correct = answers[i] === q.answer_index ? 1 : 0;
        db.prepare('INSERT INTO answers (user_id, question_id, correct, context, day) VALUES (?, ?, ?, ?, ?)').run(user.id, q.id, correct, 'module', day);
        return { questionId: q.id, correct: !!correct, answer_index: q.answer_index, explanation: q.explanation };
      });
      const score = questions.length ? Math.round((results.filter((r) => r.correct).length / questions.length) * 100) : 100;
      const passed = score >= 60;
      const previous = db.prepare('SELECT score FROM module_completions WHERE user_id = ? AND module_id = ?').get(user.id, m.id);
      let xpGained = 0;
      if (passed) {
        if (!previous) {
          db.prepare('INSERT INTO module_completions (user_id, module_id, score) VALUES (?, ?, ?)').run(user.id, m.id, score);
          awardXp(db, user.id, m.xp, `Module completed: ${m.title}`, day);
          xpGained = m.xp;
        } else if (score > previous.score) {
          db.prepare("UPDATE module_completions SET score = ?, completed_at = datetime('now') WHERE user_id = ? AND module_id = ?").run(score, user.id, m.id);
        }
      }
      return { score, passed, results, xpGained, newBadges: evaluateBadges(db, user.id, day) };
    });
  });

  // ---------- Pitch practice ----------
  route('GET', '/api/scenarios', [], ({ user }) => db.prepare(`
      SELECT s.*, (SELECT MAX(score) FROM pitch_attempts p WHERE p.scenario_id = s.id AND p.user_id = ?) AS bestScore,
             (SELECT COUNT(*) FROM pitch_attempts p WHERE p.scenario_id = s.id AND p.user_id = ?) AS attempts
      FROM scenarios s ORDER BY s.id`).all(user.id, user.id)
    .map((s) => ({ ...s, key_points: JSON.parse(s.key_points) })));

  route('POST', '/api/scenarios/:id/attempt', [], async ({ user, params, body }) => {
    const s = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(params.id);
    if (!s) throw new HttpError(404, 'Scenario not found');
    const pitch = String(body.pitch ?? '').trim();
    if (pitch.split(/\s+/).length < 10) throw bad('Write at least a couple of sentences so the coach has something to work with.');
    if (pitch.length > 5000) throw bad('Pitch is too long (max 5000 characters).');

    const feedback = await scorePitch(s, pitch);
    const day = today();
    return tx(db, () => {
      const id = Number(db.prepare('INSERT INTO pitch_attempts (user_id, scenario_id, pitch, score, feedback, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, s.id, pitch, feedback.score, JSON.stringify(feedback), feedback.source).lastInsertRowid);
      // Full XP once per scenario per day for 70+, partial otherwise — rewards practice without farming.
      const reason = `Pitch drill #${s.id}`;
      const already = db.prepare('SELECT 1 FROM xp_events WHERE user_id = ? AND day = ? AND reason = ?').get(user.id, day, reason);
      const xpGained = already ? 0 : Math.round(s.xp * (feedback.score >= 70 ? 1 : 0.5));
      awardXp(db, user.id, xpGained, reason, day);
      return { id, ...feedback, xpGained, newBadges: evaluateBadges(db, user.id, day) };
    });
  });

  route('GET', '/api/pitches', [], ({ user, query }) => {
    const isLead = user.role !== 'rep';
    const scope = isLead && query.get('scope') === 'team' ? 'team' : 'mine';
    const rows = db.prepare(`
      SELECT p.id, p.pitch, p.score, p.feedback, p.source, p.manager_comment, p.created_at,
             s.title AS scenario, u.name AS rep, u.id AS user_id
      FROM pitch_attempts p JOIN scenarios s ON s.id = p.scenario_id JOIN users u ON u.id = p.user_id
      WHERE ${scope === 'team' ? (user.role === 'admin' ? '1 = 1' : 'u.team_id = ?') : 'p.user_id = ?'}
      ORDER BY p.created_at DESC, p.id DESC LIMIT 50`)
      .all(...(scope === 'team' && user.role === 'admin' ? [] : [scope === 'team' ? user.team_id ?? -1 : user.id]));
    return rows.map((r) => ({ ...r, feedback: JSON.parse(r.feedback) }));
  });

  route('POST', '/api/pitches/:id/comment', ['manager', 'admin'], ({ user, params, body }) => {
    requireFields(body, ['comment']);
    const p = db.prepare('SELECT p.*, u.team_id FROM pitch_attempts p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(params.id);
    if (!p) throw new HttpError(404, 'Pitch not found');
    if (user.role === 'manager' && p.team_id !== user.team_id) throw new HttpError(403, 'Not your team');
    db.prepare('UPDATE pitch_attempts SET manager_comment = ? WHERE id = ?').run(String(body.comment), p.id);
    notify(db, p.user_id, 'coaching', `${user.name} left coaching feedback on your pitch: "${String(body.comment).slice(0, 140)}"`);
    return { ok: true };
  });

  // ---------- Leaderboard, profile, knowledge ----------
  route('GET', '/api/leaderboard', [], ({ user, query }) => {
    const day = today();
    const period = query.get('period') === 'all' ? 'all' : 'week';
    const teamOnly = query.get('team') === 'mine' && user.team_id;
    const since = period === 'week' ? weekStart(day) : '0000-00-00';
    const rows = db.prepare(`
      SELECT u.id, u.name, t.name AS team, COALESCE(SUM(x.amount), 0) AS xp
      FROM users u LEFT JOIN teams t ON t.id = u.team_id
      LEFT JOIN xp_events x ON x.user_id = u.id AND x.day >= ?
      WHERE u.role = 'rep' ${teamOnly ? 'AND u.team_id = ?' : ''}
      GROUP BY u.id ORDER BY xp DESC, u.name`).all(...(teamOnly ? [since, user.team_id] : [since]));
    const ranked = rows.map((r, i) => ({ ...r, rank: i + 1, streak: streakInfo(db, r.id, day).current, me: r.id === user.id }));
    const teams = db.prepare(`
      SELECT t.name AS team, COALESCE(SUM(x.amount), 0) AS xp, COUNT(DISTINCT u.id) AS reps
      FROM teams t JOIN users u ON u.team_id = t.id AND u.role = 'rep'
      LEFT JOIN xp_events x ON x.user_id = u.id AND x.day >= ?
      GROUP BY t.id ORDER BY xp DESC`).all(since)
      .map((t) => ({ ...t, xpPerRep: t.reps ? Math.round(t.xp / t.reps) : 0 }));
    return { period, since, reps: ranked, teams };
  });

  route('GET', '/api/profile', [], ({ user }) => {
    const day = today();
    const earned = new Map(db.prepare('SELECT code, earned_at FROM badges WHERE user_id = ?').all(user.id).map((b) => [b.code, b.earned_at]));
    return {
      level: levelInfo(totalXp(db, user.id)),
      streak: streakInfo(db, user.id, day),
      readiness: readiness(db, user.id, day),
      topics: topicAccuracy(db, [user.id]),
      badges: Object.entries(BADGES).map(([code, b]) => ({ code, ...b, earned: earned.has(code), earned_at: earned.get(code) || null })),
      recentXp: db.prepare('SELECT amount, reason, day FROM xp_events WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(user.id),
      dailyGoal: user.daily_goal_xp,
    };
  });

  route('GET', '/api/battlecards', [], ({ query }) => {
    const q = (query.get('q') || '').trim();
    if (!q) return db.prepare('SELECT * FROM battlecards ORDER BY category, title').all();
    const like = `%${q}%`;
    return db.prepare('SELECT * FROM battlecards WHERE title LIKE ? OR content LIKE ? OR category LIKE ? ORDER BY category, title').all(like, like, like);
  });

  route('GET', '/api/notifications', [], ({ user }) =>
    db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(user.id));

  route('POST', '/api/notifications/read', [], ({ user }) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user.id);
    return { ok: true };
  });

  // ---------- Manager ----------
  function teamPulse(user, day) {
    if (!user.team_id) return null;
    const reps = db.prepare("SELECT id FROM users WHERE team_id = ? AND role = 'rep'").all(user.team_id);
    const activeToday = reps.filter((r) => xpOnDay(db, r.id, day) > 0).length;
    return { activeToday, total: reps.length };
  }

  function teamRepIds(user, teamId) {
    if (user.role === 'admin') {
      return teamId
        ? db.prepare("SELECT id FROM users WHERE role = 'rep' AND team_id = ?").all(teamId).map((r) => r.id)
        : db.prepare("SELECT id FROM users WHERE role = 'rep'").all().map((r) => r.id);
    }
    return db.prepare("SELECT id FROM users WHERE role = 'rep' AND team_id = ?").all(user.team_id ?? -1).map((r) => r.id);
  }

  function assertCanManage(user, repId) {
    const rep = db.prepare('SELECT id, name, team_id, role FROM users WHERE id = ?').get(repId);
    if (!rep) throw new HttpError(404, 'User not found');
    if (user.role === 'manager' && rep.team_id !== user.team_id) throw new HttpError(403, 'Not your team');
    return rep;
  }

  route('GET', '/api/manager/team', ['manager', 'admin'], ({ user, query }) => {
    const day = today();
    const teamId = query.get('teamId') ? Number(query.get('teamId')) : null;
    const ids = teamRepIds(user, teamId);
    const ws = weekStart(day);
    const reps = ids.map((id) => {
      const u = db.prepare('SELECT u.id, u.name, u.email, t.name AS team FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?').get(id);
      const last = db.prepare('SELECT MAX(day) AS d FROM xp_events WHERE user_id = ?').get(id).d;
      const weekXp = db.prepare('SELECT COALESCE(SUM(amount), 0) AS xp FROM xp_events WHERE user_id = ? AND day >= ?').get(id, ws).xp;
      const activeDays7 = db.prepare('SELECT COUNT(DISTINCT day) AS n FROM xp_events WHERE user_id = ? AND day > ?').get(id, addDays(day, -7)).n;
      return {
        ...u,
        lastActive: last,
        daysInactive: last ? daysBetween(last, day) : null,
        weekXp,
        activeDays7,
        streak: streakInfo(db, id, day).current,
        readiness: readiness(db, id, day),
        crm: repCrmStats(db, id, day),
      };
    }).sort((a, b) => (b.readiness.score ?? -1) - (a.readiness.score ?? -1));

    const assignmentStatus = db.prepare(`
      SELECT a.id, a.module_id, m.title, a.due_date, a.team_id, a.user_id FROM assignments a JOIN modules m ON m.id = a.module_id
      ${user.role === 'admin' ? '' : 'WHERE a.team_id = ? OR a.user_id IN (SELECT id FROM users WHERE team_id = ?)'}
      ORDER BY a.due_date`).all(...(user.role === 'admin' ? [] : [user.team_id ?? -1, user.team_id ?? -1]))
      .map((a) => {
        const targets = a.user_id ? [a.user_id] : db.prepare("SELECT id FROM users WHERE team_id = ? AND role = 'rep'").all(a.team_id).map((r) => r.id);
        const done = targets.filter((uid) => db.prepare('SELECT 1 FROM module_completions WHERE user_id = ? AND module_id = ?').get(uid, a.module_id)).length;
        return { id: a.id, title: a.title, due_date: a.due_date, done, total: targets.length, overdue: a.due_date < day };
      });

    const activeToday = reps.filter((r) => r.lastActive === day).length;
    const scored = reps.filter((r) => r.readiness.score !== null);
    return {
      summary: {
        reps: reps.length,
        activeToday,
        dailyActiveRate: reps.length ? Math.round((activeToday / reps.length) * 100) : 0,
        weeklyActiveRate: reps.length ? Math.round((reps.filter((r) => r.activeDays7 > 0).length / reps.length) * 100) : 0,
        avgReadiness: scored.length ? Math.round(scored.reduce((s, r) => s + r.readiness.score, 0) / scored.length) : null,
        avgStreak: reps.length ? +(reps.reduce((s, r) => s + r.streak, 0) / reps.length).toFixed(1) : 0,
      },
      reps,
      atRisk: reps.filter((r) => r.daysInactive === null || r.daysInactive >= 2),
      focusAreas: topicAccuracy(db, ids),
      hasCrm: !!db.prepare(`SELECT 1 FROM crm_deals WHERE user_id IN (${ids.map(() => '?').join(',') || 'NULL'}) LIMIT 1`).get(...ids),
      readinessVsResults: readinessVsResults(db, ids, day),
      assignments: assignmentStatus,
      teams: db.prepare('SELECT id, name FROM teams ORDER BY name').all(),
    };
  });

  route('POST', '/api/manager/nudge', ['manager', 'admin'], async ({ user, body }) => {
    requireFields(body, ['userId']);
    const rep = assertCanManage(user, Number(body.userId));
    const message = String(body.message || `${user.name}: Your Daily Challenge is waiting — 2 minutes to keep your streak alive! 🔥`);
    notify(db, rep.id, 'nudge', message);
    await sendSlack(`Nudge for ${rep.name}: ${message}`);
    return { ok: true };
  });

  route('POST', '/api/manager/kudos', ['manager', 'admin'], ({ user, body }) => {
    requireFields(body, ['userId', 'message']);
    const rep = assertCanManage(user, Number(body.userId));
    notify(db, rep.id, 'kudos', `🎉 Kudos from ${user.name}: ${String(body.message).slice(0, 280)}`);
    awardXp(db, rep.id, 10, `Kudos from ${user.name}`, today());
    return { ok: true };
  });

  route('POST', '/api/manager/assign', ['manager', 'admin'], ({ user, body }) => {
    requireFields(body, ['moduleId', 'dueDate']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
    const m = db.prepare('SELECT id, title FROM modules WHERE id = ?').get(Number(body.moduleId));
    if (!m) throw new HttpError(404, 'Module not found');
    let teamId = null;
    let userId = null;
    if (body.userId) userId = assertCanManage(user, Number(body.userId)).id;
    else teamId = user.role === 'admin' && body.teamId ? Number(body.teamId) : user.team_id;
    if (!teamId && !userId) throw bad('Choose a team or a rep to assign to');
    const id = Number(db.prepare('INSERT INTO assignments (module_id, team_id, user_id, due_date, assigned_by) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, teamId, userId, body.dueDate, user.id).lastInsertRowid);
    const targets = userId ? [userId] : db.prepare("SELECT id FROM users WHERE team_id = ? AND role = 'rep'").all(teamId).map((r) => r.id);
    for (const t of targets) notify(db, t, 'assignment', `New assignment: "${m.title}" due ${body.dueDate}`);
    return { id, notified: targets.length };
  });

  // ---------- Content studio ----------
  route('POST', '/api/content/modules', ['manager', 'admin'], ({ user, body }) => {
    requireFields(body, ['title', 'topic', 'summary', 'body']);
    const questions = Array.isArray(body.questions) ? body.questions : [];
    for (const q of questions) {
      if (!q.prompt || !Array.isArray(q.options) || q.options.length < 2) throw bad('Each question needs a prompt and at least 2 options');
      if (!Number.isInteger(q.answer_index) || q.answer_index < 0 || q.answer_index >= q.options.length) throw bad('Invalid answer_index');
    }
    return tx(db, () => {
      const id = Number(db.prepare('INSERT INTO modules (title, topic, summary, body, minutes, xp, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(body.title, body.topic, body.summary, body.body, Number(body.minutes) || 5, Number(body.xp) || 30, user.id).lastInsertRowid);
      for (const q of questions) {
        db.prepare('INSERT INTO questions (module_id, topic, prompt, options, answer_index, explanation) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, body.topic, q.prompt, JSON.stringify(q.options.map(String)), q.answer_index, q.explanation || '');
      }
      return { id };
    });
  });

  route('POST', '/api/content/scenarios', ['manager', 'admin'], ({ body }) => {
    requireFields(body, ['title', 'persona', 'situation', 'objective', 'key_points']);
    if (!Array.isArray(body.key_points) || !body.key_points.length) throw bad('key_points must be a non-empty array');
    const id = Number(db.prepare('INSERT INTO scenarios (title, persona, situation, objective, key_points, xp) VALUES (?, ?, ?, ?, ?, ?)')
      .run(body.title, body.persona, body.situation, body.objective, JSON.stringify(body.key_points.map(String)), Number(body.xp) || 40).lastInsertRowid);
    return { id };
  });

  route('POST', '/api/content/battlecards', ['manager', 'admin'], ({ body }) => {
    requireFields(body, ['title', 'category', 'content']);
    const id = Number(db.prepare('INSERT INTO battlecards (title, category, content) VALUES (?, ?, ?)').run(body.title, body.category, body.content).lastInsertRowid);
    return { id };
  });

  route('POST', '/api/content/tips', ['manager', 'admin'], ({ user, body }) => {
    requireFields(body, ['text']);
    const id = Number(db.prepare('INSERT INTO tips (text, author) VALUES (?, ?)').run(body.text, user.name).lastInsertRowid);
    return { id };
  });

  route('GET', '/api/integrations/status', ['admin', 'manager'], () => {
    const sso = config.sso();
    const crm = config.crm();
    const cal = config.calendar();
    const chat = config.chat();
    const lastRun = (kind) => db.prepare('SELECT status, detail, created_at FROM integration_runs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) || null;
    const count = (sql) => db.prepare(sql).get().n;
    return {
      appUrl: config.appUrl(),
      sso: { enabled: sso.enabled, name: sso.name, issuer: sso.issuer || null, ssoOnly: sso.ssoOnly, allowedDomains: sso.allowedDomains,
        redirectUri: `${config.appUrl()}/auth/sso/callback`, ssoUsers: count('SELECT COUNT(*) AS n FROM users WHERE sso_subject IS NOT NULL') },
      crm: { provider: crm.provider || null, syncMinutes: crm.syncMinutes, lastRun: lastRun('crm_sync'),
        deals: count('SELECT COUNT(*) AS n FROM crm_deals'), linkedDeals: count('SELECT COUNT(*) AS n FROM crm_deals WHERE user_id IS NOT NULL') },
      calendar: { enabled: cal.enabled, redirectUri: `${config.appUrl()}/integrations/calendar/callback`,
        connectedUsers: count('SELECT COUNT(*) AS n FROM calendar_connections'), lastError: lastRun('calendar_sync') },
      googleChat: { enabled: chat.enabled, canSend: !!(chat.enabled && chat.serviceAccount), hour: chat.hour,
        endpoint: `${config.appUrl()}/integrations/google-chat`, linkedUsers: count('SELECT COUNT(*) AS n FROM chat_links'), lastRun: lastRun('chat_challenge') },
      digest: (() => {
        const d = config.digest();
        return { canDeliver: chat.enabled && !!chat.serviceAccount, mirror: !!d.webhookUrl, sendTime: d.sendTime, approval: d.approval,
          pilot: d.pilotEmails.length, gong: d.gong.enabled, drive: d.drive.enabled, web: d.web.enabled, ai: aiEnabled(),
          crmReasons: !!(config.crm().fields.wonReason || config.crm().fields.lostReason),
          lastRuns: ['digest_plan', 'digest_draft', 'digest_queue', 'digest_send'].map(lastRun).filter(Boolean) };
      })(),
      ai: { enabled: aiEnabled() },
    };
  });

  // ---------- Integrations & extensions ----------
  for (const register of opts.extensions || []) register({ db, route, today, opts });

  // ---------- Dispatcher ----------
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const isRoute = /^\/(api|auth|integrations|digest)\//.test(url.pathname);
      if (!isRoute) return await serveStatic(url.pathname, res);

      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) throw new HttpError(404, 'Not found');
      const params = Object.fromEntries(match.keys.map((k, i) => [k, Number(url.pathname.match(match.re)[i + 1])]));
      const token = parseCookies(req.headers.cookie).pp_session;
      let user = null;
      if (match.roles) {
        user = userForToken(db, token);
        if (!user) throw new HttpError(401, 'Please sign in');
        if (match.roles.length && !match.roles.includes(user.role)) throw new HttpError(403, 'Not allowed');
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'pitchpulse') throw new HttpError(403, 'Missing CSRF header');
      } else {
        user = userForToken(db, token); // optional on public routes
      }
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const result = await match.handler({ req, res, user, token, params, body, query: url.searchParams });
      if (res.writableEnded) return; // handler wrote its own response (e.g. a redirect)
      send(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.end();
      send(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  };
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new HttpError(413, 'Body too large');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw bad('Invalid JSON'); }
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'Not found');
  let data;
  let type = MIME[extname(file)];
  try {
    data = await readFile(file);
  } catch {
    data = await readFile(join(PUBLIC_DIR, 'index.html')); // SPA fallback
    type = MIME['.html'];
  }
  res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' });
  res.end(data);
}
