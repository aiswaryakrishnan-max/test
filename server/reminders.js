// Daily habit loop: remind reps whose streak is at risk, and send managers a digest.
// Notifications land in the in-app inbox; set SLACK_WEBHOOK_URL to also post to Slack.
import { dayOf, notify, streakInfo, xpOnDay } from './engagement.js';

export async function sendSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    return res.ok;
  } catch (err) {
    console.error('[slack] post failed:', err.message);
    return false;
  }
}

export async function sendDailyReminders(db, day = dayOf()) {
  const reps = db.prepare("SELECT id, name, team_id FROM users WHERE role = 'rep'").all();
  const reminded = [];
  for (const rep of reps) {
    if (xpOnDay(db, rep.id, day) > 0) continue;
    const { current } = streakInfo(db, rep.id, day);
    const msg = current > 0
      ? `🔥 Your ${current}-day streak ends at midnight — today's Daily Challenge takes 2 minutes.`
      : '👋 Fresh start! Complete today\'s Daily Challenge to begin a new streak.';
    notify(db, rep.id, 'reminder', msg);
    reminded.push(rep);
  }

  const managers = db.prepare("SELECT id, team_id FROM users WHERE role = 'manager' AND team_id IS NOT NULL").all();
  for (const m of managers) {
    const team = reps.filter((r) => r.team_id === m.team_id);
    const inactive = reminded.filter((r) => r.team_id === m.team_id);
    if (!team.length) continue;
    notify(db, m.id, 'digest', `Team pulse: ${team.length - inactive.length}/${team.length} reps active today.${inactive.length ? ` Not yet: ${inactive.map((r) => r.name).join(', ')}.` : ' Everyone showed up! 🎉'}`);
  }
  if (reminded.length) await sendSlack(`Daily reminder sent to ${reminded.length} rep(s) who haven't trained yet today.`);
  return reminded.length;
}

/** Fire sendDailyReminders once per day at REMINDER_HOUR (server local time, default 16:00). */
export function scheduleReminders(db) {
  const hour = Number(process.env.REMINDER_HOUR ?? 16);
  let lastRun = null;
  const tick = () => {
    const now = new Date();
    const day = dayOf(now);
    if (now.getHours() >= hour && lastRun !== day) {
      lastRun = day;
      sendDailyReminders(db, day).catch((err) => console.error('[reminders]', err));
    }
  };
  const timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref();
  tick();
  return timer;
}
