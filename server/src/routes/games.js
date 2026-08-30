import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { db } from "../db.js";
import { requireAuth } from "../lib/auth.js";
import { isCoachAccount } from "../config.js";
import { colorOfUser, rebuildChess } from "../lib/gameState.js";
import {
  GameError,
  createGame,
  joinGame,
  getGameByCode,
  serializeGame,
  summarizeForUser,
  canView,
  checkTimeout,
} from "../services/gameService.js";
import { getAnalysis, queueAnalysis } from "../services/analysis.js";
import { computeHint } from "../services/hintService.js";

const router = Router();
router.use(requireAuth);

const CreateSchema = z.object({
  color: z.enum(["white", "black", "random"]).default("random"),
  initialTime: z.number().int().min(0).max(7200).default(600),
  increment: z.number().int().min(0).max(180).default(5),
  rated: z.boolean().default(true),
});

const LIST = db.prepare(`
  SELECT g.*, a.status AS a_status, a.accuracy_white, a.accuracy_black
  FROM games g LEFT JOIN analyses a ON a.game_id = g.id
  WHERE (g.white_id = @id OR g.black_id = @id OR g.creator_id = @id)
    AND (@status = 'all' OR (@status = 'active' AND g.status IN ('waiting','active')) OR (@status = 'finished' AND g.status = 'finished'))
  ORDER BY COALESCE(g.ended_at, g.started_at, g.created_at) DESC
  LIMIT @limit OFFSET @offset
`);
const COUNT = db.prepare(`
  SELECT COUNT(*) AS n FROM games g
  WHERE (g.white_id = @id OR g.black_id = @id OR g.creator_id = @id)
    AND (@status = 'all' OR (@status = 'active' AND g.status IN ('waiting','active')) OR (@status = 'finished' AND g.status = 'finished'))
`);
const ANALYSIS_ROW = db.prepare("SELECT * FROM analyses WHERE game_id = ?");

function handle(res, err) {
  if (err instanceof GameError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: "Internal error" });
}

function loadViewable(req, res) {
  let game = getGameByCode(req.params.code);
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return null;
  }
  const flagged = checkTimeout(game);
  if (flagged) game = flagged.game;
  if (!canView(game, req.user.id)) {
    res.status(403).json({ error: "This game is between two other players" });
    return null;
  }
  return game;
}

router.post("/", (req, res) => {
  const parsed = CreateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input" });
  try {
    const game = createGame({ creatorId: req.user.id, ...parsed.data });
    res.status(201).json({ game: serializeGame(game, req.user) });
  } catch (err) {
    handle(res, err);
  }
});

router.get("/", (req, res) => {
  const status = ["all", "active", "finished"].includes(req.query.status) ? req.query.status : "all";
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const params = { id: req.user.id, status, limit, offset };
  const rows = LIST.all(params);
  const total = COUNT.get(params).n;
  const games = rows.map((row) =>
    summarizeForUser(
      row,
      req.user.id,
      row.a_status ? { status: row.a_status, accuracy_white: row.accuracy_white, accuracy_black: row.accuracy_black } : null
    )
  );
  res.json({ games, total, limit, offset });
});

router.get("/:code", (req, res) => {
  const game = loadViewable(req, res);
  if (!game) return;
  res.json({ game: serializeGame(game, req.user) });
});

router.post("/:code/join", (req, res) => {
  try {
    const game = joinGame({ code: req.params.code, userId: req.user.id });
    res.json({ game: serializeGame(game, req.user) });
  } catch (err) {
    handle(res, err);
  }
});

router.get("/:code/pgn", (req, res) => {
  const game = loadViewable(req, res);
  if (!game) return;
  const pgn = game.pgn || rebuildChess(game.id).pgn();
  res.setHeader("Content-Type", "application/x-chess-pgn; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="game-${game.code}.pgn"`);
  res.send(pgn);
});

router.get("/:code/analysis", (req, res) => {
  const game = loadViewable(req, res);
  if (!game) return;
  if (game.status !== "finished") return res.status(409).json({ error: "Analysis is available once the game has finished" });
  let analysis = getAnalysis(game.id);
  if (!analysis) {
    queueAnalysis(game.id);
    analysis = getAnalysis(game.id);
  }
  res.json({ analysis, game: serializeGame(game, req.user) });
});

router.post("/:code/analysis", (req, res) => {
  const game = loadViewable(req, res);
  if (!game) return;
  if (game.status !== "finished") return res.status(409).json({ error: "Analysis is available once the game has finished" });
  if (!colorOfUser(game, req.user.id)) return res.status(403).json({ error: "Only the players can re-run analysis" });
  const existing = ANALYSIS_ROW.get(game.id);
  const force = !!req.body?.force && (!existing || ["done", "error"].includes(existing.status));
  queueAnalysis(game.id, { force });
  res.status(202).json({ analysis: getAnalysis(game.id) });
});

const hintLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Slow down: too many hint requests" },
});

/**
 * Live move suggestions. The privilege is checked here, on the server, against
 * the authenticated account's email; the client never decides this.
 */
router.post(
  "/:code/hint",
  hintLimiter,
  asyncHandler(async (req, res) => {
    if (!isCoachAccount(req.user.email)) {
      return res.status(403).json({ error: "Live suggestions are not enabled for this account" });
    }
    const game = loadViewable(req, res);
    if (!game) return;
    if (!colorOfUser(game, req.user.id)) {
      return res.status(403).json({ error: "Only a player in this game can request hints" });
    }
    if (game.status !== "active") {
      return res.status(409).json({ error: "Hints are only available during an active game" });
    }
    try {
      const chess = rebuildChess(game.id);
      const hint = await computeHint(chess.fen(), { explain: req.body?.explain !== false });
      res.json({
        hint,
        forViewer: (chess.turn() === "w" ? "white" : "black") === colorOfUser(game, req.user.id),
      });
    } catch (err) {
      handle(res, err);
    }
  })
);

export default router;
