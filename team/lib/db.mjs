// server/lib/db.mjs
// SQLite persistence (better-sqlite3 — the server's ONE dependency).
// WAL mode; schema created idempotently at boot.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || join(HERE, '..', 'data');

let db = null;

export function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, 'riah-swipe.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                 TEXT PRIMARY KEY,
      email              TEXT NOT NULL UNIQUE,
      password_hash      TEXT NOT NULL,
      session_version    INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      quota_bytes      INTEGER NOT NULL DEFAULT 2147483648 CHECK (quota_bytes >= 0),
      created_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      org_role     TEXT NOT NULL CHECK (org_role IN ('owner', 'member')),
      notify_email INTEGER NOT NULL DEFAULT 1 CHECK (notify_email IN (0, 1)),
      joined_at    TEXT NOT NULL,
      PRIMARY KEY (workspace_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      purge_days   INTEGER NOT NULL DEFAULT 30 CHECK (purge_days >= 0),
      created_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_roles (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('reviewer', 'submitter')),
      PRIMARY KEY (project_id, account_id, role)
    );
    CREATE TABLE IF NOT EXISTS submitter_tokens (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      label        TEXT NOT NULL DEFAULT '',
      created_by   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS hosted_decks (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id     TEXT NOT NULL,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT '',
      rev           INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'done')),
      created_by    TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      done_at       TEXT,
      source        TEXT NOT NULL DEFAULT '',
      return_to     TEXT NOT NULL DEFAULT '',
      note          TEXT NOT NULL DEFAULT '',
      selecting_for TEXT NOT NULL DEFAULT '',
      description   TEXT NOT NULL DEFAULT '',
      accent        TEXT NOT NULL DEFAULT '',
      UNIQUE (project_id, source_id, rev)
    );
    CREATE TABLE IF NOT EXISTS hosted_cards (
      deck_id        TEXT NOT NULL REFERENCES hosted_decks(id) ON DELETE CASCADE,
      id             TEXT NOT NULL,
      position       INTEGER NOT NULL DEFAULT 0,
      title          TEXT NOT NULL,
      kind           TEXT NOT NULL DEFAULT '',
      media_key      TEXT,
      media_required INTEGER NOT NULL DEFAULT 0 CHECK (media_required IN (0, 1)),
      media_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
      original_media TEXT,
      content        TEXT NOT NULL DEFAULT '',
      caption        TEXT NOT NULL DEFAULT '',
      preview        TEXT NOT NULL DEFAULT '',
      tag            TEXT NOT NULL DEFAULT '',
      meta           TEXT,
      bytes          INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
      PRIMARY KEY (deck_id, id)
    );
    CREATE TABLE IF NOT EXISTS hosted_verdicts (
      deck_id    TEXT NOT NULL,
      card_id    TEXT NOT NULL,
      decision   TEXT NOT NULL CHECK (decision IN ('keep', 'revise', 'discard')),
      note       TEXT NOT NULL DEFAULT '',
      voice_note TEXT NOT NULL DEFAULT '',
      thumb      TEXT NOT NULL DEFAULT '',
      decided_by TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (deck_id, card_id),
      FOREIGN KEY (deck_id, card_id) REFERENCES hosted_cards(deck_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ws_events (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      seq          INTEGER NOT NULL,
      project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
      type         TEXT NOT NULL,
      payload      TEXT NOT NULL,
      at           TEXT NOT NULL,
      PRIMARY KEY (workspace_id, seq)
    );
    CREATE TABLE IF NOT EXISTS ws_usage (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      bytes_used   INTEGER NOT NULL DEFAULT 0 CHECK (bytes_used >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_members_account ON workspace_members(account_id);
    CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_project_roles_account ON project_roles(account_id, role);
    CREATE INDEX IF NOT EXISTS idx_submitter_tokens_project ON submitter_tokens(project_id);
    CREATE INDEX IF NOT EXISTS idx_hosted_decks_project_status ON hosted_decks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_hosted_decks_workspace_status ON hosted_decks(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_hosted_cards_deck_position ON hosted_cards(deck_id, position);
    CREATE INDEX IF NOT EXISTS idx_ws_events_project ON ws_events(workspace_id, project_id, seq);

    -- Short-lived Google OAuth handoff (PKCE verifier + CSRF state). Must survive
    -- a server restart between "Continue with Google" and the callback.
    CREATE TABLE IF NOT EXISTS oauth_pending (
      ref         TEXT PRIMARY KEY,
      state       TEXT NOT NULL,
      verifier    TEXT NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires ON oauth_pending(expires_at);
  `);
  // Additive columns for DBs created before the column existed (CREATE TABLE IF NOT EXISTS
  // does not alter existing tables).

  // ── Sign in with Google (2026-07-28) ───────────────────────────────────────
  // google_sub is Google's permanent user id. UNIQUE so one Google account can
  // never end up attached to two of ours. Nullable: password accounts have none,
  // and a Google account may later set a password — the two are alternate doors
  // to one account, never two accounts.
  ensureColumn(db, 'accounts', 'google_sub', `TEXT`);
  ensureColumn(db, 'accounts', 'email_verified', `INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_google_sub
             ON accounts(google_sub) WHERE google_sub IS NOT NULL;`);
  return db;
}

/** Add a column if missing. SQLite has no IF NOT EXISTS for ADD COLUMN. */
function ensureColumn(db, table, column, typeSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
  }
}

// Test hook: point DATA_DIR somewhere disposable BEFORE first getDb() call.
export function _resetForTests() { if (db) { db.close(); db = null; } }
