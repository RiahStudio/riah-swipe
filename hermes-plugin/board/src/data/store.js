// board/src/data/store.js
// IndexedDB-backed store. Vanilla — no idb-keyval / no Dexie / no bundler.
// All persistence lives here; the interaction and view layers never see
// `indexedDB`. Public functions return Promises.
//
// Object stores:
//   - decks    : keyPath 'id'              — review batches the user works through
//   - cards    : keyPath 'id', idx 'deckId'— items inside a deck
//   - verdicts : keyPath 'id', idx 'cardId'— append-only user decisions
//   - meta     : keyPath 'key'             — small kv bag (seeded flag, etc.)
//
// DB_NAME bumped to v2 when the data model pivoted from sections → decks; the
// old DB is orphaned and harmless. No migration code needed because no real
// user data lives there.

import { isCard, isDeck, VERDICTS } from './model.js';

const DB_NAME      = 'riah-swipe-v2';
const DB_VERSION   = 3;   // v3: + history store (Recently Swiped archive)

const STORE_DECKS  = 'decks';
const STORE_CARDS  = 'cards';
const STORE_VERDS  = 'verdicts';
const STORE_META   = 'meta';
const STORE_NOTES  = 'notes';   // Notes: one note per card (keyPath cardId)
const STORE_HIST   = 'history'; // Recently Swiped: verdict snapshots that survive purge

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis) || !indexedDB) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    const timer = setTimeout(() => {
      _dbPromise = null;
      reject(new Error('IndexedDB open timed out'));
    }, 4000);
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
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        const s = db.createObjectStore(STORE_NOTES, { keyPath: 'cardId' });
        s.createIndex('deckId', 'deckId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_HIST)) {
        const s = db.createObjectStore(STORE_HIST, { keyPath: 'id' });
        s.createIndex('deckId',    'deckId',    { unique: false });
        s.createIndex('archivedAt','archivedAt', { unique: false });
      }
    };
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror   = () => { clearTimeout(timer); reject(req.error); };
    req.onblocked = () => { /* wait for timeout */ };
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

export async function putDecks(decks) {
  const store = await tx(STORE_DECKS, 'readwrite');
  return Promise.all(decks.filter(isDeck).map(d => reqAsPromise(store.put(d))));
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
  // Note: deletes the deck row only. Cards in this deck remain orphaned until
  // a separate cleanup pass — keeps the operation cheap and reversible.
  const store = await tx(STORE_DECKS, 'readwrite');
  return reqAsPromise(store.delete(id));
}

// ── Cards ───────────────────────────────────────────────────────────────────

export async function putCard(card) {
  if (!isCard(card)) throw new Error('putCard: invalid card');
  const store = await tx(STORE_CARDS, 'readwrite');
  return reqAsPromise(store.put(card));
}

export async function putCards(cards) {
  const store = await tx(STORE_CARDS, 'readwrite');
  return Promise.all(cards.filter(isCard).map(c => reqAsPromise(store.put(c))));
}

export async function getCard(id) {
  const store = await tx(STORE_CARDS, 'readonly');
  return reqAsPromise(store.get(id));
}

export async function getAllCards() {
  const store = await tx(STORE_CARDS, 'readonly');
  return reqAsPromise(store.getAll());
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

// Undo support: removes every verdict for one card so it counts as undecided
// again and re-surfaces in its deck. The verdict log is append-only in spirit —
// this is the ONE sanctioned exception, used only by the user's explicit Undo.
export async function deleteVerdictsForCard(cardId) {
  const all   = await getVerdictsForCard(cardId);
  const store = await tx(STORE_VERDS, 'readwrite');
  return Promise.all(all.map(v => reqAsPromise(store.delete(v.id))));
}

// Returns Set<string> of cardIds that already have any verdict — used by the
// controller to filter the deck so seen cards don't re-surface.
export async function getDecidedCardIds() {
  const all = await getAllVerdicts();
  return new Set(all.map(v => v.cardId));
}

// ── Notes (Notes mode) ────────────────────────────────────────────────
// One note per card (keyPath cardId), upserted as the reviewer types. Separate
// from verdicts: a note is feedback for the author, not a keep/cut decision.

export async function putNote(note) {
  if (!note || !note.cardId) throw new Error('putNote: cardId required');
  const row = {
    cardId:    String(note.cardId),
    deckId:    String(note.deckId || ''),
    text:      String(note.text || ''),
    voiceNote: String(note.voiceNote || ''),
    approval:  String(note.approval || ''),   // 'approved' | 'rejected' | ''
    updatedAt: new Date().toISOString(),
  };
  const store = await tx(STORE_NOTES, 'readwrite');
  return reqAsPromise(store.put(row));
}

export async function getNote(cardId) {
  const store = await tx(STORE_NOTES, 'readonly');
  return reqAsPromise(store.get(cardId));
}

export async function getNotesByDeck(deckId) {
  const store = await tx(STORE_NOTES, 'readonly');
  const idx   = store.index('deckId');
  return reqAsPromise(idx.getAll(deckId));
}

export async function deleteNotesByDeck(deckId) {
  const notes = await getNotesByDeck(deckId);
  const store = await tx(STORE_NOTES, 'readwrite');
  return Promise.all(notes.map((n) => reqAsPromise(store.delete(n.cardId))));
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
// When a fully-decided deck's results are sent back, we clear the
// deck off the picker entirely. A tombstone (deck id → sentAt) is kept in meta
// so the auto-loader never re-imports a deck the user already finished + sent.

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

// Compact text-body snapshot for text-ish cards (script/chapter/line/text) so a
// re-opened "Recently Swiped" deck can replay the actual words even after the deck
// data has left the device. Capped to keep the history store light.
function snapshotCardText(card) {
  const kind = (card && card.kind) || '';
  let t = '';
  if (kind === 'script' || kind === 'chapter') {
    t = typeof card.media === 'string' ? card.media : (card.media && card.media.text) || '';
  } else if (kind === 'line' || kind === 'text') {
    t = [card.title, card.preview].filter(Boolean).join('\n');
  }
  return String(t || '').slice(0, 4000);
}

// Copy a finished deck's verdicts into Recently Swiped. Does not wipe the live
// deck — finished work stays on the device until the hold period ends.
export async function snapshotDeckToHistory(deckId) {
  const deck = await getDeck(deckId);
  const cards = await getCardsByDeck(deckId);
  const verdicts = await getVerdictsForDeck(deckId);
  const byCard = new Map(cards.map((c) => [c.id, c]));
  const now = new Date().toISOString();
  const latest = new Map();
  for (const v of verdicts) {
    const prev = latest.get(v.cardId);
    if (!prev || v.decidedAt > prev.decidedAt) latest.set(v.cardId, v);
  }
  const histEntries = [];
  for (const [cardId, v] of latest) {
    const card = byCard.get(cardId) || {};
    const mediaSrc = typeof card.media === 'string' ? card.media
      : (card.media && (card.media.src || card.media.poster)) || '';
    histEntries.push({
      id:         v.id,
      cardId,
      deckId,
      deckName:   (deck && deck.name) || '',
      project:    (deck && deck.source) || '',
      kind:       card.kind || (deck && deck.kind) || 'text',
      decision:   v.decision,
      title:      card.title || '',
      thumb:      v.thumb || '',
      media:      mediaSrc,
      caption:    card.caption || '',
      preview:    String(card.preview || '').slice(0, 280),
      // Fuller text body for text-ish kinds so a re-opened (demo) deck shows the
      // real words, not just the 280-char preview. Capped so a giant doc can't
      // bloat the history store.
      content:    snapshotCardText(card),
      note:       v.note || '',
      voiceNote:  v.voiceNote || '',
      decidedAt:  v.decidedAt,
      archivedAt: now,
    });
  }
  if (histEntries.length) await putHistoryBatch(histEntries);
}

// Called only AFTER a deck's results are confirmed sent AND the hold
// (hold period over). Wipe the deck off this device so storage
// never fills up: tombstone the id (picker + auto-loader skip it), then delete
// the deck row, its cards (the heavy image data), and its verdicts. The
// permanent home is your own results store, never the device.
export async function purgeDeckAfterSend(deckId) {
  await markDeckSent(deckId);
  try {
    await snapshotDeckToHistory(deckId);
    const cards = await getCardsByDeck(deckId);
    await Promise.all(cards.map((c) => deleteVerdictsForCard(c.id).catch(() => {})));
    await Promise.all(cards.map((c) => deleteCard(c.id).catch(() => {})));
  } catch { /* best-effort cleanup — never block the UI */ }
  await deleteDeck(deckId).catch(() => {});
}

// ── Dismiss a deck from the picker (user-initiated) ───────────────────────────
// The user's "I'm done with this / get it off my list" action. Unlike
// purgeDeckAfterSend (which archives the decisions first), dismiss just clears the
// deck off THIS device: tombstone it so the auto-loader never re-imports it, then
// delete its cards + verdicts + notes. Returns a snapshot so an immediate Undo can
// put everything back exactly as it was.
export async function dismissDeck(deckId) {
  const [deck, cards, verdicts, notes] = await Promise.all([
    getDeck(deckId),
    getCardsByDeck(deckId),
    getVerdictsForDeck(deckId),
    getNotesByDeck(deckId),
  ]);
  await markDeckSent(deckId);   // tombstone → picker + auto-loader skip it for good
  await Promise.all(cards.map((c) => deleteVerdictsForCard(c.id).catch(() => {})));
  await Promise.all(cards.map((c) => deleteCard(c.id).catch(() => {})));
  await deleteNotesByDeck(deckId).catch(() => {});
  await deleteDeck(deckId).catch(() => {});
  return { deck, cards, verdicts, notes };
}

// Undo a dismiss: lift the tombstone and restore the deck + its cards/verdicts/
// notes from the snapshot. Best-effort; only meaningful right after a dismiss
// (the snapshot is held in memory by the view layer until the Undo toast fades).
export async function restoreDismissedDeck(snap) {
  if (!snap || !snap.deck) return;
  const sent = (await getMeta(SENT_KEY)) || {};
  delete sent[snap.deck.id];
  await setMeta(SENT_KEY, sent);
  await putDeck(snap.deck);
  if (snap.cards && snap.cards.length) await putCards(snap.cards);
  if (snap.verdicts && snap.verdicts.length) {
    const store = await tx(STORE_VERDS, 'readwrite');
    await Promise.all(snap.verdicts.map((v) => reqAsPromise(store.put(v))));
  }
  if (snap.notes && snap.notes.length) {
    const store = await tx(STORE_NOTES, 'readwrite');
    await Promise.all(snap.notes.map((n) => reqAsPromise(store.put(n))));
  }
}

// ── History (Recently Swiped archive) ────────────────────────────────────────
// Compact snapshots of verdicts that survive deck purging. Each row is one
// decided card with just enough data for a thumbnail + verdict badge + label.
// Written at purge time; the history view merges these with any still-live
// verdicts for a complete "recently swiped" picture.

export async function putHistoryBatch(entries) {
  const db = await openDB();
  const t = db.transaction(STORE_HIST, 'readwrite');
  const store = t.objectStore(STORE_HIST);
  return Promise.all(entries.map((e) => reqAsPromise(store.put(e))));
}

export async function getAllHistory() {
  const store = await tx(STORE_HIST, 'readonly');
  return reqAsPromise(store.getAll());
}

export async function clearHistory() {
  const store = await tx(STORE_HIST, 'readwrite');
  return reqAsPromise(store.clear());
}

// ── Dismiss individual Recently Swiped items (user-initiated) ────────────────
// The "clear ones I never want to see again" action on the Recently Swiped tab.
// A row there can come from the history store OR from a still-live
// verdict, so a dismissed id is tombstoned in meta (the history view always
// filters these out) AND, if a stored history row exists, it's deleted outright.
// Dismissing NEVER touches the underlying verdict — the card stays decided; it
// just leaves the showcase list.
const DISMISSED_HIST_KEY = 'dismissedHistoryIds';

export async function getDismissedHistoryIds() {
  const arr = (await getMeta(DISMISSED_HIST_KEY)) || [];
  return new Set(arr);
}

export async function dismissHistoryItem(id) {
  const set = await getDismissedHistoryIds();
  set.add(id);
  await setMeta(DISMISSED_HIST_KEY, [...set]);
  // Delete the stored row if one exists; return it so Undo can put it back.
  let removed = null;
  try { const ro = await tx(STORE_HIST, 'readonly');  removed = await reqAsPromise(ro.get(id)); } catch { /* none */ }
  try { const rw = await tx(STORE_HIST, 'readwrite'); await reqAsPromise(rw.delete(id)); }       catch { /* best-effort */ }
  return removed || null;
}

export async function restoreHistoryItem(id, entry) {
  const set = await getDismissedHistoryIds();
  set.delete(id);
  await setMeta(DISMISSED_HIST_KEY, [...set]);
  if (entry) { try { await putHistoryBatch([entry]); } catch { /* non-fatal */ } }
}

// Expire history entries older than `maxAgeMs`. Called at boot so the device
// doesn't accumulate stale thumbnails forever — this is a
// showcase feature, not a permanent archive.
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days after the live deck is gone

export async function expireOldHistory() {
  const cutoff = new Date(Date.now() - HISTORY_MAX_AGE_MS).toISOString();
  const [all, decks] = await Promise.all([getAllHistory(), getAllDecks()]);
  const live = new Set(decks.map((d) => d.id));
  // Live finished decks stay on Recently Swiped until
  // the hold period ends. Do not age out their snapshots while they exist.
  const stale = all.filter((h) => {
    if (live.has(h.deckId)) return false;
    return (h.archivedAt || h.decidedAt || '') < cutoff;
  });
  if (!stale.length) return;
  const store = await tx(STORE_HIST, 'readwrite');
  await Promise.all(stale.map((h) => reqAsPromise(store.delete(h.id))));
}

// ── Reset (dev / settings) ──────────────────────────────────────────────────

export async function resetAll() {
  const db = await openDB();
  const t  = db.transaction(
    [STORE_DECKS, STORE_CARDS, STORE_VERDS, STORE_META, STORE_NOTES, STORE_HIST],
    'readwrite'
  );
  await Promise.all([
    reqAsPromise(t.objectStore(STORE_DECKS).clear()),
    reqAsPromise(t.objectStore(STORE_CARDS).clear()),
    reqAsPromise(t.objectStore(STORE_VERDS).clear()),
    reqAsPromise(t.objectStore(STORE_META).clear()),
    reqAsPromise(t.objectStore(STORE_NOTES).clear()),
    reqAsPromise(t.objectStore(STORE_HIST).clear()),
  ]);
}
