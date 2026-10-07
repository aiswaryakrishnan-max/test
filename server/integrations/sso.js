// Single sign-on via OpenID Connect (authorization code flow + PKCE).
// Works with any OIDC provider: Google Workspace, Okta, Microsoft Entra ID, Auth0, OneLogin…
import { createSession } from '../auth.js';
import { redirect, sessionCookie } from '../http.js';
import { HttpError } from '../errors.js';
import { config } from './config.js';
import { verifyJwt } from './jwt.js';
import { consumeState, createState, tokenRequest } from './oauth.js';

const discoveryCache = new Map();

export async function discover(issuer) {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3600e3) return hit.doc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new HttpError(502, `OIDC discovery failed for ${issuer} (${res.status})`);
  const doc = await res.json();
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

const redirectUri = () => `${config.appUrl()}/auth/sso/callback`;

/** Find the user for verified ID-token claims, creating them on first sign-in (just-in-time provisioning). */
export function provisionUser(db, claims, sso = config.sso()) {
  const email = String(claims.email || '').toLowerCase();
  if (!email) throw new HttpError(403, 'Your identity provider did not share an email address.');
  if (claims.email_verified === false) throw new HttpError(403, 'Your email address is not verified with your identity provider.');
  const domain = email.split('@')[1];
  if (sso.allowedDomains.length && !sso.allowedDomains.includes(domain)) {
    throw new HttpError(403, `Accounts from ${domain} are not allowed to sign in.`);
  }

  let user = db.prepare('SELECT * FROM users WHERE sso_subject = ?').get(claims.sub)
    || db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    db.prepare("UPDATE users SET sso_subject = ?, last_login_at = datetime('now') WHERE id = ?").run(claims.sub, user.id);
    return user;
  }
  const teamId = sso.defaultTeam ? db.prepare('SELECT id FROM teams WHERE name = ?').get(sso.defaultTeam)?.id ?? null : null;
  const name = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email.split('@')[0];
  const id = Number(db.prepare(`INSERT INTO users (email, name, password_hash, role, team_id, sso_subject, last_login_at)
    VALUES (?, ?, '', 'rep', ?, ?, datetime('now'))`).run(email, name, teamId, claims.sub).lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function registerSso({ db, route }) {
  route('GET', '/api/auth/config', null, () => {
    const sso = config.sso();
    return { sso: { enabled: sso.enabled, name: sso.name }, passwordLogin: !sso.ssoOnly };
  });

  route('GET', '/auth/sso/start', null, async ({ res }) => {
    const sso = config.sso();
    if (!sso.enabled) throw new HttpError(404, 'Single sign-on is not configured');
    const doc = await discover(sso.issuer);
    const { state, challenge, nonce } = createState(db, 'sso', { nonce: true });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: sso.clientId,
      redirect_uri: redirectUri(),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    // Google Workspace: pre-select the company domain on the account chooser.
    if (sso.allowedDomains.length === 1 && /accounts\.google\.com/.test(sso.issuer)) params.set('hd', sso.allowedDomains[0]);
    redirect(res, `${doc.authorization_endpoint}?${params}`);
  });

  route('GET', '/auth/sso/callback', null, async ({ res, query }) => {
    try {
      if (query.get('error')) throw new HttpError(401, query.get('error_description') || query.get('error'));
      const sso = config.sso();
      if (!sso.enabled) throw new HttpError(404, 'Single sign-on is not configured');
      const saved = consumeState(db, query.get('state'), 'sso');
      const doc = await discover(sso.issuer);
      const tokens = await tokenRequest(doc.token_endpoint, {
        grant_type: 'authorization_code',
        code: query.get('code') || '',
        redirect_uri: redirectUri(),
        client_id: sso.clientId,
        client_secret: sso.clientSecret,
        code_verifier: saved.verifier,
      });
      if (!tokens.id_token) throw new HttpError(502, 'Identity provider did not return an ID token');
      const claims = await verifyJwt(tokens.id_token, { keysUrl: doc.jwks_uri, issuers: [doc.issuer], audience: sso.clientId });
      if (claims.nonce !== saved.nonce) throw new HttpError(401, 'Sign-in response did not match this request (nonce)');

      const user = provisionUser(db, claims, sso);
      redirect(res, '/', { 'Set-Cookie': sessionCookie(createSession(db, user.id)) });
    } catch (err) {
      if (!err.status || err.status >= 500) console.error('[sso]', err);
      redirect(res, `/?sso_error=${encodeURIComponent(err.message)}`);
    }
  });
}
