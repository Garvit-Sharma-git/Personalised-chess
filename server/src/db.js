import Database from "libsql";
import { config } from "./config.js";

/**
 * Database access layer.
 *
 * Two backends, chosen by environment:
 *   - a local SQLite file (development, or any host with a persistent disk)
 *   - a hosted libSQL/Turso primary over the network, for hosts whose
 *     filesystem is ephemeral (Render's free tier, for example)
 *
 * The exported `db` is a small facade rather than the driver object, because
 * the remote backend needs three behaviours the driver does not provide:
 *   1. named `@param` placeholders (remote binds positional parameters only),
 *   2. statements prepared on the connection that is currently in a
 *      transaction (a statement prepared elsewhere silently loses its write),
 *   3. recovery when an idle connection is expired by the server.
 */
function createConnection() {
  const { url, authToken } = config.turso;
  if (!url) {
    return { instance: new Database(config.dbFile), kind: "file", location: config.dbFile };
  }
  return {
    instance: new Database(url, { authToken }),
    kind: "remote",
    location: url.replace(/\?.*$/, ""),
  };
}

let conn = createConnection();
// Bumped on every reconnect so cached statements bound to the dead connection
// are discarded rather than reused.
let connectionGeneration = 0;
export const dbInfo = { kind: conn.kind, location: conn.location };

/** Errors that mean "the connection went stale", not "the query was wrong". */
const TRANSIENT = /STREAM_EXPIRED|stream has expired|stream not found|baton|ECONNRESET|socket hang up|connection closed/i;

let transactionDepth = 0;

function reconnect() {
  try {
    conn.instance.close();
  } catch {
    /* already gone */
  }
  conn = createConnection();
  connectionGeneration++;
}

/**
 * Run a driver operation, transparently reconnecting once if the connection
 * had gone stale. Never retried inside a transaction: the transaction died
 * with the connection, so the caller must redo the whole unit of work.
 */
function withConnection(fn) {
  try {
    return fn(conn.instance);
  } catch (err) {
    const recoverable =
      conn.kind === "remote" && transactionDepth === 0 && TRANSIENT.test(String(err?.message ?? ""));
    if (!recoverable) throw err;
    console.warn("[db] connection went stale; reconnecting");
    reconnect();
    return fn(conn.instance);
  }
}

/**
 * Walk SQL, tagging each chunk as code, a string literal or a line comment, so
 * callers can transform code without touching literals or comments.
 */
function* scanSql(sql) {
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let literal = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            literal += ch + ch;
            i += 2;
            continue;
          }
          literal += ch;
          i++;
          break;
        }
        literal += sql[i++];
      }
      yield { text: literal, kind: "literal" };
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      let comment = "";
      while (i < sql.length && sql[i] !== "\n") comment += sql[i++];
      yield { text: comment, kind: "comment" };
      continue;
    }
    yield { text: ch, kind: "code" };
    i++;
  }
}

/**
 * Split a multi-statement script on semicolons, ignoring those inside string
 * literals and comments, and drop the comments. Drivers disagree about
 * multi-statement input; doing it here makes the schema apply identically to a
 * local file and a remote primary.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = "";
  for (const { text, kind } of scanSql(sql)) {
    if (kind === "comment") continue;
    if (kind === "code" && text === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += text;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** Rewrite `@name` placeholders to positional `?`, remembering their order. */
function translateNamedParams(sql) {
  const names = [];
  let out = "";
  let code = "";
  const flush = () => {
    out += code.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      names.push(name);
      return "?";
    });
    code = "";
  };
  for (const { text, kind } of scanSql(sql)) {
    if (kind === "code") {
      code += text;
    } else {
      flush();
      out += text;
    }
  }
  flush();
  return names.length ? { sql: out, names } : null;
}

export const db = {
  prepare(sql) {
    const translated = translateNamedParams(sql);
    const finalSql = translated ? translated.sql : sql;
    const names = translated?.names ?? null;

    // Preparing costs a network round trip remotely, which would double the
    // latency of every query, so statements are cached. The exception is
    // inside a transaction: there a statement must be created on the
    // transaction's own connection, or its write is silently discarded.
    let cache = null;
    const resolve = (instance) => {
      if (conn.kind === "remote" && transactionDepth > 0) return instance.prepare(finalSql);
      if (!cache || cache.generation !== connectionGeneration) {
        cache = { generation: connectionGeneration, statement: instance.prepare(finalSql) };
      }
      return cache.statement;
    };

    const bind = (args) => {
      if (!names) return args;
      const [first] = args;
      if (args.length === 1 && first !== null && typeof first === "object" && !Array.isArray(first)) {
        return names.map((name) => {
          if (Object.hasOwn(first, name)) return first[name];
          if (Object.hasOwn(first, `@${name}`)) return first[`@${name}`];
          throw new Error(`Missing value for named parameter @${name}`);
        });
      }
      return args;
    };

    const call = (method, args) =>
      withConnection((instance) => resolve(instance)[method](...bind(args)));

    return {
      run: (...args) => call("run", args),
      get: (...args) => call("get", args),
      all: (...args) => call("all", args),
      source: sql,
    };
  },

  exec(sql) {
    return withConnection((instance) => instance.exec(sql));
  },

  pragma(statement, options) {
    return withConnection((instance) => instance.pragma(statement, options));
  },

  /**
   * Transactions. The driver's own wrapper rethrows a failed ROLLBACK, which
   * hides the error that actually aborted the work; this one preserves it.
   */
  transaction(fn) {
    const run = (...args) => {
      db.exec("BEGIN");
      transactionDepth++;
      let result;
      try {
        result = fn(...args);
      } catch (err) {
        transactionDepth--;
        try {
          conn.instance.exec("ROLLBACK");
        } catch (rollbackErr) {
          if (process.env.DEBUG_SQL) console.error("[db] rollback failed:", rollbackErr.message);
        }
        throw err;
      }
      transactionDepth--;
      conn.instance.exec("COMMIT");
      return result;
    };
    run.database = db;
    return run;
  },

  close() {
    try {
      conn.instance.close();
    } catch {
      /* already closed */
    }
  },
};

/** Execute a multi-statement script one statement at a time. */
export function execScript(sql) {
  for (const statement of splitStatements(sql)) db.exec(statement);
}

/** Apply a PRAGMA, tolerating backends that do not implement it. */
function tryPragma(statement) {
  try {
    db.pragma(statement);
    return true;
  } catch {
    // A remote primary manages journalling itself and rejects these.
    return false;
  }
}

if (conn.kind === "file") {
  tryPragma("journal_mode = WAL");
  tryPragma("busy_timeout = 5000");
}
tryPragma("foreign_keys = ON");

execScript(`
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

CREATE INDEX IF NOT EXISTS idx_patterns_user ON user_patterns(user_id, count DESC);`);

/** Add a column to an existing table if it is missing (lightweight migrations). */
export function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

ensureColumn("analyses", "patterns_recorded", "INTEGER NOT NULL DEFAULT 0");

export default db;
