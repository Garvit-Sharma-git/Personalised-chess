/**
 * Authoritative game logic. Every mutation validates against the rebuilt
 * chess.js position and persists inside a transaction; the socket layer and
 * REST routes are thin wrappers over these functions.
 */
import { db } from "../db.js";
import { isCoachAccount } from "../config.js";
import {
  START_FEN,
  generateRoomCode,
  rebuildChess,
  detectOutcome,
  buildPgn,
  legalMoveMap,
  colorOfUser,
  uciOf,
} from "../lib/gameState.js";
import { queueAnalysis } from "./analysis.js";

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ELO_K = 32;

const S = {
  byCode: db.prepare("SELECT * FROM games WHERE code = ?"),
  byId: db.prepare("SELECT * FROM games WHERE id = ?"),
  user: db.prepare("SELECT id, username, rating, email FROM users WHERE id = ?"),
  insert: db.prepare(`
    INSERT INTO games (code, white_id, black_id, creator_id, creator_color, status, fen,
      initial_time, increment, white_time_ms, black_time_ms, rated)
    VALUES (@code, @white_id, @black_id, @creator_id, @creator_color, 'waiting', @fen,
      @initial_time, @increment, @time_ms, @time_ms, @rated)
  `),
  seat: db.prepare(
    "UPDATE games SET white_id = COALESCE(white_id, @white), black_id = COALESCE(black_id, @black), status = 'active', started_at = datetime('now') WHERE id = @id"
  ),
  moves: db.prepare(
    "SELECT ply, move_number, color, san, uci, fen_after, captured, is_check, time_spent_ms, clock_ms FROM moves WHERE game_id = ? ORDER BY ply ASC"
  ),
  insertMove: db.prepare(`
    INSERT INTO moves (game_id, ply, move_number, color, san, uci, fen_before, fen_after, captured, is_check, time_spent_ms, clock_ms)
    VALUES (@game_id, @ply, @move_number, @color, @san, @uci, @fen_before, @fen_after, @captured, @is_check, @time_spent_ms, @clock_ms)
  `),
  afterMove: db.prepare(`
    UPDATE games SET fen = @fen, pgn = @pgn, move_count = @move_count, white_time_ms = @white_time_ms,
      black_time_ms = @black_time_ms, turn_started_at = @turn_started_at, draw_offer_by = NULL
    WHERE id = @id
  `),
  finish: db.prepare(`
    UPDATE games SET status = 'finished', result = @result, result_reason = @reason, winner_id = @winner_id,
      pgn = @pgn, turn_started_at = NULL, draw_offer_by = NULL, ended_at = datetime('now')
    WHERE id = @id
  `),
  abort: db.prepare(
    "UPDATE games SET status = 'aborted', result_reason = 'abandoned', turn_started_at = NULL, ended_at = datetime('now') WHERE id = ?"
  ),
  drawOffer: db.prepare("UPDATE games SET draw_offer_by = ? WHERE id = ?"),
  rating: db.prepare("UPDATE users SET rating = ? WHERE id = ?"),
  touch: db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?"),
};

export function getGameByCode(code) {
  if (!code) return null;
  return S.byCode.get(String(code).toUpperCase()) || null;
}

export function getGameById(id) {
  return S.byId.get(id) || null;
}

function publicPlayer(id) {
  if (!id) return null;
  const u = S.user.get(id);
  return u ? { id: u.id, username: u.username, rating: u.rating } : null;
}

export function sideToMove(game) {
  return game.move_count % 2 === 0 ? "white" : "black";
}

/** Remaining clocks right now, and whether the side to move has flagged. */
export function computeClocks(game, now = Date.now()) {
  let whiteMs = game.white_time_ms;
  let blackMs = game.black_time_ms;
  let flagged = null;
  if (game.status === "active" && game.initial_time > 0 && game.turn_started_at) {
    const elapsed = Math.max(0, now - game.turn_started_at);
    if (sideToMove(game) === "white") {
      whiteMs -= elapsed;
      if (whiteMs <= 0) flagged = "white";
    } else {
      blackMs -= elapsed;
      if (blackMs <= 0) flagged = "black";
    }
  }
  return { whiteMs: Math.max(0, whiteMs), blackMs: Math.max(0, blackMs), flagged };
}

// ---------------------------------------------------------------------------
// Creation / seating
// ---------------------------------------------------------------------------

export function createGame({ creatorId, color = "random", initialTime = 600, increment = 5, rated = true }) {
  if (!["white", "black", "random"].includes(color)) throw new GameError("Invalid colour");
  initialTime = Math.max(0, Math.min(7200, Math.floor(Number(initialTime) || 0)));
  increment = Math.max(0, Math.min(180, Math.floor(Number(increment) || 0)));

  const chosen = color === "random" ? (Math.random() < 0.5 ? "white" : "black") : color;
  let code;
  do {
    code = generateRoomCode();
  } while (S.byCode.get(code));

  S.insert.run({
    code,
    white_id: chosen === "white" ? creatorId : null,
    black_id: chosen === "black" ? creatorId : null,
    creator_id: creatorId,
    creator_color: color,
    fen: START_FEN,
    initial_time: initialTime,
    increment,
    time_ms: initialTime * 1000,
    rated: rated ? 1 : 0,
  });
  return getGameByCode(code);
}

/** Seat `userId` in the open seat of a waiting game. Idempotent for participants. */
export function joinGame({ code, userId }) {
  const game = getGameByCode(code);
  if (!game) throw new GameError("Game not found", 404);
  if (colorOfUser(game, userId)) return game;
  if (game.status !== "waiting") throw new GameError("This game already has two players", 403);
  if (game.white_id && game.black_id) throw new GameError("This game is full", 403);

  S.seat.run({
    id: game.id,
    white: game.white_id ? null : userId,
    black: game.black_id ? null : userId,
  });
  return getGameById(game.id);
}

/** Can this user see the game at all? Live games are for participants only. */
export function canView(game, userId) {
  if (!game) return false;
  if (colorOfUser(game, userId)) return true;
  if (game.status === "waiting") return true; // an open invitation link
  return game.status === "finished" || game.status === "aborted";
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

function updateRatings(game, result) {
  if (!game.rated || !game.white_id || !game.black_id || game.white_id === game.black_id) return null;
  const white = S.user.get(game.white_id);
  const black = S.user.get(game.black_id);
  if (!white || !black) return null;
  const scoreW = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
  const expW = 1 / (1 + 10 ** ((black.rating - white.rating) / 400));
  const deltaW = Math.round(ELO_K * (scoreW - expW));
  S.rating.run(white.rating + deltaW, white.id);
  S.rating.run(black.rating - deltaW, black.id);
  return { white: deltaW, black: -deltaW };
}

const finishGameTx = db.transaction((game, { result, reason, winnerColor }) => {
  const winnerId = winnerColor === "white" ? game.white_id : winnerColor === "black" ? game.black_id : null;
  const white = S.user.get(game.white_id);
  const black = S.user.get(game.black_id);
  const finished = { ...game, result, result_reason: reason };
  const pgn = buildPgn(finished, white?.username, black?.username);
  S.finish.run({ id: game.id, result, reason, winner_id: winnerId, pgn });
  const ratingChange = updateRatings(game, result);
  return ratingChange;
});

export function finishGame(game, outcome) {
  const ratingChange = finishGameTx(game, outcome);
  const updated = getGameById(game.id);
  if (updated.move_count > 0) queueAnalysis(game.id);
  return { game: updated, ratingChange };
}

/** Flag the side to move if its clock has run out. Returns the updated game or null. */
export function checkTimeout(game, now = Date.now()) {
  if (!game || game.status !== "active") return null;
  const { flagged } = computeClocks(game, now);
  if (!flagged) return null;
  const chess = rebuildChess(game.id);
  const opponent = flagged === "white" ? "b" : "w";
  // A side with no mating material cannot win on time.
  const material = chess
    .board()
    .flat()
    .filter((p) => p && p.color === opponent && p.type !== "k")
    .map((p) => p.type);
  const insufficient =
    material.length === 0 || (material.length === 1 && (material[0] === "n" || material[0] === "b"));
  const outcome = insufficient
    ? { result: "1/2-1/2", reason: "timeout", winnerColor: null }
    : { result: flagged === "white" ? "0-1" : "1-0", reason: "timeout", winnerColor: opponent === "w" ? "white" : "black" };
  return finishGame(game, outcome);
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

const makeMoveTx = db.transaction((game, userId, { from, to, promotion }, now) => {
  const color = colorOfUser(game, userId);
  if (!color) throw new GameError("You are not a player in this game", 403);
  if (game.status !== "active") throw new GameError("The game is not in progress");

  const chess = rebuildChess(game.id);
  const turn = chess.turn() === "w" ? "white" : "black";
  if (turn !== color) throw new GameError("It is not your turn");

  const fenBefore = chess.fen();
  let move;
  try {
    move = chess.move({ from, to, promotion: promotion || undefined });
  } catch {
    throw new GameError("Illegal move");
  }

  const ply = chess.history().length;
  const timeSpent = game.turn_started_at ? Math.max(0, now - game.turn_started_at) : null;
  let whiteMs = game.white_time_ms;
  let blackMs = game.black_time_ms;
  if (game.initial_time > 0 && timeSpent != null) {
    if (color === "white") whiteMs = whiteMs - timeSpent + game.increment * 1000;
    else blackMs = blackMs - timeSpent + game.increment * 1000;
  }

  S.insertMove.run({
    game_id: game.id,
    ply,
    move_number: Math.ceil(ply / 2),
    color: move.color,
    san: move.san,
    uci: uciOf(move),
    fen_before: fenBefore,
    fen_after: move.after,
    captured: move.captured || null,
    is_check: chess.isCheck() ? 1 : 0,
    time_spent_ms: timeSpent,
    clock_ms: game.initial_time > 0 ? (color === "white" ? whiteMs : blackMs) : null,
  });

  S.afterMove.run({
    id: game.id,
    fen: move.after,
    pgn: chess.pgn(),
    move_count: ply,
    white_time_ms: whiteMs,
    black_time_ms: blackMs,
    turn_started_at: now,
  });

  const outcome = detectOutcome(chess);
  return { move, outcome };
});

export function makeMove(game, userId, input) {
  const now = Date.now();
  // The mover may already have flagged before the move arrived.
  const timedOut = checkTimeout(game, now);
  if (timedOut) return { ...timedOut, move: null, timedOut: true };

  const { move, outcome } = makeMoveTx(game, userId, input, now);
  let updated = getGameById(game.id);
  let ratingChange = null;
  if (outcome.over) {
    ({ game: updated, ratingChange } = finishGame(updated, outcome));
  }
  return { game: updated, move, outcome, ratingChange };
}

// ---------------------------------------------------------------------------
// Resign / draw / abort
// ---------------------------------------------------------------------------

export function resign(game, userId) {
  const color = colorOfUser(game, userId);
  if (!color) throw new GameError("You are not a player in this game", 403);
  if (game.status !== "active") throw new GameError("The game is not in progress");
  const winnerColor = color === "white" ? "black" : "white";
  return finishGame(game, {
    result: winnerColor === "white" ? "1-0" : "0-1",
    reason: "resignation",
    winnerColor,
  });
}

export function handleDraw(game, userId, action) {
  const color = colorOfUser(game, userId);
  if (!color) throw new GameError("You are not a player in this game", 403);
  if (game.status !== "active") throw new GameError("The game is not in progress");

  if (action === "offer") {
    if (game.draw_offer_by === color) return { game };
    if (game.draw_offer_by && game.draw_offer_by !== color) {
      // Offering while the opponent's offer stands counts as acceptance.
      return finishGame(game, { result: "1/2-1/2", reason: "agreement", winnerColor: null });
    }
    S.drawOffer.run(color, game.id);
    return { game: getGameById(game.id), offered: true };
  }
  if (action === "accept") {
    if (!game.draw_offer_by || game.draw_offer_by === color) throw new GameError("No draw offer to accept");
    return finishGame(game, { result: "1/2-1/2", reason: "agreement", winnerColor: null });
  }
  if (action === "decline") {
    if (game.draw_offer_by && game.draw_offer_by !== color) S.drawOffer.run(null, game.id);
    return { game: getGameById(game.id), declined: true };
  }
  throw new GameError("Unknown draw action");
}

export function abortGame(game, userId) {
  const color = colorOfUser(game, userId);
  if (!color && game.creator_id !== userId) throw new GameError("Not your game", 403);
  if (game.status === "waiting" || (game.status === "active" && game.move_count < 2)) {
    S.abort.run(game.id);
    return { game: getGameById(game.id) };
  }
  throw new GameError("The game can no longer be aborted; resign instead");
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export function serializeGame(game, viewer) {
  const viewerId = viewer?.id ?? null;
  const color = viewerId ? colorOfUser(game, viewerId) : null;
  const moves = S.moves.all(game.id).map((m) => ({
    ply: m.ply,
    moveNumber: m.move_number,
    color: m.color,
    san: m.san,
    uci: m.uci,
    from: m.uci.slice(0, 2),
    to: m.uci.slice(2, 4),
    fen: m.fen_after,
    captured: m.captured,
    check: !!m.is_check,
    timeSpentMs: m.time_spent_ms,
    clockMs: m.clock_ms,
  }));
  const last = moves[moves.length - 1] || null;
  const clocks = computeClocks(game);
  const turn = sideToMove(game);

  let legalMoves = null;
  let inCheck = false;
  if (game.status === "active") {
    const chess = rebuildChess(game.id);
    inCheck = chess.isCheck();
    if (color && color === turn) legalMoves = legalMoveMap(chess);
  }

  return {
    id: game.id,
    code: game.code,
    status: game.status,
    result: game.result,
    resultReason: game.result_reason,
    winnerId: game.winner_id,
    white: publicPlayer(game.white_id),
    black: publicPlayer(game.black_id),
    creatorId: game.creator_id,
    fen: game.fen,
    pgn: game.pgn,
    moves,
    moveCount: game.move_count,
    turn,
    inCheck,
    lastMove: last ? { from: last.from, to: last.to } : null,
    clock: {
      initial: game.initial_time,
      increment: game.increment,
      whiteMs: clocks.whiteMs,
      blackMs: clocks.blackMs,
      running: game.status === "active" && game.initial_time > 0 && !!game.turn_started_at,
      serverNow: Date.now(),
    },
    drawOfferBy: game.draw_offer_by,
    rated: !!game.rated,
    createdAt: game.created_at,
    startedAt: game.started_at,
    endedAt: game.ended_at,
    viewer: {
      color,
      isPlayer: !!color,
      canUseLiveCoach: !!color && isCoachAccount(viewer?.email),
    },
    legalMoves,
  };
}

/** Compact list entry for history pages. */
export function summarizeForUser(game, userId, analysisRow) {
  const color = colorOfUser(game, userId);
  const opponentId = color === "white" ? game.black_id : game.white_id;
  let outcome = null;
  if (game.status === "finished") {
    if (game.result === "1/2-1/2") outcome = "draw";
    else if (game.winner_id === userId) outcome = "win";
    else outcome = "loss";
  }
  return {
    id: game.id,
    code: game.code,
    status: game.status,
    result: game.result,
    resultReason: game.result_reason,
    color,
    outcome,
    opponent: publicPlayer(opponentId),
    white: publicPlayer(game.white_id),
    black: publicPlayer(game.black_id),
    moveCount: game.move_count,
    timeControl: game.initial_time > 0 ? `${game.initial_time / 60}+${game.increment}` : "∞",
    rated: !!game.rated,
    createdAt: game.created_at,
    startedAt: game.started_at,
    endedAt: game.ended_at,
    analysis: analysisRow
      ? {
          status: analysisRow.status,
          accuracy: color === "white" ? analysisRow.accuracy_white : color === "black" ? analysisRow.accuracy_black : null,
          accuracyWhite: analysisRow.accuracy_white,
          accuracyBlack: analysisRow.accuracy_black,
        }
      : null,
  };
}

export function touchUser(userId) {
  S.touch.run(userId);
}
