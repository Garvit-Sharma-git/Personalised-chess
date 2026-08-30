import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { CLASS_META } from "../lib/format.js";

export default function ProfilePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api("/users/me").then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const { user, stats, patterns } = data;
  const quality = stats.moveQuality || {};
  const qualityTotal = Object.values(quality).reduce((a, b) => a + b, 0);

  return (
    <div className="profile">
      <div className="profile-head panel">
        <div className="avatar">{user.username[0].toUpperCase()}</div>
        <div>
          <h1>{user.username}</h1>
          <div className="muted">{user.email}</div>
          {user.canUseLiveCoach && <span className="tag coach-tag">live coaching enabled</span>}
        </div>
        <div className="rating-big">
          <div className="muted small">Rating</div>
          <div>{user.rating}</div>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Games" value={stats.played} />
        <Stat label="Wins" value={stats.wins} tone="win" />
        <Stat label="Losses" value={stats.losses} tone="loss" />
        <Stat label="Draws" value={stats.draws} tone="draw" />
        <Stat label="Win rate" value={`${stats.winRate}%`} />
        <Stat label="Avg accuracy" value={stats.averageAccuracy != null ? `${stats.averageAccuracy}%` : "—"} />
      </div>

      <div className="profile-grid">
        <section className="panel">
          <h2>Recent form</h2>
          {stats.recentForm.length ? (
            <div className="form-row">
              {stats.recentForm.map((r, i) => (
                <span key={i} className={`form-pill form-${r}`}>
                  {r}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">No finished games yet.</p>
          )}
          <h2 className="mt">Move quality</h2>
          {qualityTotal ? (
            <div className="quality-bars">
              {Object.keys(CLASS_META)
                .filter((k) => quality[k])
                .map((k) => (
                  <div key={k} className="quality-row">
                    <span className="quality-label" style={{ color: CLASS_META[k].color }}>
                      {CLASS_META[k].symbol} {CLASS_META[k].label}
                    </span>
                    <div className="quality-bar">
                      <div style={{ width: `${(quality[k] / qualityTotal) * 100}%`, background: CLASS_META[k].color }} />
                    </div>
                    <span className="quality-n">{quality[k]}</span>
                  </div>
                ))}
            </div>
          ) : (
            <p className="muted">Play and analyse a game to see your move quality breakdown.</p>
          )}
        </section>

        <section className="panel">
          <h2>What to work on</h2>
          <p className="muted small">
            Recurring issues across {patterns.gamesAnalyzed} analysed game{patterns.gamesAnalyzed === 1 ? "" : "s"}.
          </p>
          {patterns.patterns.length === 0 && <p className="muted">No patterns yet: finish a game to get your first review.</p>}
          <ol className="pattern-list">
            {patterns.patterns.map((p) => (
              <li key={p.key}>
                <div className="pattern-head">
                  <strong>{p.label}</strong>
                  <span className="muted small">
                    {p.count}× · {p.perGame}/game
                  </span>
                </div>
                <div className="small">{p.advice}</div>
              </li>
            ))}
          </ol>
          <p className="small mt">
            <Link to="/history">Open a finished game</Link> to see where these happened.
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
