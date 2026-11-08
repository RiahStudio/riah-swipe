/**
 * Sign in with Google — the two HTTP legs, wired to this product's storage.
 *
 * The OAuth mechanics and the linking policy live in ./google-oauth.mjs and
 * ./account-link.mjs, which hold no storage of their own.
 * Only this file knows about our database and cookies — keep it that way,
 * so the OAuth code stays reusable.
 *
 * Routes:
 *   GET  /api/auth/google           → redirect to Google (sets a short pending cookie)
 *   GET  /api/auth/google/callback  → verify, create-or-link, return handoff page
 *   POST /api/auth/google/finish    → same-origin fetch sets the session cookie
 *
 * Why finish is a separate POST: Chrome's bounce-tracking mitigations often drop
 * cookies set on the Google→us redirect response. The callback page loads on our
 * origin, then a same-origin fetch sets the session — that sticks.
 *
 * Hidden until configured: `googleEnabled()` is false without a client id, and the
 * sign-in buttons don't render. Nothing dead ever ships.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createAuthUrl, createPkce, createState, safeEqual, completeLogin } from './google-oauth.mjs';
import { decideAccountLink, refusalMessage } from './account-link.mjs';

const PENDING_COOKIE = 'rsw_goauth';
const PENDING_MAX_AGE = 600; // 10 minutes
const FINISH_MAX_AGE_MS = 2 * 60 * 1000; // 2 minutes to redeem

export function googleEnabled() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_URL);
}

function pendingSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET missing/short');
  return s;
}

function sealPending(state, verifier) {
  const body = Buffer.from(JSON.stringify({
    state,
    verifier,
    exp: Date.now() + PENDING_MAX_AGE * 1000,
  })).toString('base64url');
  const sig = createHmac('sha256', pendingSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function openPending(raw) {
  try {
    const [body, sig] = String(raw || '').split('.');
    if (!body || !sig) return null;
    const expect = createHmac('sha256', pendingSecret()).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.state || !data.verifier || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

/** One-shot ticket the handoff page redeems via same-origin POST. */
function sealFinish(accountId) {
  const body = Buffer.from(JSON.stringify({
    aid: accountId,
    exp: Date.now() + FINISH_MAX_AGE_MS,
  })).toString('base64url');
  const sig = createHmac('sha256', pendingSecret()).update(`finish:${body}`).digest('base64url');
  return `${body}.${sig}`;
}

function openFinish(raw) {
  try {
    const [body, sig] = String(raw || '').split('.');
    if (!body || !sig) return null;
    const expect = createHmac('sha256', pendingSecret()).update(`finish:${body}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.aid || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function pendingCookieHeader(value, { clear = false } = {}) {
  const prod = process.env.NODE_ENV === 'production';
  return [
    `${PENDING_COOKIE}=${clear ? '' : value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    prod ? 'Secure' : '',
    clear ? 'Max-Age=0' : `Max-Age=${PENDING_MAX_AGE}`,
  ].filter(Boolean).join('; ');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param deps { getDb, newId, issueAuthCookies, setCookies, getCookie, clientIp, rateLimit, basePath, sendJson }
 */
export function makeGoogleRoutes(deps) {
  const {
    getDb, newId, issueAuthCookies, setCookies, getCookie, clientIp, rateLimit,
    basePath = '', sendJson,
  } = deps;

  const redirect = (res, to, cookies = []) => {
    if (cookies.length) setCookies(res, ...cookies);
    res.writeHead(302, {
      Location: to.startsWith('http') ? to : `${basePath}${to}`,
      'Cache-Control': 'no-store',
    });
    res.end();
  };

  /** Handoff document: no session cookie yet — finish POST sets it same-origin. */
  const handoffPage = (res, { finishToken, clearCookies = [] }) => {
    if (clearCookies.length) setCookies(res, ...clearCookies);
    const finishUrl = `${basePath}/api/auth/google/finish`;
    const dest = `${basePath}/dashboard`;
    const fail = `${basePath}/signup?google=failed`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<title>Signing in…</title>`
      + `<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0a0e1a;color:#cdd4e3}`
      + `p{opacity:.85}a{color:#a5b4fc}</style></head><body>`
      + `<main><p id="m">Signing you in…</p>`
      + `<p hidden id="fallback"><a href="${dest}">Continue to Riah Swipe</a></p></main>`
      + `<script>(async()=>{`
      + `const m=document.getElementById('m');`
      + `try{`
      + `const r=await fetch(${JSON.stringify(finishUrl)},{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({token:${JSON.stringify(finishToken)}})});`
      + `const j=await r.json().catch(()=>({}));`
      + `if(!r.ok||!j.ok)throw new Error('finish');`
      + `location.replace(${JSON.stringify(dest)});`
      + `}catch(e){`
      + `m.textContent='Could not finish Google sign-in.';`
      + `document.getElementById('fallback').hidden=false;`
      + `setTimeout(()=>location.replace(${JSON.stringify(fail)}),1800);`
      + `}`
      + `})();</script></body></html>`,
    );
  };

  function start(req, res) {
    if (!googleEnabled()) return redirect(res, '/signup?google=unavailable');
    if (!rateLimit(`goauth:${clientIp(req)}`, { limit: 20 })) {
      return redirect(res, '/signup?google=slow_down');
    }

    const state = createState();
    const { verifier, challenge } = createPkce();
    const sealed = sealPending(state, verifier);

    return redirect(res, createAuthUrl({
      clientId: process.env.GOOGLE_CLIENT_ID,
      redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URL,
      state,
      codeChallenge: challenge,
      prompt: 'select_account consent',
    }), [pendingCookieHeader(sealed)]);
  }

  async function callback(req, res, url) {
    const clearPending = [pendingCookieHeader('', { clear: true })];
    if (!googleEnabled()) return redirect(res, '/signup?google=unavailable', clearPending);

    const sealed = getCookie(req, PENDING_COOKIE);
    let row = openPending(sealed);

    if (!row && sealed && !String(sealed).includes('.')) {
      const db = getDb();
      const legacy = db.prepare(
        'SELECT state, verifier, expires_at AS expiresAt FROM oauth_pending WHERE ref=?',
      ).get(sealed);
      if (legacy) {
        db.prepare('DELETE FROM oauth_pending WHERE ref=?').run(sealed);
        if (legacy.expiresAt >= Date.now()) {
          row = { state: legacy.state, verifier: legacy.verifier };
        }
      }
    }

    if (!row) return redirect(res, '/signup?google=expired', clearPending);
    if (url.searchParams.get('error')) return redirect(res, '/signup?google=cancelled', clearPending);

    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    if (!code || !safeEqual(state, row.state)) return redirect(res, '/signup?google=failed', clearPending);

    let identity;
    try {
      identity = await completeLogin({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URL,
        codeVerifier: row.verifier,
      });
    } catch {
      return redirect(res, '/signup?google=failed', clearPending);
    }

    const db = getDb();
    const existingRow = db.prepare('SELECT * FROM accounts WHERE email=?').get(identity.email);
    const existing = existingRow
      ? {
          id: existingRow.id,
          email: existingRow.email,
          googleSub: existingRow.google_sub || null,
          hasPassword: Boolean(existingRow.password_hash) && existingRow.password_hash !== GOOGLE_ONLY_SENTINEL,
        }
      : null;

    // Already have an account for this verified Google email → link (if needed) and
    // log them in. Never bounce them to a "use password" dead end.
    const decision = decideAccountLink(identity, existing);
    let accountId = decision.accountId;

    try {
      if (decision.action === 'refuse') return redirect(res, '/signup?google=failed', clearPending);

      if (decision.action === 'create') {
        accountId = newId();
        db.prepare(`INSERT INTO accounts (id, email, password_hash,
                     session_version, created_at, google_sub, email_verified)
                    VALUES (?,?,?,1,?,?,1)`)
          .run(accountId, identity.email, GOOGLE_ONLY_SENTINEL,
               new Date().toISOString(), decision.setGoogleSub);
      } else if (decision.action === 'link') {
        db.prepare('UPDATE accounts SET google_sub=?, email_verified=1 WHERE id=?')
          .run(decision.setGoogleSub, accountId);
      } else if (decision.action === 'login') {
        db.prepare('UPDATE accounts SET email_verified=1 WHERE id=?').run(accountId);
      }
    } catch {
      return redirect(res, '/signup?google=failed', clearPending);
    }

    const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
    if (!acc) return redirect(res, '/signup?google=failed', clearPending);

    // Do NOT set the session cookie here — Chrome often drops it on this hop.
    // Hand the browser a short-lived finish ticket; the page redeems it same-origin.
    return handoffPage(res, {
      finishToken: sealFinish(acc.id),
      clearCookies: clearPending,
    });
  }

  async function finish(req, res) {
    if (!googleEnabled()) return sendJson(res, 503, { ok: false, error: 'unavailable' });
    if (!rateLimit(`goauth-finish:${clientIp(req)}`, { limit: 30 })) {
      return sendJson(res, 429, { ok: false, error: 'slow_down' });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad_body' });
    }

    const ticket = openFinish(body && body.token);
    if (!ticket) return sendJson(res, 401, { ok: false, error: 'expired' });

    const acc = getDb().prepare('SELECT * FROM accounts WHERE id=?').get(ticket.aid);
    if (!acc) return sendJson(res, 401, { ok: false, error: 'missing' });

    // Same-origin POST — session cookie set here survives bounce tracking.
    issueAuthCookies(res, acc, req, {
      path: basePath || '/',
    });
    return sendJson(res, 200, { ok: true });
  }

  return { start, callback, finish };
}

export const GOOGLE_ONLY_SENTINEL = 'google:no-password';

export { refusalMessage };
