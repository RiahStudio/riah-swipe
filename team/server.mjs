// server.mjs
// Riah Swipe team server: accounts, workspaces, projects, hosted decks and the
// browser review app. Free, self-hosted, MIT. Node >= 20; one dependency (better-sqlite3).
// Run: node server.mjs

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

import { getDb } from './lib/db.mjs';
import {
  hashPassword, verifyPassword, passwordPolicy,
  issueSession, readSession, sessionCookieHeader, SESSION_COOKIE,
  newId, rateLimit, setCookies, cookiePathForRequest,
} from './lib/auth.mjs';
import { makeGoogleRoutes, googleEnabled, GOOGLE_ONLY_SENTINEL } from './lib/google/routes.mjs';
import { purgeWorkspace } from './lib/storage.mjs';
import { sendMail, brandedMailHtml } from './lib/mail.mjs';
import {
  HostedError, createWorkspace, createProject, setProjectRole, issueSubmitterToken,
  authenticatePublisher, createHostedDecks, publishHostedDeck, hasProjectRole,
  accountHasReviewerProject, accountHasSubmitterProject, accountHasWorkspaceProject, reviewBatchForAccount,
  submitHostedVerdict, undoHostedVerdict, hostedVerdictsForReviewer,
  assembleHostedResults, workspaceEventsForAccount, submitterProjectsForAccount,
  ownedWorkspacesForAccount,
} from './lib/hosted.mjs';
import {
  HostedMediaError, putHostedCardMedia, hostedCardMediaRow, startHostedPurgeTimer,
} from './lib/hosted-media.mjs';
import { queueProjectReviewNotification } from './lib/notifications.mjs';
import { get as getStoredMedia } from './lib/storage.mjs';
import { parseRangeHeader } from './lib/http-range.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, 'site');
const REVIEW_APP = join(HERE, 'review-app');

// ── Tiny .env loader (reads ./.env next to server.mjs; real env vars win) ───
//
// Skipped under test: a test that unsets a variable would otherwise get it refilled
// from disk. NODE_TEST_CONTEXT is set by `node --test` itself.
(() => {
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test'
      || process.env.RSW_SKIP_ENV_FILE === '1') return;
  const envPath = join(HERE, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
})();

const PORT = Number(process.env.PORT || 8790);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
// Public path prefix when mounted under another host (e.g. /riahswipe on
// a shared domain). Empty = serve at root. Proxies differ in whether they
// forward the prefix — we accept BOTH forms.
const BASE_PATH = String(process.env.BASE_PATH || '').replace(/\/$/, '');

function stripBasePath(pathname) {
  if (!BASE_PATH) return pathname;
  if (pathname === BASE_PATH || pathname.startsWith(BASE_PATH + '/')) {
    const rest = pathname.slice(BASE_PATH.length) || '/';
    return rest.startsWith('/') ? rest : '/' + rest;
  }
  return pathname;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ── Small helpers ────────────────────────────────────────────────────────────
const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function readRawBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limitBytes = 256 * 1024) {
  const raw = await readRawBody(req, limitBytes);
  try { return JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return null; }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function currentAccount(req) {
  const sess = readSession(getCookie(req, SESSION_COOKIE));
  if (!sess) return null;
  const acc = getDb().prepare('SELECT * FROM accounts WHERE id=?').get(sess.aid);
  if (!acc || acc.session_version !== sess.sv) return null;
  return acc;
}

function issueAuthCookies(res, account, req, opts = {}) {
  // req is threaded in so the cookie is scoped to the path this request actually
  // arrived on — see cookiePathForRequest(). Google OAuth may pass path explicitly:
  // the callback arrives as /api/... after a proxy strips the prefix, so
  // auto-detect would wrongly pick `/`.
  const path = opts.path || cookiePathForRequest(req);
  setCookies(res, sessionCookieHeader(issueSession(account), { path }));
}


function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function publisherFor(req, projectId) {
  const acc = currentAccount(req);
  return authenticatePublisher({ projectId, accountId: acc && acc.id, token: bearerToken(req) });
}

function hostedFailure(res, error) {
  if (error instanceof HostedError || error instanceof HostedMediaError) {
    return sendJson(res, error.status, { ok: false, error: error.code, message: error.message, details: error.details });
  }
  throw error;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e) => String(e || '').trim().toLowerCase();

// ── API handlers ─────────────────────────────────────────────────────────────

async function apiSignup(req, res) {
  if (!rateLimit(`signup:${clientIp(req)}`, { limit: 10, windowMs: 60 * 60 * 1000 })) {
    return sendJson(res, 429, { ok: false, error: 'Too many signups from here — try later.' });
  }
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Invalid request.' });
  const email = normEmail(body.email);
  if (!EMAIL_RE.test(email)) return sendJson(res, 400, { ok: false, error: 'That email doesn’t look right.' });
  const pwErr = passwordPolicy(body.password);
  if (pwErr) return sendJson(res, 400, { ok: false, error: pwErr });

  const db = getDb();
  const existing = db.prepare('SELECT * FROM accounts WHERE email=?').get(email);
  if (existing) {
    // Already signed up → if the password matches, just log them in (same door).
    if (existing.password_hash === GOOGLE_ONLY_SENTINEL) {
      return sendJson(res, 409, { ok: false, error: 'That email already uses Google — click Continue with Google.' });
    }
    if (!verifyPassword(body.password, existing.password_hash)) {
      return sendJson(res, 409, { ok: false, error: 'An account with that email already exists — log in instead.' });
    }
    issueAuthCookies(res, existing, req);
    return sendJson(res, 200, { ok: true });
  }
  const account = {
    id: newId(),
    email,
    password_hash: hashPassword(body.password),
    session_version: 1,
    created_at: new Date().toISOString(),
  };
  db.prepare(`INSERT INTO accounts (id, email, password_hash, session_version, created_at)
              VALUES (@id, @email, @password_hash, @session_version, @created_at)`).run(account);
  issueAuthCookies(res, account, req);
  return sendJson(res, 200, { ok: true });
}

async function apiLogin(req, res) {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Invalid request.' });
  const email = normEmail(body.email);
  if (!rateLimit(`login:${clientIp(req)}`, { limit: 20 }) || !rateLimit(`login:${email}`, { limit: 10 })) {
    return sendJson(res, 429, { ok: false, error: 'Too many attempts — wait a few minutes.' });
  }
  const acc = getDb().prepare('SELECT * FROM accounts WHERE email=?').get(email);
  // Uniform error — never reveal whether the email exists.
  if (!acc || !verifyPassword(body.password, acc.password_hash)) {
    return sendJson(res, 401, { ok: false, error: 'Email or password didn’t match.' });
  }
  issueAuthCookies(res, acc, req);
  return sendJson(res, 200, { ok: true });
}


function apiLogout(req, res) {
  setCookies(res, sessionCookieHeader('', { clear: true, path: cookiePathForRequest(req) }));
  return sendJson(res, 200, { ok: true });
}

function apiMe(req, res) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not signed in' });
  return sendJson(res, 200, { ok: true, email: acc.email });
}



async function apiPasswordResetRequest(req, res) {
  if (!rateLimit(`reset:${clientIp(req)}`, { limit: 5 })) {
    return sendJson(res, 429, { ok: false, error: 'Too many requests — wait a few minutes.' });
  }
  const body = await readJsonBody(req);
  const email = normEmail(body && body.email);
  const db = getDb();
  const acc = db.prepare('SELECT * FROM accounts WHERE email=?').get(email);
  if (acc) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT OR REPLACE INTO reset_tokens (token_hash, account_id, expires_at) VALUES (?,?,?)')
      .run(sha256(token), acc.id, new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const resetUrl = `${BASE_URL}/reset?token=${token}`;
    const text =
      `Someone (hopefully you) asked to reset the password for this Riah Swipe account.\n\n` +
      `Reset it here — this link works for 1 hour:\n${resetUrl}\n\n` +
      `If this wasn't you, ignore this email. Nothing changes until you set a new password.`;
    const html = brandedMailHtml({
      heading: 'Reset your password',
      bodyHtml:
        `<p style="margin:0 0 12px">Someone (hopefully you) asked to reset the password for this Riah Swipe account.</p>` +
        `<p style="margin:0">The button below works for <strong>one hour</strong>. After you set a new password, you’re signed out everywhere else.</p>`,
      ctaLabel: 'Choose a new password →',
      ctaUrl: resetUrl,
      footNote: 'If this wasn’t you, you can ignore this email — nothing changes until you pick a new password.',
    });
    await sendMail({
      to: email,
      subject: 'Reset your Riah Swipe password',
      text,
      html,
    });
  }
  // Uniform response — never reveal whether the email exists.
  return sendJson(res, 200, { ok: true, message: 'If that email has an account, a reset link is on its way.' });
}


async function apiPasswordReset(req, res) {
  if (!rateLimit(`resetuse:${clientIp(req)}`, { limit: 10 })) {
    return sendJson(res, 429, { ok: false, error: 'Too many attempts — wait a few minutes.' });
  }
  const body = await readJsonBody(req);
  if (!body || !body.token) return sendJson(res, 400, { ok: false, error: 'Invalid reset link.' });
  const pwErr = passwordPolicy(body.password);
  if (pwErr) return sendJson(res, 400, { ok: false, error: pwErr });
  const db = getDb();
  const row = db.prepare('SELECT * FROM reset_tokens WHERE token_hash=?').get(sha256(String(body.token)));
  if (!row || row.expires_at < new Date().toISOString()) {
    return sendJson(res, 400, { ok: false, error: 'That reset link is expired or already used — request a new one.' });
  }
  db.prepare('DELETE FROM reset_tokens WHERE token_hash=?').run(sha256(String(body.token)));
  // Bump session_version: every existing session dies with the old password.
  db.prepare('UPDATE accounts SET password_hash=?, session_version=session_version+1 WHERE id=?')
    .run(hashPassword(body.password), row.account_id);
  return sendJson(res, 200, { ok: true });
}

async function apiDeleteAccount(req, res) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'Sign in first.' });
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Invalid request.' });

  // Confirmation. A Google-only account has no password — its stored hash is a
  // sentinel verifyPassword can never match — so requiring one locked those users
  // out of deleting their own account entirely. They confirm by typing their email.
  const googleOnly = acc.password_hash === GOOGLE_ONLY_SENTINEL;
  const confirmed = googleOnly
    ? String(body.confirmEmail || '').trim().toLowerCase() === String(acc.email).toLowerCase()
    : verifyPassword(body.password, acc.password_hash);
  if (!confirmed) {
    return sendJson(res, 401, googleOnly
      ? { ok: false, error: 'Type your email address to confirm.', needs: 'email' }
      : { ok: false, error: 'Password didn’t match.', needs: 'password' });
  }

  // Media lives on disk, keyed by workspace; DB cascade does not touch it. Purge
  // first — a failure here must not leave orphaned private files behind.
  const workspaces = getDb()
    .prepare('SELECT id FROM workspaces WHERE owner_account_id=?').all(acc.id);
  for (const ws of workspaces) {
    try {
      await purgeWorkspace(ws.id);
    } catch (err) {
      console.error('[delete-account] media purge failed, deletion refused:', err.message);
      return sendJson(res, 500, {
        ok: false,
        error: 'We could not remove your uploaded files, so we have not deleted the account. '
             + 'Try again, or ask your server admin.',
      });
    }
  }

  getDb().prepare('DELETE FROM accounts WHERE id=?').run(acc.id);   // rows cascade
  setCookies(res, sessionCookieHeader('', { clear: true, path: cookiePathForRequest(req) }));
  return sendJson(res, 200, { ok: true });
}

async function apiWorkspaceCreate(req, res) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
  try { return sendJson(res, 201, { ok: true, workspace: createWorkspace({ ownerAccountId: acc.id, name: body.name }) }); }
  catch (error) { return hostedFailure(res, error); }
}

async function apiProjectCreate(req, res, workspaceId) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
  try {
    const project = createProject({ workspaceId, accountId: acc.id, name: body.name, purgeDays: body.purgeDays ?? 30 });
    return sendJson(res, 201, { ok: true, project });
  } catch (error) { return hostedFailure(res, error); }
}

async function apiProjectRole(req, res, projectId) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
  const target = body.accountId
    ? getDb().prepare(`SELECT id FROM accounts WHERE id=?`).get(body.accountId)
    : getDb().prepare(`SELECT id FROM accounts WHERE email=?`).get(normEmail(body.email));
  if (!target) return sendJson(res, 404, { ok: false, error: 'account_not_found' });
  try {
    const role = setProjectRole({ projectId, ownerAccountId: acc.id, targetAccountId: target.id, role: body.role });
    return sendJson(res, 200, { ok: true, role });
  } catch (error) { return hostedFailure(res, error); }
}

async function apiProjectToken(req, res, projectId) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  const body = await readJsonBody(req);
  try {
    const token = issueSubmitterToken({ projectId, ownerAccountId: acc.id, label: body && body.label });
    return sendJson(res, 201, { ok: true, ...token });
  } catch (error) { return hostedFailure(res, error); }
}

async function apiHostedDeckCreate(req, res, projectId) {
  const publisher = publisherFor(req, projectId);
  if (!publisher) return sendJson(res, 403, { ok: false, error: 'submitter_required' });
  const body = await readJsonBody(req, 4 * 1024 * 1024);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
  try {
    const out = createHostedDecks({ projectId, actor: publisher.actor, batch: body });
    return sendJson(res, 201, { ok: true, ...out });
  } catch (error) { return hostedFailure(res, error); }
}

async function apiHostedMediaPut(req, res, deckId, cardId) {
  const deck = getDb().prepare(`SELECT project_id FROM hosted_decks WHERE id=?`).get(deckId);
  if (!deck) return sendJson(res, 404, { ok: false, error: 'not_found' });
  if (!publisherFor(req, deck.project_id)) return sendJson(res, 403, { ok: false, error: 'submitter_required' });
  try {
    const out = await putHostedCardMedia({
      deckId, cardId, stream: req, contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'] ?? null,
    });
    return sendJson(res, 200, { ok: true, ...out });
  } catch (error) { return hostedFailure(res, error); }
}

async function apiHostedPublish(req, res, deckId) {
  const deck = getDb().prepare(`SELECT project_id FROM hosted_decks WHERE id=?`).get(deckId);
  if (!deck) return sendJson(res, 404, { ok: false, error: 'not_found' });
  if (!publisherFor(req, deck.project_id)) return sendJson(res, 403, { ok: false, error: 'submitter_required' });
  try {
    const out = publishHostedDeck({ deckId });
    queueProjectReviewNotification({ projectId: deck.project_id, deckId, baseUrl: BASE_URL });
    return sendJson(res, 200, { ok: true, ...out });
  } catch (error) { return hostedFailure(res, error); }
}

async function apiHostedVerdictPost(req, res, deckId) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  const body = await readJsonBody(req, 1024 * 1024);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
  try {
    const result = body.undo === true
      ? undoHostedVerdict({ deckId, accountId: acc.id, cardId: String(body.cardId || '') })
      : submitHostedVerdict({ deckId, accountId: acc.id, verdict: body });
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) { return hostedFailure(res, error); }
}

function apiHostedVerdictsGet(req, res, deckId) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  try { return sendJson(res, 200, hostedVerdictsForReviewer({ deckId, accountId: acc.id })); }
  catch (error) { return hostedFailure(res, error); }
}

function apiHostedResults(req, res, deckId) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  try { return sendJson(res, 200, assembleHostedResults({ deckId, accountId: acc.id })); }
  catch (error) { return hostedFailure(res, error); }
}

function apiHostedReviewBatch(req, res) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  if (!accountHasReviewerProject(acc.id)) return sendJson(res, 403, { ok: false, error: 'reviewer_required' });
  return sendJson(res, 200, reviewBatchForAccount({ accountId: acc.id, basePath: BASE_PATH }));
}

async function serveHostedMedia(req, res, deckId, cardId) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  const row = hostedCardMediaRow(deckId, cardId);
  if (!row) return sendJson(res, 404, { ok: false, error: 'not_found' });
  if (!hasProjectRole(row.project_id, acc.id, 'reviewer')) return sendJson(res, 403, { ok: false, error: 'reviewer_required' });
  if (!row.media_key || row.bytes <= 0) return sendJson(res, 410, { ok: false, error: 'media_expired' });
  const headers = {
    'Content-Type': row.media_type || 'application/octet-stream',
    'Cache-Control': 'private, max-age=60',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    // Defense in depth for old uploads that pre-date MIME allowlisting. Media
    // never needs to execute anything, even when somebody opens its URL.
    'Content-Security-Policy': "sandbox; default-src 'none'",
  };
  const range = parseRangeHeader(req.headers.range, row.bytes);
  if (range === null) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${row.bytes}` });
    res.end();
    return;
  }
  const options = range ? { start: range.start, end: range.end } : undefined;
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${row.bytes}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
  } else {
    headers['Content-Length'] = String(row.bytes);
  }
  const status = range ? 206 : 200;
  // A HEAD request needs the same headers but must never open a media file.
  if (req.method === 'HEAD') { res.writeHead(status, headers); res.end(); return; }
  let opened;
  try {
    opened = await getStoredMedia(row.media_key, options);
  } catch (error) {
    if (error && error.code === 'ENOENT') return sendJson(res, 410, { ok: false, error: 'media_expired' });
    throw error;
  }
  res.writeHead(status, headers);
  opened.stream.on('error', (error) => res.destroy(error));
  opened.stream.pipe(res);
}

function apiWorkspaceEvents(req, res, workspaceId) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  if (!accountHasWorkspaceProject(workspaceId, acc.id)) return sendJson(res, 403, { ok: false, error: 'project_role_required' });
  let cursor = Number.parseInt(String(req.headers['last-event-id'] || '0'), 10);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const writeEvents = () => {
    if (res.writableEnded || res.destroyed) return;
    const events = workspaceEventsForAccount({ workspaceId, accountId: acc.id, afterSeq: cursor });
    for (const event of events) {
      cursor = event.seq;
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.payload, projectId: event.projectId, at: event.at })}\n\n`);
    }
  };
  writeEvents();
  const poll = setInterval(writeEvents, 1000);
  const keepalive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
  }, 25000);
  poll.unref();
  keepalive.unref();
  const close = () => { clearInterval(poll); clearInterval(keepalive); };
  req.on('close', close);
  res.on('close', close);
}

function apiOwnedWorkspaces(req, res) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  // Empty is fine for a brand-new account — never 403. The dashboard needs this
  // list to survive a refresh after "Create project".
  return sendJson(res, 200, { ok: true, ...ownedWorkspacesForAccount(acc.id) });
}

function apiSubmitterProjects(req, res) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  if (!accountHasSubmitterProject(acc.id)) return sendJson(res, 403, { ok: false, error: 'submitter_required' });
  return sendJson(res, 200, { ok: true, ...submitterProjectsForAccount(acc.id) });
}

async function apiWorkspaceMePatch(req, res, workspaceId) {
  const acc = currentAccount(req);
  if (!acc) return sendJson(res, 401, { ok: false, error: 'not_signed_in' });
  const member = getDb().prepare(`SELECT 1 FROM workspace_members WHERE workspace_id=? AND account_id=?`).get(workspaceId, acc.id);
  if (!member || !accountHasWorkspaceProject(workspaceId, acc.id)) return sendJson(res, 403, { ok: false, error: 'project_role_required' });
  const body = await readJsonBody(req);
  if (!body || !Object.hasOwn(body, 'notifyEmail') || ![true, false, 0, 1].includes(body.notifyEmail)) {
    return sendJson(res, 400, { ok: false, error: 'notify_email_required' });
  }
  const notifyEmail = body.notifyEmail === true || body.notifyEmail === 1 ? 1 : 0;
  getDb().prepare(`UPDATE workspace_members SET notify_email=? WHERE workspace_id=? AND account_id=?`)
    .run(notifyEmail, workspaceId, acc.id);
  return sendJson(res, 200, { ok: true, workspaceId, notifyEmail: Boolean(notifyEmail) });
}

/**
 * The dashboard is for people who have an account. It used to be served as a plain
 * static file, so a signed-out stranger got a 200 and an empty shell. Its DATA was
 * always safe (every API call needs a session); what leaked was the page itself.
 */
async function serveDashboardPage(req, res) {
  if (!currentAccount(req)) {
    res.writeHead(302, { Location: `${BASE_PATH}/login`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const data = await readFile(join(SITE, 'dashboard.html'));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function serveProjectsPage(req, res) {
  const acc = currentAccount(req);
  if (!acc) { res.writeHead(302, { Location: `${BASE_PATH}/login`, 'Cache-Control': 'no-store' }); res.end(); return; }
  if (!accountHasSubmitterProject(acc.id)) return sendJson(res, 403, { ok: false, error: 'submitter_required' });
  const data = await readFile(join(SITE, 'projects.html'));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function reviewBootstrap(accountId) {
  const base = JSON.stringify(BASE_PATH);
  const appModule = JSON.stringify(`${BASE_PATH}/review/assets/src/app.js`);
  return `const BASE_PATH=${base};
const realFetch=window.fetch.bind(window);
window.RSW_WORKSPACE_ID=${JSON.stringify(`hosted-${accountId}`)};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
window.fetch=async(input,init={})=>{
  const href=typeof input==='string'?input:input.url;
  const url=new URL(href,window.location.href);
  const path=url.pathname;
  if(path.endsWith('/api/info')) return json({hosted:true,lanUrls:[]});
  if(path.endsWith('/decks/index.json')) return json({batches:['hosted.swipe.json'],retired:[]});
  if(path.endsWith('/decks/hosted.swipe.json')) return realFetch(BASE_PATH+'/api/review/decks',{cache:'no-store'});
  if(path.endsWith('/api/verdict-journal') && String(init.method||'GET').toUpperCase()==='POST'){
    const value=JSON.parse(String(init.body||'{}'));
    const headers=new Headers(init.headers||{}); headers.set('Content-Type','application/json');
    return realFetch(BASE_PATH+'/api/decks/'+encodeURIComponent(value.batchId)+'/verdicts',{method:'POST',headers,body:JSON.stringify(value.verdict||{})});
  }
  const journal=path.match(/\/api\/verdict-journal\/([^/]+)$/);
  if(journal) return realFetch(BASE_PATH+'/api/decks/'+encodeURIComponent(decodeURIComponent(journal[1]))+'/verdicts',{cache:'no-store'});
  if(path.endsWith('/api/swipe-results') && String(init.method||'GET').toUpperCase()==='POST'){
    const value=JSON.parse(String(init.body||'{}'));
    return realFetch(BASE_PATH+'/api/decks/'+encodeURIComponent(value.batchId)+'/results',{cache:'no-store'});
  }
  return realFetch(input,init);
};
await import(${appModule});
`;
}

async function serveReviewApp(req, res) {
  const acc = currentAccount(req);
  if (!acc) { res.writeHead(302, { Location: `${BASE_PATH}/login`, 'Cache-Control': 'no-store' }); res.end(); return; }
  // A brand-new account has no project yet. Answering a PAGE request with raw JSON
  // would be the first thing someone saw, so send them to setup instead.
  // (The API guard still answers JSON, correctly; that one is for machines.)
  if (!accountHasReviewerProject(acc.id)) {
    // Two different people land here with no review queue, and they need different
    // pages. A SUBMITTER has projects — they just don't approve anything — so send
    // them to their own project list. Anyone with nothing at all is brand new, and
    // goes to setup. Neither should meet the raw JSON this used to return.
    const to = accountHasSubmitterProject(acc.id) ? '/projects' : '/dashboard?setup=1';
    res.writeHead(302, { Location: `${BASE_PATH}${to}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const root = `${BASE_PATH}/review`;
  let html = await readFile(join(REVIEW_APP, 'index.html'), 'utf8');
  html = html
    .replace('href="manifest.webmanifest"', `href="${root}/assets/manifest.webmanifest"`)
    .replaceAll('href="icons/', `href="${root}/assets/icons/`)
    // The app's links carry cache-busting tags (styles/app.css?v=…) since 2026-08-28;
    // match with or without one, keeping the tag on the stylesheet.
    .replace(/href="styles\/app\.css(\?[^"]*)?"/, (_, q = '') => `href="${root}/assets/styles/app.css${q}"`)
    .replace(/src="src\/app\.js(\?[^"]*)?"/, `src="${root}/hosted-bootstrap.js"`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : html);
}

function reviewAccount(req, res) {
  const acc = currentAccount(req);
  if (!acc) { sendJson(res, 401, { ok: false, error: 'not_signed_in' }); return null; }
  if (!accountHasReviewerProject(acc.id)) { sendJson(res, 403, { ok: false, error: 'reviewer_required' }); return null; }
  return acc;
}

async function serveReviewAsset(req, res, relativePath) {
  if (!reviewAccount(req, res)) return;
  const filePath = normalize(join(REVIEW_APP, relativePath));
  if (!filePath.toLowerCase().startsWith(normalize(REVIEW_APP + '/').toLowerCase())) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('not found'); }
}

function serveReviewBootstrap(req, res) {
  const acc = reviewAccount(req, res);
  if (!acc) return;
  const script = reviewBootstrap(acc.id);
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : script);
}


function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

// ── Static site ──────────────────────────────────────────────────────────────
const PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
  '/signup': 'signup.html',
  '/dashboard': 'dashboard.html',
  // Public on purpose: a submitter has no account. The access code rides in the URL
  // FRAGMENT, which never reaches this server, so the page is worthless without it.
  '/submit': 'submit.html',
  '/projects': 'projects.html',
  '/reset': 'reset.html',
  '/docs': 'docs.html',
};

async function serveSite(res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\//, '');
  const filePath = normalize(join(SITE, rel));
  if (!filePath.toLowerCase().startsWith(normalize(SITE + '/').toLowerCase())) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:system-ui;background:#0a0e1a;color:#cdd4e3;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h1>404</h1><p>That page isn’t here. <a href="./" style="color:#a5b4fc">Back home</a>.</p></div>');
  }
}

// ── Router ───────────────────────────────────────────────────────────────────
// Sign in with Google. Everything product-specific is injected, so the module in
// lib/google/ stays reusable.
const googleRoutes = makeGoogleRoutes({
  getDb, newId, issueAuthCookies, setCookies, getCookie, clientIp, rateLimit,
  basePath: BASE_PATH,
  sendJson,
});

const server = createServer(async (req, res) => {
  try {
    const rawUrl = req.url || '/';
    const rawPath = decodeURIComponent(rawUrl.split('?')[0]);
    const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';

    // Classic prefix bug: bare BASE_PATH breaks relative links — 301 to BASE_PATH/.
    if (BASE_PATH && (req.method === 'GET' || req.method === 'HEAD') && rawPath === BASE_PATH) {
      res.writeHead(301, { Location: BASE_PATH + '/' + qs, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const pathname = stripBasePath(rawPath);

    if (req.method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true });

    // ── Sign in with Google ────────────────────────────────────────────────
    // Both legs are GET because the browser arrives by redirect, not by fetch.
    if (req.method === 'GET' && pathname === '/api/auth/google') return void googleRoutes.start(req, res);
    if (req.method === 'GET' && pathname === '/api/auth/google/callback') {
      // Base is a throwaway — only searchParams (code, state, error) are read.
      return void await googleRoutes.callback(req, res, new URL(rawUrl, 'http://localhost'));
    }
    if (req.method === 'POST' && pathname === '/api/auth/google/finish') {
      return void await googleRoutes.finish(req, res);
    }
    // Lets the signup/login pages decide whether to draw the button at all,
    // so a half-configured deploy never shows one that cannot work.
    if (req.method === 'GET' && pathname === '/api/auth/google/available') {
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 200, { ok: true, google: googleEnabled() });
    }

    let match;
    if (req.method === 'PUT' && (match = pathname.match(/^\/api\/decks\/([^/]+)\/cards\/([^/]+)\/media$/))) {
      return void await apiHostedMediaPut(req, res, match[1], match[2]);
    }
    if (req.method === 'PATCH' && (match = pathname.match(/^\/api\/workspaces\/([^/]+)\/me$/))) {
      return void await apiWorkspaceMePatch(req, res, match[1]);
    }

    if (req.method === 'POST') {
      if (pathname === '/api/workspaces') return void await apiWorkspaceCreate(req, res);
      if ((match = pathname.match(/^\/api\/workspaces\/([^/]+)\/projects$/))) return void await apiProjectCreate(req, res, match[1]);
      if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/roles$/))) return void await apiProjectRole(req, res, match[1]);
      if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/tokens$/))) return void await apiProjectToken(req, res, match[1]);
      if ((match = pathname.match(/^\/api\/projects\/([^/]+)\/decks$/))) return void await apiHostedDeckCreate(req, res, match[1]);
      if ((match = pathname.match(/^\/api\/decks\/([^/]+)\/publish$/))) return void await apiHostedPublish(req, res, match[1]);
      if ((match = pathname.match(/^\/api\/decks\/([^/]+)\/verdicts$/))) return void await apiHostedVerdictPost(req, res, match[1]);
      switch (pathname) {
        case '/api/signup':                 return void await apiSignup(req, res);
        case '/api/login':                  return void await apiLogin(req, res);
        case '/api/logout':                 return void apiLogout(req, res);
        case '/api/password-reset-request': return void await apiPasswordResetRequest(req, res);
        case '/api/password-reset':         return void await apiPasswordReset(req, res);
        case '/api/delete-account':         return void await apiDeleteAccount(req, res);
        default: return void sendJson(res, 404, { ok: false, error: 'no such endpoint' });
      }
    }

    if (req.method === 'GET' && pathname === '/api/me') return void apiMe(req, res);
    if (req.method === 'GET' && pathname === '/api/workspaces') return void apiOwnedWorkspaces(req, res);
    if (req.method === 'GET' && pathname === '/api/projects') return void apiSubmitterProjects(req, res);

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/review') return void await serveReviewApp(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/dashboard') return void await serveDashboardPage(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/projects') return void await serveProjectsPage(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/review/hosted-bootstrap.js') return void serveReviewBootstrap(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && (match = pathname.match(/^\/review\/assets\/(.+)$/))) {
      return void await serveReviewAsset(req, res, match[1]);
    }
    if (req.method === 'GET' && pathname === '/api/review/decks') return void apiHostedReviewBatch(req, res);
    if (req.method === 'GET' && (match = pathname.match(/^\/api\/decks\/([^/]+)\/verdicts$/))) return void apiHostedVerdictsGet(req, res, match[1]);
    if (req.method === 'GET' && (match = pathname.match(/^\/api\/decks\/([^/]+)\/results$/))) return void apiHostedResults(req, res, match[1]);
    if ((req.method === 'GET' || req.method === 'HEAD') && (match = pathname.match(/^\/api\/decks\/([^/]+)\/cards\/([^/]+)\/media$/))) {
      return void await serveHostedMedia(req, res, match[1], match[2]);
    }
    if (req.method === 'GET' && (match = pathname.match(/^\/api\/workspaces\/([^/]+)\/events$/))) {
      return void apiWorkspaceEvents(req, res, match[1]);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('method not allowed'); return;
    }
    await serveSite(res, pathname);
  } catch (err) {
    console.error('[server] request failed:', err && err.message);
    try { sendJson(res, 500, { ok: false, error: 'server error' }); } catch { /* sent */ }
  }
});

// Boot checks that must fail LOUDLY, before listen: a usable session secret.
export function bootChecks() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET missing/short — set a 32+ char random value.');
  }
  if (process.env.NODE_ENV === 'production' &&
      process.env.SESSION_SECRET.includes('dev-only')) {
    throw new Error('Refusing to start: SESSION_SECRET is the dev placeholder.');
  }
  getDb();               // creates schema
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  bootChecks();
  startHostedPurgeTimer();
  server.listen(PORT, () => {
    console.log(`Riah Swipe team server listening on ${BASE_URL} (port ${PORT})`);
    if (!process.env.RESEND_API_KEY) console.log('  Mail is not configured — password-reset and new-deck emails will be logged, not sent.');
    if (!googleEnabled()) console.log('  Google sign-in is off (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URL to enable).');
  });
}

export { server };

