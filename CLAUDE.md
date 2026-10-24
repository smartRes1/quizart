# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Self-hosted party quiz ("Quiz-Party"). The host drives the game on a projector/TV at `/host`; teams play on their phones after scanning a QR code. No database, no cloud, no external fonts/CDNs/trackers — keep it that way. All UI text, comments and error messages are in German; match that.

## Commands

```bash
npm install
HOST_PIN=1234 node server.js        # dev run, Node >= 20; omit HOST_PIN to get a random one printed
npm run check                       # validate every quiz in the pool, print estimated durations, exit 1 on errors
docker compose up -d --build        # production; HOST_PIN comes from .env (required by compose)
```

There is no build step, linter, or test suite; `npm run check` is the only automated check. The only dependency is `qrcode`.

Env vars read by `server.js`: `PORT` (3000), `HOST_PIN`, `PUBLIC_URL` (base URL put in the QR code; otherwise derived from `Host`/`X-Forwarded-*`), `DATA_DIR`, `QUIZ_DIR` (default `$DATA_DIR/quizzes`), `MAX_TEAMS` (60).

## Architecture

- **`server.js`** — the whole backend: a plain `http` server (no framework) holding the game in a single in-memory `state` object. It is organized in sections: question loading/validation, game state, flow (state machine), client payloads, HTTP routes.
- **`public/index.html`** (team phone UI, also served for `/r/<code>`) and **`public/host.html`** (host UI) — self-contained pages with inline CSS/JS. Both **poll** `/api/state` resp. `/api/host/state` (≈300 ms during questions, ≈800 ms otherwise); there are no websockets.
- **`data/quizzes/<topic>/<short|mid|long>.json`** — the question pool; a quiz id is `<topic>/<duration>`. Each file has `title`, `settings`, `rounds[].questions[]` (format in README.md). `loadQuestions()` validates a file and normalizes `correct` from a letter (A–D) to an index; validation errors are German, location-specific messages surfaced in the host menu. `listQuizzes()` scans the pool (including broken files, with `error`) and `estimateMinutes()` derives a duration; `DURATION_FITS` holds the target minutes per length (short 2–6, mid 7–15, long >15). The host picks topic and length in the menu (`/api/host/quizzes`, `/api/host/select`).
- **`data/state.json`** — persisted game state, written debounced (150 ms) via tmp file + rename on every `save()`. `state.quiz` records the active quiz id; on startup the state is restored unless that quiz is gone/invalid or its round count changed, otherwise the first valid quiz in the pool starts fresh.

### Game flow

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
