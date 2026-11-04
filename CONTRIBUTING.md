# Contributing

Thanks for helping. This is a small, dependency-free project; please keep it that way.

## Setup

```bash
git clone https://github.com/RiahStudio/riah-swipe.git && cd riah-swipe
npm test         # Node 18+; no install step needed
npm start        # board on http://127.0.0.1:8137
```

## Guidelines

- **No runtime dependencies** in `server/` or `board/` without a strong reason (open an issue first).
- Board UI: vanilla ES modules, no build step. CSS class names are shared between
  `board/styles/app.css`, `board/src/swipe-view.js` and `board/src/app.js` — rename in all three.
- Server: every path built from a request or a deck id must be validated (see `SAFE_ID` and
  `serveFile`). Add a test for new endpoints in `test/`.
- Never commit real decks, verdicts (`data/`), tokens, `.env` files, or personal paths. Use
  generic content for samples.
- If you change the MCP tools, update `README.md` and `skills/riah-swipe/SKILL.md`.
- Keep PRs focused; describe how you tested the change (`npm test` plus a manual swipe session
  for UI changes).

## Reporting bugs and security issues

Bugs: open an issue with steps to reproduce, Node version and browser. Security issues: see
[SECURITY.md](SECURITY.md) — please don't file them publicly.

By contributing you agree your contributions are licensed under the MIT License.
