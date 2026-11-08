<p align="center"><img src="brand/logo-512.png" alt="Riah Swipe" width="120"></p>

# Riah Swipe

**The review gate for AI-generated work. Swipe the batch, ship the keeper.**

**[Try the live demo →](https://riahstudio.com/riahswipe)** (clickable, no install) · More: [riahstudio.com](https://riahstudio.com)

An AI tool can make forty versions of a poster, tagline or voice line in a minute. Picking the
good ones is the slow part. Riah Swipe turns that into a card stack: drop a batch in as a
**deck**, then swipe each **card**:

**Yes** (keep) · **Partially right** (revise, with a note) · **No** (discard)

Verdicts are saved as plain JSON, and an **MCP server** lets Claude Code, Codex, Hermes, or any
MCP client read the board and record verdicts too. Free, MIT-licensed, zero runtime dependencies.

## Why

- Reviewing 40 images in a chat window is miserable; swiping them takes a minute.
- The result is structured (`keep` / `revise` / `discard` plus a note per card), so a pipeline or
  agent can act on it: file the keepers, regenerate the discards, apply the notes.
- It closes the loop: agent generates a batch → publishes a deck → you swipe → agent reads the
  results → next round is better.

## Features

- Cards for **image, video, audio and text** (plus `script`, `line`, `chapter`, `logline`).
- Swipe or tap; undo; a revision note on any verdict.
- Decks are plain `*.swipe.json` files plus media, so anything that can write JSON can publish one.
- Results are plain JSON on your disk. Nothing is uploaded anywhere.
- MCP server (stdio or HTTP) with six tools, and a drop-in agent skill.
- Installable PWA; works on a phone browser on your network.
- Republish a corrected deck by bumping its `rev`.

## How it works

1. **Something produces a batch**: an agent, a script, or you. It writes a deck file and media into `decks/`.
2. **You swipe** on desktop or phone. Right to keep, left to discard, revise when it's almost there.
3. **The result comes back** as `data/results/<deck>.results.json` (or via MCP `swipe_results`), ready for the next step.

## Use cases

Logo or poster directions · merch designs · taglines and scripts · video takes · voice-line reads ·
game art · any "pick the best of N" step in an AI pipeline.

## Quick start

Requires Node.js 18+.

```bash
git clone https://github.com/RiahStudio/riah-swipe.git
cd riah-swipe
npm start            # board at http://127.0.0.1:8137 with a sample deck
```

Open <http://127.0.0.1:8137>, pick a deck, and swipe (or use the Yes / Partially right / No buttons).
Every verdict is written to `<root>/data/verdicts/<deck>.json` as you go; finishing a deck also
writes `<root>/data/results/<deck>.results.json`.

Use your own decks:

```bash
npm start -- --root ~/my-swipe-decks --port 8137     # or SWIPE_ROOT=... npm start
```

`<root>` is any folder with a `decks/` directory (created if missing). Put `*.swipe.json` files
and their media in `decks/`; new files show up on reload. Runtime verdicts land in `<root>/data/`.

Run the tests: `npm test`.

## Docs

- [Deck format](docs/deck-format.md): decks, cards, kinds, media, revisions
- [Verdicts and results](docs/verdicts.md): what gets saved and where
- [MCP server and agent use](docs/mcp.md): tools, setup, HTTP mode
- [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## Deck format

`decks/<name>.swipe.json` holds one or more decks and their cards:

```json
{
  "decks": [{
    "id": "logo-directions-01",
    "name": "Logo directions, round 1",
    "source": "Brand kit",
    "kind": "image",
    "note": "One line shown in the picker.",
    "selectingFor": "one direction to take forward",
    "rev": 1
  }],
  "cards": [{
    "id": "logo-directions-01-a",
    "deckId": "logo-directions-01",
    "title": "Direction A",
    "kind": "image",
    "media": "decks/logo-directions-01/a.png",
    "preview": "Longer description or prompt shown with the card."
  }]
}
```

- **Deck**: `id` and `name` required. Optional: `source` (project), `kind`, `note`, `description`,
  `selectingFor`, `returnTo`, `accent` (hex colour), `createdAt` (ISO time), `rev`.
- **Card**: `id`, `deckId`, `title` required. `kind` is one of `text`, `image`, `video`, `audio`,
  `script`, `line`, `chapter`, `logline` (unknown kinds fall back to `text`). Optional: `media`
  (a path relative to the root such as `decks/<deck>/x.png`, or a data URI; for video
  `{ "src", "poster", "mime" }`), `preview`, `caption`, `tag`, `meta` (free-form JSON passed
  back untouched in results).
- **Revisions**: re-publish a deck with a higher `rev` and the board replaces the old copy,
  discarding stale cards and verdicts. Decks without `rev` are never touched once imported.
- Ids may use letters, digits, `.`, `_`, `-` (max 128 chars).

See `examples/sample/decks/` for a working image deck (three Captain Mullet shirt designs).

### Results format (`riah-swipe.results/1`)

What the board POSTs to `/api/swipe-results` and `swipe_results` returns:

```json
{ "schema": "riah-swipe.results/1", "batchId": "logo-directions-01", "deckName": "…",
  "decidedCount": 1, "cardCount": 4,
  "results": [{ "cardId": "…", "title": "…", "decision": "keep|revise|discard",
                "approved": true, "revised": false, "note": "", "decidedAt": "…" }] }
```

## Use it from an agent (MCP)

The MCP server exposes six tools: `swipe_board`, `swipe_decks`, `swipe_deck`, `swipe_next_card`,
`swipe_record_verdict`, `swipe_results`. It reads and writes the same `<root>` as the board.

**Claude Code — as a plugin** (MCP server + skill together):

```bash
claude plugin marketplace add RiahStudio/riah-swipe
claude plugin install riah-swipe@riah-swipe
export SWIPE_ROOT=~/my-swipe-decks     # optional; defaults to the bundled sample
```

**Claude Code — MCP only:**

```bash
claude mcp add riah-swipe -e SWIPE_ROOT=$HOME/my-swipe-decks -- node /absolute/path/to/riah-swipe/server/swipe-mcp.mjs
```

**Other stdio clients** (Claude Desktop, Codex, Hermes, Cursor…) — add to the client's MCP config:

```json
{ "mcpServers": { "riah-swipe": {
    "command": "node",
    "args": ["/absolute/path/to/riah-swipe/server/swipe-mcp.mjs"],
    "env": { "SWIPE_ROOT": "/absolute/path/to/my-swipe-decks" } } } }
```

**Over HTTP** — the board server already exposes `POST /mcp` (JSON-RPC). Set a bearer token if
anything but you can reach it: `SWIPE_MCP_TOKEN=$(openssl rand -hex 24) npm start`, then send
`Authorization: Bearer <token>`. Standalone: `node server/swipe-mcp.mjs --http --port 8790`.

The agent skill that teaches an assistant how to run a review session is in
`skills/riah-swipe/SKILL.md`. Copy it into any agent's skills folder.

## FAQ

**What does a team or agent submit?** A deck: one JSON file plus media in the format above. The
bundled skill (`skills/riah-swipe/SKILL.md`) teaches an agent to write it in one shot.

**Where does my work live?** On your disk, under the `--root` folder. There is no cloud, account or upload.

**Can I use it from my phone?** Yes: run with `--host 0.0.0.0` and open the machine's LAN address,
but read [SECURITY.md](SECURITY.md) first; there is no auth on the board.

**Can two people review the same deck?** On the local board, one reviewer at a time per deck is
the intended flow. For a team, use the team server below.

**Unknown card kinds?** They render as text, so a deck never fails to load over a label.

## Team server

The board above is a one-person tool on your own machine. If a group needs to review together,
[`team/`](team/README.md) is a small self-hosted server people sign into. It has workspaces,
projects, reviewer and submitter roles, and project tokens so agents can send decks in. Reviews
happen in the browser. It's free too: no billing, no license keys. It needs Node 20+ and one
dependency (better-sqlite3). See [team/README.md](team/README.md) to set it up.

## Layout

```
board/      the swipe UI (static; vanilla JS ES modules, installable PWA)
server/     serve.mjs (board + API + /mcp)  ·  swipe-mcp.mjs (MCP server, stdio or HTTP)
skills/     agent skill  ·  .claude-plugin/ + .mcp.json  Claude Code plugin manifest
examples/   sample root with one starter deck
test/       node:test integration tests
team/       optional self-hosted team server (accounts, workspaces, shared review)
```

## Known limitations

- Board verdicts live in the browser (IndexedDB) and are **pushed** to the server after each swipe.
  A verdict recorded through MCP is stored on the server but is not pulled back into an already-open
  browser's local state.
- No accounts or auth on the board. It binds to `127.0.0.1`; see [SECURITY.md](SECURITY.md) before
  exposing it.
- The UI loads web fonts from Google Fonts; offline it falls back to system fonts.

## License and trademark

The code is [MIT](LICENSE) © Riah Harris / Riah Studio. The "Riah Swipe" name and logo
(`brand/`) identify the official project. Fork and modify freely, but please don't present a
modified fork as the official Riah Swipe.
