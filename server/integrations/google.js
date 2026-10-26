// Google service-account access tokens (JWT bearer grant), cached per account + scope.
// Shared by the Google Chat app and the weekly digest's Drive reader.
import { readFileSync } from 'node:fs';
import { HttpError } from '../errors.js';
import { signJwt } from './jwt.js';
import { tokenRequest } from './oauth.js';

const cache = new Map();

/** Accepts the JSON key contents or a path to the key file. */
export function parseServiceAccount(raw, envName = 'service account') {
  if (!raw) throw new HttpError(400, `${envName} is not set (JSON key contents or file path)`);
  return JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8'));
}

export async function serviceAccountToken(sa, scope, tokenUrl) {
  const key = `${sa.client_email} ${scope}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now() + 60e3) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({ iss: sa.client_email, scope, aud: tokenUrl, iat: now, exp: now + 3600 }, sa.private_key, sa.private_key_id);
  const tok = await tokenRequest(tokenUrl, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  cache.set(key, { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 });
  return tok.access_token;
}
