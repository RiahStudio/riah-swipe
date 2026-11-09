// board/src/data/deck-loader.js
// Auto-load deck batches so they appear in the picker with no manual import. On
// startup the app reads `decks/index.json` ({ batches: [file, ...] }, newest
// first), fetches each batch ({ decks, cards }), and imports any deck whose id
// isn't already in the store.
//
// Idempotent by deck id: a deck already present is skipped, so verdicts and
// progress are never wiped by a reload.
//
// Republishing a corrected deck: give the deck a `rev` number (1, 2, ...). When a
// deck's `rev` is higher than the one already imported, the stale deck is
// REPLACED in place (its old cards + verdicts are dropped, the fixed cards come
// in). If the reviewer has already started deciding the old deck, the revision
// arrives as a SEPARATE deck instead so their picks and notes survive.
// Decks without a `rev` (or rev 0) are never touched once imported.
//
// Safe on file:// (no server): the manifest fetch fails quietly and the app
// falls back to whatever is already in IndexedDB.

import {
  getDeck, putDeck, putCards,
  getMeta, setMeta, getCardsByDeck, deleteCard, deleteVerdictsForCard, deleteDeck,
  deleteNotesByDeck, getVerdictsForDeck, getNotesByDeck,
} from './store.js';
import { makeDeck, makeCard } from './model.js';

const MANIFEST_URL = 'decks/index.json';
const REVS_KEY = 'deckRevs';   // { [deckId]: importedRev }

function batchFiles(manifest) {
  const entries = Array.isArray(manifest) ? manifest : ((manifest && manifest.batches) || []);
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.file))
    .filter(Boolean);
}

function fileStem(file) {
  return String(file).replace(/\.swipe\.json$/i, '');
}

// Live cache of the batch order (index 0 = newest).
let cachedCatalogOrder = null;

export async function fetchCatalogOrder() {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return cachedCatalogOrder || [];
    const manifest = await res.json();
    cachedCatalogOrder = batchFiles(manifest).map(fileStem);
    return cachedCatalogOrder;
  } catch {
    return cachedCatalogOrder || [];
  }
}

export async function loadBundledDecks() {
  let manifest;
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return { loaded: 0, skipped: 0, cards: 0, retired: [] };
    manifest = await res.json();
  } catch {
    // No manifest reachable (e.g. opened from file://) — nothing to load.
    return { loaded: 0, skipped: 0, cards: 0, retired: [] };
  }

  // Decks the user already finished + sent are tombstoned. A tombstoned deck is
  // only brought back when a NEWER revision arrives; otherwise it stays gone.
  const sentMap = (await getMeta('sentDeckIds')) || {};
  let sentDirty = false;

  // Revisions already imported, so a `rev` bump can trigger a clean replace.
  const revs = (await getMeta(REVS_KEY)) || {};
  let loaded = 0, skipped = 0, cardCount = 0, revsDirty = false;

  // Fetch every batch in parallel; the import below stays sequential so the
  // shared tombstone / revision bookkeeping can't race.
  const files = batchFiles(manifest);
  cachedCatalogOrder = files.map(fileStem);
  const batches = await Promise.all(
    files.map(async (file) => {
      try {
        const res = await fetch('decks/' + file, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
      } catch (err) {
        console.warn('[Riah Swipe] skipped batch "' + file + '":', err && err.message);
        return null;
      }
    }),
  );

  for (const batch of batches) {
    if (!batch) continue;
    try {
      const decks = Array.isArray(batch.decks) ? batch.decks : [];
      const cards = Array.isArray(batch.cards) ? batch.cards : [];

      for (const d of decks) {
        if (!d || !d.id) continue;
        const bundledRev = Number(d.rev) || 0;
        const stamp = String(d.createdAt || '').trim() || new Date().toISOString();
        if (sentMap[d.id]) {
          // Finished + sent. Leave it gone UNLESS a newer revision has arrived.
          const importedRev = Number(revs[d.id]) || 0;
          if (bundledRev <= importedRev) { skipped++; continue; }
          delete sentMap[d.id]; sentDirty = true;   // lift the tombstone for the new rev
        }
        const existing = await getDeck(d.id);
        if (existing) {
          const importedRev = Number(revs[d.id]) || 0;
          if (bundledRev <= importedRev) { skipped++; continue; }
          // A newer revision arrived.
          //   - a deck the user hasn't touched: replace it quietly.
          //   - a deck they have STARTED deciding (any verdict or note): never
          //     overwrite it. Bring the revision in as a SEPARATE new deck.
          if (await deckTouched(d.id)) {
            const revId = `${d.id}__r${bundledRev}`;
            // Record the rev now so we don't fork the same revision every cycle.
            if (revs[d.id] !== bundledRev) { revs[d.id] = bundledRev; revsDirty = true; }
            if (await getDeck(revId)) { skipped++; continue; }   // already forked this rev
            await putDeck(makeDeck({ ...d, id: revId, name: `${d.name || d.id} (rev ${bundledRev})`, createdAt: stamp }));
            const revCards = cards
              .filter((c) => c && c.deckId === d.id)
              .map((c) => makeCard({ ...c, id: `${revId}:${c.id}`, deckId: revId }));
            await putCards(revCards);
            loaded++;
            cardCount += revCards.length;
            continue;
          }
          // Untouched: drop the stale deck and bring the fixed one in its place.
          await replaceDeck(d.id);
        }
        // New deck (or a just-replaced untouched one) -> import under its own id.
        await putDeck(makeDeck({ ...d, createdAt: stamp }));
        const deckCards = cards
          .filter((c) => c && c.deckId === d.id)
          .map((c) => makeCard(c));
        await putCards(deckCards);
        if (bundledRev > 0 && revs[d.id] !== bundledRev) { revs[d.id] = bundledRev; revsDirty = true; }
        loaded++;
        cardCount += deckCards.length;
      }
    } catch (err) {
      console.warn('[Riah Swipe] skipped a batch during import:', err && err.message);
    }
  }

  if (revsDirty) { try { await setMeta(REVS_KEY, revs); } catch { /* non-fatal */ } }
  if (sentDirty) { try { await setMeta('sentDeckIds', sentMap); } catch { /* non-fatal */ } }
  if (loaded) console.log(`[Riah Swipe] auto-loaded ${loaded} deck(s), ${cardCount} card(s).`);
  return { loaded, skipped, cards: cardCount, retired: [] };
}

// Has the reviewer started deciding this deck? Any verdict OR any note counts as
// "touched", and a touched deck is never overwritten by a revision.
async function deckTouched(deckId) {
  try { const v = await getVerdictsForDeck(deckId); if (v && v.length) return true; } catch { /* ignore */ }
  try { const n = await getNotesByDeck(deckId);    if (n && n.length) return true; } catch { /* ignore */ }
  return false;
}

// Replace a deck already in the store: drop its verdicts, then its cards, then
// the deck row, so a corrected re-import starts clean. Best-effort.
async function replaceDeck(id) {
  try {
    const old = await getCardsByDeck(id);
    await Promise.all(old.map((c) => deleteVerdictsForCard(c.id).catch(() => {})));
    await Promise.all(old.map((c) => deleteCard(c.id).catch(() => {})));
  } catch { /* leave orphans rather than fail the import */ }
  await deleteNotesByDeck(id).catch(() => {});
  await deleteDeck(id).catch(() => {});
}
