import { getDb } from './db.mjs';
import * as diskStorage from './storage.mjs';

export const CARD_MAX_BYTES = 25 * 1024 * 1024;
const workspaceWrites = new Map();

export class HostedMediaError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Hosted media is later served from the authenticated product origin. Never
// persist a publisher-controlled HTML/JS MIME type there: a copied media URL
// must not turn into a same-origin script surface for a reviewer.
const MIME_BY_KIND = Object.freeze({
  image: new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']),
  video: new Set(['video/mp4', 'video/quicktime', 'video/webm']),
  audio: new Set(['audio/aac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm']),
});

function allowedMediaType(kind, contentType) {
  const mediaType = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return MIME_BY_KIND[kind] && MIME_BY_KIND[kind].has(mediaType) ? mediaType : null;
}

function serializeWorkspace(workspaceId, operation) {
  const prior = workspaceWrites.get(workspaceId) || Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  workspaceWrites.set(workspaceId, current);
  return current.finally(() => {
    if (workspaceWrites.get(workspaceId) === current) workspaceWrites.delete(workspaceId);
  });
}

export async function putHostedCardMedia({
  deckId, cardId, stream, contentType = 'application/octet-stream', contentLength = null,
  db = getDb(), storage = diskStorage,
}) {
  const row = db.prepare(`
    SELECT c.*, d.workspace_id, d.status, w.quota_bytes,
           COALESCE(u.bytes_used, 0) AS bytes_used
    FROM hosted_cards c
    JOIN hosted_decks d ON d.id=c.deck_id
    JOIN workspaces w ON w.id=d.workspace_id
    LEFT JOIN ws_usage u ON u.workspace_id=w.id
    WHERE c.deck_id=? AND c.id=?
  `).get(deckId, cardId);
  if (!row) throw new HostedMediaError('not_found', 404, 'card not found');
  if (row.status !== 'draft') throw new HostedMediaError('deck_not_draft', 409, 'media is locked after publish');
  const mediaType = allowedMediaType(row.kind, contentType);
  if (!mediaType) {
    throw new HostedMediaError('unsupported_media_type', 415, 'media type is not allowed for this card kind');
  }

  return serializeWorkspace(row.workspace_id, async () => {
    const fresh = db.prepare(`
      SELECT c.bytes, d.status, w.quota_bytes, COALESCE(u.bytes_used,0) AS bytes_used
      FROM hosted_cards c JOIN hosted_decks d ON d.id=c.deck_id
      JOIN workspaces w ON w.id=d.workspace_id
      LEFT JOIN ws_usage u ON u.workspace_id=w.id
      WHERE c.deck_id=? AND c.id=?
    `).get(deckId, cardId);
    if (!fresh || fresh.status !== 'draft') throw new HostedMediaError('deck_not_draft', 409, 'media is locked after publish');

    const announced = contentLength === null ? null : Number(contentLength);
    if (announced !== null && (!Number.isFinite(announced) || announced < 0)) {
      throw new HostedMediaError('bad_content_length', 400, 'invalid content length');
    }
    if (announced !== null && announced > CARD_MAX_BYTES) {
      throw new HostedMediaError('card_too_large', 413, 'card media exceeds 25 MB');
    }
    const quotaAvailable = Math.max(0, fresh.quota_bytes - fresh.bytes_used + fresh.bytes);
    if (announced !== null && announced > quotaAvailable) {
      throw new HostedMediaError('quota_exceeded', 413, 'workspace media quota exceeded');
    }

    const key = storage.mediaKey(row.workspace_id, deckId, cardId);
    const maxBytes = Math.min(CARD_MAX_BYTES, quotaAvailable);
    let saved;
    try {
      saved = await storage.put(stream, key, { maxBytes });
    } catch (error) {
      if (error && error.code === 'storage_limit') {
        const code = quotaAvailable < CARD_MAX_BYTES ? 'quota_exceeded' : 'card_too_large';
        throw new HostedMediaError(code, 413, code === 'quota_exceeded' ? 'workspace media quota exceeded' : 'card media exceeds 25 MB');
      }
      throw error;
    }

    const nextUsage = fresh.bytes_used - fresh.bytes + saved.bytes;
    db.transaction(() => {
      db.prepare(`UPDATE hosted_cards SET media_key=?, media_type=?, bytes=? WHERE deck_id=? AND id=?`)
        .run(key, mediaType, saved.bytes, deckId, cardId);
      db.prepare(`INSERT INTO ws_usage (workspace_id,bytes_used) VALUES (?,?)
                  ON CONFLICT(workspace_id) DO UPDATE SET bytes_used=excluded.bytes_used`)
        .run(row.workspace_id, nextUsage);
    })();
    return { key, bytes: saved.bytes, workspaceBytes: nextUsage };
  });
}

export function hostedCardMediaRow(deckId, cardId, { db = getDb() } = {}) {
  return db.prepare(`
    SELECT c.media_key, c.media_type, c.bytes, c.media_required, d.workspace_id, d.project_id, d.status
    FROM hosted_cards c JOIN hosted_decks d ON d.id=c.deck_id
    WHERE c.deck_id=? AND c.id=?
  `).get(deckId, cardId);
}

export async function purgeExpiredHostedMedia({ now = new Date(), db = getDb(), storage = diskStorage } = {}) {
  const cutoffMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const decks = db.prepare(`
    SELECT d.id, d.workspace_id, d.done_at, p.purge_days
    FROM hosted_decks d
    JOIN projects p ON p.id=d.project_id
    WHERE d.status='done' AND d.done_at IS NOT NULL
  `).all().filter((deck) => {
    const doneMs = Date.parse(deck.done_at);
    return Number.isFinite(doneMs) && doneMs + deck.purge_days * 86400000 <= cutoffMs;
  });

  let decksPurged = 0, bytesFreed = 0;
  for (const deck of decks) {
    const cards = db.prepare(`SELECT id,media_key,bytes FROM hosted_cards WHERE deck_id=? AND bytes>0`).all(deck.id);
    if (!cards.length) continue;
    for (const card of cards) if (card.media_key) await storage.del(card.media_key);
    const freed = cards.reduce((sum, card) => sum + card.bytes, 0);
    db.transaction(() => {
      db.prepare(`UPDATE hosted_cards SET bytes=0 WHERE deck_id=?`).run(deck.id);
      db.prepare(`INSERT INTO ws_usage (workspace_id,bytes_used) VALUES (?,0)
                  ON CONFLICT(workspace_id) DO UPDATE SET bytes_used=MAX(0,ws_usage.bytes_used-?)`)
        .run(deck.workspace_id, freed);
    })();
    decksPurged++;
    bytesFreed += freed;
  }
  return { decksPurged, bytesFreed };
}

export function startHostedPurgeTimer({ intervalMs = 60 * 60 * 1000 } = {}) {
  const run = () => purgeExpiredHostedMedia().catch((error) => console.error('[hosted-purge]', error.message));
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
