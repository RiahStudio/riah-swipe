// BASE_PATH mount support — product can live under a path prefix.
// DATA_DIR / BASE_PATH must be set BEFORE importing server (ESM hoist).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-basepath-'));
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
process.env.BASE_PATH = '/riahswipe';
process.env.BASE_URL = 'https://swipe.example.com/riahswipe';
process.env.PORT = '0';

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { server, bootChecks } = await import('../server.mjs');
const { sessionCookieHeader, issueSession } = await import('../lib/auth.mjs');

let base = '';

test('boots under BASE_PATH', async () => {
  bootChecks();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test('prefixed AND stripped healthz both route', async () => {
  const a = await fetch(base + '/riahswipe/healthz');
  const b = await fetch(base + '/healthz');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await a.json()).ok, true);
  assert.equal((await b.json()).ok, true);
});

test('bare prefix 301s to trailing slash', async () => {
  const res = await fetch(base + '/riahswipe', { redirect: 'manual' });
  assert.equal(res.status, 301);
  const loc = res.headers.get('location');
  assert.ok(loc === '/riahswipe/' || loc.endsWith('/riahswipe/'), loc);
});

test('session cookie Path carries the prefix', () => {
  const hdr = sessionCookieHeader(issueSession({ id: 'a1', session_version: 1 }));
  assert.match(hdr, /Path=\/riahswipe/);
  assert.doesNotMatch(hdr, /Path=\/;/);
});

test('/api/me answers under the prefix (and stripped)', async () => {
  const pref = await fetch(base + '/riahswipe/api/me');
  const strip = await fetch(base + '/api/me');
  assert.equal(pref.status, 401);
  assert.equal(strip.status, 401);
});

test('landing serves under the prefix', async () => {
  const res = await fetch(base + '/riahswipe/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /href="\.\/shared\.css"/);
});

after(() => server.close());
