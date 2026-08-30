import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { REASON_LABEL, formatDate } from "../lib/format.js";

const TABS = [
  ["all", "All"],
  ["active", "In progress"],
  ["finished", "Finished"],
];

export default function HistoryPage() {
  const [status, setStatus] = useState("all");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0);
  const limit = 25;

  useEffect(() => {
    setError(null);
    api(`/games?status=${status}&limit=${limit}&offset=${offset}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [status, offset]);

  return (
    <div className="history">
      <div className="page-head">
        <h1>Game history</h1>
        <div className="seg">
          {TABS.map(([k, label]) => (
            <button
              key={k}
              className={`seg-btn ${status === k ? "active" : ""}`}
              onClick={() => {
                setStatus(k);
                setOffset(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="muted">Loading…</div>}
      {data && data.games.length === 0 && <div className="panel muted">No games yet. Create one from the Play page.</div>}
      {data && data.games.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Result</th>
                <th>Opponent</th>
                <th>Colour</th>
                <th>Moves</th>
                <th>Time</th>
                <th>Accuracy</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.games.map((g) => (
                <tr key={g.code}>
                  <td>
                    {g.status === "finished" ? (
                      <span className={`badge outcome-${g.outcome}`}>
                        {g.outcome === "win" ? "Win" : g.outcome === "loss" ? "Loss" : "Draw"}
                        <span className="badge-sub">{REASON_LABEL[g.resultReason]}</span>
                      </span>
                    ) : g.status === "aborted" ? (
                      <span className="badge">Aborted</span>
                    ) : (
                      <span className="badge outcome-active">{g.status === "waiting" ? "Waiting" : "Live"}</span>
                    )}
                  </td>
                  <td>{g.opponent ? g.opponent.username : <span className="muted">—</span>}</td>
                  <td>
                    <span className={`color-dot ${g.color || "white"}`} /> {g.color || "—"}
                  </td>
                  <td>{Math.ceil(g.moveCount / 2)}</td>
                  <td>{g.timeControl}</td>
                  <td>
                    {g.analysis?.status === "done" && g.analysis.accuracy != null ? (
                      `${g.analysis.accuracy}%`
                    ) : g.analysis && g.analysis.status !== "done" && g.status === "finished" ? (
                      <span className="muted small">analysing…</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted small">{formatDate(g.endedAt || g.startedAt || g.createdAt)}</td>
                  <td className="right">
                    {g.status === "finished" ? (
                      <Link className="btn btn-sm" to={`/review/${g.code}`}>
                        Review
                      </Link>
                    ) : g.status === "aborted" ? null : (
                      <Link className="btn btn-sm btn-primary" to={`/game/${g.code}`}>
                        {g.status === "waiting" ? "Open" : "Resume"}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > limit && (
        <div className="pager">
          <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
            ← Newer
          </button>
          <span className="muted small">
            {offset + 1}–{Math.min(offset + limit, data.total)} of {data.total}
          </span>
          <button className="btn btn-sm" disabled={offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>
            Older →
          </button>
        </div>
      )}
    </div>
  );
}
