import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");

// Load the repo-root .env regardless of the working directory the server was
// started from (npm --prefix server sets cwd to server/). Real environment
// variables always take precedence; server/.env may add local overrides.
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, "server", ".env"), quiet: true });

function bool(v, dflt = false) {
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function int(v, dflt) {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
}

const dataDir = process.env.DATA_DIR || path.join(ROOT, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  env: process.env.NODE_ENV || "development",
  port: int(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",

  dataDir,
  dbFile: process.env.DB_FILE || path.join(dataDir, "chess.db"),

  jwtSecret: process.env.JWT_SECRET || "dev-only-insecure-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "30d",
  cookieName: "chess_token",
  cookieSecure: bool(process.env.COOKIE_SECURE, false),

  // The single account allowed to receive live in-game move suggestions.
  // Enforced server-side; the client flag is only a rendering hint.
  coachAccounts: (process.env.COACH_ACCOUNTS || "garvitsharma1994@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  engine: {
    // Path to a UCI engine. Defaults to the bundled WASM Stockfish, driven as a
    // child process over stdin/stdout, so a native binary can be swapped in via
    // STOCKFISH_PATH without touching any calling code.
    path: process.env.STOCKFISH_PATH || null,
    variant: process.env.STOCKFISH_VARIANT || "lite",
    threads: int(process.env.STOCKFISH_THREADS, 1),
    hashMb: int(process.env.STOCKFISH_HASH_MB, 64),
    poolSize: int(process.env.STOCKFISH_POOL_SIZE, 2),
    analysisDepth: int(process.env.ANALYSIS_DEPTH, 16),
    analysisMovetimeMs: int(process.env.ANALYSIS_MOVETIME_MS, 900),
    hintDepth: int(process.env.HINT_DEPTH, 18),
    hintMovetimeMs: int(process.env.HINT_MOVETIME_MS, 1200),
    multiPv: int(process.env.MULTI_PV, 3),
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY || "",
    // Swappable via env: nothing in the app hard-codes a specific model.
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    fallbackModel: process.env.GROQ_FALLBACK_MODEL || "llama-3.1-8b-instant",
    temperature: Number(process.env.GROQ_TEMPERATURE ?? 0.4),
    maxTokens: int(process.env.GROQ_MAX_TOKENS, 1600),
    timeoutMs: int(process.env.GROQ_TIMEOUT_MS, 45000),
  },
};

export function isCoachAccount(email) {
  if (!email) return false;
  return config.coachAccounts.includes(String(email).trim().toLowerCase());
}
