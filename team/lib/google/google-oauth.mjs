/**
 * Sign in with Google — the OAuth core.
 *
 * Zero dependencies, Node >= 20, no framework. Implements the standard flow:
 *
 *   Authorization Code + PKCE · server-side token exchange · WE verify Google's
 *   ID token (signature via Google's JWKS, plus issuer, audience and expiry) ·
 *   verified emails only · never trust a client-sent profile.
 *
 * What this file does NOT do, on purpose: sessions, cookies, database writes. Each
 * product already has those and they differ. This returns a verified identity; the
 * product decides what to do with it (see account-link.mjs for the policy that
 * decides create-vs-link, which is the part that causes support pain if improvised).
 */

import { createHash, createPublicKey, createVerify, randomBytes, timingSafeEqual } from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** Only what we need. Asking for more triggers Google review and scares people off. */
export const DEFAULT_SCOPE = 'openid email profile';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ── CSRF state + PKCE ────────────────────────────────────────────────────────

/** Opaque value round-tripped through Google and compared on return. */
export function createState() {
  return b64url(randomBytes(32));
}

/** Constant-time compare — a plain === on a secret invites a timing oracle. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

/**
 * PKCE pair. The verifier stays server-side with the session; only the challenge
 * travels. Without it, an intercepted authorization code is enough to sign in as
 * someone else.
 */
export function createPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

// ── Step 1: where to send the user ───────────────────────────────────────────

export function createAuthUrl({
  clientId,
  redirectUri,
  state,
  codeChallenge,
  scope = DEFAULT_SCOPE,
  loginHint,
  prompt,
}) {
  if (!clientId) throw new Error('createAuthUrl: clientId required');
  if (!redirectUri) throw new Error('createAuthUrl: redirectUri required');
  if (!state) throw new Error('createAuthUrl: state required (CSRF)');
  if (!codeChallenge) throw new Error('createAuthUrl: codeChallenge required (PKCE)');

  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    include_granted_scopes: 'true',
  });
  if (loginHint) q.set('login_hint', loginHint);
  if (prompt) q.set('prompt', prompt);
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}

// ── Step 2: trade the code for tokens ────────────────────────────────────────

export async function exchangeCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
  codeVerifier,
  fetchImpl = fetch,
}) {
  if (!code) throw new Error('exchangeCode: code required');
  if (!codeVerifier) throw new Error('exchangeCode: codeVerifier required (PKCE)');

  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }).toString(),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Google's error_description can echo request detail — keep it out of logs.
    throw new Error(`Google token exchange failed (${res.status}: ${body.error || 'unknown'})`);
  }
  if (!body.id_token) throw new Error('Google token exchange returned no id_token');
  return body;
}

// ── Step 3: verify the ID token OURSELVES ────────────────────────────────────

let _jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(fetchImpl, now) {
  if (_jwksCache.keys && now - _jwksCache.fetchedAt < JWKS_TTL_MS) return _jwksCache.keys;
  const res = await fetchImpl(JWKS_URI);
  if (!res.ok) throw new Error(`Could not fetch Google JWKS (${res.status})`);
  const body = await res.json();
  if (!Array.isArray(body.keys) || !body.keys.length) throw new Error('Google JWKS was empty');
  _jwksCache = { keys: body.keys, fetchedAt: now };
  return body.keys;
}

/** Test seam only — lets a suite verify against its own keypair without network. */
export function __setJwksForTests(keys) {
  _jwksCache = { keys, fetchedAt: keys ? Date.now() : 0 };
}

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/**
 * Verify a Google ID token and return the identity, or throw.
 *
 * Checks, in order: shape → RS256 → known key id → signature → issuer → audience
 * → expiry (with a small clock skew allowance) → email present and VERIFIED.
 *
 * The email_verified check is the one that is easy to skip and expensive to miss:
 * without it, someone could register a Google account against an address they do
 * not control and be linked straight into an existing account.
 */
export async function verifyIdToken(idToken, {
  clientId,
  fetchImpl = fetch,
  now = Date.now(),
  clockSkewSec = 120,
} = {}) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('id_token is malformed');
  }
  const [headerB64, payloadB64, sigB64] = idToken.split('.');

  let header, payload;
  try {
    header = decodeSegment(headerB64);
    payload = decodeSegment(payloadB64);
  } catch {
    throw new Error('id_token could not be decoded');
  }

  if (header.alg !== 'RS256') throw new Error(`Unexpected id_token algorithm: ${header.alg}`);

  const keys = await getJwks(fetchImpl, now);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('id_token was signed with an unknown key');

  const pubKey = createPublicKey({ key: jwk, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  if (!verifier.verify(pubKey, Buffer.from(sigB64, 'base64url'))) {
    throw new Error('id_token signature is invalid');
  }

  if (!VALID_ISSUERS.has(payload.iss)) throw new Error(`id_token issuer is wrong: ${payload.iss}`);
  if (!clientId) throw new Error('verifyIdToken: clientId required to check audience');
  if (payload.aud !== clientId) throw new Error('id_token audience is not this app');

  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + clockSkewSec < nowSec) {
    throw new Error('id_token has expired');
  }
  if (typeof payload.iat === 'number' && payload.iat - clockSkewSec > nowSec) {
    throw new Error('id_token was issued in the future');
  }

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) throw new Error('Google returned no email address');
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new Error('Google has not verified this email address');
  }
  if (!payload.sub) throw new Error('Google returned no subject id');

  return {
    googleSub: String(payload.sub),
    email,
    emailVerified: true,
    name: payload.name ? String(payload.name) : '',
    picture: payload.picture ? String(payload.picture) : '',
  };
}

/** Convenience: the whole callback leg, code → verified identity. */
export async function completeLogin({
  clientId,
  clientSecret,
  code,
  redirectUri,
  codeVerifier,
  fetchImpl = fetch,
  now = Date.now(),
}) {
  const tokens = await exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier, fetchImpl });
  return verifyIdToken(tokens.id_token, { clientId, fetchImpl, now });
}
