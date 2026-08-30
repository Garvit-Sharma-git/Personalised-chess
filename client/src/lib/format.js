export const CLASS_META = {
  brilliant: { label: "Brilliant", symbol: "!!", color: "#26c2a3" },
  great: { label: "Great move", symbol: "!", color: "#5c8bb0" },
  best: { label: "Best move", symbol: "★", color: "#81b64c" },
  excellent: { label: "Excellent", symbol: "✓", color: "#8fbf6a" },
  good: { label: "Good", symbol: "○", color: "#9aa39b" },
  book: { label: "Book", symbol: "📖", color: "#a88865" },
  forced: { label: "Forced", symbol: "→", color: "#8a8a8a" },
  inaccuracy: { label: "Inaccuracy", symbol: "?!", color: "#f0c33c" },
  mistake: { label: "Mistake", symbol: "?", color: "#ff7b2e" },
  blunder: { label: "Blunder", symbol: "??", color: "#e0353a" },
};

export const REASON_LABEL = {
  checkmate: "by checkmate",
  resignation: "by resignation",
  stalemate: "by stalemate",
  timeout: "on time",
  agreement: "by agreement",
  insufficient_material: "by insufficient material",
  threefold_repetition: "by threefold repetition",
  fifty_move_rule: "by the fifty-move rule",
  abandoned: "abandoned",
};

export function resultText(game, viewerColor) {
  if (!game || game.status !== "finished") return "";
  const reason = REASON_LABEL[game.resultReason] || "";
  if (game.result === "1/2-1/2") return `Draw ${reason}`.trim();
  const winner = game.result === "1-0" ? "white" : "black";
  const who = viewerColor ? (winner === viewerColor ? "You won" : "You lost") : `${winner === "white" ? "White" : "Black"} won`;
  return `${who} ${reason}`.trim();
}

export function formatClock(ms) {
  if (ms == null) return "–";
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  if (total < 10000) {
    const tenths = Math.floor((total % 1000) / 100);
    return `${m}:${String(s).padStart(2, "0")}.${tenths}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function timeControlLabel(initial, increment) {
  if (!initial) return "Unlimited";
  const minutes = initial / 60;
  const m = Number.isInteger(minutes) ? minutes : minutes.toFixed(1);
  return `${m}+${increment}`;
}

export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function relativeDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function moveLabel(m) {
  return `${m.moveNumber}${m.color === "b" ? "…" : "."} ${m.san}`;
}

export function evalToPercent(whiteCp) {
  const clamped = Math.max(-10000, Math.min(10000, whiteCp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}
