process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, passwordPolicy,
  issueSession, readSession, rateLimit,
} from '../lib/auth.mjs';

test('password hash round-trips and rejects wrong password', () => {
  const h = hashPassword('correct horse battery staple');
  assert.ok(h.startsWith('scrypt:'));
  assert.equal(verifyPassword('correct horse battery staple', h), true);
  assert.equal(verifyPassword('wrong', h), false);
});

test('two hashes of the same password differ (salted)', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('password policy enforces a floor', () => {
  assert.ok(passwordPolicy('short'));
  assert.equal(passwordPolicy('long enough password'), null);
});

test('session round-trips and rejects tampering', () => {
  const account = { id: 'acc-1', session_version: 3 };
  const cookie = issueSession(account);
  const sess = readSession(cookie);
  assert.equal(sess.aid, 'acc-1');
  assert.equal(sess.sv, 3);

  // Tamper with the payload → dead cookie.
  const [p, sig] = cookie.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  payload.aid = 'acc-2';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;
  assert.equal(readSession(forged), null);
});

test('garbage sessions read as null, never throw', () => {
  assert.equal(readSession(''), null);
  assert.equal(readSession('abc'), null);
  assert.equal(readSession('a.b.c'), null);
});

test('rate limiter opens then closes', () => {
  const key = 'test:' + Math.random();
  for (let i = 0; i < 5; i++) assert.equal(rateLimit(key, { limit: 5 }), true);
  assert.equal(rateLimit(key, { limit: 5 }), false);
});
