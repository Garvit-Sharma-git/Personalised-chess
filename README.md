# Chess Coach

A small personal chess platform: **play a friend in real time → the game is saved → Stockfish analyses it → Groq explains the mistakes → you learn → play again.**

- Real-time multiplayer over WebSockets (Socket.IO); the server is authoritative for every move.
- Accounts, ratings (Elo), game history with move-by-move replay and PGN export.
- Automatic post-game review: every move classified (brilliant … blunder), best move, engine lines, tactical findings (hanging pieces, missed forks/mates, ignored threats …), key moments, an evaluation graph, per-player accuracy and a coaching report.
- Learning mode: recurring mistake patterns are tracked across games and shown on your profile and inside each review.
- Live move suggestions during a game for **one designated account only** (`garvitsharma1994@gmail.com` by default), enforced on the backend.

## Architecture

```
client/   React + Vite + react-chessboard  (board UI, pages, Socket.IO client)
server/   Node + Express + Socket.IO + SQLite/libSQL (local file or hosted Turso)
  src/services/engine.js       UCI driver + pool for Stockfish (bundled WASM build or a native binary)
  src/services/analysis.js     Stockfish pass: evals, classification, tags, accuracy, key moments
  src/services/chessReview.js  ChessReviewService: engine facts → coaching text (templates + Groq)
  src/services/llm.js          LLM provider abstraction (Groq by default; model set via env)
  src/services/hintService.js  Live hints (coach account only)
  src/services/gameService.js  Authoritative game logic: seating, moves, clocks, results, Elo
  src/db.js                    Schema + driver facade (named params, reconnect, Turso)
  src/sockets/gameSocket.js    Real-time events, presence, reconnection, clock flagging
  src/lib/evaluation.js        Pure chess heuristics (win%, classification, tactical tags)
```

**Stockfish does the chess; Groq only puts engine facts into words.** The Groq key lives in the server `.env` and is never sent to the browser. The model is configurable (`GROQ_MODEL`, `GROQ_FALLBACK_MODEL`, `GROQ_HINT_MODEL`); if a configured model has been retired, the server substitutes the best model your key can access and logs it. Without a key, reviews still work using deterministic, position-specific template explanations. `GET /api/health` shows the models in use and a running count of Groq requests/tokens.

## Setup

Requirements: Node 20+.

```bash
npm run install:all          # installs root, server and client dependencies
cp .env.example .env         # then edit: set JWT_SECRET and GROQ_API_KEY
```

Get a Groq key at https://console.groq.com and put it in `.env` as `GROQ_API_KEY=...`.

### Development

```bash
npm run dev                  # server on :4000 (auto-restarts), client on :5173 with proxy
```

Open http://localhost:5173.

### Production (single origin)

```bash
npm run build                # builds client/dist
npm start                    # serves API, sockets and the built client on :4000
```

Set `CLIENT_ORIGIN` to your public URL and `COOKIE_SECURE=true` when serving over HTTPS.

### Optional: native Stockfish

The bundled WASM engine works out of the box (~0.7M nodes/s). A native binary is several times faster:

```bash
brew install stockfish
echo "STOCKFISH_PATH=$(which stockfish)" >> .env
```

Analysis depth/time and the engine pool size are tunable in `.env` (`ANALYSIS_DEPTH`, `ANALYSIS_MOVETIME_MS`, `STOCKFISH_POOL_SIZE`, …).

## Groq usage per game

- **Post-game review:** one request per key moment (blunders, mistakes, missed/allowed mates, the turning point, the best "only moves"; capped at 10) plus one report per player. Typically **5–12 requests** on the review model (measured: 8 requests, ~6.7k input / ~1.6k output tokens for a 17-move game).
- **Live hints** (coach account only, Coach panel switched on): Stockfish runs locally on every position; a Groq explanation on the fast model is requested only when it is your turn and is cached per position — roughly **one request per move you make** (0 when the panel is off).
- `GET /api/health` reports the models in use and a running request/token count since the server started.

## Deploying (Vercel frontend + Render backend, free tier)

The frontend is a static build on Vercel; the API, WebSockets and Stockfish run
as a Node service on Render. Because they sit on different sites, browsers block
the session cookie as third-party, so the API also returns a JWT that the client
sends as a Bearer token. Render's free tier has no persistent disk, so the
database lives on Turso (hosted libSQL) — the same SQL, no code changes.

**1. Database — Turso.** Create an account at turso.tech, create a database, and
copy its URL (`libsql://<db>-<org>.turso.io`) and an auth token.

**2. Backend — Render.** New → Blueprint, point it at this repo; `render.yaml`
configures everything. Fill in the values it asks for:
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `GROQ_API_KEY`, and `CLIENT_ORIGIN`
(leave `CLIENT_ORIGIN` as a placeholder for now). Note the service URL, e.g.
`https://chess-coach-api.onrender.com`.

**3. Frontend — Vercel.** Import the repo, set **Root Directory** to `client`,
and add one environment variable:

    VITE_API_URL = https://chess-coach-api.onrender.com

Vite inlines this at build time, so it must be set before the build. Deploy, and
note the URL, e.g. `https://personalised-chess.vercel.app`.

**4. Close the loop.** Back on Render, set

    CLIENT_ORIGIN = https://personalised-chess.vercel.app,*.vercel.app

and redeploy. The wildcard also allows Vercel preview deployments.

### Free-tier caveats

- **Cold starts.** A free Render service sleeps after 15 minutes idle, so the
  first visit takes ~50s to wake. Games survive it: the server restores clocks
  from the database, resumes interrupted analyses, and clients reconnect on
  their own.
- **CPU.** The free instance is 0.1 CPU and Stockfish is CPU-bound, so
  `render.yaml` lowers the search depth and engine pool. A full-game review
  takes a couple of minutes rather than seconds, and live hints a few seconds.
  On a paid instance, raise `ANALYSIS_DEPTH`, `ANALYSIS_MOVETIME_MS`,
  `HINT_MOVETIME_MS` and `STOCKFISH_POOL_SIZE` back to the defaults in
  `.env.example`.
- **Single origin is more secure.** When the server also serves the client
  (`npm run build && npm start`), the session stays in an httpOnly cookie that
  JavaScript cannot read. The split-origin setup has to keep the token in
  `localStorage` instead, which is exposed to XSS. If you later put both behind
  one domain, unset `VITE_API_URL` and the app returns to cookie auth.

## How to play

1. Register, then on **Play** choose a colour and time control and click **Create game**.
2. Send the link (or the room code) to a friend; the game starts when they open it.
3. Play. Moves sync instantly; clocks, draw offers, resignation and reconnection are handled by the server.
4. When the game ends, click **Review game**. Stockfish analyses every move (a few seconds to a minute) and the review appears with explanations and a coaching report for each side.
5. **History** lists all games (open any finished one to replay/review it); **Profile** shows your record, move quality and the patterns you keep repeating.

## Security notes

- Passwords are bcrypt-hashed; sessions use an httpOnly JWT cookie.
- Every move is validated on the server with chess.js against the persisted move list; clients only receive the legal moves for their own side on their turn.
- Live game rooms are restricted to the two participants. Finished games can be reviewed by anyone who has the link (so you can share a review with a friend).
- The live-hint privilege is checked on the server against the account's email (`COACH_ACCOUNTS` in `.env`); the client only decides whether to *render* the panel.
- Rate limits on auth and hint endpoints; JSON body size capped.

## Data

SQLite database at `data/chess.db` (WAL mode). Tables: `users`, `games`, `moves`, `analyses`, `move_analyses`, `user_patterns`. Delete the file to start fresh (stop the server first).
