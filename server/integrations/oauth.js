// OAuth 2.0 helpers shared by SSO and calendar: state + PKCE (S256), token requests.
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../errors.js';

const STATE_TTL_MINUTES = 10;

export function createState(db, purpose, { userId = null, nonce = false } = {}) {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const nonceValue = nonce ? randomBytes(16).toString('base64url') : null;
  db.prepare(`DELETE FROM oauth_states WHERE created_at < datetime('now', '-${STATE_TTL_MINUTES} minutes')`).run();
  db.prepare('INSERT INTO oauth_states (state, purpose, verifier, nonce, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(state, purpose, verifier, nonceValue, userId);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { state, challenge, nonce: nonceValue };
}

/** One-time use: returns the stored state row and deletes it. */
export function consumeState(db, state, purpose) {
  const row = db.prepare(`SELECT * FROM oauth_states WHERE state = ? AND purpose = ? AND created_at >= datetime('now', '-${STATE_TTL_MINUTES} minutes')`)
    .get(String(state || ''), purpose);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(String(state || ''));
  if (!row) throw new HttpError(400, 'Sign-in link expired or invalid. Please try again.');
  return row;
}

export async function tokenRequest(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Token exchange failed: ${data.error_description || data.error || res.status}`);
  return data;
}
