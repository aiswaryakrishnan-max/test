# 🔥 PitchPulse — daily sales readiness platform

A MindTickle-style sales enablement platform built for **one goal: getting reps to train a little every day**.
Short daily sessions, visible progress, team recognition and manager nudges add up to a daily habit,
which works better than an occasional training marathon.

## How it drives daily usage

| Habit lever | What the rep sees |
|---|---|
| **2-minute Daily Challenge** | 3 questions a day, picked by **spaced repetition**: questions you missed come back first, and mastered ones resurface at growing intervals (1, 2, 4, 8… days). |
| **Streaks** | A 🔥 streak counter with a 7-day activity strip. If you haven't trained today it says **"at risk"**, not "lost". |
| **Daily XP goal** | A progress ring toward a goal you pick (Casual 30 / Regular 50 / Serious 80 / Intense 120 XP). |
| **Levels & badges** | 9 badges (First Steps, Week Warrior, Perfect Day, Pitch Pro…) with toasts and confetti when you unlock one. |
| **Weekly leaderboard** | Resets every Monday so anyone can win. There's also a team-vs-team board (XP per rep). |
| **Social proof** | "3/5 teammates trained today" on the home screen. |
| **Something new every day** | Tip of the day, Drill of the day, assignments with due dates, and a module recommended from your weakest topic. |
| **AI pitch coach** | Write (or **speak**: browser voice input) a pitch for a realistic buyer scenario and get a score, strengths, gaps and a suggested rewrite right away. |
| **Reminders** | A daily in-app reminder for reps who haven't trained yet ("your 6-day streak ends at midnight"), and a team-pulse digest for managers. Can also post to Slack. |
| **Manager loop** | One-click **Nudge** and **Kudos** (+10 XP), coaching notes on pitches, team assignments with completion tracking. |

### For managers
- **Team Readiness dashboard**: daily/weekly active rate, average readiness and streaks, and a per-rep table (readiness, knowledge, modules, pitch, streak, active days).
- **Needs attention**: reps inactive for 2+ days, with "Nudge all".
- **Focus areas**: team accuracy by topic, plus a suggestion for what to assign next.
- **Readiness score** (0–100) = 40% quiz accuracy (30 days) + 30% assigned-module completion + 30% average of the last 5 pitch scores.
- **Content Studio**: publish modules (Markdown + quiz), pitch scenarios, battlecards and daily tips. New quiz questions join the Daily Challenge pool automatically.

## Quick start

Requires **Node.js 22.5+** (uses the built-in `node:sqlite`; no database server needed).

```bash
npm install
npm start            # http://localhost:3000; seeds demo data on first run
```

Demo accounts (password `password123`):

| Role | Email |
|---|---|
| Rep | `rep@pitchpulse.dev` (also `sam@`, `jordan@`, `casey@`, `taylor@`) |
| Manager | `manager@pitchpulse.dev` (Enterprise East), `wm@pitchpulse.dev` (Mid-Market West) |
| Admin | `admin@pitchpulse.dev` (sees all teams) |

```bash
npm test             # API + engine tests (node:test)
npm run seed         # reset the database to demo data
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/pitchpulse.db` | SQLite file |
| `ANTHROPIC_API_KEY` | – | Turns on the **Claude AI pitch coach**. Without it, a built-in rubric coach scores pitches offline. |
| `COACH_MODEL` | `claude-opus-5-5` | Claude model used by the coach |
| `SLACK_WEBHOOK_URL` | – | Also post nudges and daily reminder summaries to Slack |
| `REMINDER_HOUR` | `16` | Local hour when the daily "streak at risk" reminders go out |
| `TZ` | system | Time zone that defines a "day" for streaks |

## Make it yours

The seed content (`server/seed.js`) is generic B2B SaaS: a "Competitor X", a sample ICP, pricing objections and so on.
Replace it with your real product, personas, competitors and customer stories. You can edit the seed file, or have managers
publish content through **Content Studio** in the app.

## Architecture

No build step and one runtime dependency (`@anthropic-ai/sdk`).

```
server/
  index.js        HTTP server entry, first-run seeding, reminder scheduler
  app.js          REST API (auth, today, daily challenge, modules, pitches, leaderboard, manager, content)
  engagement.js   XP/levels, streaks, badges, spaced-repetition question picker, readiness score
  coach.js        Pitch scoring: Claude (structured JSON output) with an offline rubric fallback
  reminders.js    Daily streak reminders, manager digests, Slack webhook
  db.js           SQLite schema (node:sqlite)
  auth.js         scrypt password hashing, cookie sessions
  seed.js         Demo content, users and 3 weeks of activity history
public/           Vanilla JS single-page app (index.html, app.js, styles.css)
test/             node:test suite
```

Security basics: scrypt-hashed passwords, HttpOnly SameSite cookies, a CSRF header required on every mutation,
role checks on manager/admin routes (managers only see their own team), and HTML escaping on all rendered content.

## Ideas for next steps
- SSO (Google / Okta) and CRM sync (Salesforce/HubSpot) to tie readiness to win rates and quota attainment
- Video/audio pitch recording with transcript-based AI scoring
- Slack/Teams bot that delivers the Daily Challenge right in chat
- Certifications and learning paths with prerequisites
- Mobile PWA with push notifications
