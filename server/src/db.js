import Database from "better-sqlite3";
import { config } from "./config.js";

export const db = new Database(config.dbFile);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rating        INTEGER NOT NULL DEFAULT 1200,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS games (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  white_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  black_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  creator_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- creator's requested colour: 'white' | 'black' | 'random'
  creator_color  TEXT NOT NULL DEFAULT 'random',
  -- 'waiting' | 'active' | 'finished' | 'aborted'
  status         TEXT NOT NULL DEFAULT 'waiting',
  -- '1-0' | '0-1' | '1/2-1/2' | NULL
  result         TEXT,
  -- 'checkmate' | 'resignation' | 'stalemate' | 'timeout' | 'agreement' |
  -- 'insufficient_material' | 'threefold_repetition' | 'fifty_move_rule' | 'abandoned'
  result_reason  TEXT,
  winner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  fen            TEXT NOT NULL,
  pgn            TEXT NOT NULL DEFAULT '',
  move_count     INTEGER NOT NULL DEFAULT 0,
  -- base time per side in seconds; 0 disables the clock
  initial_time   INTEGER NOT NULL DEFAULT 600,
  increment      INTEGER NOT NULL DEFAULT 5,
  white_time_ms  INTEGER NOT NULL DEFAULT 600000,
  black_time_ms  INTEGER NOT NULL DEFAULT 600000,
  -- wall clock at which the side to move started thinking
  turn_started_at INTEGER,
  draw_offer_by  TEXT,
  rated          INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  started_at     TEXT,
  ended_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_id);
CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_id);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_created ON games(created_at DESC);

CREATE TABLE IF NOT EXISTS moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply           INTEGER NOT NULL,
  move_number   INTEGER NOT NULL,
  color         TEXT NOT NULL,
  san           TEXT NOT NULL,
  uci           TEXT NOT NULL,
  fen_before    TEXT NOT NULL,
  fen_after     TEXT NOT NULL,
  captured      TEXT,
  is_check      INTEGER NOT NULL DEFAULT 0,
  time_spent_ms INTEGER,
  clock_ms      INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (game_id, ply)
);

CREATE INDEX IF NOT EXISTS idx_moves_game ON moves(game_id, ply);

CREATE TABLE IF NOT EXISTS analyses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       INTEGER NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  -- 'pending' | 'running' | 'done' | 'error'
  status        TEXT NOT NULL DEFAULT 'pending',
  progress      REAL NOT NULL DEFAULT 0,
  engine_depth  INTEGER,
  engine_name   TEXT,
  accuracy_white REAL,
  accuracy_black REAL,
  acpl_white    REAL,
  acpl_black    REAL,
  summary_json  TEXT,
  coaching_json TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

CREATE TABLE IF NOT EXISTS move_analyses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply            INTEGER NOT NULL,
  color          TEXT NOT NULL,
  san            TEXT NOT NULL,
  uci            TEXT NOT NULL,
  fen_before     TEXT NOT NULL,
  fen_after      TEXT NOT NULL,
  phase          TEXT,
  -- Evaluations are stored from White's point of view (cp). Mate scores are
  -- encoded as +/-(MATE_CP - n) in the cp columns and also kept explicitly.
  eval_before_cp INTEGER,
  mate_before    INTEGER,
  eval_after_cp  INTEGER,
  mate_after     INTEGER,
  -- Loss metrics are from the mover's point of view.
  cp_loss        INTEGER,
  win_before     REAL,
  win_after      REAL,
  win_drop       REAL,
  accuracy       REAL,
  -- 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'book' | 'forced' |
  -- 'inaccuracy' | 'mistake' | 'blunder'
  classification TEXT,
  best_move_uci  TEXT,
  best_move_san  TEXT,
  best_line_san  TEXT,
  played_line_san TEXT,
  alternatives_json TEXT,
  tags_json      TEXT,
  is_critical    INTEGER NOT NULL DEFAULT 0,
  explanation    TEXT,
  improvement    TEXT,
  headline       TEXT,
  UNIQUE (game_id, ply)
);

CREATE INDEX IF NOT EXISTS idx_move_analyses_game ON move_analyses(game_id, ply);

CREATE TABLE IF NOT EXISTS user_patterns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern     TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  last_game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, pattern)
);

CREATE INDEX IF NOT EXISTS idx_patterns_user ON user_patterns(user_id, count DESC);
`);

/** Add a column to an existing table if it is missing (lightweight migrations). */
export function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

ensureColumn("analyses", "patterns_recorded", "INTEGER NOT NULL DEFAULT 0");

export default db;
