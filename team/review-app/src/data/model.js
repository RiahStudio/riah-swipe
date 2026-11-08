// src/data/model.js
// Data layer — pure types, factories, and small invariants. No DOM, no storage.
//
// Mental model:
//   • A DECK is one batch of homogeneous things to review in a single sitting —
//     "Hero pose v3 — 6 variants", "Episode 12 monologue — 5 jokes", "Logo
//     round 2 — 4 marks". One project + one kind of decision, end to end.
//   • A CARD is one item inside one deck. Cards never live outside a deck.
//   • A VERDICT is the reviewer's keep/revise/discard decision on one card.
//     Append-only. ("revise" = partially right, needs another pass.)
//   • KIND is what shape the card's payload has — image / video / audio /
//     script / line / text. The swipe surface renders a different body per
//     kind. Decks are typically a single kind end-to-end so the swipe-through
//     feels rhythmic.
//
// This file implements the public deck spec (riah-swipe.deck/1). Registries
// (KIND, VERDICT) grow only when a fundamentally new content shape or decision
// shape appears; unknown kinds ALWAYS degrade to text so a deck never fails to
// load just because it was labeled with a kind this version doesn't know.

export const KIND = Object.freeze({
  TEXT:    'text',
  IMAGE:   'image',
  VIDEO:   'video',
  AUDIO:   'audio',
  SCRIPT:  'script',
  LINE:    'line',
  CHAPTER: 'chapter',   // long prose — script-shaped body
  LOGLINE: 'logline',   // pitches / one-liners — text-shaped body
});

export const KINDS = Object.freeze([
  KIND.TEXT, KIND.IMAGE, KIND.VIDEO, KIND.AUDIO, KIND.SCRIPT, KIND.LINE,
  KIND.CHAPTER, KIND.LOGLINE,
]);

export const VERDICT = Object.freeze({
  KEEP:    'keep',
  REVISE:  'revise',   // "partially right, needs another pass"
  DISCARD: 'discard',
});

export const VERDICTS = Object.freeze([VERDICT.KEEP, VERDICT.REVISE, VERDICT.DISCARD]);

// Deck factory. Required: id, name. Everything else optional.
export function makeDeck({
  id, name,
  source       = '',   // upstream project/tool that generated this batch
  kind         = KIND.TEXT,
  accent       = '#5ba0d9',
  note         = '',   // one-line context shown in the picker
  description  = '',   // friendly blurb shown atop the review
  selectingFor = '',   // what the reviewer is choosing — "the cover for ch. 3"
  returnTo     = '',   // opaque routing hint echoed into the results file
  rev          = 0,    // bump to republish a corrected deck (see deck-loader)
} = {}) {
  if (!id)   throw new Error('makeDeck: id is required');
  if (!name) throw new Error('makeDeck: name is required');
  if (!KINDS.includes(kind)) kind = KIND.TEXT;   // unknown kind → still loads
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
    rev:          Number(rev) || 0,
    createdAt:    new Date().toISOString(),
  };
}

// Card factory. Required: id, deckId, title.
// media shape by kind:
//   image  → string URL or data URI
//   video  → { src, poster, mime } — any field optional; poster-only OK
//   audio  → string URL or { src, mime }
//   script → string (full body, plain text / simple markdown)
//   line   → unused (the line itself is `title`)
//   text   → unused
export function makeCard({
  id, deckId, title,
  kind    = KIND.TEXT,
  media   = null,
  preview = '',     // longer notes/context blurb under the media
  caption = '',     // clean short "top text" shown ABOVE the media
  tag     = '',
  meta    = null,   // opaque sidecar payload echoed into the results file
                    // (e.g. { character, shot, outFile }); the app ignores it
} = {}) {
  if (!id)     throw new Error('makeCard: id is required');
  if (!deckId) throw new Error('makeCard: deckId is required');
  if (!title)  throw new Error('makeCard: title is required');
  if (!KINDS.includes(kind)) kind = KIND.TEXT;   // unknown kind → still loads
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

// Verdict factory. cardId required; deckId recorded for fast per-deck filtering.
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
    thumb:     String(thumb || ''),      // tiny image data-URI captured at decision time
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
