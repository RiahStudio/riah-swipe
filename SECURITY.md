# Security Policy

## Reporting a vulnerability

Please report privately via GitHub's **"Report a vulnerability"** (Security → Advisories) on this
repository. Include steps to reproduce and impact. Expect an acknowledgement within a week.
Please don't open a public issue for security problems.

## Threat model and defaults

Riah Swipe is a **local tool**. Out of the box:

- The server binds to `127.0.0.1` only.
- The board has **no authentication**. Anyone who can reach the port can read decks/media and write
  verdicts. If you use `--host 0.0.0.0`, a tunnel, or a reverse proxy, put it behind your own auth.
- `POST /api/swipe-results` rejects cross-origin browser requests (Origin must match Host) and
  invalid ids; request bodies are size-capped. Only `<root>/decks/` and `board/` are served — never
  `<root>/data/`.
- The MCP endpoint (`POST /mcp`) accepts an optional bearer token via `SWIPE_MCP_TOKEN`. **Set one**
  if anything other than you can reach the server. Tokens are accepted only in the
  `Authorization` header, never in URLs.
- The MCP tools can read every deck under `<root>/decks/` and write under `<root>/data/`; nothing else.
- Don't put secrets in deck files; deck content is served verbatim to the browser.
