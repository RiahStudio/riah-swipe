import { createHash, randomBytes } from 'node:crypto';

import { validateBatch } from './deck-validate.mjs';
import { getDb } from './db.mjs';
import { newId } from './auth.mjs';

export class HostedError extends Error {
  constructor(code, status, message, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const isoNow = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

export function createWorkspace({ ownerAccountId, name, quotaBytes = undefined, db = getDb() }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new HostedError('name_required', 400, 'workspace name is required');
  const id = newId(), at = isoNow();
  db.transaction(() => {
    if (quotaBytes === undefined) {
      db.prepare(`INSERT INTO workspaces (id,name,owner_account_id,created_at) VALUES (?,?,?,?)`)
        .run(id, cleanName, ownerAccountId, at);
    } else {
      const quota = Number(quotaBytes);
      if (!Number.isSafeInteger(quota) || quota < 0) throw new HostedError('bad_quota', 400, 'invalid workspace quota');
      db.prepare(`INSERT INTO workspaces (id,name,owner_account_id,quota_bytes,created_at) VALUES (?,?,?,?,?)`)
        .run(id, cleanName, ownerAccountId, quota, at);
    }
    db.prepare(`INSERT INTO workspace_members (workspace_id,account_id,org_role,joined_at) VALUES (?,?,'owner',?)`)
      .run(id, ownerAccountId, at);
    db.prepare(`INSERT INTO ws_usage (workspace_id,bytes_used) VALUES (?,0)`).run(id);
  })();
  return db.prepare(`SELECT id,name,quota_bytes AS quotaBytes,created_at AS createdAt FROM workspaces WHERE id=?`).get(id);
}

export function isWorkspaceOwner(workspaceId, accountId, { db = getDb() } = {}) {
  return Boolean(db.prepare(`SELECT 1 FROM workspaces WHERE id=? AND owner_account_id=?`).get(workspaceId, accountId));
}

export function createProject({ workspaceId, accountId, name, purgeDays = 30, db = getDb() }) {
  if (!isWorkspaceOwner(workspaceId, accountId, { db })) throw new HostedError('owner_required', 403, 'workspace owner required');
  const cleanName = String(name || '').trim();
  const days = Number(purgeDays);
  if (!cleanName) throw new HostedError('name_required', 400, 'project name is required');
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new HostedError('bad_purge_days', 400, 'purgeDays must be 0-3650');
  const id = newId(), at = isoNow();
  db.transaction(() => {
    db.prepare(`INSERT INTO projects (id,workspace_id,name,purge_days,created_at) VALUES (?,?,?,?,?)`)
      .run(id, workspaceId, cleanName, days, at);
    // The creator reviews their own project. Without this the whole product breaks
    // at its last step: an owner could make a project and hand out a submit link,
    // work would arrive, and their review queue stayed empty forever — because the
    // queue joins on project_roles.role='reviewer' and nobody ever had one.
    // The person who made the project is exactly who should review it.
    db.prepare(`INSERT INTO project_roles (project_id,account_id,role) VALUES (?,?,'reviewer')
                ON CONFLICT(project_id,account_id,role) DO NOTHING`)
      .run(id, accountId);
  })();
  return { id, workspaceId, name: cleanName, purgeDays: days, createdAt: at };
}

export function isProjectOwner(projectId, accountId, { db = getDb() } = {}) {
  return Boolean(db.prepare(`
    SELECT 1 FROM projects p JOIN workspaces w ON w.id=p.workspace_id
    WHERE p.id=? AND w.owner_account_id=?
  `).get(projectId, accountId));
}

export function hasProjectRole(projectId, accountId, role, { db = getDb() } = {}) {
  return Boolean(db.prepare(`SELECT 1 FROM project_roles WHERE project_id=? AND account_id=? AND role=?`)
    .get(projectId, accountId, role));
}

export function setProjectRole({ projectId, ownerAccountId, targetAccountId, role, db = getDb() }) {
  if (!isProjectOwner(projectId, ownerAccountId, { db })) throw new HostedError('owner_required', 403, 'workspace owner required');
  if (!['reviewer', 'submitter'].includes(role)) throw new HostedError('bad_role', 400, 'role must be reviewer or submitter');
  const project = db.prepare(`SELECT workspace_id FROM projects WHERE id=?`).get(projectId);
  const target = db.prepare(`SELECT id FROM accounts WHERE id=?`).get(targetAccountId);
  if (!project || !target) throw new HostedError('not_found', 404, 'project or account not found');
  db.transaction(() => {
    db.prepare(`INSERT INTO workspace_members (workspace_id,account_id,org_role,joined_at)
                VALUES (?,?,'member',?) ON CONFLICT(workspace_id,account_id) DO NOTHING`)
      .run(project.workspace_id, targetAccountId, isoNow());
    db.prepare(`INSERT INTO project_roles (project_id,account_id,role) VALUES (?,?,?)
                ON CONFLICT(project_id,account_id,role) DO NOTHING`)
      .run(projectId, targetAccountId, role);
  })();
  return { projectId, accountId: targetAccountId, role };
}

export function issueSubmitterToken({ projectId, ownerAccountId, label = '', db = getDb() }) {
  if (!isProjectOwner(projectId, ownerAccountId, { db })) throw new HostedError('owner_required', 403, 'workspace owner required');
  const token = `rswt_${randomBytes(24).toString('base64url')}`;
  const row = { id: newId(), projectId, label: String(label || '').trim().slice(0, 120), createdAt: isoNow() };
  db.prepare(`INSERT INTO submitter_tokens (id,project_id,token_hash,label,created_by,created_at) VALUES (?,?,?,?,?,?)`)
    .run(row.id, projectId, sha256(token), row.label, ownerAccountId, row.createdAt);
  return { ...row, token };
}

export function authenticatePublisher({ projectId, accountId = null, token = '', db = getDb() }) {
  if (token) {
    if (!/^rswt_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
    const row = db.prepare(`SELECT id,project_id FROM submitter_tokens WHERE token_hash=?`).get(sha256(token));
    if (!row || row.project_id !== projectId) return null;
    db.prepare(`UPDATE submitter_tokens SET last_used_at=? WHERE id=?`).run(isoNow(), row.id);
    return { type: 'token', id: row.id, actor: `token:${row.id}`, projectId };
  }
  if (accountId && hasProjectRole(projectId, accountId, 'submitter', { db })) {
    return { type: 'session', id: accountId, actor: accountId, projectId };
  }
  return null;
}

function textSnapshot(card) {
  const kind = String(card.kind || '');
  if (kind === 'script' || kind === 'chapter') {
    const value = typeof card.media === 'string' ? card.media : card.media && card.media.text;
    return String(value || '').slice(0, 20000);
  }
  if (['line', 'text', 'logline'].includes(kind)) return [card.title, card.preview].filter(Boolean).join('\n').slice(0, 20000);
  return '';
}

function primaryMedia(media) {
  if (typeof media === 'string') return media;
  if (media && typeof media === 'object') return String(media.src || '');
  return '';
}

export function createHostedDecks({ projectId, actor, batch, db = getDb() }) {
  const validation = validateBatch(batch);
  if (!validation.ok) throw new HostedError('invalid_manifest', 400, 'deck manifest failed validation', validation);
  const project = db.prepare(`SELECT id,workspace_id FROM projects WHERE id=?`).get(projectId);
  if (!project) throw new HostedError('not_found', 404, 'project not found');
  const at = isoNow();
  const created = [];
  try {
    db.transaction(() => {
      for (const sourceDeck of batch.decks) {
        const id = newId();
        const rev = Number(sourceDeck.rev) || 0;
        db.prepare(`
          INSERT INTO hosted_decks
            (id,workspace_id,project_id,source_id,name,kind,rev,status,created_by,created_at,
             source,return_to,note,selecting_for,description,accent)
          VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)
        `).run(
          id, project.workspace_id, projectId, sourceDeck.id, sourceDeck.name,
          String(sourceDeck.kind || ''), rev, actor, at, String(sourceDeck.source || ''),
          String(sourceDeck.returnTo || sourceDeck.source || ''), String(sourceDeck.note || ''),
          String(sourceDeck.selectingFor || ''), String(sourceDeck.description || ''), String(sourceDeck.accent || ''),
        );
        const cards = batch.cards.filter((card) => card.deckId === sourceDeck.id);
        const uploadCards = [];
        cards.forEach((card, position) => {
          const kind = String(card.kind || sourceDeck.kind || 'text');
          const mediaRef = primaryMedia(card.media);
          const mediaRequired = ['image', 'video', 'audio'].includes(kind) && Boolean(mediaRef);
          db.prepare(`
            INSERT INTO hosted_cards
              (deck_id,id,position,title,kind,media_required,original_media,content,caption,preview,tag,meta)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            id, card.id, position, card.title, kind, mediaRequired ? 1 : 0,
            JSON.stringify(card.media ?? null), textSnapshot(card), String(card.caption || ''),
            String(card.preview || ''), String(card.tag || ''), JSON.stringify(card.meta ?? null),
          );
          uploadCards.push({ id: card.id, mediaRequired, media: mediaRef });
        });
        created.push({ id, sourceId: sourceDeck.id, name: sourceDeck.name, status: 'draft', cards: uploadCards });
      }
    })();
  } catch (error) {
    if (String(error && error.code).startsWith('SQLITE_CONSTRAINT')) {
      throw new HostedError('deck_revision_exists', 409, 'that deck revision already exists in this project');
    }
    throw error;
  }
  return { schema: 'riah-swipe.deck/1', warnings: validation.warnings, decks: created };
}

export function appendWorkspaceEvent({ workspaceId, projectId = null, type, payload, at = isoNow(), db = getDb() }) {
  return db.transaction(() => {
    const seq = db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS seq FROM ws_events WHERE workspace_id=?`).get(workspaceId).seq;
    db.prepare(`INSERT INTO ws_events (workspace_id,seq,project_id,type,payload,at) VALUES (?,?,?,?,?,?)`)
      .run(workspaceId, seq, projectId, type, JSON.stringify(payload || {}), at);
    return { workspaceId, seq, projectId, type, payload: payload || {}, at };
  })();
}

export function publishHostedDeck({ deckId, db = getDb() }) {
  const deck = db.prepare(`SELECT * FROM hosted_decks WHERE id=?`).get(deckId);
  if (!deck) throw new HostedError('not_found', 404, 'deck not found');
  if (deck.status !== 'draft') throw new HostedError('not_draft', 409, 'deck is already published');
  const missing = db.prepare(`
    SELECT id FROM hosted_cards WHERE deck_id=? AND media_required=1 AND (media_key IS NULL OR bytes<=0)
    ORDER BY position
  `).all(deckId).map((row) => row.id);
  if (missing.length) throw new HostedError('media_missing', 409, 'all card media must be uploaded before publish', { cards: missing });
  const event = db.transaction(() => {
    db.prepare(`UPDATE hosted_decks SET status='open' WHERE id=? AND status='draft'`).run(deckId);
    return appendWorkspaceEvent({
      workspaceId: deck.workspace_id, projectId: deck.project_id, type: 'deck.published',
      payload: { projectId: deck.project_id, deckId, sourceId: deck.source_id, name: deck.name }, db,
    });
  })();
  return { deck: { id: deckId, sourceId: deck.source_id, status: 'open' }, event };
}

function parseJson(value, fallback = null) {
  try { return value === null || value === undefined ? fallback : JSON.parse(value); }
  catch { return fallback; }
}

function hostedMediaUrl(basePath, deckId, cardId) {
  return `${basePath}/api/decks/${encodeURIComponent(deckId)}/cards/${encodeURIComponent(cardId)}/media`;
}

export function accountHasReviewerProject(accountId, { db = getDb() } = {}) {
  return Boolean(db.prepare(`SELECT 1 FROM project_roles WHERE account_id=? AND role='reviewer' LIMIT 1`).get(accountId));
}

export function accountHasSubmitterProject(accountId, { db = getDb() } = {}) {
  return Boolean(db.prepare(`SELECT 1 FROM project_roles WHERE account_id=? AND role='submitter' LIMIT 1`).get(accountId));
}

export function accountHasWorkspaceProject(workspaceId, accountId, { db = getDb() } = {}) {
  return Boolean(db.prepare(`
    SELECT 1 FROM project_roles pr JOIN projects p ON p.id=pr.project_id
    WHERE p.workspace_id=? AND pr.account_id=? LIMIT 1
  `).get(workspaceId, accountId));
}

export function reviewBatchForAccount({ accountId, basePath = '', db = getDb() }) {
  const decks = db.prepare(`
    SELECT DISTINCT d.* FROM hosted_decks d
    JOIN project_roles pr ON pr.project_id=d.project_id
    WHERE pr.account_id=? AND pr.role='reviewer' AND d.status='open'
    ORDER BY d.created_at, d.id
  `).all(accountId);
  const outDecks = [], outCards = [];
  const deckIds = decks.map((deck) => deck.id);
  const cardsByDeck = new Map();
  if (deckIds.length) {
    const placeholders = deckIds.map(() => '?').join(',');
    const cards = db.prepare(`
      SELECT * FROM hosted_cards
      WHERE deck_id IN (${placeholders})
      ORDER BY deck_id, position, id
    `).all(...deckIds);
    for (const card of cards) {
      if (!cardsByDeck.has(card.deck_id)) cardsByDeck.set(card.deck_id, []);
      cardsByDeck.get(card.deck_id).push(card);
    }
  }
  for (const deck of decks) {
    outDecks.push({
      id: deck.id, name: deck.name, source: deck.source, kind: deck.kind, note: deck.note,
      selectingFor: deck.selecting_for, returnTo: deck.return_to, rev: deck.rev,
    });
    for (const card of cardsByDeck.get(deck.id) || []) {
      let media = '';
      if (card.media_required && card.bytes > 0) {
        const url = hostedMediaUrl(basePath, deck.id, card.id);
        media = card.kind === 'video' || card.kind === 'audio'
          ? { src: url, mime: card.media_type }
          : url;
      } else if (card.kind === 'script' || card.kind === 'chapter') {
        media = card.content;
      }
      outCards.push({
        id: card.id, deckId: deck.id, title: card.title, kind: card.kind, media,
        caption: card.caption, preview: card.preview, tag: card.tag, meta: parseJson(card.meta),
      });
    }
  }
  return { schema: 'riah-swipe.deck/1', decks: outDecks, cards: outCards };
}

function reviewerDeck(deckId, accountId, db) {
  return db.prepare(`
    SELECT d.* FROM hosted_decks d JOIN project_roles pr ON pr.project_id=d.project_id
    WHERE d.id=? AND pr.account_id=? AND pr.role='reviewer'
  `).get(deckId, accountId);
}

export function submitHostedVerdict({ deckId, accountId, verdict, db = getDb() }) {
  const deck = reviewerDeck(deckId, accountId, db);
  if (!deck) throw new HostedError('reviewer_required', 403, 'reviewer role required');
  if (deck.status !== 'open' && deck.status !== 'done') throw new HostedError('deck_not_open', 409, 'deck is not open for review');
  const cardId = String(verdict && verdict.cardId || '');
  const decision = String(verdict && verdict.decision || '');
  if (!['keep', 'revise', 'discard'].includes(decision)) throw new HostedError('bad_decision', 400, 'invalid verdict decision');
  if (!db.prepare(`SELECT 1 FROM hosted_cards WHERE deck_id=? AND id=?`).get(deckId, cardId)) {
    throw new HostedError('card_not_found', 404, 'card not found in this deck');
  }
  const decidedMs = Date.parse(verdict && verdict.decidedAt);
  if (!Number.isFinite(decidedMs)) throw new HostedError('bad_decided_at', 400, 'decidedAt must be an ISO timestamp');
  const decidedAt = new Date(decidedMs).toISOString();
  const note = String(verdict.note || '').slice(0, 20000);
  const voiceNote = String(verdict.voiceNote || '').slice(0, 20000);
  const thumb = String(verdict.thumb || '').slice(0, 512 * 1024);

  return db.transaction(() => {
    const existing = db.prepare(`SELECT decided_at FROM hosted_verdicts WHERE deck_id=? AND card_id=?`).get(deckId, cardId);
    if (existing && Date.parse(existing.decided_at) >= decidedMs) {
      return { applied: false, deckDone: deck.status === 'done', decidedAt: existing.decided_at };
    }
    db.prepare(`
      INSERT INTO hosted_verdicts (deck_id,card_id,decision,note,voice_note,thumb,decided_by,decided_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(deck_id,card_id) DO UPDATE SET
        decision=excluded.decision,note=excluded.note,voice_note=excluded.voice_note,
        thumb=excluded.thumb,decided_by=excluded.decided_by,decided_at=excluded.decided_at
      WHERE excluded.decided_at > hosted_verdicts.decided_at
    `).run(deckId, cardId, decision, note, voiceNote, thumb, accountId, decidedAt);
    appendWorkspaceEvent({
      workspaceId: deck.workspace_id, projectId: deck.project_id, type: 'verdict',
      payload: { projectId: deck.project_id, deckId, cardId, decision, decidedAt }, db,
    });
    const counts = db.prepare(`
      SELECT (SELECT COUNT(*) FROM hosted_cards WHERE deck_id=?) AS cards,
             (SELECT COUNT(*) FROM hosted_verdicts WHERE deck_id=?) AS verdicts
    `).get(deckId, deckId);
    let deckDone = deck.status === 'done';
    if (!deckDone && counts.cards > 0 && counts.cards === counts.verdicts) {
      const doneAt = isoNow();
      db.prepare(`UPDATE hosted_decks SET status='done',done_at=? WHERE id=? AND status='open'`).run(doneAt, deckId);
      appendWorkspaceEvent({
        workspaceId: deck.workspace_id, projectId: deck.project_id, type: 'deck.done',
        payload: { projectId: deck.project_id, deckId, sourceId: deck.source_id, doneAt }, db,
      });
      deckDone = true;
    }
    return { applied: true, deckDone, decidedAt };
  })();
}

export function undoHostedVerdict({ deckId, accountId, cardId, db = getDb() }) {
  const deck = reviewerDeck(deckId, accountId, db);
  if (!deck) throw new HostedError('reviewer_required', 403, 'reviewer role required');
  return db.transaction(() => {
    const removed = db.prepare(`DELETE FROM hosted_verdicts WHERE deck_id=? AND card_id=?`).run(deckId, cardId).changes > 0;
    if (removed && deck.status === 'done') db.prepare(`UPDATE hosted_decks SET status='open',done_at=NULL WHERE id=?`).run(deckId);
    if (removed) appendWorkspaceEvent({
      workspaceId: deck.workspace_id, projectId: deck.project_id, type: 'verdict.undo',
      payload: { projectId: deck.project_id, deckId, cardId }, db,
    });
    return { removed, deckDone: false };
  })();
}

export function hostedVerdictsForReviewer({ deckId, accountId, db = getDb() }) {
  if (!reviewerDeck(deckId, accountId, db)) throw new HostedError('reviewer_required', 403, 'reviewer role required');
  const entries = db.prepare(`
    SELECT card_id,decision,note,voice_note,thumb,decided_at
    FROM hosted_verdicts WHERE deck_id=? ORDER BY decided_at,card_id
  `).all(deckId).map((row) => ({
    cardId: row.card_id, decision: row.decision, note: row.note,
    voiceNote: row.voice_note, thumb: row.thumb, decidedAt: row.decided_at,
  }));
  return { ok: true, batchId: deckId, entries };
}

function resultsAccess(deckId, accountId, db) {
  return db.prepare(`
    SELECT d.* FROM hosted_decks d JOIN project_roles pr ON pr.project_id=d.project_id
    WHERE d.id=? AND pr.account_id=? AND pr.role IN ('reviewer','submitter') LIMIT 1
  `).get(deckId, accountId);
}

export function assembleHostedResults({ deckId, accountId, db = getDb() }) {
  const deck = resultsAccess(deckId, accountId, db);
  if (!deck) throw new HostedError('project_role_required', 403, 'project role required');
  if (deck.status !== 'done') throw new HostedError('deck_not_done', 409, 'results are available after every card has a verdict');
  const rows = db.prepare(`
    SELECT c.*,v.decision,v.note AS verdict_note,v.voice_note,v.thumb,v.decided_at
    FROM hosted_cards c JOIN hosted_verdicts v ON v.deck_id=c.deck_id AND v.card_id=c.id
    WHERE c.deck_id=? ORDER BY c.position,c.id
  `).all(deckId);
  const results = rows.map((row) => {
    const original = parseJson(row.original_media);
    const media = typeof original === 'string' ? original : (original && original.src) || '';
    return {
      cardId: row.id,
      title: row.title,
      approved: row.decision === 'keep',
      revised: row.decision === 'revise',
      decision: row.decision,
      note: row.verdict_note,
      voiceNote: row.voice_note,
      thumb: row.thumb,
      content: row.content,
      meta: parseJson(row.meta),
      media,
      decidedAt: row.decided_at,
    };
  });
  return {
    schema: 'riah-swipe.results/2',
    batchId: deck.source_id,
    deckName: deck.name,
    project: deck.source,
    returnTo: deck.return_to || deck.source,
    kind: deck.kind,
    sentAt: deck.done_at,
    decidedCount: results.length,
    cardCount: rows.length,
    results,
  };
}

export function workspaceEventsForAccount({ workspaceId, accountId, afterSeq = 0, db = getDb() }) {
  return db.prepare(`
    SELECT e.seq,e.project_id,e.type,e.payload,e.at FROM ws_events e
    WHERE e.workspace_id=? AND e.seq>? AND EXISTS (
      SELECT 1 FROM project_roles pr WHERE pr.project_id=e.project_id AND pr.account_id=?
    ) ORDER BY e.seq
  `).all(workspaceId, Number(afterSeq) || 0, accountId).map((row) => ({
    seq: row.seq, projectId: row.project_id, type: row.type, payload: parseJson(row.payload, {}), at: row.at,
  }));
}

export function submitterProjectsForAccount(accountId, { db = getDb() } = {}) {
  const projectRows = db.prepare(`
    SELECT DISTINCT p.id,p.name,p.purge_days,p.workspace_id,w.name AS workspace_name,
           w.quota_bytes,COALESCE(u.bytes_used,0) AS bytes_used,wm.notify_email
    FROM project_roles pr JOIN projects p ON p.id=pr.project_id
    JOIN workspaces w ON w.id=p.workspace_id
    JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.account_id=pr.account_id
    LEFT JOIN ws_usage u ON u.workspace_id=w.id
    WHERE pr.account_id=? AND pr.role='submitter'
    ORDER BY w.name,p.name
  `).all(accountId);
  const projectIds = projectRows.map((row) => row.id);
  const decksByProject = new Map();
  if (projectIds.length) {
    const placeholders = projectIds.map(() => '?').join(',');
    const deckRows = db.prepare(`
      SELECT d.id,d.project_id,d.source_id,d.name,d.kind,d.status,d.created_at,d.done_at,
             (SELECT COUNT(*) FROM hosted_cards c WHERE c.deck_id=d.id) AS card_count,
             (SELECT COUNT(*) FROM hosted_verdicts v WHERE v.deck_id=d.id) AS verdict_count,
             (SELECT COUNT(*) FROM hosted_cards c WHERE c.deck_id=d.id AND c.media_required=1) AS media_count,
             (SELECT COUNT(*) FROM hosted_cards c WHERE c.deck_id=d.id AND c.media_required=1 AND c.bytes>0) AS live_media_count
      FROM hosted_decks d WHERE d.project_id IN (${placeholders})
      ORDER BY d.project_id,d.created_at DESC,d.id DESC
    `).all(...projectIds);
    for (const deck of deckRows) {
      if (!decksByProject.has(deck.project_id)) decksByProject.set(deck.project_id, []);
      decksByProject.get(deck.project_id).push(deck);
    }
  }
  const workspaces = new Map();
  for (const row of projectRows) {
    let workspace = workspaces.get(row.workspace_id);
    if (!workspace) {
      workspace = {
        id: row.workspace_id, name: row.workspace_name, quotaBytes: row.quota_bytes,
        bytesUsed: row.bytes_used, notifyEmail: Boolean(row.notify_email), projects: [],
      };
      workspaces.set(row.workspace_id, workspace);
    }
    workspace.projects.push({
      id: row.id, name: row.name, purgeDays: row.purge_days,
      decks: (decksByProject.get(row.id) || []).map((deck) => ({
        id: deck.id, sourceId: deck.source_id, name: deck.name, kind: deck.kind,
        status: deck.status, createdAt: deck.created_at, doneAt: deck.done_at,
        cardCount: deck.card_count, verdictCount: deck.verdict_count,
        mediaExpired: deck.status === 'done' && deck.media_count > 0 && deck.live_media_count === 0,
      })),
    });
  }
  return { workspaces: [...workspaces.values()] };
}

/**
 * Owner dashboard listing. Owners are project_roles.reviewer, NOT submitter —
 * so /api/projects (submitter-scoped) correctly returned nothing and the
 * dashboard looked empty after refresh even though the project was saved.
 */
export function ownedWorkspacesForAccount(accountId, { db = getDb() } = {}) {
  const wsRows = db.prepare(`
    SELECT w.id, w.name, w.quota_bytes AS quotaBytes,
           COALESCE(u.bytes_used, 0) AS bytesUsed,
           COALESCE(wm.notify_email, 1) AS notify_email
    FROM workspaces w
    LEFT JOIN ws_usage u ON u.workspace_id = w.id
    LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.account_id = w.owner_account_id
    WHERE w.owner_account_id = ?
    ORDER BY w.name
  `).all(accountId);
  const workspaces = wsRows.map((row) => ({
    id: row.id,
    name: row.name,
    quotaBytes: row.quotaBytes,
    bytesUsed: row.bytesUsed,
    notifyEmail: Boolean(row.notify_email),
    projects: [],
  }));
  if (!workspaces.length) return { workspaces };
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const placeholders = workspaces.map(() => '?').join(',');
  const projectRows = db.prepare(`
    SELECT id, workspace_id, name, purge_days AS purgeDays, created_at AS createdAt
    FROM projects
    WHERE workspace_id IN (${placeholders})
    ORDER BY name
  `).all(...workspaces.map((w) => w.id));
  for (const p of projectRows) {
    const ws = byId.get(p.workspace_id);
    if (ws) ws.projects.push({ id: p.id, name: p.name, purgeDays: p.purgeDays, createdAt: p.createdAt });
  }
  return { workspaces };
}
