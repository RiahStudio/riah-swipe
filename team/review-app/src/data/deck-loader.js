// src/data/deck-loader.js
// Auto-load deck batches from the workspace `decks/` folder so new batches
// appear in the picker with no manual step. On startup the app reads
// `decks/index.json` (the manifest), fetches each batch ({ decks, cards }),
// and imports any deck whose id isn't already in the store.
//
// Idempotent by deck id: a deck already present is skipped, so verdicts and
// progress are never wiped by a reload. Drop a new <batch>.swipe.json in
// decks/, add its filename to decks/index.json (or let the `riah-swipe add`
// helper do it), refresh — it shows up.
//
// Republishing a corrected deck: give the deck a `rev` number (1, 2, …). When
// a bundled deck's `rev` is higher than the one already imported:
//   • a deck the reviewer hasn't touched → replaced quietly in place.
//   • a deck they've STARTED deciding → NEVER overwritten. The revision comes
//     in as a SEPARATE new deck ("… (rev 2)") so their picks + notes survive.
//
// Retiring a deck: list its id in the manifest's `retired` array — it purges
// off every device that loads the manifest, even mid-review.

import {
  getDeck, putDeck, putCards, getMeta, setMeta,
  getCardsByDeck, deleteCard, deleteVerdictsForCard, deleteDeck,
  getVerdictsForDeck,
} from './store.js';
import { makeDeck, makeCard } from './model.js';

const MANIFEST_URL = 'decks/index.json';
const REVS_KEY = 'deckRevs';   // { [deckId]: importedRev }

export async function loadBundledDecks() {
  let manifest;
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return { loaded: 0, skipped: 0, cards: 0 };
    manifest = await res.json();
  } catch {
    return { loaded: 0, skipped: 0, cards: 0 };   // server down → whatever's in IndexedDB
  }

  const entries = Array.isArray(manifest) ? manifest : (manifest.batches || []);
  const sentMap = (await getMeta('sentDeckIds')) || {};
  let sentDirty = false;

  // Retired decks: purge + tombstone so a stale bundle can't resurrect them.
  const retired = Array.isArray(manifest) ? [] : (Array.isArray(manifest.retired) ? manifest.retired : []);
  for (const id of retired) {
    if (typeof id !== 'string' || !id) continue;
    try {
      if (await getDeck(id)) await replaceDeck(id);
      if (!sentMap[id]) { sentMap[id] = true; sentDirty = true; }
    } catch { /* best-effort — never block the load */ }
  }

  const revs = (await getMeta(REVS_KEY)) || {};
  let loaded = 0, skipped = 0, cardCount = 0, revsDirty = false;

  // Fetch every batch in parallel; import sequentially so the shared
  // tombstone/revision bookkeeping can't race.
  const files = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.file))
    .filter(Boolean);
  const batches = await Promise.all(
    files.map(async (file) => {
      try {
        const res = await fetch('decks/' + file, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
      } catch (err) {
        console.warn('[Swipe] skipped batch "' + file + '":', err && err.message);
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
        if (sentMap[d.id]) {
          // Finished + sent. Stays gone UNLESS a newer revision arrived.
          const importedRev = Number(revs[d.id]) || 0;
          if (bundledRev <= importedRev) { skipped++; continue; }
          delete sentMap[d.id]; sentDirty = true;   // lift the tombstone for the new rev
        }
        if (await getDeck(d.id)) {
          const importedRev = Number(revs[d.id]) || 0;
          if (bundledRev <= importedRev) { skipped++; continue; }
          if (await deckTouched(d.id)) {
            // Started deck → never overwrite; fork the revision alongside it.
            const revId = `${d.id}__r${bundledRev}`;
            if (revs[d.id] !== bundledRev) { revs[d.id] = bundledRev; revsDirty = true; }
            if (await getDeck(revId)) { skipped++; continue; }
            await putDeck(makeDeck({ ...d, id: revId, name: `${d.name || d.id} (rev ${bundledRev})` }));
            const revCards = cards
              .filter((c) => c && c.deckId === d.id)
              .map((c) => makeCard({ ...c, id: `${revId}:${c.id}`, deckId: revId }));
            await putCards(revCards);
            loaded++;
            cardCount += revCards.length;
            continue;
          }
          await replaceDeck(d.id);   // untouched → swap in the fix quietly
        }
        await putDeck(makeDeck(d));
        const deckCards = cards
          .filter((c) => c && c.deckId === d.id)
          .map((c) => makeCard(c));
        await putCards(deckCards);
        if (bundledRev > 0 && revs[d.id] !== bundledRev) { revs[d.id] = bundledRev; revsDirty = true; }
        loaded++;
        cardCount += deckCards.length;
      }
    } catch (err) {
      console.warn('[Swipe] skipped a batch during import:', err && err.message);
    }
  }

  if (revsDirty) { try { await setMeta(REVS_KEY, revs); } catch { /* non-fatal */ } }
  if (sentDirty) { try { await setMeta('sentDeckIds', sentMap); } catch { /* non-fatal */ } }
  return { loaded, skipped, cards: cardCount };
}

// Has the reviewer started deciding this deck? Any verdict counts as touched —
// and a touched deck is never overwritten by a revision.
async function deckTouched(deckId) {
  try { const v = await getVerdictsForDeck(deckId); if (v && v.length) return true; } catch { /* ignore */ }
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
  await deleteDeck(id).catch(() => {});
}
