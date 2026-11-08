/**
 * Account deletion must keep the promise the privacy policy makes.
 *
 * Three failures this pins down, all found 2026-07-29:
 *  1. (Removed: an external-service step that no longer exists.)
 *  2. Database rows cascaded but uploaded FILES stayed on disk, with no row left
 *     to find them through. Private media outliving the account that owned it.
 *  3. A Google-only account could never delete itself: its stored password hash is
 *     a sentinel `verifyPassword` can never match, so the confirmation always failed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-del-'));
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';

const { purgeWorkspace } = await import('../lib/storage.mjs');

test('purgeWorkspace deletes every stored byte for that workspace', async () => {
  const ws = 'ws_test_1';
  const dir = join(process.env.DATA_DIR, 'media', ws, 'deck-a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'card.bin'), 'private bytes');
  assert.equal(existsSync(join(dir, 'card.bin')), true, 'fixture should exist first');

  await purgeWorkspace(ws);
  assert.equal(existsSync(join(process.env.DATA_DIR, 'media', ws)), false,
    'the workspace media directory must be gone');
});

test('purgeWorkspace leaves OTHER workspaces untouched', async () => {
  const keep = join(process.env.DATA_DIR, 'media', 'ws_keep', 'deck');
  const drop = join(process.env.DATA_DIR, 'media', 'ws_drop', 'deck');
  mkdirSync(keep, { recursive: true });
  mkdirSync(drop, { recursive: true });
  writeFileSync(join(keep, 'a.bin'), 'keep me');
  writeFileSync(join(drop, 'b.bin'), 'delete me');

  await purgeWorkspace('ws_drop');
  assert.equal(existsSync(join(keep, 'a.bin')), true, 'a different workspace must survive');
  assert.equal(existsSync(join(process.env.DATA_DIR, 'media', 'ws_drop')), false);
});

test('purgeWorkspace refuses a traversing or malformed workspace id', async () => {
  // Without the guard this is an rm -rf with caller-chosen path segments.
  for (const bad of ['../../etc', 'a/b', '', null, undefined, '.', '..']) {
    await assert.rejects(() => purgeWorkspace(bad), /invalid workspace id|refusing/i,
      `must refuse: ${JSON.stringify(bad)}`);
  }
  // And nothing was collaterally removed.
  assert.equal(existsSync(join(process.env.DATA_DIR, 'media')), true);
});

test('purging a workspace that has no media on disk is not an error', async () => {
  await purgeWorkspace('ws_never_uploaded');
});

test('purgeWorkspace is idempotent — running twice is safe', async () => {
  const ws = 'ws_twice';
  const dir = join(process.env.DATA_DIR, 'media', ws);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'x.bin'), 'x');
  await purgeWorkspace(ws);
  await purgeWorkspace(ws);
  assert.equal(existsSync(dir), false);
});

test('the media root itself is never destroyed', async () => {
  const root = join(process.env.DATA_DIR, 'media');
  mkdirSync(join(root, 'ws_a'), { recursive: true });
  await purgeWorkspace('ws_a');
  assert.equal(existsSync(root), true, 'purging a workspace must not take the whole media root');
  assert.ok(Array.isArray(readdirSync(root)));
});
