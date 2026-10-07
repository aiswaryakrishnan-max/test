// Google Calendar connect: each rep links their calendar (read-only) so PitchPulse can surface
// upcoming customer meetings with a just-in-time prep plan and a role-play of that buyer.
import { HttpError } from '../errors.js';
import { redirect } from '../http.js';
import { config } from './config.js';
import { logRun } from './crm.js';
import { consumeState, createState, tokenRequest } from './oauth.js';
import { decrypt, encrypt } from './secrets.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const LOOKAHEAD_HOURS = 72;
const STALE_MINUTES = 15;

const redirectUri = () => `${config.appUrl()}/integrations/calendar/callback`;

const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';
const IGNORED_DOMAINS = /(resource\.calendar\.google\.com|group\.calendar\.google\.com|group\.v\.calendar\.google\.com)$/;

/** Attendee domains that are not ours, i.e. this is a customer/prospect meeting. */
export function externalDomains(attendeeEmails, userEmail) {
  const internal = new Set([domainOf(userEmail), ...config.companyDomains()]);
  return [...new Set(attendeeEmails.map(domainOf))].filter((d) => d && !internal.has(d) && !IGNORED_DOMAINS.test(d));
}

async function accessToken(db, userId) {
  const conn = db.prepare('SELECT * FROM calendar_connections WHERE user_id = ?').get(userId);
  if (!conn) return null;
  const cfg = config.calendar();
  try {
    const tok = await tokenRequest(cfg.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: decrypt(conn.refresh_token_enc),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
    return tok.access_token;
  } catch (err) {
    if (/invalid_grant/.test(err.message)) {
      // The user revoked access in their Google account. Forget the connection so the UI asks again.
      db.prepare('DELETE FROM calendar_connections WHERE user_id = ?').run(userId);
    }
    throw err;
  }
}

export async function syncCalendar(db, userId, now = new Date()) {
  const cfg = config.calendar();
  const token = await accessToken(db, userId);
  if (!token) return 0;
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + LOOKAHEAD_HOURS * 3600e3).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  });
  const res = await fetch(`${cfg.apiBase}/calendars/primary/events?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Google Calendar error (${res.status}): ${data.error?.message || 'unknown'}`);

  const keep = [];
  const upsert = db.prepare(`
    INSERT INTO calendar_events (user_id, external_id, title, start_at, end_at, attendees, external_domains, link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, external_id) DO UPDATE SET title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
      attendees = excluded.attendees, external_domains = excluded.external_domains, link = excluded.link`);
  for (const ev of data.items || []) {
    if (ev.status === 'cancelled' || !ev.start?.dateTime) continue; // skip all-day events
    const me = (ev.attendees || []).find((a) => a.self);
    if (me?.responseStatus === 'declined') continue;
    const emails = (ev.attendees || []).filter((a) => !a.self && !a.resource).map((a) => a.email);
    const ext = externalDomains(emails, user.email);
    if (!ext.length) continue; // internal meeting
    upsert.run(userId, ev.id, ev.summary || '(no title)', new Date(ev.start.dateTime).toISOString(),
      ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : null, JSON.stringify(emails), JSON.stringify(ext), ev.hangoutLink || ev.htmlLink || null);
    keep.push(ev.id);
  }
  // Drop future events that disappeared (cancelled, moved out of window, became internal).
  const placeholders = keep.map(() => '?').join(',');
  db.prepare(`DELETE FROM calendar_events WHERE user_id = ? AND start_at >= ? ${keep.length ? `AND external_id NOT IN (${placeholders})` : ''}`)
    .run(userId, now.toISOString(), ...keep);
  db.prepare("UPDATE calendar_connections SET last_synced_at = datetime('now') WHERE user_id = ?").run(userId);
  return keep.length;
}

/** Match a meeting to an open CRM deal by attendee domain or account name. */
export function matchDeal(db, userId, meeting) {
  // Soonest-closing first, so the most urgent deal wins when an account has several.
  const deals = db.prepare(`SELECT id, name, account, stage, amount, close_date FROM crm_deals WHERE user_id = ? AND is_closed = 0
    ORDER BY close_date IS NULL, close_date ASC`).all(userId);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const roots = meeting.domains.map((d) => norm(d.split('.').slice(-2, -1)[0]));
  const title = norm(meeting.title);
  return deals.find((d) => {
    const acct = norm(d.account || d.name.split(/[-–—:|]/)[0]);
    return acct.length >= 3 && (roots.some((r) => r && (acct.includes(r) || r.includes(acct))) || title.includes(acct));
  }) || null;
}

export async function upcomingMeetings(db, userId, now = new Date()) {
  const conn = db.prepare('SELECT * FROM calendar_connections WHERE user_id = ?').get(userId);
  let syncError = null;
  const stale = conn && (!conn.last_synced_at || Date.parse(`${conn.last_synced_at}Z`) < now.getTime() - STALE_MINUTES * 60e3);
  if (stale && config.calendar().enabled) {
    try { await syncCalendar(db, userId, now); } catch (err) { syncError = err.message; logRun(db, 'calendar_sync', 'error', `user ${userId}: ${err.message}`); }
  }
  const rows = db.prepare(`SELECT * FROM calendar_events WHERE user_id = ? AND start_at >= ? AND start_at <= ? ORDER BY start_at LIMIT 10`)
    .all(userId, new Date(now.getTime() - 3600e3).toISOString(), new Date(now.getTime() + 48 * 3600e3).toISOString());
  const meetings = rows.map((r) => {
    const m = { id: r.id, title: r.title, start: r.start_at, end: r.end_at, link: r.link, attendees: JSON.parse(r.attendees), domains: JSON.parse(r.external_domains) };
    return { ...m, deal: matchDeal(db, userId, m) };
  });
  return { enabled: config.calendar().enabled, connected: !!db.prepare('SELECT 1 FROM calendar_connections WHERE user_id = ?').get(userId), meetings, syncError };
}

export function registerCalendar({ db, route }) {
  route('GET', '/api/calendar/meetings', [], ({ user }) => upcomingMeetings(db, user.id));

  route('GET', '/integrations/calendar/connect', [], ({ user, res }) => {
    const cfg = config.calendar();
    if (!cfg.enabled) throw new HttpError(404, 'Google Calendar is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
    const { state, challenge } = createState(db, 'calendar', { userId: user.id });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: redirectUri(),
      scope: SCOPE,
      access_type: 'offline',     // we need a refresh token to sync in the background
      prompt: 'consent',
      include_granted_scopes: 'true',
      login_hint: user.email,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    redirect(res, `${cfg.authUrl}?${params}`);
  });

  route('GET', '/integrations/calendar/callback', [], async ({ user, res, query }) => {
    try {
      if (query.get('error')) throw new HttpError(400, query.get('error') === 'access_denied' ? 'Calendar access was not granted.' : query.get('error'));
      const saved = consumeState(db, query.get('state'), 'calendar');
      if (saved.user_id !== user.id) throw new HttpError(403, 'This calendar link was started by a different user.');
      const cfg = config.calendar();
      const tok = await tokenRequest(cfg.tokenUrl, {
        grant_type: 'authorization_code',
        code: query.get('code') || '',
        redirect_uri: redirectUri(),
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code_verifier: saved.verifier,
      });
      if (!tok.refresh_token) throw new HttpError(502, 'Google did not return a refresh token. Remove PitchPulse from your Google account permissions and connect again.');
      db.prepare(`INSERT INTO calendar_connections (user_id, provider, refresh_token_enc) VALUES (?, 'google', ?)
        ON CONFLICT (user_id) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc, connected_at = datetime('now'), last_synced_at = NULL`)
        .run(user.id, encrypt(tok.refresh_token));
      await syncCalendar(db, user.id).catch((err) => console.error('[calendar] first sync failed:', err.message));
      redirect(res, '/#/today?calendar=connected');
    } catch (err) {
      redirect(res, `/#/profile?calendar_error=${encodeURIComponent(err.message)}`);
    }
  });

  route('POST', '/api/calendar/disconnect', [], ({ user }) => {
    db.prepare('DELETE FROM calendar_connections WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM calendar_events WHERE user_id = ?').run(user.id);
    return { ok: true };
  });
}
