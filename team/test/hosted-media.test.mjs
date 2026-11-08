import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-hosted-media-'));

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { getDb, _resetForTests } = await import('../lib/db.mjs');
const storage = await import('../lib/storage.mjs');
const { putHostedCardMedia, purgeExpiredHostedMedia, HostedMediaError } = await import('../lib/hosted-media.mjs');

const db = getDb();
const now = new Date().toISOString();

async function seed({ quota = 100, purgeDays = 30, doneAt = null } = {}) {
  await storage.del(storage.mediaKey('ws', 'd', 'c'));
  db.exec(`DELETE FROM hosted_verdicts; DELETE FROM hosted_cards; DELETE FROM hosted_decks;
           DELETE FROM project_roles; DELETE FROM projects; DELETE FROM workspace_members;
           DELETE FROM ws_usage; DELETE FROM workspaces; DELETE FROM accounts;`);
  db.prepare(`INSERT INTO accounts (id,email,password_hash,created_at) VALUES ('owner','owner@example.com','x',?)`).run(now);
  db.prepare(`INSERT INTO workspaces (id,name,owner_account_id,quota_bytes,created_at) VALUES ('ws','Team','owner',?,?)`)
    .run(quota, now);
  db.prepare(`INSERT INTO workspace_members VALUES ('ws','owner','owner',1,?)`).run(now);
  db.prepare(`INSERT INTO projects (id,workspace_id,name,purge_days,created_at) VALUES ('p','ws','Project',?,?)`).run(purgeDays, now);
  db.prepare(`INSERT INTO hosted_decks (id,workspace_id,project_id,source_id,name,status,created_by,created_at,done_at)
              VALUES ('d','ws','p','source','Deck',?,'owner',?,?)`).run(doneAt ? 'done' : 'draft', now, doneAt);
  db.prepare(`INSERT INTO hosted_cards (deck_id,id,title,kind,media_required) VALUES ('d','c','Card','image',1)`).run();
  db.prepare(`INSERT INTO ws_usage VALUES ('ws',0)`).run();
}

test('storage seam puts, streams, measures, and deletes opaque media keys', async () => {
  const key = storage.mediaKey('plainws', 'plaindeck', 'plaincard');
  const saved = await storage.put(Readable.from(Buffer.from('abcdef')), key, { maxBytes: 10 });
  assert.equal(saved.bytes, 6);
  const opened = await storage.get(key, { start: 1, end: 3 });
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'bcd');
  assert.equal(await storage.usage('plainws'), 6);
  await storage.del(key);
  assert.equal(await storage.usage('plainws'), 0);
});

test('raw media upload updates the card and workspace quota ledger', async () => {
  await seed({ quota: 12 });
  const result = await putHostedCardMedia({
    deckId: 'd', cardId: 'c', stream: Readable.from(Buffer.from('1234567890')),
    contentType: 'image/webp', contentLength: 10,
  });
  assert.equal(result.bytes, 10);
  assert.equal(db.prepare(`SELECT bytes_used FROM ws_usage WHERE workspace_id='ws'`).get().bytes_used, 10);
  const card = db.prepare(`SELECT bytes,media_type,media_key FROM hosted_cards WHERE deck_id='d' AND id='c'`).get();
  assert.equal(card.bytes, 10);
  assert.equal(card.media_type, 'image/webp');
  assert.match(card.media_key, /^ws\/d\/c-[a-f0-9]{64}$/);
});

test('workspace quota is enforced before a streamed replacement commits', async () => {
  await seed({ quota: 5 });
  await assert.rejects(
    putHostedCardMedia({ deckId: 'd', cardId: 'c', stream: Readable.from(Buffer.from('123456')), contentType: 'image/webp', contentLength: 6 }),
    (error) => error instanceof HostedMediaError && error.code === 'quota_exceeded',
  );
  assert.equal(db.prepare(`SELECT bytes_used FROM ws_usage WHERE workspace_id='ws'`).get().bytes_used, 0);
  assert.equal(await storage.usage('ws'), 0);
});

test('hosted uploads refuse executable or mismatched media types before writing', async () => {
  await seed({ quota: 100 });
  for (const contentType of ['text/html', 'image/svg+xml', 'video/mp4']) {
    await assert.rejects(
      putHostedCardMedia({
        deckId: 'd', cardId: 'c', stream: Readable.from(Buffer.from('<script>bad</script>')),
        contentType, contentLength: 20,
      }),
      (error) => error instanceof HostedMediaError && error.code === 'unsupported_media_type',
      contentType,
    );
  }
  assert.equal(db.prepare(`SELECT bytes FROM hosted_cards WHERE deck_id='d' AND id='c'`).get().bytes, 0);
  assert.equal(await storage.usage('ws'), 0);
});

test('purge tick deletes expired media but preserves deck, card, and verdict rows', async () => {
  const doneAt = '2026-01-01T00:00:00.000Z';
  await seed({ quota: 100, purgeDays: 2, doneAt });
  const key = storage.mediaKey('ws', 'd', 'c');
  await storage.put(Readable.from(Buffer.from('media')), key);
  db.prepare(`UPDATE hosted_cards SET media_key=?,bytes=5 WHERE deck_id='d' AND id='c'`).run(key);
  db.prepare(`UPDATE ws_usage SET bytes_used=5 WHERE workspace_id='ws'`).run();
  db.prepare(`INSERT INTO hosted_verdicts (deck_id,card_id,decision,decided_by,decided_at) VALUES ('d','c','keep','owner',?)`).run(doneAt);

  const result = await purgeExpiredHostedMedia({ now: new Date('2026-01-04T00:00:00.000Z') });
  assert.deepEqual(result, { decksPurged: 1, bytesFreed: 5 });
  assert.equal(await storage.usage('ws'), 0);
  assert.equal(db.prepare(`SELECT bytes FROM hosted_cards WHERE deck_id='d' AND id='c'`).get().bytes, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM hosted_decks WHERE id='d'`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM hosted_verdicts WHERE deck_id='d'`).get().n, 1);
  assert.equal(db.prepare(`SELECT bytes_used FROM ws_usage WHERE workspace_id='ws'`).get().bytes_used, 0);
});

