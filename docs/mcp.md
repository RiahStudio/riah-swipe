# MCP server and agent use

`server/swipe-mcp.mjs` reads and writes the same `<root>` as the board.

## Tools

| Tool | Arguments | Does |
|---|---|---|
| `swipe_board` | none | Every deck with card count, decided count, waiting count, keep/revise/discard tally. |
| `swipe_decks` | `project?`, `only_undecided?` | List decks, optionally filtered by project/source. |
| `swipe_deck` | `deck_id`, `undecided_only?` | One deck's metadata and cards, with recorded verdicts. |
| `swipe_next_card` | `deck_id` | The next card still waiting on a verdict. |
| `swipe_record_verdict` | `deck_id`, `card_id`, `decision` (`keep`/`revise`/`discard`), `note?` | Record a verdict. |
| `swipe_results` | `deck_id`, `partial?`, `file?` | Build the `riah-swipe.results/1` payload; `file: true` also writes it to disk. |

## Setup

```bash
# Claude Code plugin (MCP server + skill)
claude plugin marketplace add RiahStudio/riah-swipe
claude plugin install riah-swipe@riah-swipe

# Claude Code, MCP only
claude mcp add riah-swipe -e SWIPE_ROOT=$HOME/my-swipe-decks -- node /absolute/path/to/riah-swipe/server/swipe-mcp.mjs
```

Other stdio clients (Claude Desktop, Codex, Hermes, Cursor…):

```json
{ "mcpServers": { "riah-swipe": {
    "command": "node",
    "args": ["/absolute/path/to/riah-swipe/server/swipe-mcp.mjs"],
    "env": { "SWIPE_ROOT": "/absolute/path/to/my-swipe-decks" } } } }
```

## HTTP

The board server exposes `POST /mcp` (JSON-RPC). Protect it with a bearer token if anything but you
can reach it: `SWIPE_MCP_TOKEN=$(openssl rand -hex 24) npm start`, then send
`Authorization: Bearer <token>`. Standalone: `node server/swipe-mcp.mjs --http --port 8790`.

## Agent skill

`skills/riah-swipe/SKILL.md` teaches an assistant how to publish decks and run a review session.
Copy it into any agent's skills folder.
