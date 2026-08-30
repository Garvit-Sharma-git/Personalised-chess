/**
 * Post-game analysis pipeline.
 *
 *   Stockfish  -> evaluations, best moves, alternative lines   (this file)
 *   heuristics -> classification, tactical tags, phases       (lib/evaluation.js)
 *   Groq       -> human explanations and coaching             (chessReview.js)
 *
 * Every position of the game is searched once with MultiPV, which yields both
 * "what was best here" and "how good was the previous move" in a single pass.
 */
import { Chess } from "chess.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { enginePool, ensureEngine } from "./engine.js";
import * as E from "../lib/evaluation.js";
import { identifyOpening } from "../lib/openings.js";
import { START_FEN } from "../lib/gameState.js";
import { reviewService } from "./chessReview.js";
import { derivePatternCounts, recordPatterns } from "./patterns.js";

const SELECT_GAME = db.prepare("SELECT * FROM games WHERE id = ?");
const SELECT_MOVES = db.prepare("SELECT * FROM moves WHERE game_id = ? ORDER BY ply ASC");
const SELECT_ANALYSIS = db.prepare("SELECT * FROM analyses WHERE game_id = ?");
const SELECT_MOVE_ANALYSES = db.prepare(
  "SELECT * FROM move_analyses WHERE game_id = ? ORDER BY ply ASC"
);
const UPSERT_ANALYSIS = db.prepare(`
  INSERT INTO analyses (game_id, status, progress) VALUES (?, 'pending', 0)
  ON CONFLICT(game_id) DO NOTHING
`);
const UPDATE_STATUS = db.prepare(
  "UPDATE analyses SET status = ?, progress = ?, error = ? WHERE game_id = ?"
);
const UPDATE_PROGRESS = db.prepare("UPDATE analyses SET progress = ? WHERE game_id = ?");
const FINALIZE_ENGINE = db.prepare(`
  UPDATE analyses SET status = 'coaching', progress = 1, engine_depth = ?, engine_name = ?,
    accuracy_white = ?, accuracy_black = ?, acpl_white = ?, acpl_black = ?, summary_json = ?
  WHERE game_id = ?
`);
const FINALIZE_COACHING = db.prepare(`
  UPDATE analyses SET status = 'done', coaching_json = ?, error = ?, completed_at = datetime('now')
  WHERE game_id = ?
`);
const MARK_PATTERNS = db.prepare("UPDATE analyses SET patterns_recorded = 1 WHERE game_id = ?");
const DELETE_MOVE_ANALYSES = db.prepare("DELETE FROM move_analyses WHERE game_id = ?");
const INSERT_MOVE_ANALYSIS = db.prepare(`
  INSERT INTO move_analyses (
    game_id, ply, color, san, uci, fen_before, fen_after, phase,
    eval_before_cp, mate_before, eval_after_cp, mate_after,
    cp_loss, win_before, win_after, win_drop, accuracy, classification,
    best_move_uci, best_move_san, best_line_san, played_line_san,
    alternatives_json, tags_json, is_critical, explanation, improvement, headline
  ) VALUES (
    @game_id, @ply, @color, @san, @uci, @fen_before, @fen_after, @phase,
    @eval_before_cp, @mate_before, @eval_after_cp, @mate_after,
    @cp_loss, @win_before, @win_after, @win_drop, @accuracy, @classification,
    @best_move_uci, @best_move_san, @best_line_san, @played_line_san,
    @alternatives_json, @tags_json, @is_critical, @explanation, @improvement, @headline
  )
`);
const UPDATE_EXPLANATION = db.prepare(
  "UPDATE move_analyses SET explanation = ?, improvement = ?, headline = ? WHERE game_id = ? AND ply = ?"
);

// ---------------------------------------------------------------------------
// Engine pass
// ---------------------------------------------------------------------------

async function evaluatePosition(fen, { depth, movetime, multiPv }) {
  const chess = new Chess(fen);
  const turn = chess.turn();
  const sign = turn === "w" ? 1 : -1;

  if (chess.isGameOver()) {
    const mated = chess.isCheckmate();
    return {
      terminal: true,
      bestMove: null,
      lines: [],
      whiteCp: mated ? -sign * E.MATE_CP : 0,
      whiteMate: null,
      depth: null,
    };
  }

  const result = await enginePool.search({ fen, depth, movetime, multiPv });
  const lines = result.lines.map((l) => {
    const stmCp = E.scoreToCp(l);
    return {
      multipv: l.multipv,
      uci: l.pv[0],
      pv: l.pv,
      stmCp,
      whiteCp: sign * stmCp,
      stmMate: l.mate ?? null,
      whiteMate: l.mate != null ? sign * l.mate : null,
      depth: l.depth,
    };
  });
  const top = lines[0];
  return {
    terminal: false,
    bestMove: result.bestMove || top?.uci || null,
    lines,
    whiteCp: top ? top.whiteCp : 0,
    whiteMate: top ? top.whiteMate : null,
    depth: result.depth,
  };
}

async function evaluatePositions(fens, opts, onProgress) {
  const results = new Array(fens.length);
  let next = 0;
  let done = 0;
  const concurrency = Math.max(1, Math.min(opts.concurrency, fens.length));
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < fens.length) {
      const k = next++;
      results[k] = await evaluatePosition(fens[k], opts);
      done++;
      onProgress?.(done / fens.length);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Per-move interpretation
// ---------------------------------------------------------------------------

function buildMoveAnalyses(game, moves, evals) {
  const out = [];
  const lastOwnTo = { w: null, b: null };
  const lastOwnFrom = { w: null, b: null };

  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    const before = evals[i];
    const after = evals[i + 1];
    const mover = mv.color;
    const sign = mover === "w" ? 1 : -1;

    const chessBefore = new Chess(mv.fen_before);
    const legalMoves = chessBefore.moves().length;

    // Mover's point of view for the quality metrics.
    const moverCpBefore = sign * before.whiteCp;
    const moverCpAfter = sign * after.whiteCp;
    const secondBestCp = before.lines[1] ? before.lines[1].stmCp : null;
    const isBest = mv.uci === before.bestMove || moverCpAfter >= moverCpBefore;
    const isSacrifice = isBest && E.isSacrificeMove(mv.fen_before, mv.uci);

    const classification = E.classifyMove({
      cpBefore: moverCpBefore,
      cpAfter: moverCpAfter,
      isBest,
      secondBestCp,
      legalMoves,
      isSacrifice,
    });

    const winBefore = E.winPercent(moverCpBefore);
    const winAfter = E.winPercent(moverCpAfter);
    const winDrop = Math.max(0, winBefore - winAfter);
    const cpLoss = Math.min(1000, Math.max(0, moverCpBefore - moverCpAfter));
    const accuracy = classification === "forced" ? 100 : E.moveAccuracy(winBefore, winAfter);

    const bestUci = before.bestMove;
    const bestSan = bestUci ? E.uciToSan(mv.fen_before, bestUci) : null;
    const bestLine = before.lines[0]
      ? E.formatLine(mv.fen_before, E.pvToSan(mv.fen_before, before.lines[0].pv, 8))
      : "";
    const playedContinuation = after.lines[0]
      ? E.pvToSan(mv.fen_after, after.lines[0].pv, 6)
      : [];
    const playedLine = E.formatLine(mv.fen_before, [mv.san, ...playedContinuation]);

    const alternatives = before.lines.slice(0, 3).map((l) => ({
      uci: l.uci,
      san: E.uciToSan(mv.fen_before, l.uci),
      whiteCp: l.whiteCp,
      whiteMate: l.whiteMate,
      evalText: E.formatWhiteEval(l.whiteCp),
      line: E.formatLine(mv.fen_before, E.pvToSan(mv.fen_before, l.pv, 6)),
    }));

    const tags = E.tagMove({
      fenBefore: mv.fen_before,
      fenAfter: mv.fen_after,
      playedUci: mv.uci,
      bestUci,
      bestReplyUci: after.bestMove,
      cpBefore: moverCpBefore,
      cpAfter: moverCpAfter,
      classification,
      ply: mv.ply - 1,
      prevOwnMoveFrom: lastOwnFrom[mover],
      prevOwnMoveTo: lastOwnTo[mover],
    });

    // Clock-derived tags.
    if (game.initial_time > 0 && mv.time_spent_ms != null) {
      const severe = E.SEVERITY[classification] >= 2;
      if (severe && mv.time_spent_ms < 3000 && mv.ply > 10) {
        tags.push({
          tag: "rushed",
          detail: `Played in ${(mv.time_spent_ms / 1000).toFixed(1)}s in a position that deserved more thought.`,
        });
      }
      if (
        E.SEVERITY[classification] >= 1 &&
        mv.clock_ms != null &&
        mv.clock_ms < game.initial_time * 1000 * 0.1
      ) {
        tags.push({ tag: "time_pressure", detail: "Played with under 10% of the clock remaining." });
      }
    }

    const phase = E.gamePhase(chessBefore, mv.ply - 1);

    lastOwnTo[mover] = mv.uci.slice(2, 4);
    lastOwnFrom[mover] = mv.uci.slice(0, 2);

    out.push({
      ply: mv.ply,
      moveNumber: mv.move_number,
      color: mover,
      san: mv.san,
      uci: mv.uci,
      fenBefore: mv.fen_before,
      fenAfter: mv.fen_after,
      phase,
      evalBefore: before.whiteCp,
      mateBefore: before.whiteMate,
      evalAfter: after.whiteCp,
      mateAfter: after.whiteMate,
      moverCpBefore,
      moverCpAfter,
      cpLoss,
      winBefore,
      winAfter,
      winDrop,
      accuracy,
      classification,
      bestMoveUci: bestUci,
      bestMoveSan: bestSan,
      bestLine,
      playedLine,
      alternatives,
      tags,
      timeSpentMs: mv.time_spent_ms,
      clockMs: mv.clock_ms,
      isCritical: false,
    });
  }
  return out;
}

function playerStats(moves, color) {
  const own = moves.filter((m) => m.color === color);
  const counts = {};
  for (const c of E.CLASSIFICATIONS) counts[c] = 0;
  const phases = {};
  const tagCounts = {};
  let cpSum = 0;
  let accSum = 0;
  let timeSum = 0;
  let timed = 0;
  let fastMoves = 0;
  let slowest = null;

  for (const m of own) {
    counts[m.classification] = (counts[m.classification] || 0) + 1;
    cpSum += m.cpLoss;
    accSum += m.accuracy;
    const ph = (phases[m.phase] ||= { moves: 0, cpSum: 0, mistakes: 0, accSum: 0 });
    ph.moves++;
    ph.cpSum += m.cpLoss;
    ph.accSum += m.accuracy;
    if (E.SEVERITY[m.classification] >= 2) ph.mistakes++;
    for (const t of m.tags) tagCounts[t.tag] = (tagCounts[t.tag] || 0) + 1;
    if (m.timeSpentMs != null) {
      timed++;
      timeSum += m.timeSpentMs;
      if (m.timeSpentMs < 2000) fastMoves++;
      if (!slowest || m.timeSpentMs > slowest.ms) slowest = { ms: m.timeSpentMs, san: m.san, ply: m.ply };
    }
  }

  for (const ph of Object.values(phases)) {
    ph.acpl = ph.moves ? Math.round(ph.cpSum / ph.moves) : 0;
    ph.accuracy = ph.moves ? Number((ph.accSum / ph.moves).toFixed(1)) : null;
    delete ph.cpSum;
    delete ph.accSum;
  }

  return {
    moves: own.length,
    accuracy: own.length ? Number((accSum / own.length).toFixed(1)) : null,
    acpl: own.length ? Math.round(cpSum / own.length) : null,
    counts,
    phases,
    tags: tagCounts,
    time: timed
      ? {
          avgMs: Math.round(timeSum / timed),
          fastMoves,
          slowest,
        }
      : null,
  };
}

function findTurningPoint(moves, game) {
  if (!game.result || game.result === "1/2-1/2") return null;
  const loser = game.result === "1-0" ? "b" : "w";
  const loserMoves = moves.filter((m) => m.color === loser);
  let best = null;
  for (const m of loserMoves) {
    if (m.winAfter >= 40) continue;
    // Did the loser ever recover to a roughly equal position afterwards?
    const recovered = moves.some(
      (x) => x.ply > m.ply && (x.color === loser ? x.winAfter : 100 - x.winAfter) >= 50
    );
    if (recovered) continue;
    if (!best || m.winDrop > best.winDrop) best = m;
  }
  return best && best.winDrop >= 8 ? best : null;
}

function markKeyMoments(moves, game) {
  const turningPoint = findTurningPoint(moves, game);
  const negative = moves
    .filter((m) => E.SEVERITY[m.classification] >= 1 || m.tags.some((t) => t.tag === "missed_mate"))
    .sort((a, b) => b.winDrop - a.winDrop);
  const positive = moves.filter((m) => ["great", "brilliant"].includes(m.classification));

  const picked = new Set();
  for (const m of moves) {
    if (m.classification === "blunder") picked.add(m.ply);
    if (m.tags.some((t) => t.tag === "missed_mate" || t.tag === "allowed_mate")) picked.add(m.ply);
  }
  if (turningPoint) picked.add(turningPoint.ply);
  for (const color of ["w", "b"]) {
    negative
      .filter((m) => m.color === color)
      .slice(0, 3)
      .forEach((m) => picked.add(m.ply));
  }
  positive.slice(0, 3).forEach((m) => picked.add(m.ply));

  for (const m of moves) m.isCritical = picked.has(m.ply);

  const keyMoments = moves
    .filter((m) => m.isCritical)
    .map((m) => ({
      ply: m.ply,
      moveNumber: m.moveNumber,
      color: m.color,
      san: m.san,
      classification: m.classification,
      winDrop: Number(m.winDrop.toFixed(1)),
      evalBefore: m.evalBefore,
      evalAfter: m.evalAfter,
      bestMoveSan: m.bestMoveSan,
      tags: m.tags.map((t) => t.tag),
      isTurningPoint: turningPoint?.ply === m.ply,
      positive: ["great", "brilliant"].includes(m.classification),
    }));

  return { keyMoments, turningPoint: turningPoint ? turningPoint.ply : null };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function analyzeGame(gameId, { force = false } = {}) {
  const game = SELECT_GAME.get(gameId);
  if (!game) throw new Error(`Game ${gameId} not found`);
  const moves = SELECT_MOVES.all(gameId);

  UPSERT_ANALYSIS.run(gameId);
  const existing = SELECT_ANALYSIS.get(gameId);
  if (existing.status === "done" && !force) return existing;
  // Patterns are counted once per game; a forced re-run must not add them again.
  const patternsAlreadyRecorded = !!existing.patterns_recorded;

  UPDATE_STATUS.run("running", 0, null, gameId);
  const started = Date.now();

  try {
    await ensureEngine();
    const opts = {
      depth: config.engine.analysisDepth,
      movetime: config.engine.analysisMovetimeMs,
      multiPv: config.engine.multiPv,
      concurrency: Math.max(1, config.engine.poolSize - 1),
    };

    const fens = [moves[0]?.fen_before || START_FEN, ...moves.map((m) => m.fen_after)];
    let lastProgressWrite = 0;
    const evals = await evaluatePositions(fens, opts, (p) => {
      const now = Date.now();
      if (now - lastProgressWrite > 400 || p === 1) {
        UPDATE_PROGRESS.run(p * 0.9, gameId);
        lastProgressWrite = now;
      }
    });

    const analysed = buildMoveAnalyses(game, moves, evals);
    const { keyMoments, turningPoint } = markKeyMoments(analysed, game);
    const white = playerStats(analysed, "w");
    const black = playerStats(analysed, "b");
    const opening = identifyOpening(moves.map((m) => m.san));

    const evalGraph = evals.map((e, ply) => ({
      ply,
      whiteCp: Math.max(-1500, Math.min(1500, e.whiteCp)),
      whiteWin: Number(E.winPercent(e.whiteCp).toFixed(1)),
      mate: e.whiteMate,
      text: E.formatWhiteEval(e.whiteCp),
    }));

    const summary = {
      opening,
      engine: {
        name: enginePool.info.name,
        depth: opts.depth,
        movetimeMs: opts.movetime,
        multiPv: opts.multiPv,
        elapsedMs: Date.now() - started,
      },
      players: { white, black },
      keyMoments,
      turningPoint,
      evalGraph,
      result: game.result,
      resultReason: game.result_reason,
      totalPlies: moves.length,
    };

    // Deterministic template explanations first; the LLM enriches them later.
    for (const m of analysed) {
      const t = reviewService.templateExplanation(m);
      m.explanation = t.why;
      m.improvement = t.improve;
      m.headline = t.headline;
    }

    db.transaction(() => {
      DELETE_MOVE_ANALYSES.run(gameId);
      for (const m of analysed) {
        INSERT_MOVE_ANALYSIS.run({
          game_id: gameId,
          ply: m.ply,
          color: m.color,
          san: m.san,
          uci: m.uci,
          fen_before: m.fenBefore,
          fen_after: m.fenAfter,
          phase: m.phase,
          eval_before_cp: m.evalBefore,
          mate_before: m.mateBefore,
          eval_after_cp: m.evalAfter,
          mate_after: m.mateAfter,
          cp_loss: m.cpLoss,
          win_before: m.winBefore,
          win_after: m.winAfter,
          win_drop: m.winDrop,
          accuracy: m.accuracy,
          classification: m.classification,
          best_move_uci: m.bestMoveUci,
          best_move_san: m.bestMoveSan,
          best_line_san: m.bestLine,
          played_line_san: m.playedLine,
          alternatives_json: JSON.stringify(m.alternatives),
          tags_json: JSON.stringify(m.tags),
          is_critical: m.isCritical ? 1 : 0,
          explanation: m.explanation,
          improvement: m.improvement,
          headline: m.headline,
        });
      }
      FINALIZE_ENGINE.run(
        opts.depth,
        enginePool.info.name,
        white.accuracy,
        black.accuracy,
        white.acpl,
        black.acpl,
        JSON.stringify(summary),
        gameId
      );
    })();

    // LLM coaching pass (never fatal). Runs before this game's patterns are
    // recorded so the "recurring patterns" context refers to earlier games only.
    let coaching = null;
    let coachingError = null;
    try {
      coaching = await reviewService.generateReview({ game, summary, moves: analysed });
      for (const [ply, text] of Object.entries(coaching.moveExplanations || {})) {
        UPDATE_EXPLANATION.run(text.why, text.improve, text.headline, gameId, Number(ply));
      }
    } catch (err) {
      coachingError = err.message;
      console.error(`[analysis] coaching failed for game ${gameId}:`, err.message);
    }

    // Cross-game pattern tracking for each registered player (once per game).
    const lostOnTime = (color) =>
      game.result_reason === "timeout" && game.result === (color === "w" ? "0-1" : "1-0");
    for (const [color, userId, stats] of [
      ["w", game.white_id, white],
      ["b", game.black_id, black],
    ]) {
      if (!userId || patternsAlreadyRecorded) continue;
      const own = analysed.filter((m) => m.color === color);
      const counts = derivePatternCounts(own, stats, { lostOnTime: lostOnTime(color) });
      recordPatterns(userId, gameId, counts);
    }
    if (!patternsAlreadyRecorded) MARK_PATTERNS.run(gameId);
    FINALIZE_COACHING.run(
      JSON.stringify(coaching ? { ...coaching, moveExplanations: undefined } : { provider: "template" }),
      coachingError,
      gameId
    );
    return SELECT_ANALYSIS.get(gameId);
  } catch (err) {
    console.error(`[analysis] game ${gameId} failed:`, err);
    UPDATE_STATUS.run("error", 0, err.message, gameId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const queue = [];
const queued = new Set();
let running = false;

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const { gameId, force } = queue.shift();
    queued.delete(gameId);
    try {
      await analyzeGame(gameId, { force });
    } catch {
      /* logged inside */
    }
  }
  running = false;
}

export function queueAnalysis(gameId, { force = false } = {}) {
  UPSERT_ANALYSIS.run(gameId);
  const existing = SELECT_ANALYSIS.get(gameId);
  if (existing.status === "done" && !force) return existing;
  // Patterns are counted once per game; a forced re-run must not add them again.
  const patternsAlreadyRecorded = !!existing.patterns_recorded;
  if (existing.status === "running" || existing.status === "coaching") return existing;
  if (!queued.has(gameId)) {
    queued.add(gameId);
    queue.push({ gameId, force });
    if (force) UPDATE_STATUS.run("pending", 0, null, gameId);
    setImmediate(drain);
  }
  return SELECT_ANALYSIS.get(gameId);
}

export function resumePendingAnalyses() {
  db.prepare(
    "UPDATE analyses SET status = 'pending', progress = 0 WHERE status IN ('running', 'coaching')"
  ).run();
  const pending = db
    .prepare("SELECT game_id FROM analyses WHERE status = 'pending' ORDER BY created_at ASC")
    .all();
  for (const row of pending) queueAnalysis(row.game_id);
  return pending.length;
}

export function getAnalysis(gameId) {
  const row = SELECT_ANALYSIS.get(gameId);
  if (!row) return null;
  const moves = SELECT_MOVE_ANALYSES.all(gameId).map((m) => ({
    ply: m.ply,
    moveNumber: Math.ceil(m.ply / 2),
    color: m.color,
    san: m.san,
    uci: m.uci,
    fenBefore: m.fen_before,
    fenAfter: m.fen_after,
    phase: m.phase,
    evalBefore: m.eval_before_cp,
    mateBefore: m.mate_before,
    evalAfter: m.eval_after_cp,
    mateAfter: m.mate_after,
    evalBeforeText: E.formatWhiteEval(m.eval_before_cp ?? 0),
    evalAfterText: E.formatWhiteEval(m.eval_after_cp ?? 0),
    cpLoss: m.cp_loss,
    winBefore: m.win_before,
    winAfter: m.win_after,
    winDrop: m.win_drop,
    accuracy: m.accuracy,
    classification: m.classification,
    bestMoveUci: m.best_move_uci,
    bestMoveSan: m.best_move_san,
    bestLine: m.best_line_san,
    playedLine: m.played_line_san,
    alternatives: JSON.parse(m.alternatives_json || "[]"),
    tags: JSON.parse(m.tags_json || "[]"),
    isCritical: !!m.is_critical,
    explanation: m.explanation,
    improvement: m.improvement,
    headline: m.headline,
  }));
  return {
    status: row.status,
    progress: row.progress,
    error: row.error,
    engine: { name: row.engine_name, depth: row.engine_depth },
    accuracy: { white: row.accuracy_white, black: row.accuracy_black },
    acpl: { white: row.acpl_white, black: row.acpl_black },
    summary: row.summary_json ? JSON.parse(row.summary_json) : null,
    coaching: row.coaching_json ? JSON.parse(row.coaching_json) : null,
    moves,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
