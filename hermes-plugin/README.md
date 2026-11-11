# Riah Swipe for Hermes

Swipe through what your agent made.

You ask Hermes for ten logo ideas, six taglines, or four cuts of a video. Hermes
puts them in a swipe deck and hands you a link. Swipe right to keep, left to
discard, and up to send one back with a note. When you finish the deck, Hermes
has the verdicts and remakes the ones you sent back.

It works on your desktop. Turn on phone mode and it works from your phone on the
same Wi-Fi too. On Telegram you don't need the board at all: the cards show up
right in the chat with buttons, and you can type a note on any card to say why.

## Install

You need Hermes 0.21.5 or newer (0.22.3 or newer for swiping right inside
Telegram; tested on 0.22.5). Then:

```bash
hermes plugins install RiahStudio/riah-swipe/hermes-plugin
hermes plugins enable riah-swipe
```

Plain `RiahStudio/riah-swipe` works too; it just downloads the whole repo
instead of only the plugin's folder.

The board ships inside the plugin and needs no build step, Node, or extra
Python packages.

To check it worked, run:

```bash
hermes swipe status
```

You should see a board link and "No decks yet". `hermes swipe serve` opens
the empty board, if you'd like to see it before Hermes makes your first deck.

## Using it

Just ask in plain words:

> Give me 8 names for my coffee cart and let me swipe on them.

> Make four poster ideas for the bake sale, put them in Swipe, and redo whatever I send back.

Hermes calls `swipe_publish`, gives you the board link, and waits. Swipe the
deck. In the CLI, TUI and desktop app Hermes picks up your verdicts as soon as
you finish. In a messaging chat it does not sit and wait. If the host allows
it (see below), Hermes posts your verdicts back into the chat as soon as you
finish the deck; otherwise they reach it with your next message. If you change
a verdict after that, Hermes hears about the change once, too.

The gateway is the part of Hermes that talks to Telegram, Discord and other
chat apps. Hermes doesn't let plugins post into those chats unless you say so.
To let Riah Swipe post your verdicts back into the chat when you finish a deck,
add this to Hermes' `config.yaml` (it's a Hermes permission, so it sits next to
the plugin's name, not under its `settings`) and restart the gateway with
`hermes gateway restart`:

```yaml
plugins:
  entries:
    riah-swipe:
      allow_gateway_injection: true
```

It only ever sends one short summary, and only to the chat that made the deck.
Without it nothing breaks; Hermes just picks up your verdicts the next time
you send it a message.

### Swiping in Telegram

When Hermes makes a deck from a Telegram chat, the deck appears in that chat as
one message that flips from card to card. Each card is numbered (#1, #2, …) and
has **Keep**, **Cut**, **Redo**, **Note** and **Undo** buttons. The board link still works if you'd rather use
it, and both stay in sync.

Notes are the point: a quick way to tell Hermes why. They're optional, on any
card, and a note is just a message you type. Dictating with your keyboard's
mic or whatever voice app you already use works the same, since it arrives as
text. There's nothing extra to install.

- After you tap a button, type a message and it's
  attached to the card you just decided. "Kept it, the blue one reads better"
  or "Cut, the hands look wrong" both work. A note can be about the whole
  batch, too ("none of these feel like summer"); Hermes reads every note
  before it makes the next round.
- Tap **Note** to write about the card on screen before you decide it (at the
  end, it's for the last card). Your next message is the note.
- Right after Undo, a note goes with the card on screen and is saved when you
  decide it.
- Until your first tap on a new deck, whatever you type still goes to Hermes,
  so a deck landing mid-conversation never swallows what you were saying. To
  note the first card before deciding it, tap Note or reply to the card.
- Redo asks for a note but never waits for one. Send nothing and keep going.
- After the last card there's a short wait (30 seconds by default, longer if
  you tapped Redo and haven't said what to change yet) for one more note, with
  a **Send** button to skip it. Then the verdicts go back to Hermes.
  The card says "Sent to Hermes" if Hermes heard straight away, or "Hermes gets
  these with your next message" if it isn't allowed to post into the chat yet
  (see `allow_gateway_injection` above).

**Several decks in a row.** If Hermes makes another deck while you're still
swiping, it waits its turn and shows up in the chat when you finish the one on
screen. The card tells you how many are waiting. Finish a deck on the board
instead and the chat moves on to the next one by itself. If you walked away
from a deck for 10 minutes, the next deck Hermes makes takes its place in the
chat (ahead of any that were already waiting); the cards you left stay on the
board. Up to 20 decks can wait; past that a new deck comes as a board link.

**Redo rounds.** When Hermes remakes the cards you sent back, the new deck is
marked "round 2" and each remade card shows what you asked for ("You said:
“make the hat red”"), so you can check it against your own words.

Only the person who asked for the deck can tap the buttons or add notes, and only while a deck
is open in that chat. Commands like `/swipe` always pass through to Hermes.
Type `/swipe stop` to stop swiping in the chat; what you've swiped is saved and
the rest stay on the board. Decks that were waiting their turn leave the chat
too, and are still on the board.

**Telegram voice messages (optional).** If your Hermes already understands
voice messages, you can send one as a note too. The card says "Listening to
your voice note…", you can keep swiping, and the words land on the card you
said them for. If your Hermes doesn't do speech-to-text, or the words can't be
made out, the card says so and the clip is saved with your verdict; type the
note if you want Hermes to read it. You never need this: typed notes do
everything.

A card whose picture or video won't load in the chat is shown as text instead,
and you can still swipe it.

Swiping in chat needs Hermes 0.22.3 or newer (tested on 0.22.5), with plugins running inside
Hermes (`plugins.isolation: in_process`, which is the default). On older
versions, with `plugins.isolation: host`, in other chat apps, or with `chat_swipe: false`,
Hermes sends the board link instead.

You can also type `/swipe` to get the board link and see how recent decks are
going, or run `hermes swipe serve` to open the board on its own.

### Signing in

The board link Hermes gives you signs that browser in the first time you open
it (it ends in `/pair?c=...`, works once, and expires after 10 minutes). After
that the browser stays signed in for 30 days and the plain board address works.
A different browser, or the same one after 30 days, needs a fresh link: type
`/swipe` or ask Hermes. `/swipe unpair` (or `hermes swipe unpair`) signs every
browser out at once.

### Phone mode

Set `lan: true` in the plugin's settings (Settings → Plugins → Riah Swipe, or
`plugins.entries.riah-swipe.settings.lan` in `config.yaml`). The board then
listens on your local network and Hermes also gives you a phone link. Open it
on your phone; it signs the phone in the same way. Phone links are only posted
in direct messages, never in group chats, so ask in a DM if you need one.

Two optional settings help with more unusual setups:

- `bind` picks the one network address the board listens on, instead of all of them.
- `advertise_host` is the name or address that goes in the phone link.

**Tailscale tip.** Set `advertise_host` to your PC's MagicDNS name (like
`my-pc.your-tailnet.ts.net`) and set `bind` to the PC's Tailscale `100.x`
address. The board is then reachable from your phone anywhere on your tailnet,
and from nowhere else.

**Windows Firewall.** The first time the board listens on your network,
Windows may ask whether to let Python through, or may quietly block it. If your
phone can't connect, allow inbound connections for Python on private networks.

## Tools

| Tool | What it does |
|---|---|
| `swipe_publish` | Makes a deck from a list of cards (text, image, video or audio) and returns the board link. `redo_of` makes it the next round of an earlier deck, and a card's `replaces` says which card it remakes |
| `swipe_status` | The board link and progress on recent decks |
| `swipe_results` | Keep, revise and discard lists for one deck, with every note in the order you gave it, any saved voice clips, and what to do next |
| `swipe_wait` | Waits for you to finish a deck. Only in interactive sessions; returns at once anywhere else |

There are two hooks:

- `pre_llm_call`. When you finish a deck Hermes made in this session, the next
  turn gets a short summary of your verdicts so Hermes can follow up without
  being asked. It holds off during the last-note wait in Telegram.
- `pre_gateway_dispatch`. While a deck is open in a Telegram chat, it catches a
  typed note (or a voice message) from the person swiping and attaches it to the
  card, so it doesn't start a new Hermes turn. Everything else (other people,
  other chats, commands, photos, a reply to some other message, any chat with
  no open deck) passes through untouched. A deck left alone for 10 minutes
  stops catching notes. Swiping in chat needs plugins loaded in-process (the
  default); with `plugins.isolation: host` Hermes doesn't let plugins add Telegram
  buttons, so you get the board link instead.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `lan` | `false` | Listen on your local network so a phone can open the board |
| `bind` | empty | Network address to listen on. Empty means this computer only, or all networks when `lan` is on |
| `advertise_host` | empty | Host name or address to put in the phone link. Empty means your PC's local network address |
| `port` | `8137` | First port to try. If it's taken, the next free one (up to +19) is used |
| `media_dirs` | empty | Extra folders Hermes may copy local media from, separated by commas (or a list) |
| `chat_swipe` | `true` | Show decks made in Telegram right in the chat, with buttons |
| `chat_finish_delay` | `30` | Seconds to wait after the last card for one more note (3 to 300). The wait is longer after a Redo with no note yet |

Local media is copied only from your working folder (unless that is your home
folder), Hermes' own image, audio and video caches, the temp folders (Hermes'
own and your computer's usual one, where most image and video makers save), and
any folder in `media_dirs`. A card pointing anywhere else is refused with a
message naming a folder that works and the setting to change.

## Disclosure

Everything stays on your computer. Specifically:

- **A local web server.** The first `swipe_publish` (or `/swipe`, or
  `hermes swipe serve`) starts a small HTTP server on a background thread
  inside the Hermes process. It stops when Hermes exits. By default it binds
  `127.0.0.1` only and refuses requests whose `Host` header is not a local
  name, which blocks DNS-rebinding pages.
- **Every browser signs in, this computer's too.** Each request needs a
  sign-in cookie, even from `127.0.0.1`, so another account on the same
  computer, a page in your browser posting blindly to the port, or a port
  forward can't use the board. A browser signs in by opening a one-time link
  (`/pair?c=...`, single use, 10 minutes, compared in constant time). That
  gives the browser its own random token (`secrets.token_urlsafe(32)`) in a
  cookie (HttpOnly, SameSite=Lax, 30 days, named per Hermes profile). Only a
  hash of each token is stored (`data/devices.json`, at most 50), and
  `/swipe unpair` deletes them all. POSTs must also come from the board's own
  origin.
- **Phone mode listens on your network, over plain HTTP.** With `lan: true` the
  server binds `0.0.0.0`, every network on the computer, unless you set `bind`
  to one address. Traffic is not encrypted, so use it on a network you trust
  (or Tailscale, which encrypts it). Phone links are never posted in group
  chats. The server caps open connections, times out slow clients, limits
  request sizes, and sends headers that stop the board being framed or
  sniffed. The board page only runs its own scripts (a Content-Security-Policy
  with `script-src 'self'` plus hashes of its two inline scripts). Uploaded
  media is served in a sandbox. To find your LAN address it opens a UDP socket
  toward a reserved test address (192.0.2.1); no packet is sent.
- **Media checks.** Local files are copied only if their type is on the list
  (no SVG) and their first bytes match that type. A deck can hold at most 1 GB
  of copied media. Remote media must be `https://`.
- **Files it writes.** Everything goes in the plugin's own data folder
  (`$HERMES_HOME/plugin-data/riah-swipe/`): decks, your verdicts, a small
  session ledger, and `data/server.json`, which records the running server's
  port and the board's persistent secret (a random value created on first run,
  readable only by you on systems that support it). It lets a second Hermes
  process reuse the same board, after proving it holds the secret, instead of
  starting another; the server only answers that proof for requests from this
  computer. The secret is never a sign-in cookie. A program running as you
  could read it, as it could read anything else in your Hermes folder.
  Swiping in Telegram adds `data/chat-swipe.json` (which deck is open in which
  chat, and the card message's id) and, if you send voice messages as notes, copies of
  those clips in `data/chat-notes/`. Nothing is deleted automatically; to clear everything,
  delete the `plugin-data/riah-swipe/` folder.
- **Files it reads.** When a card points at a local image, video or audio file,
  that one file is copied into the deck folder so the board can show it, and
  only if it sits inside an allowed folder (the working folder unless it is
  your home folder, Hermes' media caches, the temp folders, or `media_dirs`).
  For a voice message sent as a note while swiping, it reads the copy Hermes
  already downloaded. It reads nothing else outside its data folder.
- **Messages it sends.** With `allow_gateway_injection: true`, when you finish
  a deck that Hermes made in a chat, the plugin hands that chat one short
  summary of your verdicts through Hermes' own `inject_message`. It goes only
  to the chat that made the deck, once per change, and never from the CLI. It
  arrives as a new message, so Hermes starts a turn to follow up on it.
  Remote `https://` media links are passed to the board as-is; your browser
  (and Telegram, for chat cards) loads them, the plugin does not.
  Verdict notes are treated as plain data: trimmed, stripped of control
  characters, and shown to Hermes labeled as data, not instructions.
- **Telegram messages.** Swiping in chat sends, edits and deletes only the one
  card message in the chat that made the deck, through Hermes' own connected
  bot. It sends card media you gave it (a local file, or an `https://` link
  Telegram fetches). Typed notes stay on your computer. A voice message sent as a
  note goes through Hermes' own speech-to-text, if you set one up, which may
  use whatever provider you chose there.
- **No other outbound network calls, no telemetry, no accounts, no credentials.**
- **No background processes.** The server is a thread, not a separate process.
- **Waiting for a person.** `swipe_wait` only blocks in interactive surfaces
  (CLI, TUI, desktop, ACP), never longer than 15 minutes, and returns
  immediately under cron, the gateway, or a headless run.

## Developing

This part is only for people changing the plugin's code. The board lives in
`../board/` in the source repo. This folder carries a copy, because Hermes
installs only `hermes-plugin/`. After changing the board:

```bash
node scripts/sync-hermes-board.mjs
python -m unittest discover -s hermes-plugin/tests -t hermes-plugin
```

The tests are standard library only and talk to loopback only. The Telegram
tests use `python-telegram-bot` (which Hermes already ships) and skip if it
isn't installed.

MIT licensed. Made by Riah Studio.
