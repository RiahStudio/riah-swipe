---
name: riah-swipe
description: Review decks on a Riah Swipe board and record keep / revise / discard verdicts. Use when the user says "swipe", "what's on the board", "open deck X", "mark that as cut", or asks what is still waiting for review.
---

# Riah Swipe (via the `riah-swipe` MCP server)

A Swipe board is where a person judges generated batches: one **deck** = one batch,
one **card** = one thing to judge (image variant, script page, take, option, tagline).
Every card gets exactly one verdict: **keep** (approved) · **revise** (partially right,
needs another pass) · **discard** (cut).

## Tools

| tool | use it for |
|---|---|
| `swipe_board` | first call: every deck with cards / decided / waiting, most-waiting first |
| `swipe_decks` | list decks — filter by `project`, or `only_undecided: true` |
| `swipe_deck` | open one deck with its cards (ids, titles, media, existing verdicts) |
| `swipe_next_card` | the next card still waiting — walk a deck card by card |
| `swipe_record_verdict` | record `deck_id`, `card_id`, `decision`, optional `note` |
| `swipe_results` | build the `riah-swipe.results/1` payload; `file: true` also writes it to disk |

## Running a session

1. `swipe_board` → tell the user what is actually waiting (deck name, cards left), not a wall of ids.
2. Pick the deck they name, or the one with the most remaining.
3. `swipe_next_card`; describe the card in plain language (title, what it is; for media give
   the `mediaUrl`/path so they can look). Never invent what a card shows — if it only has a
   title/preview, say so and ask.
4. Record what the user says with `swipe_record_verdict`. Put their words in `note` verbatim.
5. Continue to the next card; when a deck is empty, offer `swipe_results` (`file: true`).

## Rules

- **Never record a verdict the user did not give.** Describe, ask, then record. Never map "maybe" to keep.
- **Latest verdict per card wins** — re-recording overwrites. That matches the board.
- The verdict store is `<root>/data/verdicts/<deck>.json`, shared with the board server.
- Read-only questions ("what did I keep in deck X?") need no writes: `swipe_deck` returns verdicts.
- A wrong deck id returns the known ids — use them, don't guess.
