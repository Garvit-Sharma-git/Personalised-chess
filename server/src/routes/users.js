import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, publicUser } from "../lib/auth.js";
import { patternsForUser } from "../services/patterns.js";

const router = Router();

const STATS = db.prepare(`
  SELECT
    COUNT(*) AS played,
    SUM(CASE WHEN winner_id = @id THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN result = '1/2-1/2' THEN 1 ELSE 0 END) AS draws,
    SUM(CASE WHEN result != '1/2-1/2' AND winner_id != @id THEN 1 ELSE 0 END) AS losses
  FROM games
  WHERE status = 'finished' AND (white_id = @id OR black_id = @id)
`);

const ACTIVE = db.prepare(
  "SELECT COUNT(*) AS n FROM games WHERE status IN ('waiting','active') AND (white_id = ? OR black_id = ?)"
);

const ACCURACY = db.prepare(`
  SELECT AVG(CASE WHEN g.white_id = @id THEN a.accuracy_white ELSE a.accuracy_black END) AS accuracy,
         AVG(CASE WHEN g.white_id = @id THEN a.acpl_white ELSE a.acpl_black END) AS acpl,
         COUNT(*) AS analysed
  FROM analyses a JOIN games g ON g.id = a.game_id
  WHERE a.status = 'done' AND (g.white_id = @id OR g.black_id = @id)
`);

const RECENT = db.prepare(`
  SELECT result, winner_id FROM games
  WHERE status = 'finished' AND (white_id = ? OR black_id = ?)
  ORDER BY ended_at DESC LIMIT 10
`);

const MISTAKES = db.prepare(`
  SELECT ma.classification, COUNT(*) AS n
  FROM move_analyses ma JOIN games g ON g.id = ma.game_id
  WHERE (g.white_id = @id AND ma.color = 'w') OR (g.black_id = @id AND ma.color = 'b')
  GROUP BY ma.classification
`);

const BY_USERNAME = db.prepare("SELECT * FROM users WHERE lower(username) = lower(?)");

function statsFor(userId) {
  const s = STATS.get({ id: userId });
  const acc = ACCURACY.get({ id: userId });
  const recent = RECENT.all(userId, userId).map((g) =>
    g.result === "1/2-1/2" ? "D" : g.winner_id === userId ? "W" : "L"
  );
  const mistakes = {};
  for (const row of MISTAKES.all({ id: userId })) mistakes[row.classification] = row.n;
  return {
    played: s.played || 0,
    wins: s.wins || 0,
    losses: s.losses || 0,
    draws: s.draws || 0,
    active: ACTIVE.get(userId, userId).n,
    winRate: s.played ? Math.round(((s.wins || 0) / s.played) * 100) : 0,
    recentForm: recent,
    averageAccuracy: acc.accuracy != null ? Number(acc.accuracy.toFixed(1)) : null,
    averageAcpl: acc.acpl != null ? Math.round(acc.acpl) : null,
    analysedGames: acc.analysed || 0,
    moveQuality: mistakes,
  };
}

router.get("/me", requireAuth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    stats: statsFor(req.user.id),
    patterns: patternsForUser(req.user.id),
  });
});

router.get("/:username", requireAuth, (req, res) => {
  const row = BY_USERNAME.get(req.params.username);
  if (!row) return res.status(404).json({ error: "User not found" });
  const user = publicUser(row);
  res.json({
    user: { id: user.id, username: user.username, rating: user.rating, createdAt: user.createdAt },
    stats: statsFor(row.id),
  });
});

export default router;
