// Encrypts stored OAuth refresh tokens at rest (AES-256-GCM).
// Set APP_SECRET in production; otherwise a random key is generated next to the database.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let key = null;
function getKey() {
  if (key) return key;
  let secret = process.env.APP_SECRET;
  if (!secret) {
    const file = process.env.APP_SECRET_FILE || 'data/app-secret';
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    secret = readFileSync(file, 'utf8').trim();
  }
  key = createHash('sha256').update(secret).digest();
  return key;
}

export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(packed) {
  const [iv, tag, data] = packed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
