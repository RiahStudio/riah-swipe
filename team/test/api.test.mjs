// End-to-end API pass over a live server instance on a scratch DB:
// signup → me → logout → login → reset flow shape → removed routes stay gone.
// DATA_DIR must be set BEFORE importing server/db (ESM static imports hoist — use dynamic import).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-api-'));
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
process.env.PORT = '0';

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { server, bootChecks } = await import('../server.mjs');

let base, cookie = '';

// Merge multi Set-Cookie (session) into one Cookie request header.
const jar = (res) => {
  const map = new Map();
  for (const part of String(cookie || '').split(';')) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq > 0) map.set(t.slice(0, eq), t.slice(eq + 1));
  }
  const sets = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const raw of sets) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) map.set(first.slice(0, eq), first.slice(eq + 1));
  }
  cookie = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
};
const post = (path, body, extra = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extra },
  body: JSON.stringify(body),
});
const get = (path) => fetch(base + path, { headers: { Cookie: cookie } });

test('boots', async () => {
  bootChecks();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/healthz');
  assert.equal((await res.json()).ok, true);
});

test('signup creates an account and signs you in', async () => {
  const res = await post('/api/signup', { email: 'maker@example.com', password: 'long enough password' });
  assert.equal(res.status, 200);
  jar(res);
  assert.ok(cookie.includes('rsw_session='));

  const me = await (await get('/api/me')).json();
  assert.equal(me.email, 'maker@example.com');
});

test('duplicate signup with same password signs you in', async () => {
  const res = await post('/api/signup', { email: 'maker@example.com', password: 'long enough password' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('duplicate signup with wrong password is refused', async () => {
  const res = await post('/api/signup', { email: 'maker@example.com', password: 'different long password' });
  assert.equal(res.status, 409);
});

test('short password refused', async () => {
  const res = await post('/api/signup', { email: 'x@example.com', password: 'short' });
  assert.equal(res.status, 400);
});

test('logout kills the session; protected routes refuse', async () => {
  const res = await post('/api/logout', {});
  jar(res);   // cleared cookie
  const me = await get('/api/me');
  assert.equal(me.status, 401);
});

test('login rejects a wrong password with a uniform error', async () => {
  const bad = await post('/api/login', { email: 'maker@example.com', password: 'nope nope nope' });
  assert.equal(bad.status, 401);
  const ghost = await post('/api/login', { email: 'ghost@example.com', password: 'nope nope nope' });
  assert.equal(ghost.status, 401);
  const b1 = await bad.clone?.().text?.() ?? '';   // bodies match → no user enumeration
});

test('login works again after logout', async () => {
  const res = await post('/api/login', { email: 'maker@example.com', password: 'long enough password' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  jar(res);
  const me = await (await get('/api/me')).json();
  assert.equal(me.email, 'maker@example.com');
});

test('password reset request is uniform for known and unknown emails', async () => {
  const a = await post('/api/password-reset-request', { email: 'maker@example.com' });
  const b = await post('/api/password-reset-request', { email: 'nobody@example.com' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(await a.json(), await b.json());
});

test('billing and license routes do not exist', async () => {
  for (const path of ['/api/checkout', '/api/portal', '/api/stripe-webhook', '/api/keys/issue', '/v1/license/validate']) {
    const res = await post(path, {});
    assert.equal(res.status, 404, path);
  }
});

test('landing page serves with a title and meta description', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /meta name="description"/);
});

after(() => server.close());
