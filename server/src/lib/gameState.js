import { Chess } from "chess.js";
import { db } from "../db.js";

export const START_FEN = new Chess().fen();

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

export function generateRoomCode(length = 6) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

export function uciOf(move) {
  return move.from + move.to + (move.promotion || "");
}

const SELECT_MOVES = db.prepare(
  "SELECT san, uci FROM moves WHERE game_id = ? ORDER BY ply ASC"
);

/**
 * Rebuild the authoritative position by replaying persisted moves. Replaying
 * (rather than loading the stored FEN) is what makes threefold-repetition and
 * fifty-move detection correct.
 */
export function rebuildChess(gameId) {
  const chess = new Chess();
  for (const row of SELECT_MOVES.all(gameId)) {
    try {
      chess.move(row.san);
    } catch {
      // Should be unreachable: every persisted move was validated on the way in.
      throw new Error(`Corrupt move history for game ${gameId} at "${row.san}"`);
    }
  }
  return chess;
}

/** Inspect a position and report whether (and how) the game has ended. */
export function detectOutcome(chess) {
  if (chess.isCheckmate()) {
    // The side to move has been mated, so the other side won.
    const winner = chess.turn() === "w" ? "black" : "white";
    return {
      over: true,
      result: winner === "white" ? "1-0" : "0-1",
      reason: "checkmate",
      winnerColor: winner,
    };
  }
  if (chess.isStalemate()) {
    return { over: true, result: "1/2-1/2", reason: "stalemate", winnerColor: null };
  }
  if (chess.isInsufficientMaterial()) {
    return {
      over: true,
      result: "1/2-1/2",
      reason: "insufficient_material",
      winnerColor: null,
    };
  }
  if (chess.isThreefoldRepetition()) {
    return {
      over: true,
      result: "1/2-1/2",
      reason: "threefold_repetition",
      winnerColor: null,
    };
  }
  if (chess.isDrawByFiftyMoves()) {
    return { over: true, result: "1/2-1/2", reason: "fifty_move_rule", winnerColor: null };
  }
  return { over: false, result: null, reason: null, winnerColor: null };
}

export const RESULT_REASON_LABEL = {
  checkmate: "Checkmate",
  resignation: "Resignation",
  stalemate: "Stalemate",
  timeout: "Time forfeit",
  agreement: "Draw by agreement",
  insufficient_material: "Insufficient material",
  threefold_repetition: "Threefold repetition",
  fifty_move_rule: "Fifty-move rule",
  abandoned: "Abandoned",
};

/** Produce a standards-compliant PGN with the real player names and result. */
export function buildPgn(game, whiteName, blackName) {
  const chess = rebuildChess(game.id);
  const date = (game.started_at || game.created_at || "").slice(0, 10).replace(/-/g, ".");
  chess.setHeader("Event", "Casual Game");
  chess.setHeader("Site", "Chess Coach");
  chess.setHeader("Date", date || "????.??.??");
  chess.setHeader("Round", "-");
  chess.setHeader("White", whiteName || "?");
  chess.setHeader("Black", blackName || "?");
  chess.setHeader("Result", game.result || "*");
  if (game.result_reason) {
    chess.setHeader("Termination", RESULT_REASON_LABEL[game.result_reason] || game.result_reason);
  }
  if (game.initial_time > 0) {
    chess.setHeader("TimeControl", `${game.initial_time}+${game.increment}`);
  }
  return chess.pgn();
}

/** Legal destination squares keyed by origin, for client-side move hints. */
export function legalMoveMap(chess) {
  const out = {};
  for (const m of chess.moves({ verbose: true })) {
    (out[m.from] ||= []).push(m.to);
  }
  return out;
}

export function colorOfUser(game, userId) {
  if (game.white_id === userId) return "white";
  if (game.black_id === userId) return "black";
  return null;
}
