import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-hosted-publish-'));
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
process.env.PORT = '0';

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { server, bootChecks } = await import('../server.mjs');
const { getDb, _resetForTests } = await import('../lib/db.mjs');
const {
  flushProjectReviewNotifications, _setMailSenderForTests, _clearNotificationsForTests,
} = await import('../lib/notifications.mjs');

let base, workspaceId, projectId, deckId, token;
const cookies = new Map();
const mail = [];

async function signup(email) {
  const response = await fetch(base + '/api/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'long enough password' }),
  });
  assert.equal(response.status, 200);
  cookies.set(email, response.headers.get('set-cookie').split(';')[0]);
  return response;
}

function request(path, { as, method = 'GET', body, bearer, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
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

test('hosted publish server boots on the existing account backbone', async () => {
  bootChecks();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  _setMailSenderForTests(async (message) => { mail.push(message); return { ok: true }; });
});

test('human sessions create a workspace and project with no setup beyond signing up', async () => {
  for (const email of ['owner@example.com', 'reviewer@example.com', 'silent@example.com', 'submitter@example.com', 'outsider@example.com']) {
    await signup(email);
  }
  const workspaceResponse = await request('/api/workspaces', {
    as: 'owner@example.com', method: 'POST', body: { name: 'Remote Team' },
  });
  assert.equal(workspaceResponse.status, 201);
  workspaceId = (await workspaceResponse.json()).workspace.id;
  const projectResponse = await request(`/api/workspaces/${workspaceId}/projects`, {
    as: 'owner@example.com', method: 'POST', body: { name: 'Campaign', purgeDays: 7 },
  });
  assert.equal(projectResponse.status, 201);
  projectId = (await projectResponse.json()).project.id;

  // Owner dashboard refresh must still see the project (owner is reviewer, not submitter).
  const listed = await request('/api/workspaces', { as: 'owner@example.com' });
  assert.equal(listed.status, 200);
  const listBody = await listed.json();
  assert.equal(listBody.ok, true);
  assert.equal(listBody.workspaces.length, 1);
  assert.equal(listBody.workspaces[0].projects.length, 1);
  assert.equal(listBody.workspaces[0].projects[0].id, projectId);
  assert.equal(listBody.workspaces[0].projects[0].name, 'Campaign');
});

test('workspace and project ownership is re-checked server-side', async () => {
  const refused = await request(`/api/projects/${projectId}/roles`, {
    as: 'outsider@example.com', method: 'POST', body: { email: 'outsider@example.com', role: 'reviewer' },
  });
  assert.equal(refused.status, 403);

  const outsiderWorkspace = await request('/api/workspaces', {
    as: 'outsider@example.com', method: 'POST', body: { name: 'Other Workspace' },
  });
  const otherWs = (await outsiderWorkspace.json()).workspace.id;
  const crossProject = await request(`/api/workspaces/${otherWs}/projects`, {
    as: 'owner@example.com', method: 'POST', body: { name: 'Crossed' },
  });
  assert.equal(crossProject.status, 403);
});

test('owner assigns reviewer and submitter roles per project', async () => {
  for (const [email, role] of [['reviewer@example.com', 'reviewer'], ['silent@example.com', 'reviewer'], ['submitter@example.com', 'submitter']]) {
    const response = await request(`/api/projects/${projectId}/roles`, {
      as: 'owner@example.com', method: 'POST', body: { email, role },
    });
    assert.equal(response.status, 200);
  }
  // FOUR roles, not three: creating a project now makes its owner a reviewer of it.
  // Before 2026-07-29 it did not, and the consequence was that an owner could invite
  // submitters, receive work, and never see any of it — the review queue joins on
  // role='reviewer' and nobody held one. The owner is the approver, so the
  // person who made the project is exactly who should have it.
  const roles = getDb().prepare(`SELECT role FROM project_roles WHERE project_id=? ORDER BY role`).all(projectId);
  assert.deepEqual(roles.map((row) => row.role), ['reviewer', 'reviewer', 'reviewer', 'submitter']);
  const toggle = await request(`/api/workspaces/${workspaceId}/me`, {
    as: 'silent@example.com', method: 'PATCH', body: { notifyEmail: false },
  });
  assert.equal(toggle.status, 200);
  assert.equal((await toggle.json()).notifyEmail, false);
});

test('submitter token is shown once and only its sha256 fingerprint is stored', async () => {
  const response = await request(`/api/projects/${projectId}/tokens`, {
    as: 'owner@example.com', method: 'POST', body: { label: 'publisher' },
  });
  assert.equal(response.status, 201);
  token = (await response.json()).token;
  assert.match(token, /^rswt_[A-Za-z0-9_-]+$/);
  const stored = getDb().prepare(`SELECT token_hash FROM submitter_tokens WHERE project_id=?`).get(projectId);
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.equal(stored.token_hash.includes(token), false);
});

test('reviewers cannot publish and invalid manifests use the deck validator', async () => {
  const refused = await request(`/api/projects/${projectId}/decks`, {
    as: 'reviewer@example.com', method: 'POST', body: { schema: 'riah-swipe.deck/1', decks: [], cards: [] },
  });
  assert.equal(refused.status, 403);
  const invalid = await request(`/api/projects/${projectId}/decks`, {
    as: 'submitter@example.com', method: 'POST', body: { schema: 'riah-swipe.deck/1', decks: [{}], cards: [] },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_manifest');
});

test('project token creates a draft deck and publish refuses missing media', async () => {
  const batch = {
    schema: 'riah-swipe.deck/1',
    decks: [{ id: 'remote-round-1', name: 'Remote round 1', kind: 'image', source: 'design-agent', returnTo: 'design-agent' }],
    cards: [
      { id: 'poster-a', deckId: 'remote-round-1', title: 'Poster A', kind: 'image', media: 'poster-a.webp', meta: { seed: 7 } },
      { id: 'brief', deckId: 'remote-round-1', title: 'Brief', kind: 'text', preview: 'Campaign line' },
    ],
  };
  const response = await request(`/api/projects/${projectId}/decks`, { bearer: token, method: 'POST', body: batch });
  assert.equal(response.status, 201);
  const out = await response.json();
  deckId = out.decks[0].id;
  assert.equal(out.decks[0].sourceId, 'remote-round-1');
  assert.equal(out.decks[0].cards.filter((card) => card.mediaRequired).length, 1);

  const publish = await request(`/api/decks/${deckId}/publish`, { bearer: token, method: 'POST', body: {} });
  assert.equal(publish.status, 409);
  assert.deepEqual((await publish.json()).details.cards, ['poster-a']);
});

test('raw PUT enforces workspace quota and updates usage when accepted', async () => {
  getDb().prepare(`UPDATE workspaces SET quota_bytes=5 WHERE id=?`).run(workspaceId);
  const refused = await request(`/api/decks/${deckId}/cards/poster-a/media`, {
    bearer: token, method: 'PUT', body: Buffer.from('123456'), headers: { 'Content-Type': 'image/webp' },
  });
  assert.equal(refused.status, 413);
  assert.equal((await refused.json()).error, 'quota_exceeded');

  getDb().prepare(`UPDATE workspaces SET quota_bytes=100 WHERE id=?`).run(workspaceId);
  const accepted = await request(`/api/decks/${deckId}/cards/poster-a/media`, {
    bearer: token, method: 'PUT', body: Buffer.from('webp-bytes'), headers: { 'Content-Type': 'image/webp' },
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).workspaceBytes, 10);
});

test('publish emits deck.published and coalesced reviewer mail honors notify_email', async () => {
  const response = await request(`/api/decks/${deckId}/publish`, { bearer: token, method: 'POST', body: {} });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deck.status, 'open');
  const published = getDb().prepare(`SELECT type,payload FROM ws_events WHERE workspace_id=? ORDER BY seq`).all(workspaceId);
  assert.equal(published[0].type, 'deck.published');

  // TWO now, not one: the project owner is a reviewer of their own project, so they
  // are told when work lands — which is the entire point of the notification. The
  // third reviewer (silent@) switched notify_email off above and must stay silent.
  const result = await flushProjectReviewNotifications(projectId);
  assert.equal(result.sent, 2);
  assert.equal(mail.length, 2);
  const recipients = mail.map((m) => m.to).sort();
  assert.deepEqual(recipients, ['owner@example.com', 'reviewer@example.com']);
  assert.ok(!recipients.includes('silent@example.com'), 'notify_email=false must be honoured');
  const events = getDb().prepare(`SELECT type FROM ws_events WHERE workspace_id=? ORDER BY seq`).all(workspaceId);
  assert.deepEqual(events.map((row) => row.type), ['deck.published', 'reviewers.notified']);
});

after(() => {
  _clearNotificationsForTests();
  server.close();
  _resetForTests();
});
