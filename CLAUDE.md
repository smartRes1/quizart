# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Self-hosted quiz ("Quiz-Party"). **Party mode** (the original mode): the host drives the game on a projector/TV at `/host`; teams play on their phones after scanning a QR code. Online modes are being added in phases: Solo (vs. a best-of list, guests allowed, only a logged-in player's first attempt per quiz counts), Battle (1 vs 1, turn-based, friend via invite link or random), Match (3–10 players live, auto-advancing, no moderator), login via email magic link, Google or Facebook, data in SQLite. Party must keep working offline with no login, mail or OAuth config; online features only switch on when their env vars are set. No external fonts/CDNs/trackers. All UI text, comments and error messages are in German; match that.

## Commands

```bash
npm install
HOST_PIN=1234 node server.js        # dev run, Node >= 22.13 (node:sqlite); omit HOST_PIN to get a random one printed
npm test                            # node:test, no extra deps
node --test test/party.test.js      # a single test file; add --test-name-pattern='…' for one test
npm run check                       # validate every quiz in the pool, print estimated durations, exit 1 on errors
docker compose up -d --build        # production; HOST_PIN comes from .env (required by compose)
```

There is no build step or linter. The only dependency is `qrcode`. Tests in `test/` start `server.js` as a child process (`test/helpers.js` → `startServer()`, free port, temp `DATA_DIR`, fixture quizzes in `test/fixtures/quizzes`). `test/party.test.js` plays a complete party game over HTTP and is the regression guard for party behaviour.

Env vars (read in `lib/config.js`, plus `HOST_PIN` in `lib/party.js`): `PORT` (3000), `HOST_PIN`, `PUBLIC_URL` (base URL put in the QR code; otherwise derived from `Host`/`X-Forwarded-*`), `DATA_DIR`, `QUIZ_DIR` (default `$DATA_DIR/quizzes`), `MAX_TEAMS` (60).

## Architecture

Plain `http` server, no framework. `server.js` only serves pages, `/healthz` and hands the rest to the mode modules; a module answers a request by calling `send()`, and the router returns 404 if nothing did (`res.writableEnded`). SIGTERM/SIGINT flush the party state (`party.saveNow()`) and exit, which also makes `docker stop` fast.

- **`lib/party.js`** — the whole party mode: one game per server in a single in-memory `state`, flow (state machine), client payloads and all `/api/state|join|enter|answer` and `/api/host/*` routes.
- **`lib/quizzes.js`** pool loading/validation, **`lib/scoring.js`** ranking shared by all modes (`rankRows`, `distribution`), **`lib/http.js`** (`send`, `readBody`, `cleanName`, `baseUrl`), **`lib/config.js`** env.
- **`lib/db.js`** — SQLite via built-in `node:sqlite` for the online modes, file `data/quiz.db`, opened lazily by `db.get()` (party alone never creates it). Schema changes are appended to `MIGRATIONS` (never edit an existing entry); `meta.schema_version` tracks progress, each migration runs in a transaction.
- **`lib/runs.js`** — one player's run through a quiz (Solo now, Battle later), routes `/api/quizzes` (public pool list) and `/api/run/start|:id|:id/answer|:id/next`. A run row keeps a full snapshot of the questions in `state` (options shuffled per run, so the correct letter varies), so later edits to the quiz file don't affect it. Server-timed: the first fetch of a question sets `servedAt`, answers after `seconds + GRACE_MS` are rejected, and an expired question is turned into a wrong answer lazily on the next request (`expire()`). The client sends `step` with `next` so double clicks can't skip a question. Guests are identified by an HttpOnly `gid` cookie; a run is only visible to its owner (404 otherwise). POSTs with a foreign `Origin` are rejected (`sameOrigin`). Guest runs are deleted after 2 days. The core functions take `now` so `test/runs.test.js` can drive them with a fake clock.
- **Pages** (`public/`): `index.html` start page at `/`; `party.html` team phone UI at `/party` and `/r/<code>`; `host.html` host UI at `/host`; `play.html` Solo at `/solo` and `/solo/<runId>` (reload resumes the run). Party pages are self-contained with inline CSS/JS; the new pages share `common.css`/`common.js` (served from a whitelist in `server.js`). Party pages **poll** `/api/state` resp. `/api/host/state` (≈300 ms during questions, ≈800 ms otherwise); there are no websockets. Don't call `/api/state` from other pages: it starts the team's answer timer during a question.
- **`data/quizzes/<topic>/<short|mid|long>.json`** — the question pool; a quiz id is `<topic>/<duration>`. Each file has `title`, `settings`, `rounds[].questions[]` (format in README.md). `loadQuestions()` validates a file and normalizes `correct` from a letter (A–D) to an index; validation errors are German, location-specific messages surfaced in the host menu. `listQuizzes()` scans the pool (including broken files, with `error`) and `estimateMinutes()` derives a duration; `DURATION_FITS` holds the target minutes per length (short 2–6, mid 7–15, long >15). The host picks topic and length in the menu (`/api/host/quizzes`, `/api/host/select`).
- **`data/state.json`** — persisted game state, written debounced (150 ms) via tmp file + rename on every `save()`. `state.quiz` records the active quiz id; on startup the state is restored unless that quiz is gone/invalid or its round count changed, otherwise the first valid quiz in the pool starts fresh.

### Party game flow (`lib/party.js`)

`state.phase` cycles `intro → question → reveal → … → standings → intro (next round) … → final`, driven by `next()` (host `POST /api/host/next`). A 250 ms interval auto-reveals when the deadline passes or every team in the round has answered.

Key details that span multiple functions:
- **Scoring/ranking** is never stored; `ranking()` recomputes it from `state.answers` over `state.revealed` questions. Ties break on total answer time (`ms`) of correct answers. `rankingWithMovement()` compares against the ranking before the current round.
- **Fair timing:** answer time is measured per team from when that phone first fetched the question (`state.seen`, recorded as a side effect inside `teamView()`), not from question start.
- **Join codes:** `state.codes` has one entry per round but currently all rounds share one code, and `next()` auto-enrolls all teams into the next round. A code is only valid while its round is active (`codeRound()`).
- **Teams** authenticate with a random `token` (kept in the phone's localStorage); the host authenticates with the `X-Host-PIN` header (constant-time compare), or `?pin=` for the QR SVG.
- **Payload separation:** `teamView()` and `hostView()` build distinct responses — teams never receive the answer distribution, and the correct answer is only included in the `reveal` phase. Preserve this when adding fields.
- Switching quiz (`/api/host/select`) and reloading (`/api/host/reload`) are only allowed before the first question of round 0 (`notStarted()`) and keep teams and join code; `/api/host/reset` reloads questions and starts a fresh state (optionally keeping teams).

### Docker

The image copies `data/quizzes/` to `/app/defaults/`; the entrypoint seeds `/app/data/quizzes` from it only if the mounted volume has none, so new example quizzes don't reach an existing volume automatically. The container runs as UID 1000, so `./data` must be writable by that user.
