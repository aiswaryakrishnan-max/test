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

### Integrations
| Integration | What it does |
|---|---|
| 🔐 **Single sign-on** | "Sign in with Google / Okta / Microsoft" using OpenID Connect. New hires get an account on first sign-in, restricted to your email domains; you can turn off passwords entirely. |
| 💼 **CRM sync** | Read-only sync of Salesforce opportunities or HubSpot deals, matched to reps by email. Managers see **win rate and pipeline next to readiness**. Reps get coaching for the stage their deals are in (Negotiation → pricing objections). |
| 📅 **Calendar connect** | Each rep links Google Calendar (read-only). Upcoming **customer meetings** appear on Today with the matching CRM deal and a one-click **rehearsal role-play of that meeting**. |
| 💬 **Google Chat** | The Daily Challenge arrives as an **interactive card in a Chat DM** every morning. Reps tap A/B/C/D, get instant feedback, and their XP and streak update in the app. Commands: `challenge`, `streak`, `leaderboard`, `help`. |
| 🎭 **AI role-plays** | A live practice call where **Claude plays the buyer** (friendly, skeptical or tough), by text or **voice** (speech-to-text in, spoken buyer replies out). Ends with a **scorecard**: 5 skill scores, talk ratio, best moment and a better line to use. |

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
npm test             # API, engine and integration tests (all providers mocked)
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
| `APP_URL` | `http://localhost:PORT` | Public URL of the app, used to build OAuth redirect URIs (use `https://` in production) |
| `APP_SECRET` | auto-generated file | Key for encrypting stored calendar tokens. **Set this in production.** |
| `COMPANY_DOMAINS` | rep's own domain | Comma-separated internal domains, so meetings with only these attendees aren't treated as customer meetings |

Admins can check the status of every integration, and copy the exact redirect URIs, under **Integrations** in the app.

## Integration setup

### 🔐 Single sign-on (OpenID Connect)
1. Create an OIDC "web application" client in your identity provider:
   - **Google Workspace**: Google Cloud Console → APIs & Services → Credentials → *OAuth client ID* → Web application. Issuer: `https://accounts.google.com`
   - **Okta**: Applications → Create App Integration → OIDC → Web. Issuer: `https://<your-org>.okta.com` (or your authorization server URL)
   - **Microsoft Entra ID**: App registrations → New registration → Web. Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`
2. Add the redirect URI: `APP_URL/auth/sso/callback`
3. Set:

| Env var | Example |
|---|---|
| `OIDC_ISSUER` | `https://accounts.google.com` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | from step 1 |
| `SSO_PROVIDER_NAME` | `Google`: the button reads "Sign in with Google" |
| `SSO_ALLOWED_DOMAINS` | `yourcompany.com`: only these email domains may sign in (strongly recommended) |
| `SSO_DEFAULT_TEAM` | optional team name for new users |
| `SSO_ONLY` | `true` to disable password login |

Users are matched by email, so existing accounts keep their role and team. New users are created as reps; promote managers by changing `role` in the `users` table.

### 💼 CRM sync
**HubSpot**: create a *Private app* (Settings → Integrations → Private Apps) with scopes `crm.objects.deals.read` and `crm.objects.owners.read`.
```
CRM_PROVIDER=hubspot
HUBSPOT_ACCESS_TOKEN=pat-...
```
**Salesforce**: create a *Connected App* with OAuth enabled and the **Client Credentials Flow** turned on. Set a "Run As" integration user who can read Opportunities, Users and Accounts.
```
CRM_PROVIDER=salesforce
SALESFORCE_DOMAIN=https://yourcompany.my.salesforce.com
SALESFORCE_CLIENT_ID=...
SALESFORCE_CLIENT_SECRET=...
```
Syncs on start-up and every `CRM_SYNC_MINUTES` (default 60). Admins can also click **Sync now**. Deals are matched to reps by the CRM owner's email. Until a CRM is connected, the demo database shows sample pipeline data.

### 📅 Google Calendar
1. In Google Cloud Console, enable the **Google Calendar API**, configure the OAuth consent screen (Internal for Workspace), and create an *OAuth client ID* (Web application).
2. Add the redirect URI: `APP_URL/integrations/calendar/callback`
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Reps then click **Connect Google Calendar** on Today or Profile.

PitchPulse requests read-only event access (`calendar.events.readonly`). It stores only meetings with external attendees in the next 72 hours, and keeps the refresh token encrypted with `APP_SECRET`.

### 💬 Google Chat
1. In Google Cloud Console, enable the **Google Chat API**. Under *Configuration*, set the app name, avatar and description, check *Receive 1:1 messages*, and choose **HTTP endpoint URL** = `APP_URL/integrations/google-chat`. Set authentication audience = *Project number*. Configure it as a Chat API app, not a Google Workspace add-on.
2. Create a **service account** and download its JSON key. The app uses it to send the morning challenge.
3. Set:

| Env var | Example |
|---|---|
| `GOOGLE_CHAT_AUDIENCE` | your Cloud **project number** (or the endpoint URL if you chose that audience type) |
| `GOOGLE_CHAT_SERVICE_ACCOUNT` | path to the JSON key file, or its contents |
| `GOOGLE_CHAT_CHALLENGE_HOUR` | `9`: local hour the challenge is sent |

4. Make the app available to your domain. Each rep opens Google Chat, finds **PitchPulse** and says hi. That links their account (by email), and the challenge arrives every morning from then on.

Every request from Google is verified (signed JWT, issuer and audience) before it's processed.

### 🎭 AI role-plays
Set `ANTHROPIC_API_KEY` to have Claude play the buyer and grade the call (`COACH_MODEL`, default `claude-opus-5-5`). Without a key, a scripted buyer and rubric scoring keep the feature working offline. Voice input and spoken replies use the browser's built-in speech APIs (best in Chrome and Edge).

## Make it yours

The seed content (`server/seed.js`) is generic B2B SaaS: a "Competitor X", a sample ICP, pricing objections and so on.
Replace it with your real product, personas, competitors and customer stories. You can edit the seed file, or have managers
publish content through **Content Studio** in the app.

## Architecture

No build step and one runtime dependency (`@anthropic-ai/sdk`). Every integration is plain `fetch` + `node:crypto`.

```
server/
  index.js        HTTP server entry, first-run seeding, reminder scheduler
  app.js          REST API (auth, today, daily challenge, modules, pitches, leaderboard, manager, content)
  engagement.js   XP/levels, streaks, badges, spaced-repetition question picker, readiness score
  coach.js        Pitch scoring: Claude (structured JSON output) with an offline rubric fallback
  roleplay.js     AI role-plays: Claude buyer persona, append-only history, scorecard; scripted fallback
  extensions.js   Feature modules that register routes
  integrations/
    sso.js        OpenID Connect sign-in (PKCE, nonce, JWKS-verified ID tokens, JIT provisioning)
    crm.js        Salesforce + HubSpot adapters, sync, win-rate and deal-stage insights
    calendar.js   Google Calendar OAuth, encrypted refresh tokens, meeting ↔ deal matching
    googlechat.js Google Chat app: verified events, interactive cards, morning DMs via service account
    jwt.js        RS256 JWT verify/sign (JWKS + x509), no dependencies
    oauth.js      OAuth state + PKCE helpers;  secrets.js  AES-256-GCM token encryption
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
- Microsoft 365 / Outlook calendar and Microsoft Teams bot
- SCIM user provisioning and role mapping from IdP groups
- Writing training activity back to the CRM (e.g. readiness score on the User record)
- Real-time voice role-plays (streaming audio) and call-recording analysis
- Certifications and learning paths with prerequisites
- Mobile PWA with push notifications
