import { CLASS_META } from "../lib/format.js";

const TAG_LABELS = {
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

/** Explanation card for the currently selected move. */
export default function ReviewPanel({ move, showBest, onToggleBest, status }) {
  if (!move) {
    return (
      <section className="panel review-panel">
        <h3>Move review</h3>
        <p className="muted small">
          {status === "done" || status === "coaching"
            ? "Select a move to see the engine's verdict and the coaching note."
            : "Explanations appear here once the engine pass has finished."}
        </p>
      </section>
    );
  }
  const meta = CLASS_META[move.classification] || CLASS_META.good;
  const negative = ["inaccuracy", "mistake", "blunder"].includes(move.classification);
  const positive = ["great", "brilliant"].includes(move.classification);
  const label = `${move.moveNumber}${move.color === "b" ? "…" : "."} ${move.san}`;

  return (
    <section className="panel review-panel" style={{ "--cls": meta.color }}>
      <div className="review-head">
        <span className="cls-badge">
          <span className="cls-sym">{meta.symbol}</span>
          {meta.label}
        </span>
        <span className="review-move">{label}</span>
        <span className="review-eval muted small">
          {move.evalBeforeText} → <strong>{move.evalAfterText}</strong>
        </span>
      </div>

      {move.headline && <div className="review-headline">{move.headline}</div>}

      {negative && move.bestMoveSan && move.bestMoveSan !== move.san && (
        <div className="better-box">
          <div className="better-label">Better move</div>
          <div className="better-move">{move.bestMoveSan}</div>
          {move.bestLine && <div className="better-line muted small">{move.bestLine}</div>}
          <button className="btn btn-xs" onClick={onToggleBest}>
            {showBest ? "Show move played" : "Show on board"}
          </button>
        </div>
      )}

      {move.explanation && (
        <div className="review-section">
          <div className="review-label">{negative ? "Why" : positive ? "What made it strong" : "Engine view"}</div>
          <p>{move.explanation}</p>
        </div>
      )}

      {negative && move.improvement && (
        <div className="review-section improve">
          <div className="review-label">How to improve</div>
          <p>{move.improvement}</p>
        </div>
      )}

      {move.tags?.length > 0 && (
        <div className="tag-row">
          {move.tags.map((t, i) => (
            <span key={i} className="chip" title={t.detail}>
              {TAG_LABELS[t.tag] || t.tag}
            </span>
          ))}
        </div>
      )}

      {move.alternatives?.length > 0 && (
        <details className="alts">
          <summary className="small">Engine candidates</summary>
          <table className="alt-table">
            <tbody>
              {move.alternatives.map((a) => (
                <tr key={a.uci} className={a.san === move.san ? "played" : ""}>
                  <td className="alt-san">{a.san}</td>
                  <td className="alt-eval">{a.evalText}</td>
                  <td className="alt-line muted">{a.line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div className="muted tiny review-foot">
        Accuracy of this move: {Math.round(move.accuracy ?? 0)}% · {move.phase}
      </div>
    </section>
  );
}
