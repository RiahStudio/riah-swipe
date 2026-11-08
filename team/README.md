# Riah Swipe team server

A small server your team signs into to review Riah Swipe decks together. Make a workspace, add projects, give people the reviewer or submitter role, and swipe through the work in the browser. Agents and scripts send decks in with a project token.

No billing, no license keys — it's free and MIT.

## Quick start

You need Node 20 or newer.

```
npm install
cp .env.example .env
# edit .env and set SESSION_SECRET to a long random string
npm start
```

Then open http://localhost:8790, create an account, and make a workspace and a project from the dashboard.

To make a good secret:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Settings

Set these in `.env` or as real environment variables. Real environment variables win.

| Name | Needed | What it does |
| --- | --- | --- |
| `SESSION_SECRET` | yes | Signs login cookies. 32 or more characters. The server won't start without it. |
| `PORT` | no | Port to listen on. Default 8790. |
| `BASE_URL` | no | The public address of the server. Used in emailed links. Default `http://localhost:<PORT>`. |
| `BASE_PATH` | no | Sub-path if a reverse proxy serves the app under one, like `/swipe`. |
| `DATA_DIR` | no | Where the database and uploaded media are kept. Default `./data`. |
| `RESEND_API_KEY` | no | Turns on email (password resets, review notifications) through Resend. Without it the server logs a notice instead. |
| `MAIL_FROM` | no | The "from" address. Default `Riah Swipe <noreply@example.com>`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URL` | no | Set all three to show "Continue with Google". The redirect URL is `<BASE_URL>/api/auth/google/callback`. |

Back up the `DATA_DIR` folder and you've backed up everything.

## How people use it

- **Dashboard** (`/dashboard`): make a workspace and projects, and get a submit link for each project.
- **Review** (`/review`): reviewers swipe keep, revise or discard on decks in their projects.
- **Projects** (`/projects`): shows what you've sent and how far along the review is.
- **Submit** (`/submit`): a page for sending a batch of files, opened from a submit link. No account needed.

## Publishing a deck from an agent

Every project can hand out tokens that start with `rswt_`. Make one with **Get submit link** on the dashboard (the token is in the part of the link after `t=`), or with `POST /api/projects/<projectId>/tokens` while signed in as the workspace owner. Send it as `Authorization: Bearer rswt_...`.

1. Create the deck:

   ```
   POST /api/projects/<projectId>/decks
   {
     "schema": "riah-swipe.deck/1",
     "decks": [{ "id": "round-1", "name": "Poster round 1", "kind": "image", "rev": 0 }],
     "cards": [{ "id": "c1", "deckId": "round-1", "title": "Poster A", "kind": "image", "media": "a.png" }]
   }
   ```

   The reply lists the new decks. Use the returned deck `id` below.

2. Upload each card's file:

   ```
   PUT /api/decks/<deckId>/cards/<cardId>/media
   Content-Type: image/png
   (file bytes)
   ```

3. Publish once every file is up:

   ```
   POST /api/decks/<deckId>/publish
   ```

Reviewers then see the deck in their queue. Results come back from `GET /api/decks/<deckId>/results`.

Card kinds are `image`, `video`, `audio`, `text`, `script`, `line`, `chapter` and `logline`. Each workspace has 2 GB of storage, and a deck's media is cleared 30 days after it's fully reviewed (change this per project). Verdicts and notes are kept.

## Tests

```
npm test
```

## License

MIT. See `LICENSE`.
