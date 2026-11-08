import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-hosted-schema-'));

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { getDb, _resetForTests } = await import('../lib/db.mjs');

const db = getDb();
const now = new Date().toISOString();

test('hosted phase-one tables are created additively', () => {
  const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => row.name);
  for (const table of [
    'workspaces', 'workspace_members', 'projects', 'project_roles', 'submitter_tokens',
    'hosted_decks', 'hosted_cards', 'hosted_verdicts', 'ws_events', 'ws_usage',
  ]) assert.ok(names.includes(table), `missing ${table}`);
  assert.ok(names.includes('accounts'), 'existing account schema remains present');
});

test('workspace quota, notification, purge, and usage defaults match the hosted contract', () => {
  db.prepare(`INSERT INTO accounts (id,email,password_hash,created_at) VALUES (?,?,?,?)`)
    .run('owner', 'owner@example.com', 'test', now);
  db.prepare(`INSERT INTO workspaces (id,name,owner_account_id,created_at) VALUES (?,?,?,?)`)
    .run('ws', 'Team', 'owner', now);
  db.prepare(`INSERT INTO workspace_members (workspace_id,account_id,org_role,joined_at) VALUES (?,?,?,?)`)
    .run('ws', 'owner', 'owner', now);
  db.prepare(`INSERT INTO projects (id,workspace_id,name,created_at) VALUES (?,?,?,?)`)
    .run('project', 'ws', 'Campaign', now);
  db.prepare(`INSERT INTO ws_usage (workspace_id) VALUES (?)`).run('ws');

  assert.equal(db.prepare(`SELECT quota_bytes FROM workspaces WHERE id='ws'`).get().quota_bytes, 2 * 1024 * 1024 * 1024);
  assert.equal(db.prepare(`SELECT notify_email FROM workspace_members WHERE workspace_id='ws'`).get().notify_email, 1);
  assert.equal(db.prepare(`SELECT purge_days FROM projects WHERE id='project'`).get().purge_days, 30);
  assert.equal(db.prepare(`SELECT bytes_used FROM ws_usage WHERE workspace_id='ws'`).get().bytes_used, 0);
});

test('hosted role and verdict enums fail closed in SQLite', () => {
  assert.throws(() => db.prepare(`INSERT INTO project_roles VALUES ('project','owner','admin')`).run());
  assert.throws(() => db.prepare(`INSERT INTO workspace_members VALUES ('ws','owner','guest',1,?)`).run(now));
});

after(() => _resetForTests());
