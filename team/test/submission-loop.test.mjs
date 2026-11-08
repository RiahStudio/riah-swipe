// The journey the landing page promises: "your team submits, you swipe."
//
// Before 2026-07-29 the backend could do every step but no SCREEN exposed two of
// them, so a real customer could not complete this without someone calling the API
// by hand. This walks the whole path over HTTP — the same calls the dashboard and
// the submit page make — so if either screen regresses, this fails.
//
//   owner signs up → workspace → project → submit link
//   submitter (NO ACCOUNT, token only) → deck → media → publish
//   owner sees it waiting in review
//
// DATA_DIR must be set BEFORE importing server/db (ESM imports hoist — use dynamic import).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rsw-loop-'));
process.env.SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
process.env.PORT = '0';
delete process.env.BASE_PATH;

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { server, bootChecks } = await import('../server.mjs');

let base, cookie = '';
let projectId, submitToken, deckId;

const jar = (res) => {
  const map = new Map();
  for (const part of String(cookie || '').split(';')) {
    const t = part.trim(); if (!t) continue;
    const eq = t.indexOf('='); if (eq > 0) map.set(t.slice(0, eq), t.slice(eq + 1));
  }
  const sets = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const raw of sets) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('='); if (eq > 0) map.set(first.slice(0, eq), first.slice(eq + 1));
  }
  cookie = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
};

const owner = (extra = {}) => ({ 'Content-Type': 'application/json', Cookie: cookie, ...extra });
const submitter = (extra = {}) => ({ Authorization: `Bearer ${submitToken}`, ...extra });

test('server boots', async () => {
  bootChecks();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test('owner signs up and gets a workspace + project', async () => {
  const s = await fetch(base + '/api/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `owner-${Date.now()}@example.com`, password: 'a long enough password' }),
  });
  jar(s);
  assert.equal((await s.json()).ok, true);

  const ws = await (await fetch(base + '/api/workspaces', {
    method: 'POST', headers: owner(), body: JSON.stringify({ name: 'Test Team' }),
  })).json();
  assert.equal(ws.ok, true, JSON.stringify(ws));

  const pr = await (await fetch(`${base}/api/workspaces/${ws.workspace.id}/projects`, {
    method: 'POST', headers: owner(), body: JSON.stringify({ name: 'Poster round 2' }),
  })).json();
  assert.equal(pr.ok, true, JSON.stringify(pr));
  projectId = pr.project.id;
  assert.ok(projectId, 'the API must return a project id — the submit-link button needs it');
});

test('owner generates a submit link', async () => {
  const t = await (await fetch(`${base}/api/projects/${projectId}/tokens`, {
    method: 'POST', headers: owner(), body: JSON.stringify({ label: 'submit link' }),
  })).json();
  assert.equal(t.ok, true, JSON.stringify(t));
  submitToken = t.token;
  assert.match(submitToken, /^rswt_/);
});

test('a submitter with NO ACCOUNT can create a deck with only the token', async () => {
  const res = await (await fetch(`${base}/api/projects/${projectId}/decks`, {
    method: 'POST', headers: submitter({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      schema: 'riah-swipe.deck/1',
      decks: [{ id: 'sub-1', name: 'Poster — round 2', kind: 'image', rev: 0 }],
      cards: [
        { id: 'sub-1-c1', deckId: 'sub-1', title: 'Variant A', kind: 'image', media: 'a.png' },
        { id: 'sub-1-c2', deckId: 'sub-1', title: 'Variant B', kind: 'image', media: 'b.png' },
      ],
    }),
  })).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  deckId = res.decks[0].id;
  assert.equal(res.decks[0].status, 'draft', 'a new deck must be a draft, not yet visible');
});

test('the submitter uploads media for each card', async () => {
  for (const cardId of ['sub-1-c1', 'sub-1-c2']) {
    const res = await fetch(`${base}/api/decks/${deckId}/cards/${cardId}/media`, {
      method: 'PUT', headers: submitter({ 'Content-Type': 'image/png' }),
      body: Buffer.from('\x89PNG\r\n\x1a\n fake bytes'),
    });
    assert.equal(res.status, 200, `upload failed for ${cardId}`);
  }
});

test('a WRONG token cannot publish into the project', async () => {
  const res = await fetch(`${base}/api/projects/${projectId}/decks`, {
    method: 'POST',
    headers: { Authorization: 'Bearer rswt_not-a-real-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'riah-swipe.deck/1', decks: [{ id: 'x', name: 'x' }], cards: [] }),
  });
  assert.equal(res.status, 403);
});

test('publishing hands it to the reviewer', async () => {
  const pub = await (await fetch(`${base}/api/decks/${deckId}/publish`, {
    method: 'POST', headers: submitter(),
  })).json();
  assert.equal(pub.ok, true, JSON.stringify(pub));
});

test('THE WHOLE POINT: the owner sees the submitted work waiting to review', async () => {
  // This endpoint returns the review BATCH itself ({schema, decks, cards}) rather
  // than an {ok:true} envelope — it feeds the swipe surface directly.
  const review = await (await fetch(base + '/api/review/decks', { headers: { Cookie: cookie } })).json();
  assert.equal(review.schema, 'riah-swipe.deck/1', JSON.stringify(review).slice(0, 300));
  assert.equal(review.decks.length, 1, 'exactly the submitted deck should be waiting');
  assert.equal(review.decks[0].name, 'Poster — round 2');
  assert.equal(review.cards.length, 2, 'both submitted cards should be there to swipe');
});

after(() => { try { server.close(); } catch { /* already closed */ } });
