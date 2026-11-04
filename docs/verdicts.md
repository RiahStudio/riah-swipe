# Verdicts and results

Each card gets one verdict:

| Decision | In the UI | Meaning |
|---|---|---|
| `keep` | Yes (swipe right) | approved |
| `revise` | Partially right | needs another pass; add a note |
| `discard` | No (swipe left) | cut |

Any verdict can carry a text note. Swipes can be undone before the deck is finished.

## Where they are saved

- `<root>/data/verdicts/<deck>.json`: written after every swipe (the board pushes to the server).
- `<root>/data/results/<deck>.results.json`: written when the deck is finished, or on demand via MCP `swipe_results` with `file: true`.
- `GET /api/verdicts/<deck>` returns the stored verdicts. `data/` is never served as static files.

## Results format (`riah-swipe.results/1`)

```json
{ "schema": "riah-swipe.results/1", "batchId": "poster-round-2", "deckName": "…",
  "decidedCount": 1, "cardCount": 6,
  "results": [{ "cardId": "poster-r2-a", "title": "…", "decision": "keep",
                "approved": true, "revised": false, "note": "", "decidedAt": "…" }] }
```

A pipeline can watch `data/results/`: file the `keep`s, regenerate the `discard`s, and apply the
note on every `revise`.

Limitation: a verdict recorded through MCP is stored on the server but is not pulled back into an
already-open browser's local state.
