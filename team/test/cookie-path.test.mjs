/**
 * Cookies must be scoped to the path the request ACTUALLY arrived on.
 *
 * The bug this pins down (found 2026-07-28, before any customer hit it): the service
 * answers on two origins — behind a reverse proxy under /riahswipe, and directly on
 * its own host with no prefix. Cookies were scoped to BASE_PATH unconditionally, so
 * on the direct host the browser was handed a session cookie for /riahswipe and never
 * sent it back to /dashboard. Signing up bounced you straight to /login, forever.
 *
 * Nothing else caught it: every unit test passed, the pages all returned 200, and the
 * failure only appears once a browser is asked to store and return a cookie.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = async () => {
  const mod = await import('../lib/auth.mjs?cookiepath=' + Math.random());
  return mod;
};

test('with no BASE_PATH, cookies are scoped to the whole origin', async () => {
  delete process.env.BASE_PATH;
  const { cookiePathForRequest, sessionCookieHeader } = await load();
  assert.equal(cookiePathForRequest({ url: '/dashboard' }), '/');
  assert.match(sessionCookieHeader('x', { path: cookiePathForRequest({ url: '/dashboard' }) }), /Path=\/;/);
});

test('behind the proxy, a prefixed request gets a prefix-scoped cookie', async () => {
  process.env.BASE_PATH = '/riahswipe';
  const { cookiePathForRequest } = await load();
  assert.equal(cookiePathForRequest({ url: '/riahswipe/dashboard' }), '/riahswipe');
  assert.equal(cookiePathForRequest({ url: '/riahswipe' }), '/riahswipe');
  assert.equal(cookiePathForRequest({ url: '/riahswipe/api/auth/google/callback' }), '/riahswipe');
});

test('THE BUG: on the direct host, a request without the prefix must NOT get a prefixed cookie', async () => {
  process.env.BASE_PATH = '/riahswipe';
  const { cookiePathForRequest } = await load();
  // These are real paths on riah-swipe-pro.onrender.com.
  for (const url of ['/dashboard', '/api/auth/google/callback', '/signup', '/api/login']) {
    assert.equal(
      cookiePathForRequest({ url }),
      '/',
      `${url} must get an origin-scoped cookie — a /riahswipe cookie is never sent back to it`,
    );
  }
});

test('a path that merely starts with the same letters is not treated as the prefix', async () => {
  process.env.BASE_PATH = '/riahswipe';
  const { cookiePathForRequest } = await load();
  // /riahswipe-pro is a DIFFERENT path; only an exact segment match counts.
  assert.equal(cookiePathForRequest({ url: '/riahswipe-pro/dashboard' }), '/');
});

test('query strings do not confuse the match', async () => {
  process.env.BASE_PATH = '/riahswipe';
  const { cookiePathForRequest } = await load();
  assert.equal(cookiePathForRequest({ url: '/riahswipe/dashboard?x=1' }), '/riahswipe');
  assert.equal(cookiePathForRequest({ url: '/dashboard?x=1' }), '/');
});

test('a missing or malformed request degrades to the safe origin scope', async () => {
  process.env.BASE_PATH = '/riahswipe';
  const { cookiePathForRequest } = await load();
  assert.equal(cookiePathForRequest(undefined), '/');
  assert.equal(cookiePathForRequest({}), '/');
});

