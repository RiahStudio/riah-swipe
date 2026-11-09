// src/logic/deck-sort.js
// How the picker orders decks. Newest-first is the default: a just-published batch
// lands on top, using the deck's real arrival clock. List position is only a
// tie-breaker — tacking a file onto the end of index.json cannot bury it.

export const DECK_SORT = Object.freeze({
  NEWEST: 'newest',
  OLDEST: 'oldest',
  NAME:   'name',
});

export const DECK_SORTS = Object.freeze([
  DECK_SORT.NEWEST,
  DECK_SORT.OLDEST,
  DECK_SORT.NAME,
]);

export const DECK_SORT_DEFAULT = DECK_SORT.NEWEST;

export function normalizeDeckSort(value) {
  return DECK_SORTS.includes(value) ? value : DECK_SORT_DEFAULT;
}

function createdKey(deck) {
  return String((deck && deck.createdAt) || '');
}

// Import used to stamp catalog position as 2099-01-01 minus N seconds,
// which rolls into 2098 for later rows. Those are not real arrival times.
export function isFakeListedStamp(iso) {
  const year = new Date(iso).getUTCFullYear();
  return Number.isFinite(year) && year >= 2098;
}

function arrivalTime(deck) {
  const iso = createdKey(deck);
  if (!iso || isFakeListedStamp(iso)) return '';
  return iso;
}

function nameKey(deck) {
  return String((deck && deck.name) || (deck && deck.id) || '');
}

function idKey(deck) {
  return String((deck && deck.id) || '');
}

function deckOf(item) {
  return (item && item.deck) ? item.deck : item;
}

function catalogRank(deck, ranks) {
  if (!ranks || !ranks.size) return null;
  const id = idKey(deck);
  if (ranks.has(id)) return ranks.get(id);
  const base = id.replace(/__r\d+$/, '');
  if (ranks.has(base)) return ranks.get(base);
  return null;
}

function compareIso(ta, tb, oldest) {
  if (ta && tb && ta !== tb) return oldest ? ta.localeCompare(tb) : tb.localeCompare(ta);
  if (ta && !tb) return oldest ? 1 : -1;
  if (!ta && tb) return oldest ? -1 : 1;
  return 0;
}

// Stable sort of picker rows (or raw decks).
//
// Newest / Oldest follow real arrival time first . Catalog order
// (index 0 = newest) is the tie-breaker for decks
// with no real clock. A deck not in the catalog yet still counts as newest.
export function sortDeckItems(items, order = DECK_SORT_DEFAULT, catalogOrder = []) {
  const list = Array.isArray(items) ? items.slice() : [];
  const sort = normalizeDeckSort(order);
  const oldest = sort === DECK_SORT.OLDEST;
  const ranks = new Map();
  if (Array.isArray(catalogOrder)) {
    catalogOrder.forEach((id, i) => {
      if (id) ranks.set(String(id), i);
    });
  }
  list.sort((a, b) => {
    const da = deckOf(a);
    const db = deckOf(b);
    if (sort === DECK_SORT.NAME) {
      const byName = nameKey(da).localeCompare(nameKey(db), undefined, { sensitivity: 'base' });
      return byName || idKey(da).localeCompare(idKey(db));
    }
    const byDate = compareIso(arrivalTime(da), arrivalTime(db), oldest);
    if (byDate) return byDate;
    const ra = catalogRank(da, ranks);
    const rb = catalogRank(db, ranks);
    if (ra !== null || rb !== null) {
      const na = ra === null ? -1 : ra;
      const nb = rb === null ? -1 : rb;
      if (na !== nb) return oldest ? nb - na : na - nb;
    }
    const byId = idKey(da).localeCompare(idKey(db));
    return oldest ? byId : -byId;
  });
  return list;
}
