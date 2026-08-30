/**
 * Cross-game learning: aggregate recurring mistake types per user so the
 * profile and each review can point at habits rather than one-off errors.
 */
import { db } from "../db.js";

export const PATTERNS = {
  hanging_pieces: {
    label: "Hanging pieces",
    advice: "Before every move, scan the board for any of your pieces that are attacked and not adequately defended.",
  },
  missed_tactics: {
    label: "Missing tactics",
    advice: "Look at every check, capture and threat (for both sides) before settling on a quiet move.",
  },
  missed_threats: {
    label: "Missing the opponent's threats",
    advice: "After each opponent move ask: what does that move attack, and what would they play if I passed?",
  },
  missed_mates: {
    label: "Missing forced mates",
    advice: "When the enemy king is exposed, calculate the forcing checks all the way to the end before playing anything else.",
  },
  weak_opening: {
    label: "Weak opening play",
    advice: "Develop knights and bishops, castle early, and connect the rooks before starting an attack.",
  },
  weak_endgame: {
    label: "Endgame technique",
    advice: "Activate your king, create and push passed pawns, and study basic king-and-pawn and rook endings.",
  },
  same_piece_repeat: {
    label: "Moving the same piece repeatedly",
    advice: "In the opening, move each piece once until development is complete unless there is a concrete reason.",
  },
  king_safety: {
    label: "King safety",
    advice: "Castle early, keep the pawns in front of your king intact, and watch for attacks along open lines.",
  },
  time_management: {
    label: "Time management",
    advice: "Spend your time on critical, sharp positions and avoid instant moves when the position changes.",
  },
  losing_won_positions: {
    label: "Losing won positions",
    advice: "When ahead, simplify: trade pieces (not pawns), keep everything protected, and avoid unnecessary risks.",
  },
};

const UPSERT = db.prepare(`
  INSERT INTO user_patterns (user_id, pattern, count, last_game_id, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, pattern) DO UPDATE SET
    count = count + excluded.count,
    last_game_id = excluded.last_game_id,
    updated_at = datetime('now')
`);

const SELECT_FOR_USER = db.prepare(
  "SELECT pattern, count, last_game_id, updated_at FROM user_patterns WHERE user_id = ? ORDER BY count DESC"
);

const TAG_TO_PATTERN = {
  hanging_piece: "hanging_pieces",
  loose_piece: "hanging_pieces",
  ignored_threat: "missed_threats",
  missed_tactic: "missed_tactics",
  missed_fork: "missed_tactics",
  missed_free_piece: "missed_tactics",
  missed_opportunity: "missed_tactics",
  missed_mate: "missed_mates",
  allowed_mate: "king_safety",
  king_in_centre: "king_safety",
  same_piece_twice: "same_piece_repeat",
  rushed: "time_management",
  time_pressure: "time_management",
};

/**
 * Compute this game's pattern increments for one side from its analysed moves.
 * Returns { patternKey: count }.
 */
export function derivePatternCounts(playerMoves, playerStats, { lostOnTime = false } = {}) {
  const counts = {};
  const bump = (key, n = 1) => {
    if (n > 0) counts[key] = (counts[key] || 0) + n;
  };

  for (const m of playerMoves) {
    for (const t of m.tags || []) {
      const key = TAG_TO_PATTERN[t.tag];
      if (key) bump(key);
    }
    if (m.classification === "blunder" && m.moverCpBefore >= 200) bump("losing_won_positions");
  }

  const op = playerStats.phases?.opening;
  if (op && op.moves >= 6 && (op.acpl >= 60 || op.mistakes >= 2)) bump("weak_opening");
  const eg = playerStats.phases?.endgame;
  if (eg && eg.moves >= 6 && (eg.acpl >= 60 || eg.mistakes >= 2)) bump("weak_endgame");
  if (lostOnTime) bump("time_management");

  return counts;
}

export const recordPatterns = db.transaction((userId, gameId, counts) => {
  UPSERT.run(userId, "games_analyzed", 1, gameId);
  for (const [pattern, n] of Object.entries(counts)) {
    if (PATTERNS[pattern] && n > 0) UPSERT.run(userId, pattern, n, gameId);
  }
});

const SELECT_USER_GAMES = db.prepare(`
  SELECT g.id, g.white_id, g.black_id, g.result, g.result_reason
  FROM games g JOIN analyses a ON a.game_id = g.id
  WHERE a.status = 'done' AND (g.white_id = ? OR g.black_id = ?)
  ORDER BY g.id ASC
`);
const SELECT_GAME_MOVES = db.prepare(
  "SELECT color, classification, eval_before_cp, cp_loss, phase, tags_json FROM move_analyses WHERE game_id = ? ORDER BY ply"
);
const DELETE_USER_PATTERNS = db.prepare("DELETE FROM user_patterns WHERE user_id = ?");

/**
 * Recompute a user's pattern counts from every analysed game they played
 * (maintenance: e.g. after tuning the heuristics or repairing double counts).
 */
export const rebuildPatternsForUser = db.transaction((userId) => {
  DELETE_USER_PATTERNS.run(userId);
  for (const g of SELECT_USER_GAMES.all(userId, userId)) {
    const color = g.white_id === userId ? "w" : "b";
    const sign = color === "w" ? 1 : -1;
    const own = SELECT_GAME_MOVES.all(g.id)
      .filter((m) => m.color === color)
      .map((m) => ({
        classification: m.classification,
        moverCpBefore: sign * (m.eval_before_cp ?? 0),
        cpLoss: m.cp_loss ?? 0,
        phase: m.phase,
        tags: JSON.parse(m.tags_json || "[]"),
      }));
    const phases = {};
    for (const m of own) {
      const ph = (phases[m.phase] ||= { moves: 0, cpSum: 0, mistakes: 0 });
      ph.moves++;
      ph.cpSum += m.cpLoss;
      if (["mistake", "blunder"].includes(m.classification)) ph.mistakes++;
    }
    for (const ph of Object.values(phases)) ph.acpl = ph.moves ? Math.round(ph.cpSum / ph.moves) : 0;
    const lostOnTime = g.result_reason === "timeout" && g.result === (color === "w" ? "0-1" : "1-0");
    recordPatterns(userId, g.id, derivePatternCounts(own, { phases }, { lostOnTime }));
    db.prepare("UPDATE analyses SET patterns_recorded = 1 WHERE game_id = ?").run(g.id);
  }
});

/** Patterns for a user, decorated with labels, advice and a per-game rate. */
export function patternsForUser(userId) {
  const rows = SELECT_FOR_USER.all(userId);
  const games = rows.find((r) => r.pattern === "games_analyzed")?.count || 0;
  const list = rows
    .filter((r) => PATTERNS[r.pattern])
    .map((r) => ({
      key: r.pattern,
      label: PATTERNS[r.pattern].label,
      advice: PATTERNS[r.pattern].advice,
      count: r.count,
      perGame: games ? Number((r.count / games).toFixed(2)) : r.count,
      lastGameId: r.last_game_id,
      updatedAt: r.updated_at,
    }))
    .sort((a, b) => b.count - a.count);
  return { gamesAnalyzed: games, patterns: list };
}
