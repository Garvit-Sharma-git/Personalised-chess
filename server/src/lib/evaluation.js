/**
 * Pure chess-evaluation helpers: win-probability model, move classification,
 * position features and tactical tags. Everything here is deterministic and
 * derived from Stockfish output + chess.js; no LLM involvement.
 */
import { Chess } from "chess.js";

export const MATE_CP = 10000;
export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAME = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

/** Convert an engine score (side-to-move POV) into a single cp-like number. */
export function scoreToCp({ cp, mate }) {
  if (mate != null && mate !== 0) {
    return mate > 0 ? MATE_CP - Math.abs(mate) : -MATE_CP + Math.abs(mate);
  }
  if (mate === 0) return -MATE_CP; // side to move is mated
  return cp ?? 0;
}

/** Lichess win-probability model (0..100) for the side the cp is measured for. */
export function winPercent(cp) {
  const clamped = Math.max(-MATE_CP, Math.min(MATE_CP, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/** Lichess per-move accuracy from a win% drop (0..100). */
export function moveAccuracy(winBefore, winAfter) {
  const drop = Math.max(0, winBefore - winAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

export function formatEval(cp, mate, { pov = "white" } = {}) {
  if (mate != null && mate !== 0) return `M${Math.abs(mate)}${mate < 0 ? " (against)" : ""}`;
  const v = (cp ?? 0) / 100;
  const s = v > 0 ? "+" : "";
  return `${s}${v.toFixed(2)}`;
}

/** Human-friendly eval from White's POV: "+1.35", "-0.40", "M3", "-M2". */
export function formatWhiteEval(whiteCp) {
  if (whiteCp >= MATE_CP - 500) return `M${MATE_CP - whiteCp}`;
  if (whiteCp <= -MATE_CP + 500) return `-M${whiteCp + MATE_CP}`;
  const v = whiteCp / 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

export function describeAdvantage(whiteCp) {
  const a = Math.abs(whiteCp);
  const side = whiteCp > 0 ? "White" : "Black";
  if (a >= MATE_CP - 500) return `${side} has a forced mate`;
  if (a < 30) return "The position is equal";
  if (a < 80) return `${side} is slightly better`;
  if (a < 200) return `${side} is clearly better`;
  if (a < 500) return `${side} is winning`;
  return `${side} is completely winning`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export const CLASSIFICATIONS = [
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "book",
  "forced",
  "inaccuracy",
  "mistake",
  "blunder",
];

export const SEVERITY = { inaccuracy: 1, mistake: 2, blunder: 3 };

/**
 * Classify a move given evaluations from the mover's point of view.
 * @param {object} p
 * @param {number} p.cpBefore   best achievable eval before the move (mover POV)
 * @param {number} p.cpAfter    eval after the move (mover POV)
 * @param {boolean} p.isBest    the played move equals the engine's top choice
 * @param {number|null} p.secondBestCp eval of the engine's second choice (mover POV), if known
 * @param {number} p.legalMoves count of legal moves in the position
 * @param {boolean} p.isSacrifice heuristic flag for a sound sacrifice
 */
export function classifyMove({
  cpBefore,
  cpAfter,
  isBest,
  secondBestCp = null,
  legalMoves = 99,
  isSacrifice = false,
}) {
  if (legalMoves <= 1) return "forced";

  const winBefore = winPercent(cpBefore);
  const winAfter = winPercent(cpAfter);
  const drop = Math.max(0, winBefore - winAfter);
  const cpLoss = Math.max(0, cpBefore - cpAfter);

  const hadMate = cpBefore >= MATE_CP - 500;
  const hasMate = cpAfter >= MATE_CP - 500;
  const gotMated = cpAfter <= -MATE_CP + 500;
  const wasLost = cpBefore <= -MATE_CP + 500;

  // Walking into a forced mate when a defence existed: a blunder from a
  // playable position, still a mistake from a lost one.
  if (gotMated && !wasLost) return cpBefore > -600 ? "blunder" : "mistake";
  // Throwing away a forced mate.
  if (hadMate && !hasMate) {
    if (cpAfter < 150) return "blunder";
    return "mistake";
  }

  if (isBest) {
    // "Great": the only move that keeps the evaluation; everything else collapses.
    if (secondBestCp != null) {
      const secondDrop = winBefore - winPercent(secondBestCp);
      if (secondDrop >= 15 && cpAfter > -150) return isSacrifice ? "brilliant" : "great";
    }
    return "best";
  }

  // Win% is the primary yardstick (it de-emphasises noise in decided positions);
  // raw centipawns catch clean material losses in balanced positions.
  let byWin = "good";
  if (drop >= 30) byWin = "blunder";
  else if (drop >= 20) byWin = "mistake";
  else if (drop >= 10) byWin = "inaccuracy";
  else if (drop >= 3) byWin = "good";
  else byWin = "excellent";

  let byCp = "excellent";
  if (Math.abs(cpBefore) <= 300) {
    if (cpLoss >= 300) byCp = "blunder";
    else if (cpLoss >= 120) byCp = "mistake";
    else if (cpLoss >= 50) byCp = "inaccuracy";
    else if (cpLoss >= 20) byCp = "good";
  } else if (cpLoss >= 20) {
    byCp = "good";
  }

  const rank = (c) => SEVERITY[c] ?? (c === "good" ? 0 : -1);
  return rank(byCp) > rank(byWin) ? byCp : byWin;
}

// ---------------------------------------------------------------------------
// Position features
// ---------------------------------------------------------------------------

export function materialOf(chess) {
  const totals = { w: 0, b: 0 };
  const pieces = { w: {}, b: {} };
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      totals[sq.color] += PIECE_VALUE[sq.type];
      pieces[sq.color][sq.type] = (pieces[sq.color][sq.type] || 0) + 1;
    }
  }
  return { white: totals.w, black: totals.b, diff: totals.w - totals.b, pieces };
}

/** Fruit-style game phase from non-pawn material (24 = opening, 0 = bare kings). */
export function phaseScore(chess) {
  const weight = { n: 1, b: 1, r: 2, q: 4 };
  let score = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && weight[sq.type]) score += weight[sq.type];
    }
  }
  return score;
}

export function gamePhase(chess, ply) {
  const score = phaseScore(chess);
  if (score <= 8) return "endgame";
  if (ply < 20 && score >= 20) return "opening";
  return "middlegame";
}

export function squareOfKing(chess, color) {
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && sq.type === "k" && sq.color === color) return sq.square;
    }
  }
  return null;
}

export function parseUci(uci) {
  if (!uci || uci.length < 4) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

export function safeMove(chess, uciOrSan) {
  try {
    if (typeof uciOrSan === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uciOrSan)) {
      return chess.move(parseUci(uciOrSan));
    }
    return chess.move(uciOrSan);
  } catch {
    return null;
  }
}

/** Convert a UCI principal variation into SAN, stopping at the first illegal move. */
export function pvToSan(fen, pv, maxPlies = 10) {
  const chess = new Chess(fen);
  const sans = [];
  for (const uci of (pv || []).slice(0, maxPlies)) {
    const m = safeMove(chess, uci);
    if (!m) break;
    sans.push(m.san);
  }
  return sans;
}

/** "18.Rfe1 Nf6 19.Qe2" style formatting starting from `fen`. */
export function formatLine(fen, sans) {
  if (!sans?.length) return "";
  const chess = new Chess(fen);
  let moveNo = chess.moveNumber();
  let white = chess.turn() === "w";
  const parts = [];
  sans.forEach((san, i) => {
    if (white) parts.push(`${moveNo}.${san}`);
    else parts.push(i === 0 ? `${moveNo}...${san}` : san);
    if (!white) moveNo++;
    white = !white;
  });
  return parts.join(" ");
}

export function uciToSan(fen, uci) {
  const chess = new Chess(fen);
  const m = safeMove(chess, uci);
  return m ? m.san : null;
}

/** Lowest-value attacker of `square` by `color` (value, square). */
function cheapestAttacker(chess, square, color) {
  let best = null;
  for (const from of chess.attackers(square, color)) {
    const piece = chess.get(from);
    if (!piece) continue;
    const v = PIECE_VALUE[piece.type];
    if (!best || v < best.value) best = { value: v, square: from, type: piece.type };
  }
  return best;
}

/**
 * Pieces of `color` that are en prise: attacked by the opponent and either
 * undefended or attacked by a cheaper piece. Kings excluded.
 */
export function hangingPieces(chess, color) {
  const opp = color === "w" ? "b" : "w";
  const out = [];
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== color || sq.type === "k") continue;
      const attacker = cheapestAttacker(chess, sq.square, opp);
      if (!attacker) continue;
      const defenders = chess.attackers(sq.square, color).length;
      const value = PIECE_VALUE[sq.type];
      if (defenders === 0 || attacker.value < value) {
        out.push({
          square: sq.square,
          type: sq.type,
          name: PIECE_NAME[sq.type],
          value,
          attackedBy: attacker.type,
          undefended: defenders === 0,
        });
      }
    }
  }
  return out.sort((a, b) => b.value - a.value);
}

/** Enemy pieces (value >= 3, or the king) attacked from `square` by the piece standing on it. */
export function piecesAttackedFrom(chess, square) {
  const piece = chess.get(square);
  if (!piece) return [];
  const opp = piece.color === "w" ? "b" : "w";
  const out = [];
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== opp) continue;
      if (sq.type !== "k" && PIECE_VALUE[sq.type] < 3) continue;
      if (chess.attackers(sq.square, piece.color).includes(square)) {
        out.push({ square: sq.square, type: sq.type, name: PIECE_NAME[sq.type] });
      }
    }
  }
  return out;
}

/**
 * Heuristic "sacrifice": the moved piece (value >= 3) lands on a square where it
 * can be captured profitably, or the move gives up material without recapture.
 */
export function isSacrificeMove(fenBefore, uci) {
  const chess = new Chess(fenBefore);
  const move = safeMove(chess, uci);
  if (!move || move.piece === "p" || move.piece === "k") return false;
  const value = PIECE_VALUE[move.piece];
  const captured = move.captured ? PIECE_VALUE[move.captured] : 0;
  const opp = move.color === "w" ? "b" : "w";
  const attacker = cheapestAttacker(chess, move.to, opp);
  if (!attacker) return false;
  const defended = chess.attackers(move.to, move.color).length > 0;
  const netLoss = value - captured - (defended ? attacker.value : 0);
  return netLoss >= 2;
}

/**
 * Was `opponentMove` (UCI, played from `fenAfter`) already available to the
 * opponent before the mover's move? Uses a null-move trick to detect ignored
 * threats.
 */
export function threatExistedBefore(fenBefore, opponentMove) {
  try {
    const chess = new Chess(fenBefore);
    if (chess.isCheck()) return false;
    const opp = chess.turn() === "w" ? "b" : "w";
    chess.setTurn(opp);
    return safeMove(chess, opponentMove) != null;
  } catch {
    return false;
  }
}

/** Quick feature summary of a position for prompts and hint panels. */
export function positionFeatures(fen) {
  const chess = new Chess(fen);
  const turn = chess.turn();
  const opp = turn === "w" ? "b" : "w";
  const moves = chess.moves({ verbose: true });
  const checks = moves.filter((m) => m.san.includes("+") || m.san.includes("#"));
  const captures = moves.filter((m) => m.captured);
  const material = materialOf(chess);
  return {
    turn,
    inCheck: chess.isCheck(),
    legalMoves: moves.length,
    checks: checks.map((m) => m.san),
    captures: captures.map((m) => m.san),
    ourHanging: hangingPieces(chess, turn),
    theirHanging: hangingPieces(chess, opp),
    material,
    phase: gamePhase(chess, 0),
    castling: {
      white: chess.getCastlingRights("w"),
      black: chess.getCastlingRights("b"),
    },
  };
}

/**
 * Derive tactical tags for a played move, using the engine's view of the
 * position before (best line) and after (opponent's best reply).
 */
export function tagMove({
  fenBefore,
  fenAfter,
  playedUci,
  bestUci,
  bestReplyUci,
  cpBefore,
  cpAfter,
  classification,
  ply,
  prevOwnMoveFrom,
  prevOwnMoveTo,
}) {
  const tags = [];
  const before = new Chess(fenBefore);
  const mover = before.turn();
  const opp = mover === "w" ? "b" : "w";
  const cpLoss = Math.max(0, cpBefore - cpAfter);
  const severe = SEVERITY[classification] >= 2;

  const played = safeMove(new Chess(fenBefore), playedUci);
  const after = new Chess(fenAfter);

  // Missed / allowed mate
  if (cpBefore >= MATE_CP - 500 && cpAfter < MATE_CP - 500) {
    tags.push({ tag: "missed_mate", detail: `A forced mate was available.` });
  }
  if (cpAfter <= -MATE_CP + 500 && cpBefore > -MATE_CP + 500) {
    tags.push({ tag: "allowed_mate", detail: `The move allows a forced mate.` });
  }

  // Hanging a piece: the opponent's best reply is a capture that wins material.
  if (bestReplyUci && SEVERITY[classification] >= 1) {
    const reply = safeMove(new Chess(fenAfter), bestReplyUci);
    if (reply?.captured) {
      const victimValue = PIECE_VALUE[reply.captured];
      const recapturable = after.attackers(reply.to, mover).length > 0;
      const attackerValue = PIECE_VALUE[reply.piece];
      const losesMaterial = !recapturable || attackerValue < victimValue;
      if (losesMaterial && victimValue >= 1 && cpLoss >= 80) {
        const preexisting = threatExistedBefore(fenBefore, bestReplyUci);
        const movedIntoIt = played && played.to === reply.to;
        tags.push({
          tag: movedIntoIt ? "hanging_piece" : preexisting ? "ignored_threat" : "hanging_piece",
          detail: movedIntoIt
            ? `The ${PIECE_NAME[reply.captured]} was moved to ${reply.to}, where it can simply be taken by ${reply.san}.`
            : preexisting
              ? `The ${PIECE_NAME[reply.captured]} on ${reply.to} was already under attack and the move did nothing about it (${reply.san}).`
              : `The move left the ${PIECE_NAME[reply.captured]} on ${reply.to} en prise to ${reply.san}.`,
          square: reply.to,
          piece: reply.captured,
        });
      }
    }
  }

  // Missed tactic: the engine's best move is a capture/check that wins material or more.
  if (bestUci && bestUci !== playedUci && cpLoss >= 120) {
    const best = safeMove(new Chess(fenBefore), bestUci);
    if (best) {
      const isForcing = best.captured || best.san.includes("+") || best.san.includes("#");
      const tmp = new Chess(fenBefore);
      safeMove(tmp, bestUci);
      const forked = piecesAttackedFrom(tmp, best.to);
      if (forked.length >= 2) {
        tags.push({
          tag: "missed_fork",
          detail: `${best.san} would attack ${forked.map((f) => `the ${f.name} on ${f.square}`).join(" and ")} at the same time.`,
        });
      } else if (best.captured && !before.attackers(best.to, opp).length) {
        tags.push({
          tag: "missed_free_piece",
          detail: `${best.san} simply wins the undefended ${PIECE_NAME[best.captured]} on ${best.to}.`,
        });
      } else if (isForcing) {
        tags.push({
          tag: "missed_tactic",
          detail: `The forcing move ${best.san} was much stronger.`,
        });
      } else if (cpLoss >= 200) {
        tags.push({ tag: "missed_opportunity", detail: `${best.san} was significantly stronger.` });
      }
    }
  }

  // Moving the same piece repeatedly in the opening.
  if (ply < 20 && played && prevOwnMoveTo && played.from === prevOwnMoveTo && played.piece !== "p") {
    if (played.piece !== "k" || !played.san.startsWith("O")) {
      tags.push({
        tag: "same_piece_twice",
        detail: `The ${PIECE_NAME[played.piece]} moved again instead of developing a new piece.`,
      });
    }
  }

  // Leaving own pieces en prise after a non-losing move is still worth noting when the engine punishes it.
  if (severe && !tags.some((t) => t.tag === "hanging_piece" || t.tag === "ignored_threat")) {
    const hanging = hangingPieces(after, mover).filter((h) => h.value >= 3);
    if (hanging.length) {
      tags.push({
        tag: "loose_piece",
        detail: `After the move the ${hanging[0].name} on ${hanging[0].square} is loose.`,
        square: hanging[0].square,
      });
    }
  }

  // King safety: a severe mistake while the king is uncastled and it is past the opening.
  if (severe && ply >= 16) {
    const kingSq = squareOfKing(before, mover);
    const home = mover === "w" ? "e1" : "e8";
    const rights = before.getCastlingRights(mover);
    if (kingSq === home && (rights.k || rights.q)) {
      tags.push({ tag: "king_in_centre", detail: "The king was still uncastled in the centre." });
    }
  }

  // Strong-move tags for positive feedback.
  if (["great", "brilliant", "best"].includes(classification) && played) {
    const tmp = new Chess(fenBefore);
    safeMove(tmp, playedUci);
    const forked = piecesAttackedFrom(tmp, played.to);
    if (forked.length >= 2) tags.push({ tag: "fork", detail: `${played.san} forks ${forked.map((f) => f.name).join(" and ")}.` });
    if (played.san.includes("#")) tags.push({ tag: "checkmate", detail: "Checkmate delivered." });
  }

  return tags;
}

export const TAG_LABELS = {
  missed_mate: "Missed mate",
  allowed_mate: "Allowed mate",
  hanging_piece: "Hung a piece",
  ignored_threat: "Missed opponent's threat",
  missed_fork: "Missed fork",
  missed_free_piece: "Missed free piece",
  missed_tactic: "Missed tactic",
  missed_opportunity: "Missed opportunity",
  same_piece_twice: "Moved same piece twice",
  loose_piece: "Loose piece",
  king_in_centre: "King left in centre",
  fork: "Fork",
  checkmate: "Checkmate",
  rushed: "Played too fast",
  time_pressure: "Time pressure",
};
