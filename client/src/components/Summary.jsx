import { CLASS_META } from "../lib/format.js";

const ROWS = ["brilliant", "great", "best", "excellent", "good", "inaccuracy", "mistake", "blunder"];

export default function Summary({ analysis, game }) {
  const s = analysis.summary;
  if (!s) return null;
  const w = s.players.white;
  const b = s.players.black;
  return (
    <section className="panel summary-panel">
      <div className="summary-grid">
        <div className="summary-player">
          <div className="summary-name">
            <span className="color-dot white" /> {game.white?.username || "White"}
          </div>
          <div className="summary-acc">{w.accuracy != null ? `${w.accuracy}%` : "—"}</div>
          <div className="muted tiny">accuracy · {w.acpl ?? "—"} avg cp loss</div>
        </div>
        <table className="count-table">
          <tbody>
            {ROWS.map((k) => (
              <tr key={k}>
                <td className={`n ${w.counts[k] ? "" : "zero"}`}>{w.counts[k] || 0}</td>
                <td className="label" style={{ color: CLASS_META[k].color }}>
                  <span className="cls-sym">{CLASS_META[k].symbol}</span> {CLASS_META[k].label}
                </td>
                <td className={`n ${b.counts[k] ? "" : "zero"}`}>{b.counts[k] || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="summary-player right">
          <div className="summary-name">
            {game.black?.username || "Black"} <span className="color-dot black" />
          </div>
          <div className="summary-acc">{b.accuracy != null ? `${b.accuracy}%` : "—"}</div>
          <div className="muted tiny">accuracy · {b.acpl ?? "—"} avg cp loss</div>
        </div>
      </div>
      <div className="summary-foot muted small">
        {s.opening ? <span>Opening: {s.opening.name}</span> : <span>Opening: not in book</span>}
        <span>
          Stockfish {s.engine?.name?.replace(/\.js$/, "").replace(/^stockfish-?/i, "")} · depth {s.engine?.depth}
        </span>
      </div>
    </section>
  );
}
