// src/data/store.js
// IndexedDB-backed store. Vanilla — no wrappers, no bundler. All persistence
// lives here; the interaction and view layers never see `indexedDB`.
// Public functions return Promises.
//
// Why IndexedDB at all in a local-first app: verdicts survive refreshes,
// browser crashes, and phone sleep mid-deck. The decks folder on disk is the
// inbox; this store is the working state; the results folder is the outbox.
//
// Object stores:
//   - decks    : keyPath 'id'              — review batches
//   - cards    : keyPath 'id', idx 'deckId'— items inside a deck
//   - verdicts : keyPath 'id', idx 'cardId'— append-only decisions
//   - meta     : keyPath 'key'             — small kv bag (tombstones, revs)

import { isCard, isDeck, VERDICTS } from './model.js';

const DB_NAME    = databaseNameForWorkspaceId(
  typeof window !== 'undefined' ? window.RSW_WORKSPACE_ID : '',
);
const DB_VERSION = 1;

export function databaseNameForWorkspaceId(workspaceId) {
  const id = String(workspaceId || '').trim();
  return id ? `riah-swipe-pro-v1--${id}` : 'riah-swipe-pro-v1';
}

const STORE_DECKS = 'decks';
const STORE_CARDS = 'cards';
const STORE_VERDS = 'verdicts';
const STORE_META  = 'meta';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_DECKS)) {
        db.createObjectStore(STORE_DECKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CARDS)) {
        const s = db.createObjectStore(STORE_CARDS, { keyPath: 'id' });
        s.createIndex('deckId', 'deckId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_VERDS)) {
        const s = db.createObjectStore(STORE_VERDS, { keyPath: 'id' });
        s.createIndex('cardId',   'cardId',   { unique: false });
        s.createIndex('deckId',   'deckId',   { unique: false });
        s.createIndex('decision', 'decision', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode = 'readonly') {
  return openDB().then(db => db.transaction(store, mode).objectStore(store));
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── Decks ───────────────────────────────────────────────────────────────────

export async function putDeck(deck) {
  if (!isDeck(deck)) throw new Error('putDeck: invalid deck');
  const store = await tx(STORE_DECKS, 'readwrite');
  return reqAsPromise(store.put(deck));
}

export async function getDeck(id) {
  const store = await tx(STORE_DECKS, 'readonly');
  return reqAsPromise(store.get(id));
}

export async function getAllDecks() {
  const store = await tx(STORE_DECKS, 'readonly');
  return reqAsPromise(store.getAll());
}

export async function deleteDeck(id) {
  const store = await tx(STORE_DECKS, 'readwrite');
  return reqAsPromise(store.delete(id));
}

// ── Cards ───────────────────────────────────────────────────────────────────

export async function putCards(cards) {
  const store = await tx(STORE_CARDS, 'readwrite');
  return Promise.all(cards.filter(isCard).map(c => reqAsPromise(store.put(c))));
}

export async function getCardsByDeck(deckId) {
  const store = await tx(STORE_CARDS, 'readonly');
  const idx   = store.index('deckId');
  return reqAsPromise(idx.getAll(deckId));
}

export async function deleteCard(id) {
  const store = await tx(STORE_CARDS, 'readwrite');
  return reqAsPromise(store.delete(id));
}

// ── Verdicts ────────────────────────────────────────────────────────────────

export async function putVerdict(verdict) {
  if (!verdict || !VERDICTS.includes(verdict.decision)) {
    throw new Error('putVerdict: invalid verdict');
  }
  const store = await tx(STORE_VERDS, 'readwrite');
  return reqAsPromise(store.put(verdict));
}

export async function getAllVerdicts() {
  const store = await tx(STORE_VERDS, 'readonly');
  return reqAsPromise(store.getAll());
}

export async function getVerdictsForCard(cardId) {
  const store = await tx(STORE_VERDS, 'readonly');
  const idx   = store.index('cardId');
  return reqAsPromise(idx.getAll(cardId));
}

export async function getVerdictsForDeck(deckId) {
  const store = await tx(STORE_VERDS, 'readonly');
  const idx   = store.index('deckId');
  return reqAsPromise(idx.getAll(deckId));
}

export function replayVerdictJournal(entries, deckId) {
  const latest = new Map();
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    if (!entry || typeof entry.cardId !== 'string' || !entry.cardId) continue;
    if (entry.undo === true) {
      latest.delete(entry.cardId);
      continue;
    }
    if (!VERDICTS.includes(entry.decision)) continue;
    latest.set(entry.cardId, {
      id: `${entry.cardId}:journal:${index}`,
      cardId: entry.cardId,
      deckId: String(deckId || ''),
      decision: entry.decision,
      note: String(entry.note || ''),
      voiceNote: String(entry.voiceNote || ''),
      thumb: String(entry.thumb || ''),
      decidedAt: String(entry.decidedAt || new Date(0).toISOString()),
    });
  }
  return [...latest.values()];
}

// Undo support: removes every verdict for one card so it counts as undecided
// again. The verdict log is append-only in spirit — this is the ONE sanctioned
// exception, used only by the reviewer's explicit Undo.
export async function deleteVerdictsForCard(cardId) {
  const all   = await getVerdictsForCard(cardId);
  const store = await tx(STORE_VERDS, 'readwrite');
  return Promise.all(all.map(v => reqAsPromise(store.delete(v.id))));
}

// Set<string> of cardIds that already have any verdict — the controller filters
// the deck with this so decided cards don't re-surface.
export async function getDecidedCardIds() {
  const all = await getAllVerdicts();
  return new Set(all.map(v => v.cardId));
}

// ── Meta / config bag ───────────────────────────────────────────────────────

export async function setMeta(key, value) {
  const store = await tx(STORE_META, 'readwrite');
  return reqAsPromise(store.put({ key, value }));
}

export async function getMeta(key) {
  const store = await tx(STORE_META, 'readonly');
  const row   = await reqAsPromise(store.get(key));
  return row ? row.value : undefined;
}

// ── Sent decks (tombstones) ──────────────────────────────────────────────────
// When a fully-decided deck's results are delivered to the results folder, the
// deck is cleared off the picker. A tombstone (deck id → sentAt) is kept in
// meta so the auto-loader never re-imports a deck already finished + sent
// (until a newer rev arrives).

const SENT_KEY = 'sentDeckIds';

export async function markDeckSent(deckId) {
  const sent = (await getMeta(SENT_KEY)) || {};
  sent[deckId] = new Date().toISOString();
  await setMeta(SENT_KEY, sent);
}

export async function getSentDeckIds() {
  const sent = (await getMeta(SENT_KEY)) || {};
  return new Set(Object.keys(sent));
}

// Called only AFTER a deck's results are confirmed written to the results
// folder. Wipe the deck off this browser so a phone never fills up: tombstone
// the id, then delete the deck row, its cards (the heavy media data), and its
// verdicts. The permanent record is the results file, never this store.
export async function purgeDeckAfterSend(deckId) {
  await markDeckSent(deckId);
  try {
    const cards = await getCardsByDeck(deckId);
    await Promise.all(cards.map((c) => deleteVerdictsForCard(c.id).catch(() => {})));
    await Promise.all(cards.map((c) => deleteCard(c.id).catch(() => {})));
  } catch { /* best-effort cleanup — never block the UI */ }
  await deleteDeck(deckId).catch(() => {});
}

// ── Reset (settings) ────────────────────────────────────────────────────────

export async function resetAll() {
  const db = await openDB();
  const t  = db.transaction([STORE_DECKS, STORE_CARDS, STORE_VERDS, STORE_META], 'readwrite');
  await Promise.all([
    reqAsPromise(t.objectStore(STORE_DECKS).clear()),
    reqAsPromise(t.objectStore(STORE_CARDS).clear()),
    reqAsPromise(t.objectStore(STORE_VERDS).clear()),
    reqAsPromise(t.objectStore(STORE_META).clear()),
  ]);
}
