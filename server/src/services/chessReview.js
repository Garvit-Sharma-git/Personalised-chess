/**
 * ChessReviewService
 *
 * Turns engine analysis into coaching. Two layers:
 *   1. Deterministic templates built purely from Stockfish data + tactical
 *      tags. Always available; specific to the position by construction.
 *   2. LLM enrichment (Groq by default) that rewrites the key moments and
 *      writes a per-player game summary in natural language. The model only
 *      ever sees engine facts and is told not to invent moves.
 */
import { Chess } from "chess.js";
import { llm, parseJsonLoose } from "./llm.js";
import * as E from "../lib/evaluation.js";
import { patternsForUser } from "./patterns.js";

const COLOR_NAME = { w: "White", b: "Black" };

const PIECE_PLURAL = {
  p: "Pawns",
  n: "Knights",
  b: "Bishops",
  r: "Rooks",
  q: "Queen",
  k: "King",
};

/** "White: King g1, Queen d1, Rooks a1 f1, ..." — far more legible to an LLM than a FEN. */
export function describePieces(fen) {
  const chess = new Chess(fen);
  const bySide = { w: {}, b: {} };
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      (bySide[sq.color][sq.type] ||= []).push(sq.square);
    }
  }
  const fmt = (side) =>
    ["k", "q", "r", "b", "n", "p"]
      .filter((t) => bySide[side][t])
      .map((t) => `${PIECE_PLURAL[t]} ${bySide[side][t].join(" ")}`)
      .join(", ");
  return `White: ${fmt("w")}\nBlack: ${fmt("b")}`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const HABIT_BY_TAG = {
  hanging_piece:
    "Before you release a piece, ask: 'Can this be captured, and by what?' Count attackers and defenders on the destination square.",
  loose_piece:
    "After each move, check that every piece is protected or out of reach. Loose pieces drop off.",
  ignored_threat:
    "After every opponent move ask 'what does that attack?' and deal with the threat before pursuing your own plan.",
  missed_mate:
    "When the enemy king is exposed, look at all forcing checks first and calculate them to the end.",
  allowed_mate:
    "Before every move, check your own king: what checks does the opponent have, and can you meet them?",
  missed_fork:
    "Scan for squares from which one piece attacks two targets, especially knight forks against king, queen and rooks.",
  missed_free_piece:
    "Always list the captures available to you first; free material is the easiest win.",
  missed_tactic:
    "Use the checklist: checks, captures, threats, for both sides, before choosing a quiet move.",
  missed_opportunity:
    "When you have the initiative, look for the most forcing continuation rather than a routine move.",
  same_piece_twice:
    "In the opening, aim to move each piece once: develop knights and bishops, castle, then connect the rooks.",
  king_in_centre:
    "Castle early, particularly when the centre is opening up. An uncastled king invites tactics.",
  rushed: "Slow down when the position changes character: a new capture or check deserves a proper look.",
  time_pressure:
    "Manage the clock: spend time in the opening and middlegame decisions so you are not rushing later.",
};

const HABIT_BY_CLASS = {
  blunder: "Before every move, run the checklist: checks, captures and threats for both sides.",
  mistake: "Compare your candidate move with the most forcing alternatives before committing.",
  inaccuracy: "Look for the most active square for each piece and prefer moves that create threats.",
};

export class ChessReviewService {
  constructor(provider) {
    this.provider = provider;
  }

  get providerName() {
    return this.provider?.name || "none";
  }

  // ---------------------------------------------------------------------
  // Layer 1: deterministic templates
  // ---------------------------------------------------------------------

  /** Template explanation for one analysed move (see analysis.js for the shape). */
  templateExplanation(m) {
    const sev = E.SEVERITY[m.classification] || 0;
    const mover = COLOR_NAME[m.color];
    const evalBefore = E.formatWhiteEval(m.evalBefore);
    const evalAfter = E.formatWhiteEval(m.evalAfter);
    const primaryTag = m.tags.find((t) => HABIT_BY_TAG[t.tag]);

    if (["great", "brilliant"].includes(m.classification)) {
      const fork = m.tags.find((t) => t.tag === "fork");
      return {
        headline: m.classification === "brilliant" ? `Brilliant: ${m.san}` : `Only move: ${m.san}`,
        why:
          `${m.san} was the one move that kept ${mover} on track (evaluation ${evalAfter}). ` +
          (fork ? fork.detail + " " : "") +
          (m.alternatives[1]
            ? `The next-best option, ${m.alternatives[1].san}, would have left the position at ${m.alternatives[1].evalText}.`
            : ""),
        improve: "Well calculated. Keep looking for forcing moves that change the evaluation.",
      };
    }

    if (sev === 0) {
      return {
        headline: m.classification === "best" ? `${m.san} was the best move` : `${m.san}: fine`,
        why:
          m.classification === "best" || m.classification === "forced"
            ? `${m.san} matches the engine's first choice. Evaluation: ${evalAfter}.`
            : `${m.san} is a reasonable move (evaluation ${evalAfter}). The engine slightly prefers ${m.bestMoveSan}: ${m.bestLine}.`,
        improve: "",
      };
    }

    const parts = [];
    if (primaryTag) parts.push(primaryTag.detail);
    else if (m.tags[0]?.detail) parts.push(m.tags[0].detail);

    if (m.bestMoveSan && m.bestMoveSan !== m.san) {
      parts.push(
        `Stronger was ${m.bestMoveSan}, keeping the evaluation around ${evalBefore} after ${m.bestLine}.`
      );
    }
    if (m.playedLine) {
      parts.push(`After ${m.san} the position is ${evalAfter}: ${m.playedLine}.`);
    }
    if (m.alternatives[1] && m.alternatives[1].san !== m.san) {
      parts.push(`${m.alternatives[1].san} (${m.alternatives[1].evalText}) was also playable.`);
    }

    const headline = primaryTag
      ? `${E.TAG_LABELS[primaryTag.tag]}: ${m.san}`
      : `${m.classification[0].toUpperCase()}${m.classification.slice(1)}: ${m.san}, better was ${m.bestMoveSan}`;

    return {
      headline,
      why: parts.join(" "),
      improve: HABIT_BY_TAG[primaryTag?.tag] || HABIT_BY_CLASS[m.classification] || "",
    };
  }

  templateSummary({ color, stats, keyMoments, patterns, game, summary }) {
    const name = COLOR_NAME[color];
    const c = stats.counts;
    const own = keyMoments.filter((k) => k.color === color && !k.positive);
    const result = describeResult(game, color);
    const overview =
      `${name} played with ${stats.accuracy ?? "n/a"}% accuracy (average loss ${stats.acpl ?? "n/a"} centipawns per move) and ${result}. ` +
      `${c.blunder} blunder${c.blunder === 1 ? "" : "s"}, ${c.mistake} mistake${c.mistake === 1 ? "" : "s"} and ${c.inaccuracy} inaccurac${c.inaccuracy === 1 ? "y" : "ies"} over ${stats.moves} moves` +
      (summary.opening ? `, starting with the ${summary.opening.name}.` : ".");

    const strengths = [];
    if ((c.best || 0) + (c.great || 0) + (c.brilliant || 0) >= stats.moves * 0.4)
      strengths.push("Found the engine's top move in a large share of positions.");
    if (c.great || c.brilliant) strengths.push("Found difficult only-moves when it mattered.");
    const phases = stats.phases || {};
    const bestPhase = Object.entries(phases).sort((a, b) => a[1].acpl - b[1].acpl)[0];
    if (bestPhase && bestPhase[1].moves >= 4) strengths.push(`Most accurate in the ${bestPhase[0]} (${bestPhase[1].acpl} cp loss per move).`);
    if (!strengths.length) strengths.push("Kept fighting to the end of the game.");

    const weaknesses = Object.entries(stats.tags || {})
      .filter(([t]) => HABIT_BY_TAG[t])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t, n]) => `${E.TAG_LABELS[t]} (${n}×)`);
    const worstPhase = Object.entries(phases).sort((a, b) => b[1].acpl - a[1].acpl)[0];
    if (worstPhase && worstPhase[1].moves >= 4 && worstPhase[1].acpl >= 50)
      weaknesses.push(`The ${worstPhase[0]} was the weakest phase (${worstPhase[1].acpl} cp loss per move).`);

    const lessons = [];
    for (const k of own.slice(0, 3)) {
      const tag = k.tags.find((t) => HABIT_BY_TAG[t]);
      lessons.push(
        `Move ${k.moveNumber}${k.color === "b" ? "..." : "."}${k.san}: ${k.bestMoveSan ? `${k.bestMoveSan} was better. ` : ""}${HABIT_BY_TAG[tag] || HABIT_BY_CLASS[k.classification] || ""}`.trim()
      );
    }
    if (!lessons.length) lessons.push("Keep applying the checks-captures-threats routine on every move.");

    const top = patterns?.patterns?.slice(0, 2) || [];
    const patternNote = top.length
      ? `Across your ${patterns.gamesAnalyzed} analysed game${patterns.gamesAnalyzed === 1 ? "" : "s"}, the most frequent issue is "${top[0].label}" (${top[0].count}×). ${top[0].advice}`
      : "";

    return {
      overview,
      strengths,
      weaknesses: weaknesses.length ? weaknesses : ["No recurring weakness stood out in this game."],
      lessons,
      focus: own[0]
        ? HABIT_BY_TAG[own[0].tags.find((t) => HABIT_BY_TAG[t])] || HABIT_BY_CLASS[own[0].classification] || ""
        : "Keep looking for the most forcing move in every position.",
      patternNote,
    };
  }

  // ---------------------------------------------------------------------
  // Layer 2: LLM enrichment
  // ---------------------------------------------------------------------

  momentPrompt(m, game, summary) {
    const mover = COLOR_NAME[m.color];
    const moveLabel = `${m.moveNumber}${m.color === "b" ? "..." : "."}${m.san}`;
    const alts = m.alternatives
      .map((a, i) => `${i + 1}. ${a.san} (${a.evalText}) ${a.line}`)
      .join("\n");
    const tags = m.tags.map((t) => `- ${E.TAG_LABELS[t.tag] || t.tag}: ${t.detail}`).join("\n");
    const features = E.positionFeatures(m.fenBefore);

    return `GAME CONTEXT
Opening: ${summary.opening?.name || "unknown"}. Phase: ${m.phase}. Result: ${game.result || "unfinished"}${game.result_reason ? ` (${game.result_reason.replace(/_/g, " ")})` : ""}.
Material before the move: White ${features.material.white}, Black ${features.material.black}.
${mover} king: ${describeKing(m.fenBefore, m.color)}${features.inCheck ? ", in check" : ""}.

POSITION BEFORE THE MOVE (${mover} to move)
FEN: ${m.fenBefore}
${describePieces(m.fenBefore)}
${features.ourHanging.length ? `${mover}'s pieces under attack: ${features.ourHanging.map((h) => `${h.name} on ${h.square}`).join(", ")}.` : ""}
${features.theirHanging.length ? `Opponent pieces that can be won: ${features.theirHanging.map((h) => `${h.name} on ${h.square}`).join(", ")}.` : ""}

MOVE PLAYED: ${moveLabel}
Classification: ${m.classification}. Evaluation went from ${E.formatWhiteEval(m.evalBefore)} to ${E.formatWhiteEval(m.evalAfter)} (White's point of view). ${mover} lost ${Math.round(m.winDrop)}% winning chances.
Best play after the move: ${m.playedLine}

ENGINE'S PREFERRED MOVE: ${m.bestMoveSan} (${E.formatWhiteEval(m.evalBefore)})
Main line: ${m.bestLine}
Top candidates:
${alts}

TACTICAL FINDINGS (from engine + board analysis):
${tags || "- none detected"}

Write the coaching note for ${mover}.`;
  }

  get momentSystem() {
    return `You are a chess coach explaining Stockfish analysis to a club player (about 1200 rating) who wants to improve.
You will receive one position, the move that was played, the engine's preferred move, concrete lines and tactical findings.
Rules:
- Be specific to THIS position: name the pieces, squares and threats involved.
- Only mention moves that appear in the provided lines or findings. Never invent moves or evaluations.
- Explain in plain language what the played move overlooked and WHY the recommended move is better (what it attacks, defends, prevents, or wins).
- Keep it concrete and encouraging, no filler.
Respond with JSON only: {"headline": "<= 10 words", "why": "2-4 sentences", "improve": "1-2 sentences describing a habit or checklist that would have prevented this"}.`;
  }

  async explainMoment(m, game, summary) {
    const text = await this.provider.complete({
      system: this.momentSystem,
      user: this.momentPrompt(m, game, summary),
      json: true,
      maxTokens: 500,
      temperature: 0.35,
    });
    const parsed = parseJsonLoose(text);
    if (!parsed?.why) return null;
    return {
      headline: String(parsed.headline || "").trim().slice(0, 120),
      why: String(parsed.why).trim(),
      improve: String(parsed.improve || "").trim(),
    };
  }

  get summarySystem() {
    return `You are a supportive, precise chess coach writing a post-game report for one player, based strictly on Stockfish analysis you are given.
Rules:
- Use only the facts provided (statistics, key moments, patterns). Do not invent moves.
- Explain in terms a club player understands. Refer to specific moves by number when useful.
- Be honest about mistakes but constructive. Prioritise the 2-3 things that would most improve results.
Respond with JSON only:
{"overview": "2-3 sentences on how the game went for this player",
 "strengths": ["1-3 short bullet strings"],
 "weaknesses": ["1-3 short bullet strings"],
 "lessons": ["exactly 3 concrete, actionable lessons drawn from the key moments"],
 "focus": "one sentence: the single most valuable thing to work on next",
 "patternNote": "1-2 sentences connecting this game to the player's recurring patterns across games (empty string if no history)"}`;
  }

  summaryPrompt({ color, stats, keyMoments, explanations, patterns, game, summary, opponentStats }) {
    const name = COLOR_NAME[color];
    const moments = keyMoments
      .filter((k) => k.color === color)
      .map((k) => {
        const ex = explanations[k.ply];
        return `- ${k.moveNumber}${k.color === "b" ? "..." : "."}${k.san} (${k.classification}${k.isTurningPoint ? ", turning point" : ""}) best was ${k.bestMoveSan || "?"}; eval ${E.formatWhiteEval(k.evalBefore)} -> ${E.formatWhiteEval(k.evalAfter)}. ${ex?.headline ? `Note: ${ex.headline}. ${ex.why}` : ""}`;
      })
      .join("\n");
    const phases = Object.entries(stats.phases || {})
      .map(([p, v]) => `${p}: ${v.moves} moves, ${v.acpl} cp loss/move, ${v.mistakes} mistakes`)
      .join("; ");
    const tags = Object.entries(stats.tags || {})
      .map(([t, n]) => `${E.TAG_LABELS[t] || t} ×${n}`)
      .join(", ");
    const history = patterns?.patterns?.length
      ? patterns.patterns
          .slice(0, 4)
          .map((p) => `${p.label}: ${p.count} times in ${patterns.gamesAnalyzed} analysed games`)
          .join("; ")
      : "none yet (this is the first analysed game, so do not describe anything as recurring)";
    const time = stats.time
      ? `Average ${(stats.time.avgMs / 1000).toFixed(1)}s per move, ${stats.time.fastMoves} moves under 2s.`
      : "";

    return `PLAYER: ${name}. Result: ${describeResult(game, color)} (${game.result_reason?.replace(/_/g, " ") || "n/a"}).
Opening: ${summary.opening?.name || "unknown"}. Game length: ${summary.totalPlies} plies.
${name} accuracy ${stats.accuracy}% (opponent ${opponentStats.accuracy}%), average centipawn loss ${stats.acpl} (opponent ${opponentStats.acpl}).
Move quality: ${Object.entries(stats.counts).filter(([, n]) => n).map(([c, n]) => `${c} ${n}`).join(", ")}.
By phase: ${phases || "n/a"}.
Tactical findings this game: ${tags || "none"}.
${time}
Recurring patterns from the player's PREVIOUS analysed games (not including this one): ${history}.

KEY MOMENTS FOR ${name.toUpperCase()}:
${moments || "- no significant mistakes"}

Write the report for ${name}.`;
  }

  async summarizeForPlayer(args) {
    const text = await this.provider.complete({
      system: this.summarySystem,
      user: this.summaryPrompt(args),
      json: true,
      maxTokens: 900,
      temperature: 0.45,
    });
    const parsed = parseJsonLoose(text);
    if (!parsed?.overview) return null;
    const arr = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
    return {
      overview: String(parsed.overview).trim(),
      strengths: arr(parsed.strengths),
      weaknesses: arr(parsed.weaknesses),
      lessons: arr(parsed.lessons).slice(0, 3),
      focus: String(parsed.focus || "").trim(),
      patternNote: String(parsed.patternNote || "").trim(),
    };
  }

  /**
   * Full review for a finished analysis. Returns
   * { provider, model, moveExplanations: {ply: {headline, why, improve}}, players: {white, black} }
   */
  async generateReview({ game, summary, moves }) {
    const keyMoments = summary.keyMoments || [];
    const byPly = new Map(moves.map((m) => [m.ply, m]));
    const patterns = {
      w: game.white_id ? patternsForUser(game.white_id) : null,
      b: game.black_id ? patternsForUser(game.black_id) : null,
    };

    const moveExplanations = {};
    let usedLlm = false;

    if (this.provider.available) {
      const targets = keyMoments
        .map((k) => byPly.get(k.ply))
        .filter((m) => m && (E.SEVERITY[m.classification] >= 1 || ["great", "brilliant"].includes(m.classification)))
        .slice(0, 10);
      const results = await mapLimit(targets, 3, async (m) => {
        try {
          return await this.explainMoment(m, game, summary);
        } catch (err) {
          console.warn(`[review] moment ${m.ply} failed: ${err.message}`);
          return null;
        }
      });
      targets.forEach((m, i) => {
        if (results[i]) {
          moveExplanations[m.ply] = results[i];
          usedLlm = true;
        }
      });
    }

    const players = {};
    for (const color of ["w", "b"]) {
      const stats = summary.players[color === "w" ? "white" : "black"];
      const opponentStats = summary.players[color === "w" ? "black" : "white"];
      const args = {
        color,
        stats,
        opponentStats,
        keyMoments,
        explanations: moveExplanations,
        patterns: patterns[color],
        game,
        summary,
      };
      let report = null;
      if (this.provider.available) {
        try {
          report = await this.summarizeForPlayer(args);
          if (report) usedLlm = true;
        } catch (err) {
          console.warn(`[review] summary for ${color} failed: ${err.message}`);
        }
      }
      players[color === "w" ? "white" : "black"] = report || this.templateSummary(args);
    }

    return {
      provider: usedLlm ? this.provider.name : "template",
      generatedAt: new Date().toISOString(),
      moveExplanations,
      players,
    };
  }

  // ---------------------------------------------------------------------
  // Live hints (coach account only; authorisation happens in the route)
  // ---------------------------------------------------------------------

  async explainHint({ fen, lines, features }) {
    const chess = new Chess(fen);
    const side = COLOR_NAME[chess.turn()];
    const candidates = lines
      .map((l, i) => `${i + 1}. ${l.san} (${l.evalText}): ${l.line}`)
      .join("\n");
    const user = `POSITION (${side} to move)
FEN: ${fen}
${describePieces(fen)}
${features.ourHanging.length ? `${side}'s pieces under attack: ${features.ourHanging.map((h) => `${h.name} on ${h.square}`).join(", ")}.` : ""}
${features.theirHanging.length ? `Opponent pieces that can be taken: ${features.theirHanging.map((h) => `${h.name} on ${h.square}`).join(", ")}.` : ""}
Available checks: ${features.checks.join(", ") || "none"}. Captures: ${features.captures.join(", ") || "none"}.

ENGINE CANDIDATES:
${candidates}

Explain the recommended move for ${side}.`;
    const text = await this.provider.complete({
      system: `You are a chess coach whispering a hint during a game. Using only the engine lines given, explain in plain language the idea behind the top move (what it threatens, defends or prepares) and what the opponent is threatening. Never mention moves that are not in the lines. Respond with JSON only: {"idea": "1-2 sentences", "threat": "1 sentence on the opponent's main threat, or empty", "plan": "1 sentence on the plan for the next few moves"}.`,
      user,
      json: true,
      maxTokens: 300,
      temperature: 0.3,
      tier: "fast",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed?.idea) return null;
    return {
      idea: String(parsed.idea).trim(),
      threat: String(parsed.threat || "").trim(),
      plan: String(parsed.plan || "").trim(),
    };
  }

  templateHint({ fen, lines, features }) {
    const top = lines[0];
    if (!top) return null;
    const parts = [`${top.san} is the engine's choice (${top.evalText}); main line ${top.line}.`];
    if (features.theirHanging.length)
      parts.push(`Note the opponent's ${features.theirHanging[0].name} on ${features.theirHanging[0].square} can be taken.`);
    if (features.ourHanging.length)
      parts.push(`Your ${features.ourHanging[0].name} on ${features.ourHanging[0].square} is under attack.`);
    return {
      idea: parts.join(" "),
      threat: features.ourHanging.length ? `Your ${features.ourHanging[0].name} on ${features.ourHanging[0].square} is hanging.` : "",
      plan: lines[1] ? `Alternative: ${lines[1].san} (${lines[1].evalText}).` : "",
    };
  }
}

function describeKing(fen, color) {
  const chess = new Chess(fen);
  const rights = chess.getCastlingRights(color);
  const sq = E.squareOfKing(chess, color);
  const home = color === "w" ? "e1" : "e8";
  if (sq !== home) return `on ${sq}${["g1", "c1", "g8", "c8"].includes(sq) ? " (castled)" : ""}`;
  const can = [rights.k ? "kingside" : null, rights.q ? "queenside" : null].filter(Boolean);
  return can.length ? `uncastled on ${sq}, may still castle ${can.join(" or ")}` : `uncastled on ${sq}, castling rights lost`;
}

function describeResult(game, color) {
  if (!game.result) return "the game is unfinished";
  if (game.result === "1/2-1/2") return "drew";
  const won = (game.result === "1-0" && color === "w") || (game.result === "0-1" && color === "b");
  return won ? "won" : "lost";
}

export const reviewService = new ChessReviewService(llm);
