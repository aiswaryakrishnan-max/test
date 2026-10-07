// Minimal, dependency-free JWT (RS256) verification and signing on top of node:crypto.
import { X509Certificate, createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import { HttpError } from '../errors.js';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

const keyCache = new Map(); // url -> { at, keys: Map<kid, KeyObject> }
const KEY_TTL_MS = 60 * 60 * 1000;

/** Fetch signing keys from a JWKS endpoint ({keys:[...]}) or an x509 cert map ({kid: pem}). */
export async function fetchKeys(url, { force = false } = {}) {
  const cached = keyCache.get(url);
  if (cached && !force && Date.now() - cached.at < KEY_TTL_MS) return cached.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch signing keys from ${url} (${res.status})`);
  const data = await res.json();
  const keys = new Map();
  if (Array.isArray(data.keys)) {
    for (const jwk of data.keys) if (jwk.kty === 'RSA') keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
  } else {
    for (const [kid, pem] of Object.entries(data)) keys.set(kid, new X509Certificate(pem).publicKey);
  }
  keyCache.set(url, { at: Date.now(), keys });
  return keys;
}

export function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed token');
  try {
    return {
      header: JSON.parse(fromB64url(parts[0])),
      payload: JSON.parse(fromB64url(parts[1])),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: fromB64url(parts[2]),
    };
  } catch {
    throw new HttpError(401, 'Malformed token');
  }
}

/**
 * Verify an RS256 JWT: signature against keysUrl, then iss / aud / exp / nbf.
 * `issuers` is a list of accepted issuers; `audience` must appear in the aud claim.
 */
export async function verifyJwt(token, { keysUrl, issuers, audience, skewSeconds = 60 }) {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header.alg !== 'RS256') throw new HttpError(401, `Unsupported token algorithm ${header.alg}`);
  let keys = await fetchKeys(keysUrl);
  if (!keys.has(header.kid)) keys = await fetchKeys(keysUrl, { force: true }); // key rotation
  const key = keys.get(header.kid);
  if (!key) throw new HttpError(401, 'Unknown token signing key');
  if (!verify('RSA-SHA256', Buffer.from(signingInput), key, signature)) throw new HttpError(401, 'Invalid token signature');

  const now = Math.floor(Date.now() / 1000);
  if (!issuers.includes(payload.iss)) throw new HttpError(401, 'Unexpected token issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new HttpError(401, 'Unexpected token audience');
  if (typeof payload.exp !== 'number' || payload.exp + skewSeconds < now) throw new HttpError(401, 'Token expired');
  if (typeof payload.nbf === 'number' && payload.nbf - skewSeconds > now) throw new HttpError(401, 'Token not yet valid');
  return payload;
}

export function signJwt(payload, privateKeyPem, kid) {
  const header = { alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = sign('RSA-SHA256', Buffer.from(input), createPrivateKey(privateKeyPem));
  return `${input}.${b64url(sig)}`;
}
