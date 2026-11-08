import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-hosted-query-count-'));

const { test, afterEach, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { getDb, _resetForTests } = await import('../lib/db.mjs');
const {
  reviewBatchForAccount, submitterProjectsForAccount,
} = await import('../lib/hosted.mjs');

const db = getDb();
const now = '2026-07-30T00:00:00.000Z';

function resetRows() {
  db.exec(`DELETE FROM hosted_verdicts; DELETE FROM hosted_cards; DELETE FROM hosted_decks;
           DELETE FROM submitter_tokens; DELETE FROM project_roles; DELETE FROM projects;
           DELETE FROM workspace_members; DELETE FROM ws_usage; DELETE FROM workspaces; DELETE FROM accounts;`);
}

function insertAccount(id) {
  db.prepare(`INSERT INTO accounts (id,email,password_hash,created_at) VALUES (?,?,?,?)`)
    .run(id, `${id}@example.com`, 'hash', now);
}

function seedWorkspace(id = 'ws') {
  db.prepare(`INSERT INTO workspaces (id,name,owner_account_id,created_at) VALUES (?, 'Team', 'owner', ?)`)
    .run(id, now);
  db.prepare(`INSERT INTO workspace_members (workspace_id,account_id,org_role,joined_at) VALUES (?, 'owner', 'owner', ?)`)
    .run(id, now);
  db.prepare(`INSERT INTO ws_usage (workspace_id,bytes_used) VALUES (?,0)`).run(id);
}

function seedProject({ id, workspaceId = 'ws', roleAccountId, role = 'reviewer' }) {
  db.prepare(`INSERT INTO projects (id,workspace_id,name,purge_days,created_at) VALUES (?,?,?,30,?)`)
    .run(id, workspaceId, `Project ${id}`, now);
  db.prepare(`INSERT OR IGNORE INTO workspace_members (workspace_id,account_id,org_role,joined_at) VALUES (?, ?, 'member', ?)`)
    .run(workspaceId, roleAccountId, now);
  db.prepare(`INSERT INTO project_roles (project_id,account_id,role) VALUES (?,?,?)`)
    .run(id, roleAccountId, role);
}

function seedDeck({ id, projectId, workspaceId = 'ws', status = 'open', cardCount = 2 }) {
  db.prepare(`INSERT INTO hosted_decks (id,workspace_id,project_id,source_id,name,status,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, workspaceId, projectId, `source-${id}`, `Deck ${id}`, status, 'submitter', now);
  for (let i = 1; i <= cardCount; i++) {
    db.prepare(`INSERT INTO hosted_cards (deck_id,id,position,title,kind,content,preview,meta)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, `card-${i}`, i, `Card ${i}`, 'text', `Body ${id}-${i}`, `Preview ${i}`, JSON.stringify({ i }));
  }
}

function countingDb(realDb) {
  const executions = [];
  const normalize = (statement) => String(statement).replace(/\s+/g, ' ').trim();
  return {
    get executions() { return executions; },
    prepare(statement) {
      const normalized = normalize(statement);
      const prepared = realDb.prepare(statement);
      return {
        all(...args) { executions.push({ sql: normalized, method: 'all' }); return prepared.all(...args); },
        get(...args) { executions.push({ sql: normalized, method: 'get' }); return prepared.get(...args); },
        run(...args) { executions.push({ sql: normalized, method: 'run' }); return prepared.run(...args); },
        iterate(...args) { executions.push({ sql: normalized, method: 'iterate' }); return prepared.iterate(...args); },
      };
    },
    transaction(fn) { return realDb.transaction(fn); },
    exec(statement) { return realDb.exec(statement); },
  };
}

test('review batch loads cards in one bulk query instead of one query per deck', () => {
  insertAccount('owner');
  insertAccount('reviewer');
  seedWorkspace();
  seedProject({ id: 'p', roleAccountId: 'reviewer' });
  for (const deckId of ['d1', 'd2', 'd3']) seedDeck({ id: deckId, projectId: 'p' });

  const counted = countingDb(db);
  const batch = reviewBatchForAccount({ accountId: 'reviewer', db: counted });

  assert.equal(batch.decks.length, 3);
  assert.equal(batch.cards.length, 6);
  const perDeckCardQueries = counted.executions.filter(({ sql, method }) =>
    method === 'all' && /FROM hosted_cards WHERE deck_id=\? ORDER BY position,id/i.test(sql)
  );
  assert.equal(perDeckCardQueries.length, 0, 'cards should be fetched with one bulk deck_id IN query, not per deck');
});

test('submitter projects load decks in one bulk query instead of one query per project', () => {
  insertAccount('owner');
  insertAccount('submitter');
  seedWorkspace();
  for (const projectId of ['p1', 'p2', 'p3']) {
    seedProject({ id: projectId, roleAccountId: 'submitter', role: 'submitter' });
    seedDeck({ id: `d-${projectId}`, projectId, status: 'done', cardCount: 1 });
  }

  const counted = countingDb(db);
  const out = submitterProjectsForAccount('submitter', { db: counted });

  assert.equal(out.workspaces.length, 1);
  assert.equal(out.workspaces[0].projects.length, 3);
  assert.equal(out.workspaces[0].projects.reduce((sum, project) => sum + project.decks.length, 0), 3);
  const perProjectDeckQueries = counted.executions.filter(({ sql, method }) =>
    method === 'all' && /FROM hosted_decks d WHERE d\.project_id=\? ORDER BY d\.created_at DESC,d\.id DESC/i.test(sql)
  );
  assert.equal(perProjectDeckQueries.length, 0, 'decks should be fetched with one bulk project_id IN query, not per project');
});

afterEach(resetRows);
after(() => _resetForTests());
