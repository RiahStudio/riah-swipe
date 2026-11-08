import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-hosted-review-'));
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
process.env.PORT = '0';

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { server, bootChecks } = await import('../server.mjs');
const { getDb, _resetForTests } = await import('../lib/db.mjs');
const {
  createWorkspace, createProject, setProjectRole, createHostedDecks, publishHostedDeck,
  appendWorkspaceEvent,
} = await import('../lib/hosted.mjs');
const { putHostedCardMedia } = await import('../lib/hosted-media.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const resultsFixture = readFileSync(join(HERE, 'fixtures', 'reference.results.json'), 'utf8').trim();
const swipeViewSource = readFileSync(join(HERE, '..', 'review-app', 'src', 'swipe-view.js'), 'utf8');

let base, workspaceId, projectId, hiddenProjectId, deckId;
const cookies = new Map();

async function signup(email) {
  const response = await fetch(base + '/api/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'long enough password' }),
  });
  assert.equal(response.status, 200);
  cookies.set(email, response.headers.get('set-cookie').split(';')[0]);
}

function accountId(email) {
  return getDb().prepare(`SELECT id FROM accounts WHERE email=?`).get(email).id;
}

function request(path, { as, method = 'GET', body, headers = {}, signal, redirect } = {}) {
  // `redirect` is forwarded so a test can assert WHERE a page sends someone, not
  // just that it eventually returns 200 after following the hop.
  const init = { method, headers: { ...headers }, signal, ...(redirect ? { redirect } : {}) };
  if (as) init.headers.Cookie = cookies.get(as);
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(base + path, init);
}

test('hosted review server boots and seeds two isolated reviewer projects', async () => {
  bootChecks();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const email of ['owner@example.com', 'reviewer@example.com', 'submitter@example.com', 'outsider@example.com']) await signup(email);

  const ownerId = accountId('owner@example.com');
  const reviewerId = accountId('reviewer@example.com');
  const submitterId = accountId('submitter@example.com');
  const outsiderId = accountId('outsider@example.com');
  workspaceId = createWorkspace({ ownerAccountId: ownerId, name: 'Review Workspace' }).id;
  projectId = createProject({ workspaceId, accountId: ownerId, name: 'Visible Project', purgeDays: 30 }).id;
  hiddenProjectId = createProject({ workspaceId, accountId: ownerId, name: 'Hidden Project', purgeDays: 30 }).id;
  setProjectRole({ projectId, ownerAccountId: ownerId, targetAccountId: reviewerId, role: 'reviewer' });
  setProjectRole({ projectId, ownerAccountId: ownerId, targetAccountId: submitterId, role: 'submitter' });
  setProjectRole({ projectId: hiddenProjectId, ownerAccountId: ownerId, targetAccountId: outsiderId, role: 'reviewer' });

  const visible = createHostedDecks({
    projectId, actor: submitterId,
    batch: {
      schema: 'riah-swipe.deck/1',
      decks: [{ id: 'fixture-batch', name: 'Fixture Deck', source: 'design-agent', returnTo: 'design-agent', kind: 'image' }],
      cards: [
        { id: 'poster-a', deckId: 'fixture-batch', title: 'Poster A', kind: 'image', media: 'poster-a.webp', meta: { seed: 7 } },
        { id: 'brief', deckId: 'fixture-batch', title: 'Brief', kind: 'text', preview: 'Campaign line' },
      ],
    },
  });
  deckId = visible.decks[0].id;
  await putHostedCardMedia({
    deckId, cardId: 'poster-a', stream: Readable.from(Buffer.from('webp-bytes')),
    contentType: 'image/webp', contentLength: 10,
  });
  publishHostedDeck({ deckId });

  const hidden = createHostedDecks({
    projectId: hiddenProjectId, actor: outsiderId,
    batch: {
      schema: 'riah-swipe.deck/1',
      decks: [{ id: 'hidden-batch', name: 'Hidden Deck', source: 'other', kind: 'text' }],
      cards: [{ id: 'hidden-card', deckId: 'hidden-batch', title: 'Hidden', kind: 'text' }],
    },
  });
  publishHostedDeck({ deckId: hidden.decks[0].id });
});

test('/review serves the review app only to project reviewers', async () => {
  const anonymous = await fetch(base + '/review', { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  // A submitter has no review queue, but answering a PAGE request with raw JSON put
  // {"ok":false,"error":"reviewer_required"} in front of a human. They are redirected
  // to their own project list instead; the API guard still returns 403 for machines.
  const submitter = await request('/review', { as: 'submitter@example.com', redirect: 'manual' });
  assert.equal(submitter.status, 302);
  assert.match(submitter.headers.get('location') || '', /\/projects$/);
  const reviewer = await request('/review', { as: 'reviewer@example.com' });
  assert.equal(reviewer.status, 200);
  const html = await reviewer.text();
  assert.match(html, /class="rs-app"/);
  assert.match(html, /\/review\/assets\/styles\/app\.css/);
  assert.match(html, /\/review\/hosted-bootstrap\.js/);

  const asset = await request('/review/assets/src/swipe-view.js', { as: 'reviewer@example.com' });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), swipeViewSource);
  const bootstrap = await request('/review/hosted-bootstrap.js', { as: 'reviewer@example.com' });
  assert.match(await bootstrap.text(), /review\/assets\/src\/app\.js/);
});

test('review deck bootstrap is scoped to reviewer projects', async () => {
  const response = await request('/api/review/decks', { as: 'reviewer@example.com' });
  assert.equal(response.status, 200);
  const batch = await response.json();
  assert.deepEqual(batch.decks.map((deck) => deck.name), ['Fixture Deck']);
  assert.deepEqual(batch.cards.map((card) => card.id), ['poster-a', 'brief']);
  assert.match(batch.cards[0].media, new RegExp(`/api/decks/${deckId}/cards/poster-a/media$`));
});

test('hosted media reuses Range semantics and enforces reviewer role', async () => {
  const refused = await request(`/api/decks/${deckId}/cards/poster-a/media`, { as: 'outsider@example.com' });
  assert.equal(refused.status, 403);
  const response = await request(`/api/decks/${deckId}/cards/poster-a/media`, {
    as: 'reviewer@example.com', headers: { Range: 'bytes=1-3' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 1-3/10');
  assert.equal(await response.text(), 'ebp');

  const head = await request(`/api/decks/${deckId}/cards/poster-a/media`, {
    as: 'reviewer@example.com', method: 'HEAD',
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.headers.get('content-security-policy'), "sandbox; default-src 'none'");
});

test('verdict route refuses other projects and applies newest decidedAt only', async () => {
  const refused = await request(`/api/decks/${deckId}/verdicts`, {
    as: 'outsider@example.com', method: 'POST',
    body: { cardId: 'poster-a', decision: 'keep', decidedAt: '2026-07-15T12:25:00.000Z' },
  });
  assert.equal(refused.status, 403);

  const first = await request(`/api/decks/${deckId}/verdicts`, {
    as: 'reviewer@example.com', method: 'POST',
    body: { cardId: 'poster-a', decision: 'keep', decidedAt: '2026-07-15T12:25:00.000Z' },
  });
  assert.equal((await first.json()).applied, true);
  const older = await request(`/api/decks/${deckId}/verdicts`, {
    as: 'reviewer@example.com', method: 'POST',
    body: { cardId: 'poster-a', decision: 'discard', decidedAt: '2026-07-15T12:20:00.000Z' },
  });
  assert.equal((await older.json()).applied, false);
  const newer = await request(`/api/decks/${deckId}/verdicts`, {
    as: 'reviewer@example.com', method: 'POST',
    body: { cardId: 'poster-a', decision: 'revise', note: 'Bigger title', decidedAt: '2026-07-15T12:30:00.000Z' },
  });
  assert.equal((await newer.json()).applied, true);
  assert.equal(getDb().prepare(`SELECT decision FROM hosted_verdicts WHERE deck_id=? AND card_id='poster-a'`).get(deckId).decision, 'revise');
  assert.equal(getDb().prepare(`SELECT status FROM hosted_decks WHERE id=?`).get(deckId).status, 'open');
  const earlyResults = await request(`/api/decks/${deckId}/results`, { as: 'submitter@example.com' });
  assert.equal(earlyResults.status, 409);
});

test('finish guard marks done only after every card has a verdict', async () => {
  const response = await request(`/api/decks/${deckId}/verdicts`, {
    as: 'reviewer@example.com', method: 'POST',
    body: { cardId: 'brief', decision: 'keep', decidedAt: '2026-07-15T12:31:00.000Z' },
  });
  const out = await response.json();
  assert.equal(out.deckDone, true);
  assert.equal(getDb().prepare(`SELECT status FROM hosted_decks WHERE id=?`).get(deckId).status, 'done');
  assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM ws_events WHERE workspace_id=? AND type='deck.done'`).get(workspaceId).n, 1);
});

test('hosted results serialize byte-for-byte like the reference fixture', async () => {
  getDb().prepare(`UPDATE hosted_decks SET done_at='2026-07-15T12:34:56.000Z' WHERE id=?`).run(deckId);
  const response = await request(`/api/decks/${deckId}/results`, { as: 'submitter@example.com' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text, resultsFixture);

  const tokenOnly = await fetch(base + `/api/decks/${deckId}/results`, { headers: { Authorization: 'Bearer rswt_not-a-session-token' } });
  assert.equal(tokenOnly.status, 401);
});

test('/projects shows submitter-scoped status and wires live SSE counts', async () => {
  const refused = await request('/projects', { as: 'reviewer@example.com' });
  assert.equal(refused.status, 403);
  const page = await request('/projects', { as: 'submitter@example.com' });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /href="\.\/shared\.css"/);
  assert.match(html, /src="\.\/projects\.js"/);

  const response = await request('/api/projects', { as: 'submitter@example.com' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.workspaces.length, 1);
  assert.equal(data.workspaces[0].projects.length, 1);
  const deck = data.workspaces[0].projects[0].decks[0];
  assert.equal(deck.status, 'done');
  assert.equal(deck.cardCount, 2);
  assert.equal(deck.verdictCount, 2);

  const script = await fetch(base + '/projects.js');
  const source = await script.text();
  assert.match(source, /new EventSource/);
  assert.match(source, /'deck\.published', 'verdict', 'verdict\.undo', 'deck\.done'/);
});

test('SSE replays after Last-Event-ID and filters inaccessible project events', async () => {
  const hidden = appendWorkspaceEvent({
    workspaceId, projectId: hiddenProjectId, type: 'hidden.event', payload: { secret: true },
  });
  const visible = appendWorkspaceEvent({
    workspaceId, projectId, type: 'visible.event', payload: { deckId },
  });
  const controller = new AbortController();
  const response = await request(`/api/workspaces/${workspaceId}/events`, {
    as: 'reviewer@example.com', headers: { 'Last-Event-ID': String(hidden.seq - 1) }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes(`id: ${visible.seq}`)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += Buffer.from(chunk.value).toString('utf8');
  }
  controller.abort();
  assert.match(text, new RegExp(`id: ${visible.seq}\\nevent: visible\\.event`));
  assert.doesNotMatch(text, /hidden\.event/);
});

after(() => {
  server.close();
  _resetForTests();
});
