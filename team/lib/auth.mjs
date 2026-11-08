// server/lib/auth.mjs
// Passwords (scrypt — built into node, correct choice, no exotic crypto),
// session cookies (HMAC-signed, httpOnly), and a small sliding-window rate
// limiter for the abusable endpoints.

import {
  scryptSync, randomBytes, timingSafeEqual, createHmac, randomUUID,
} from 'node:crypto';

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;

// ── Passwords ────────────────────────────────────────────────────────────────
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, nStr, saltHex, hashHex] = String(stored).split(':');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(String(password), salt, expected.length, {
      N: Number(nStr) || SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function passwordPolicy(password) {
  const p = String(password || '');
  if (p.length < 10) return 'Password needs at least 10 characters.';
  if (p.length > 200) return 'Password is too long.';
  return null;
}

// ── Sessions (stateless signed cookie) ───────────────────────────────────────
// Cookie value: base64url(json).base64url(hmac). Payload carries the account
// id, a session_version (bump it server-side to log out everywhere), and exp.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const SESSION_COOKIE = 'rsw_session';

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET missing/short — set a 32+ char random value');
  return s;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function issueSession(account) {
  const payload = JSON.stringify({
    aid: account.id,
    sv:  account.session_version,
    exp: Date.now() + SESSION_TTL_MS,
  });
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${b64u(payload)}.${sig}`;
}

export function readSession(cookieValue) {
  try {
    const [p, sig] = String(cookieValue || '').split('.');
    if (!p || !sig) return null;
    const payload = Buffer.from(p, 'base64url').toString('utf8');
    const expect = createHmac('sha256', secret()).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(payload);
    if (!data.aid || !data.exp || Date.now() > data.exp) return null;
    return data;   // caller still checks session_version against the account row
  } catch {
    return null;
  }
}

/**
 * Which path a cookie should be scoped to for THIS request.
 *
 * Not simply BASE_PATH. The service answers on two origins: behind a reverse proxy
 * under a prefix (BASE_PATH) and directly at its own host, where there is no
 * prefix. Scoping every cookie to BASE_PATH broke the direct host completely —
 * the browser would never send the session back to /dashboard, so signup redirected
 * straight into an endless bounce to /login.
 *
 * So: scope to the prefix only when the request actually arrived under it.
 */
export function cookiePathForRequest(req) {
  const basePath = String(process.env.BASE_PATH || '').replace(/\/$/, '');
  if (!basePath) return '/';
  const path = String((req && req.url) || '').split('?')[0];
  return (path === basePath || path.startsWith(basePath + '/')) ? basePath : '/';
}

export function sessionCookieHeader(value, { clear = false, path } = {}) {
  const prod = process.env.NODE_ENV === 'production';
  // `path` comes from cookiePathForRequest(req). The BASE_PATH fallback keeps old
  // callers working, but every call site in this app passes one explicitly.
  const rawPath = String(process.env.BASE_PATH || '').replace(/\/$/, '');
  const cookiePath = path || rawPath || '/';
  const bits = [
    `${SESSION_COOKIE}=${clear ? '' : value}`,
    `Path=${cookiePath}`,
    'HttpOnly',
    'SameSite=Lax',
    prod ? 'Secure' : '',
    clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  return bits.filter(Boolean).join('; ');
}

/** Append one or more Set-Cookie headers (Node preserves multi-cookie correctly). */
export function setCookies(res, ...cookieHeaders) {
  for (const c of cookieHeaders) {
    if (c) res.appendHeader('Set-Cookie', c);
  }
}

export function newId() { return randomUUID(); }

// ── Rate limiting (sliding window, in-memory) ────────────────────────────────
// Good enough for a single-node deploy; the login lockout that matters most is
// per-identifier so a botnet can't brute one account across IPs.
const buckets = new Map();   // key → number[] (timestamps)

export function rateLimit(key, { limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return false; }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

// Periodic sweep so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    const live = arr.filter((t) => now - t < 60 * 60 * 1000);
    if (live.length) buckets.set(k, live); else buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();
