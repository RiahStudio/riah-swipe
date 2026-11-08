// Adversarial two-tenant isolation: workspace A must never see or mutate workspace B
// (and vice versa). Fail closed (403/404), never 500, never leak foreign ids/media.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-tenant-isolation-'));
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
process.env.PORT = '0';

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { server, bootChecks } = await import('../server.mjs');
const { getDb, _resetForTests } = await import('../lib/db.mjs');
const {
  createWorkspace, createProject, setProjectRole, issueSubmitterToken,
  createHostedDecks, publishHostedDeck, submitHostedVerdict,
} = await import('../lib/hosted.mjs');
const { putHostedCardMedia, purgeExpiredHostedMedia } = await import('../lib/hosted-media.mjs');

let base;
const cookies = new Map();
/** @type {Record<'a'|'b', Tenant>} */
const tenants = {};

/**
 * @typedef {{
 *   tag: string,
 *   ownerEmail: string,
 *   approverEmail: string,
 *   submitterEmail: string,
 *   ownerId: string,
 *   approverId: string,
 *   submitterId: string,
 *   workspaceId: string,
 *   projectId: string,
 *   deckId: string,
 *   cardId: string,
 *   textCardId: string,
 *   sourceDeckId: string,
 *   token: string,
 *   mediaBytes: Buffer,
 *   mediaKey: string,
 *   secretName: string,
 * }} Tenant
 */

async function signup(email) {
  const response = await fetch(base + '/api/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'long enough password' }),
  });
  assert.equal(response.status, 200, `signup ${email}`);
  cookies.set(email, response.headers.get('set-cookie').split(';')[0]);
}

function accountId(email) {
  return getDb().prepare(`SELECT id FROM accounts WHERE email=?`).get(email).id;
}

function request(path, { as, method = 'GET', body, bearer, headers = {}, signal } = {}) {
  const init = { method, headers: { ...headers }, signal };
  if (as) init.headers.Cookie = cookies.get(as);
  if (bearer) init.headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) init.body = body;
    else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  return fetch(base + path, init);
}

/** Fail closed: 403 or 404 only, never 500, never leak known foreign secrets. */
async function assertFailClosed(response, secrets = [], { allow = [403, 404] } = {}) {
  const status = response.status;
  assert.notEqual(status, 500, `must not 500; got ${status}`);
  assert.ok(allow.includes(status), `expected ${allow.join('|')}, got ${status}`);
  const text = await response.text();
  for (const secret of secrets) {
    if (!secret) continue;
    assert.equal(text.includes(secret), false, `response body leaked ${JSON.stringify(secret)}`);
  }
  return { status, text };
}

async function bootstrapTenant(tag) {
  const ownerEmail = `${tag}-owner@example.com`;
  const approverEmail = `${tag}-approver@example.com`;
  const submitterEmail = `${tag}-submitter@example.com`;
  for (const email of [ownerEmail, approverEmail, submitterEmail]) await signup(email);

  const ownerId = accountId(ownerEmail);
  const approverId = accountId(approverEmail);
  const submitterId = accountId(submitterEmail);
  const secretName = `TENANT-${tag.toUpperCase()}-SECRET-DECK`;

  const workspaceId = createWorkspace({ ownerAccountId: ownerId, name: `Workspace ${tag.toUpperCase()}`, quotaBytes: 1_000_000 }).id;
  const projectId = createProject({ workspaceId, accountId: ownerId, name: `Project ${tag.toUpperCase()}`, purgeDays: 30 }).id;
  setProjectRole({ projectId, ownerAccountId: ownerId, targetAccountId: approverId, role: 'reviewer' });
  setProjectRole({ projectId, ownerAccountId: ownerId, targetAccountId: submitterId, role: 'submitter' });

  const { token } = issueSubmitterToken({ projectId, ownerAccountId: ownerId, label: `${tag}-publisher` });
  const sourceDeckId = `${tag}-source-deck`;
  const cardId = `${tag}-poster`;
  const textCardId = `${tag}-brief`;
  const mediaBytes = Buffer.from(`${tag}-media-payload-UNIQUE-${secretName}`);

  const created = createHostedDecks({
    projectId, actor: `token:bootstrap-${tag}`,
    batch: {
      schema: 'riah-swipe.deck/1',
      decks: [{
        id: sourceDeckId, name: secretName, kind: 'image',
        source: `${tag}-agent`, returnTo: `${tag}-agent`,
      }],
      cards: [
        { id: cardId, deckId: sourceDeckId, title: `${tag} Poster`, kind: 'image', media: `${cardId}.webp`, meta: { tenant: tag } },
        { id: textCardId, deckId: sourceDeckId, title: `${tag} Brief`, kind: 'text', preview: `Copy for ${tag}` },
      ],
    },
  });
  const deckId = created.decks[0].id;
  await putHostedCardMedia({
    deckId, cardId, stream: Readable.from(mediaBytes),
    contentType: 'image/webp', contentLength: mediaBytes.length,
  });
  publishHostedDeck({ deckId });

  submitHostedVerdict({
    deckId, accountId: approverId,
    verdict: {
      cardId, decision: 'keep',
      decidedAt: '2026-07-15T10:00:00.000Z',
      note: `${tag}-verdict-note`,
    },
  });

  const mediaKey = getDb().prepare(
    `SELECT media_key FROM hosted_cards WHERE deck_id=? AND id=?`,
  ).get(deckId, cardId).media_key;
  assert.ok(mediaKey, `tenant ${tag} media_key`);

  return {
    tag, ownerEmail, approverEmail, submitterEmail,
    ownerId, approverId, submitterId,
    workspaceId, projectId, deckId, cardId, textCardId, sourceDeckId,
    token, mediaBytes, mediaKey, secretName,
  };
}

function foreignSecrets(foreign) {
  return [
    foreign.workspaceId, foreign.projectId, foreign.deckId,
    foreign.secretName, foreign.mediaKey,
    foreign.mediaBytes.toString('utf8'),
    `${foreign.tag}-verdict-note`,
  ];
}

test('tenant isolation: boot and seed workspaces A and B', async () => {
  bootChecks();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  tenants.a = await bootstrapTenant('a');
  tenants.b = await bootstrapTenant('b');

  assert.notEqual(tenants.a.workspaceId, tenants.b.workspaceId);
  assert.notEqual(tenants.a.projectId, tenants.b.projectId);
  assert.notEqual(tenants.a.deckId, tenants.b.deckId);
  assert.notEqual(tenants.a.mediaKey, tenants.b.mediaKey);

  // Sanity: each approver can read their own media and review batch.
  for (const t of [tenants.a, tenants.b]) {
    const media = await request(`/api/decks/${t.deckId}/cards/${t.cardId}/media`, { as: t.approverEmail });
    assert.equal(media.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await media.arrayBuffer()), t.mediaBytes), 0);

    const batch = await request('/api/review/decks', { as: t.approverEmail });
    assert.equal(batch.status, 200);
    const body = await batch.json();
    assert.equal(body.decks.length, 1);
    assert.equal(body.decks[0].id, t.deckId);
    assert.equal(body.decks[0].name, t.secretName);
  }
});

async function assertCrossApproverBlocked(actor, foreign) {
  const secrets = foreignSecrets(foreign);

  // List: review batch must not include foreign decks / names.
  const batch = await request('/api/review/decks', { as: actor.approverEmail });
  assert.equal(batch.status, 200);
  const listed = await batch.json();
  assert.equal(listed.decks.some((d) => d.id === foreign.deckId), false);
  assert.equal(listed.decks.some((d) => d.name === foreign.secretName), false);
  assert.equal(listed.cards.some((c) => c.deckId === foreign.deckId), false);

  // Fetch foreign deck surfaces by id.
  await assertFailClosed(
    await request(`/api/decks/${foreign.deckId}/verdicts`, { as: actor.approverEmail }),
    secrets,
  );
  await assertFailClosed(
    await request(`/api/decks/${foreign.deckId}/results`, { as: actor.approverEmail }),
    secrets,
  );

  // Media: valid session on actor must not serve foreign card bytes.
  const media = await request(
    `/api/decks/${foreign.deckId}/cards/${foreign.cardId}/media`,
    { as: actor.approverEmail },
  );
  const mediaClosed = await assertFailClosed(media, secrets);
  assert.equal(mediaClosed.text.includes(foreign.mediaBytes.toString('utf8')), false);

  // Live event stream for foreign workspace.
  const events = await request(`/api/workspaces/${foreign.workspaceId}/events`, {
    as: actor.approverEmail,
  });
  await assertFailClosed(events, secrets);

  // Create project under foreign workspace (owner-only + membership).
  await assertFailClosed(
    await request(`/api/workspaces/${foreign.workspaceId}/projects`, {
      as: actor.approverEmail, method: 'POST', body: { name: 'Crossed Project' },
    }),
    secrets,
  );
  await assertFailClosed(
    await request(`/api/workspaces/${foreign.workspaceId}/projects`, {
      as: actor.ownerEmail, method: 'POST', body: { name: 'Crossed Project' },
    }),
    secrets,
  );
}

test('tenant isolation: approver cross-access fails closed both directions', async () => {
  await assertCrossApproverBlocked(tenants.a, tenants.b);
  await assertCrossApproverBlocked(tenants.b, tenants.a);
});

test('tenant isolation: submitter token cannot publish into or read the other workspace', async () => {
  for (const [actor, foreign] of [[tenants.a, tenants.b], [tenants.b, tenants.a]]) {
    const secrets = foreignSecrets(foreign);

    // Publish into foreign project with actor's token.
    const publishInto = await request(`/api/projects/${foreign.projectId}/decks`, {
      bearer: actor.token, method: 'POST',
      body: {
        schema: 'riah-swipe.deck/1',
        decks: [{ id: `${actor.tag}-into-${foreign.tag}`, name: 'Cross publish', kind: 'text', source: 'x' }],
        cards: [{ id: 'x', deckId: `${actor.tag}-into-${foreign.tag}`, title: 'X', kind: 'text', preview: 'nope' }],
      },
    });
    await assertFailClosed(publishInto, secrets, { allow: [403, 404] });

    // Token cannot publish foreign deck, put media on foreign card, or finish foreign publish.
    await assertFailClosed(
      await request(`/api/decks/${foreign.deckId}/publish`, { bearer: actor.token, method: 'POST', body: {} }),
      secrets,
    );
    await assertFailClosed(
      await request(`/api/decks/${foreign.deckId}/cards/${foreign.cardId}/media`, {
        bearer: actor.token, method: 'PUT', body: Buffer.from('intrusion'),
        headers: { 'Content-Type': 'image/webp' },
      }),
      secrets,
    );

    // Session submitter listing must not include foreign workspace/project/deck.
    const projects = await request('/api/projects', { as: actor.submitterEmail });
    assert.equal(projects.status, 200);
    const data = await projects.json();
    const allWs = data.workspaces || [];
    assert.equal(allWs.some((w) => w.id === foreign.workspaceId), false);
    for (const ws of allWs) {
      for (const p of ws.projects || []) {
        assert.notEqual(p.id, foreign.projectId);
        for (const d of p.decks || []) assert.notEqual(d.id, foreign.deckId);
      }
    }

    // Submitter session + token cannot read foreign results/verdicts/media/events.
    for (const as of [actor.submitterEmail, null]) {
      const opts = as ? { as } : { bearer: actor.token };
      await assertFailClosed(await request(`/api/decks/${foreign.deckId}/results`, opts), secrets, {
        allow: [401, 403, 404],
      });
      await assertFailClosed(await request(`/api/decks/${foreign.deckId}/verdicts`, opts), secrets, {
        allow: [401, 403, 404],
      });
      await assertFailClosed(
        await request(`/api/decks/${foreign.deckId}/cards/${foreign.cardId}/media`, opts),
        secrets,
        { allow: [401, 403, 404] },
      );
      await assertFailClosed(
        await request(`/api/workspaces/${foreign.workspaceId}/events`, opts),
        secrets,
        { allow: [401, 403, 404] },
      );
    }
  }
});

test('tenant isolation: approver cannot post a verdict on the foreign deck', async () => {
  for (const [actor, foreign] of [[tenants.a, tenants.b], [tenants.b, tenants.a]]) {
    const before = getDb().prepare(
      `SELECT decision,note,decided_by FROM hosted_verdicts WHERE deck_id=? AND card_id=?`,
    ).get(foreign.deckId, foreign.cardId);

    const response = await request(`/api/decks/${foreign.deckId}/verdicts`, {
      as: actor.approverEmail, method: 'POST',
      body: {
        cardId: foreign.cardId, decision: 'discard',
        decidedAt: '2026-07-16T12:00:00.000Z',
        note: `leaked-from-${actor.tag}`,
      },
    });
    await assertFailClosed(response, foreignSecrets(foreign).concat([`leaked-from-${actor.tag}`]));

    const after = getDb().prepare(
      `SELECT decision,note,decided_by FROM hosted_verdicts WHERE deck_id=? AND card_id=?`,
    ).get(foreign.deckId, foreign.cardId);
    assert.deepEqual(after, before);
    assert.equal(after.decided_by, foreign.approverId);
  }
});

test('tenant isolation: deleted/foreign workspace ids and mangled media keys return 404 not 500', async () => {
  const actor = tenants.a;
  const foreign = tenants.b;

  // Foreign / deleted workspace ids on events and project create.
  for (const badWs of ['ws_does_not_exist', 'deleted-workspace', tenants.b.workspaceId + '-gone', '../etc']) {
    const events = await request(`/api/workspaces/${encodeURIComponent(badWs)}/events`, {
      as: actor.approverEmail,
    });
    assert.notEqual(events.status, 500);
    assert.ok([403, 404].includes(events.status), `events ${badWs} → ${events.status}`);
    await events.text();

    const create = await request(`/api/workspaces/${encodeURIComponent(badWs)}/projects`, {
      as: actor.ownerEmail, method: 'POST', body: { name: 'Nope' },
    });
    assert.notEqual(create.status, 500);
    assert.ok([403, 404].includes(create.status), `project create ${badWs} → ${create.status}`);
    await create.text();
  }

  // Mangled deck/card media paths (opaque key is not a public URL; media is deck/card scoped).
  const mangled = [
    `/api/decks/${foreign.deckId}/cards/${foreign.cardId}%2e%2e/media`,
    `/api/decks/not-a-deck/cards/${foreign.cardId}/media`,
    `/api/decks/${foreign.deckId}/cards/not-a-card/media`,
    `/api/decks/${encodeURIComponent(foreign.mediaKey)}/cards/${foreign.cardId}/media`,
    `/api/decks/${foreign.deckId}/cards/${encodeURIComponent(foreign.mediaKey)}/media`,
    `/api/decks/../${foreign.deckId}/cards/${foreign.cardId}/media`,
  ];
  for (const path of mangled) {
    const response = await request(path, { as: actor.approverEmail });
    assert.notEqual(response.status, 500, path);
    // 403/404 preferred; 400 also fail-closed. Never 200 with foreign bytes.
    assert.notEqual(response.status, 200, path);
    const text = await response.text();
    assert.equal(text.includes(foreign.mediaBytes.toString('utf8')), false, path);
    assert.equal(text.includes(foreign.mediaKey), false, path);
  }

  // Direct storage-key-looking segments must not open a second media surface.
  const opaqueProbe = await request(
    `/api/decks/${foreign.workspaceId}/cards/${foreign.deckId}/media`,
    { as: actor.approverEmail },
  );
  assert.notEqual(opaqueProbe.status, 500);
  assert.notEqual(opaqueProbe.status, 200);
  await opaqueProbe.text();
});

test('tenant isolation: media upload increments only the owning workspace quota', async () => {
  const a = tenants.a;
  const b = tenants.b;
  const usage = (ws) => getDb().prepare(`SELECT bytes_used FROM ws_usage WHERE workspace_id=?`).get(ws).bytes_used;
  const beforeA = usage(a.workspaceId);
  const beforeB = usage(b.workspaceId);

  // Extra draft deck in A so we can upload without reopening the published deck.
  const extra = createHostedDecks({
    projectId: a.projectId, actor: a.submitterId,
    batch: {
      schema: 'riah-swipe.deck/1',
      decks: [{ id: 'a-quota-extra', name: 'Quota Extra', kind: 'image', source: 'a-agent' }],
      cards: [{ id: 'a-extra-card', deckId: 'a-quota-extra', title: 'Extra', kind: 'image', media: 'extra.webp' }],
    },
  });
  const extraDeckId = extra.decks[0].id;
  const payload = Buffer.from('AAAA-ONLY-QUOTA-BYTES-1234567890');
  const put = await request(`/api/decks/${extraDeckId}/cards/a-extra-card/media`, {
    bearer: a.token, method: 'PUT', body: payload,
    headers: { 'Content-Type': 'image/webp' },
  });
  assert.equal(put.status, 200);
  const out = await put.json();
  assert.equal(out.bytes, payload.length);
  assert.equal(usage(a.workspaceId), beforeA + payload.length);
  assert.equal(usage(b.workspaceId), beforeB);
  assert.equal(out.workspaceBytes, beforeA + payload.length);
});

test('tenant isolation: purge/retention in A leaves B media and verdicts untouched', async () => {
  const a = tenants.a;
  const b = tenants.b;
  const db = getDb();

  // Make A's published deck eligible for media purge; B stays within retention.
  const oldDone = '2026-01-01T00:00:00.000Z';
  db.prepare(`UPDATE hosted_decks SET status='done', done_at=? WHERE id=?`).run(oldDone, a.deckId);
  db.prepare(`UPDATE projects SET purge_days=2 WHERE id=?`).run(a.projectId);
  // Ensure B has a live verdict + media that must survive.
  const bVerdictBefore = db.prepare(
    `SELECT card_id,decision,note FROM hosted_verdicts WHERE deck_id=? ORDER BY card_id`,
  ).all(b.deckId);
  assert.ok(bVerdictBefore.length >= 1);
  const bMediaBefore = db.prepare(
    `SELECT media_key,bytes FROM hosted_cards WHERE deck_id=? AND id=?`,
  ).get(b.deckId, b.cardId);
  assert.ok(bMediaBefore.bytes > 0);
  const bUsageBefore = db.prepare(`SELECT bytes_used FROM ws_usage WHERE workspace_id=?`).get(b.workspaceId).bytes_used;

  const result = await purgeExpiredHostedMedia({ now: new Date('2026-01-10T00:00:00.000Z') });
  assert.ok(result.decksPurged >= 1);

  // A media freed (or at least the expired A deck processed); B untouched.
  const aCard = db.prepare(`SELECT bytes FROM hosted_cards WHERE deck_id=? AND id=?`).get(a.deckId, a.cardId);
  assert.equal(aCard.bytes, 0);
  const aVerdicts = db.prepare(`SELECT COUNT(*) AS n FROM hosted_verdicts WHERE deck_id=?`).get(a.deckId).n;
  assert.ok(aVerdicts >= 1, 'purge must preserve A verdict rows');

  const bVerdictAfter = db.prepare(
    `SELECT card_id,decision,note FROM hosted_verdicts WHERE deck_id=? ORDER BY card_id`,
  ).all(b.deckId);
  assert.deepEqual(bVerdictAfter, bVerdictBefore);
  const bMediaAfter = db.prepare(
    `SELECT media_key,bytes FROM hosted_cards WHERE deck_id=? AND id=?`,
  ).get(b.deckId, b.cardId);
  assert.deepEqual(bMediaAfter, bMediaBefore);
  assert.equal(
    db.prepare(`SELECT bytes_used FROM ws_usage WHERE workspace_id=?`).get(b.workspaceId).bytes_used,
    bUsageBefore,
  );

  // B approver can still stream B media after A's purge.
  const media = await request(`/api/decks/${b.deckId}/cards/${b.cardId}/media`, { as: b.approverEmail });
  assert.equal(media.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await media.arrayBuffer()), b.mediaBytes), 0);
});

after(() => {
  server.close();
  _resetForTests();
});
