/**
 * Live move suggestions. Authorisation (coach account + participant) is
 * enforced by the caller; this module only knows how to analyse a position.
 */
import { Chess } from "chess.js";
import { config } from "../config.js";
import { enginePool, ensureEngine } from "./engine.js";
import { reviewService } from "./chessReview.js";
import * as E from "../lib/evaluation.js";

const cache = new Map(); // fen -> { at, value }
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;

function remember(fen, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(fen, { at: Date.now(), value });
}

export async function computeHint(fen, { explain = true } = {}) {
  const cached = cache.get(fen);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const chess = new Chess(fen);
  const turn = chess.turn();
  const sign = turn === "w" ? 1 : -1;
  const features = E.positionFeatures(fen);

  if (chess.isGameOver()) {
    const value = {
      fen,
      sideToMove: turn === "w" ? "white" : "black",
      gameOver: true,
      eval: { whiteCp: 0, text: chess.isCheckmate() ? "#" : "½", description: "Game over" },
      bestMove: null,
      candidates: [],
      features,
      explanation: null,
    };
    remember(fen, value);
    return value;
  }

  await ensureEngine();
  const result = await enginePool.search({
    fen,
    depth: config.engine.hintDepth,
    movetime: config.engine.hintMovetimeMs,
    multiPv: 3,
  });

  const candidates = result.lines.map((l) => {
    const stmCp = E.scoreToCp(l);
    const whiteCp = sign * stmCp;
    const sans = E.pvToSan(fen, l.pv, 6);
    return {
      uci: l.uci ?? l.pv[0],
      san: sans[0] || null,
      from: l.pv[0].slice(0, 2),
      to: l.pv[0].slice(2, 4),
      whiteCp,
      mate: l.mate != null ? sign * l.mate : null,
      evalText: E.formatWhiteEval(whiteCp),
      line: E.formatLine(fen, sans),
      depth: l.depth,
    };
  });

  const top = candidates[0] || null;
  const whiteCp = top ? top.whiteCp : 0;

  const ideas = [];
  if (features.theirHanging.length)
    ideas.push(`Opponent's ${features.theirHanging.map((h) => `${h.name} on ${h.square}`).join(", ")} can be captured.`);
  if (features.ourHanging.length)
    ideas.push(`Your ${features.ourHanging.map((h) => `${h.name} on ${h.square}`).join(", ")} ${features.ourHanging.length > 1 ? "are" : "is"} under attack.`);
  if (features.checks.length) ideas.push(`Checks available: ${features.checks.slice(0, 4).join(", ")}.`);
  if (features.inCheck) ideas.push("You are in check.");
  if (top) {
    const tmp = new Chess(fen);
    E.safeMove(tmp, top.uci);
    const forked = E.piecesAttackedFrom(tmp, top.to);
    if (forked.length >= 2) ideas.push(`${top.san} attacks ${forked.map((f) => `the ${f.name} on ${f.square}`).join(" and ")}.`);
    if (tmp.isCheck()) ideas.push(`${top.san} gives check.`);
  }

  let explanation = null;
  if (explain && top) {
    try {
      explanation = reviewService.provider.available
        ? await reviewService.explainHint({ fen, lines: candidates, features })
        : reviewService.templateHint({ fen, lines: candidates, features });
    } catch (err) {
      console.warn("[hint] explanation failed:", err.message);
      explanation = reviewService.templateHint({ fen, lines: candidates, features });
    }
  }

  const value = {
    fen,
    sideToMove: turn === "w" ? "white" : "black",
    gameOver: false,
    eval: {
      whiteCp,
      mate: top?.mate ?? null,
      text: E.formatWhiteEval(whiteCp),
      description: E.describeAdvantage(whiteCp),
      whiteWin: Number(E.winPercent(whiteCp).toFixed(1)),
    },
    bestMove: top,
    candidates,
    ideas,
    features: {
      inCheck: features.inCheck,
      checks: features.checks,
      captures: features.captures,
      ourHanging: features.ourHanging,
      theirHanging: features.theirHanging,
      phase: features.phase,
    },
    explanation,
    engine: { depth: result.depth, name: enginePool.info.name },
  };
  remember(fen, value);
  return value;
}
