// board/src/data/model.js
// Data layer — pure types, factories, and small invariants. No DOM, no storage.
//
// Mental model:
//   • A DECK is one batch of homogeneous things to review in a single sitting.
//     "Poster round 3 — 6 variants" is a deck. "Podcast intro
//     take 2 — 5 lines" is a deck. "Product demo take 4 — 3 cuts" is a
//     deck. The whole deck is one project + one kind of decision.
//   • A CARD is one item inside one deck. Cards never live outside a deck.
//   • A VERDICT is the user's keep/revise/discard decision on one card.
//     Append-only. ("revise" = partially right, needs another pass.)
//   • KIND is what shape the card's payload has — image / video / script /
//     line / text. The swipe surface renders a different body per kind. Decks
//     are typically a single kind end-to-end (all variants of an image, all
//     options for a line) so the swipe-through feels rhythmic.
//
// Registries (KIND, VERDICT) grow only when a fundamentally new content shape
// or decision shape appears.

export const KIND = Object.freeze({
  TEXT:    'text',
  IMAGE:   'image',
  VIDEO:   'video',
  AUDIO:   'audio',
  SCRIPT:  'script',
  LINE:    'line',
  CHAPTER: 'chapter',   // book chapters — script-shaped body
  LOGLINE: 'logline',   // loglines / character-type pitches — text/script-shaped body
});

export const KINDS = Object.freeze([
  KIND.TEXT, KIND.IMAGE, KIND.VIDEO, KIND.AUDIO, KIND.SCRIPT, KIND.LINE,
  KIND.CHAPTER, KIND.LOGLINE,
]);

export const VERDICT = Object.freeze({
  KEEP:    'keep',
  REVISE:  'revise',   // "partially right, needs another pass" — routes back to the
                       // department for revision. Replaces the old "shelve" verdict.
  DISCARD: 'discard',
});

export const VERDICTS = Object.freeze([VERDICT.KEEP, VERDICT.REVISE, VERDICT.DISCARD]);

// Deck factory. Required: id, name. Optional: source (upstream project),
// kind (the dominant kind in this deck — drives picker iconography), accent
// (palette tint), note (one-line context shown in the picker).
export function makeDeck({
  id, name,
  source       = '',
  kind         = KIND.TEXT,
  accent       = '#5ba0d9',
  note         = '',
  description  = '',   // a friendly, plain-English blurb shown atop the review
  selectingFor = '',   // what the user is choosing — e.g. "the voice for each character"
  returnTo     = '',   // department to route results back to (defaults to source)
  review       = '',   // '' / 'swipe' = keep/cut surface; 'notes' = Studio Notes (read in order, note each)
  createdAt    = '',   // arrival time from the published JSON
} = {}) {
  if (!id)   throw new Error('makeDeck: id is required');
  if (!name) throw new Error('makeDeck: name is required');
  // Unknown / brand-new kind → degrade to text so the deck STILL LOADS. A deck
  // must never silently vanish just because a department labeled it with a kind
  // the app doesn't know yet.
  if (!KINDS.includes(kind)) kind = KIND.TEXT;
  return {
    id:           String(id),
    name:         String(name),
    source:       String(source),
    kind,
    accent:       String(accent),
    note:         String(note),
    description:  String(description),
    selectingFor: String(selectingFor),
    returnTo:     String(returnTo || source),
    review:       String(review),
    createdAt:    String(createdAt || ''),
  };
}

// Card factory. Required: id, deckId, title. Optional kind/media/preview/tag.
// media shape by kind:
//   image  → string URL or data URI
//   video  → { src, poster, mime } — any field optional; poster-only OK
//   script → string (full body, plain text / simple markdown)
//   line   → unused (the line itself is `title`)
//   text   → unused
export function makeCard({
  id, deckId, title,
  kind    = KIND.TEXT,
  media   = null,
  preview = '',
  caption = '',     // clean short "top text" shown ABOVE the media (image/video
                    // decks). The prominent context line — distinct from `preview`
                    // (the long TAKE/notes blurb). Carried through to IndexedDB.
  tag     = '',
  meta    = null,   // sidecar payload for routing the verdict back to the sender
                    // (e.g. { character, voice, outFile, shot }). Swipe ignores it.
} = {}) {
  if (!id)     throw new Error('makeCard: id is required');
  if (!deckId) throw new Error('makeCard: deckId is required');
  if (!title)  throw new Error('makeCard: title is required');
  // Unknown / brand-new kind → degrade to text so the card STILL LOADS (the
  // body renderer already falls back to a text card for unknown kinds).
  if (!KINDS.includes(kind)) kind = KIND.TEXT;
  return {
    id:        String(id),
    deckId:    String(deckId),
    title:     String(title),
    kind,
    media,
    preview:   String(preview),
    caption:   String(caption || ''),
    tag:       String(tag),
    meta:      meta && typeof meta === 'object' ? meta : null,
    createdAt: new Date().toISOString(),
  };
}

// Verdict factory. cardId is required; deckId optional but recorded for fast
// per-deck filtering of the audit trail later.
export function makeVerdict({ cardId, deckId = '', decision, note = '', voiceNote = '', thumb = '' } = {}) {
  if (!cardId) throw new Error('makeVerdict: cardId is required');
  if (!VERDICTS.includes(decision)) {
    throw new Error(`makeVerdict: decision must be one of ${VERDICTS.join(', ')}`);
  }
  return {
    id:        `${cardId}:${Date.now()}`,
    cardId:    String(cardId),
    deckId:    String(deckId),
    decision,
    note:      String(note),
    voiceNote: String(voiceNote || ''),  // audio data-URI of a recorded note, if any
    thumb:     String(thumb || ''),      // tiny image data-URI captured on KEEP — the
                                         // approved-thumbnail archive;
    decidedAt: new Date().toISOString(),
  };
}

export function isCard(x) {
  return !!x
    && typeof x.id     === 'string'
    && typeof x.deckId === 'string'
    && typeof x.title  === 'string'
    && (x.kind === undefined || KINDS.includes(x.kind));
}

export function isDeck(x) {
  return !!x
    && typeof x.id   === 'string'
    && typeof x.name === 'string'
    && (x.kind === undefined || KINDS.includes(x.kind));
}

