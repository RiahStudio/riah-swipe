# Deck format

A deck is one batch: one project, one kind of decision, reviewed in one sitting. Decks live in
`<root>/decks/*.swipe.json`; media sits beside them in `<root>/decks/`. New files show up on reload.

```json
{
  "decks": [{
    "id": "poster-round-2",
    "name": "Poster, round 2 (6 variants)",
    "source": "my-poster-pipeline",
    "kind": "image",
    "note": "Round 1 notes applied: warmer palette, bigger title.",
    "selectingFor": "the one-sheet we print",
    "returnTo": "poster-pipeline",
    "rev": 1
  }],
  "cards": [{
    "id": "poster-r2-a",
    "deckId": "poster-round-2",
    "title": "Variant A: dawn palette",
    "kind": "image",
    "media": "decks/poster-round-2/a.png",
    "caption": "Warmer, per your round-1 note",
    "preview": "Longer context if the reviewer needs it.",
    "tag": "round 2",
    "meta": { "outFile": "renders/a.png", "seed": 41 }
  }]
}
```

## Deck fields

`id`, `name` required. Optional: `source` (project), `kind`, `note`, `description`, `selectingFor`,
`returnTo`, `accent` (hex colour), `createdAt` (ISO time), `rev`.

## Card fields

`id`, `deckId`, `title` required. Ids use letters, digits, `.`, `_`, `-` (max 128 chars).

| Field | Meaning |
|---|---|
| `kind` | `image`, `video`, `audio`, `text`, `script`, `line`, `chapter`, `logline`. Unknown kinds render as text. |
| `media` | Path relative to the root (`decks/<deck>/x.png`) or a data URI. For video, `{ "src", "poster", "mime" }`. |
| `preview`, `caption`, `tag` | Extra text shown with the card. |
| `meta` | Free-form JSON, returned untouched in the results (file paths, seeds, shot ids). |

### Card kinds

- **image**: `media` is an image path or data URI.
- **video**: `media` is `{ "src": "decks/x/take1.mp4", "poster": "decks/x/take1.jpg", "mime": "video/mp4" }`.
- **audio**: `media` is an audio file; put the spoken line in `preview`.
- **text** (`text`, `script`, `line`, `chapter`, `logline`): no media; `title` and `preview` carry the content.

A beat sheet is one card with all its beats; a full script is one card per page; media batches are
one asset per card.

## Revisions

Re-publish a deck with a higher `rev` and the board replaces the old copy, discarding stale cards
and verdicts. Decks without `rev` are never touched once imported.

See `examples/sample/decks/` for a working image deck (three Captain Mullet shirt designs).
