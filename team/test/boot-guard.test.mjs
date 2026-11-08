// bootChecks refuses to start without a real session secret.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-boot-'));
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';

const { bootChecks } = await import('../server.mjs');

test('boot passes with a long session secret', () => {
  assert.doesNotThrow(() => bootChecks());
});

test('boot refuses a missing or short session secret', () => {
  const keep = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'short';
  assert.throws(() => bootChecks(), /SESSION_SECRET/);
  delete process.env.SESSION_SECRET;
  assert.throws(() => bootChecks(), /SESSION_SECRET/);
  process.env.SESSION_SECRET = keep;
});

test('production refuses the dev placeholder secret', () => {
  const keepSecret = process.env.SESSION_SECRET;
  const keepEnv = process.env.NODE_ENV;
  process.env.SESSION_SECRET = 'dev-only-secret-0123456789-abcdefghijklmnop';
  process.env.NODE_ENV = 'production';
  assert.throws(() => bootChecks(), /placeholder/);
  process.env.SESSION_SECRET = keepSecret;
  if (keepEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = keepEnv;
});
