import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.jsx";
import { relativeDate } from "../lib/format.js";

const PRESETS = [
  { label: "Unlimited", initial: 0, inc: 0 },
  { label: "3+2", initial: 180, inc: 2 },
  { label: "5+0", initial: 300, inc: 0 },
  { label: "5+3", initial: 300, inc: 3 },
  { label: "10+0", initial: 600, inc: 0 },
  { label: "10+5", initial: 600, inc: 5 },
  { label: "15+10", initial: 900, inc: 10 },
  { label: "30+0", initial: 1800, inc: 0 },
];

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [color, setColor] = useState("random");
  const [preset, setPreset] = useState(5);
  const [rated, setRated] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [active, setActive] = useState([]);

  useEffect(() => {
    api("/games?status=active&limit=10")
      .then((d) => setActive(d.games))
      .catch(() => {});
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const tc = PRESETS[preset];
      const data = await api("/games", {
        method: "POST",
        body: { color, initialTime: tc.initial, increment: tc.inc, rated },
      });
      navigate(`/game/${data.game.code}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  function join(e) {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase().replace(/.*\/game\//, "");
    if (code) navigate(`/game/${code}`);
  }

  return (
    <div className="home">
      <section className="hero">
        <h1>Play a friend. Learn from the game.</h1>
        <p className="muted">
          Create a room, send the link, play in real time. Every finished game is analysed by Stockfish and turned into a
          coaching review.
        </p>
      </section>

      <div className="home-grid">
        <section className="panel">
          <h2>Create a game</h2>
          <div className="field">
            <div className="field-label">Your colour</div>
            <div className="seg">
              {["white", "random", "black"].map((c) => (
                <button key={c} className={`seg-btn ${color === c ? "active" : ""}`} onClick={() => setColor(c)}>
                  {c === "white" ? "♔ White" : c === "black" ? "♚ Black" : "⚄ Random"}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <div className="field-label">Time control</div>
            <div className="preset-grid">
              {PRESETS.map((p, i) => (
                <button key={p.label} className={`preset ${preset === i ? "active" : ""}`} onClick={() => setPreset(i)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={rated} onChange={(e) => setRated(e.target.checked)} /> Rated
          </label>
          {error && <div className="error">{error}</div>}
          <button className="btn btn-primary btn-lg" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create game & get link"}
          </button>
        </section>

        <section className="panel">
          <h2>Join a game</h2>
          <p className="muted small">Paste the room code or link your friend sent you.</p>
          <form onSubmit={join} className="join-form">
            <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="e.g. K7XQ2M" spellCheck={false} />
            <button className="btn btn-primary">Join</button>
          </form>

          {active.length > 0 && (
            <>
              <h3 className="mt">Your ongoing games</h3>
              <ul className="game-mini-list">
                {active.map((g) => (
                  <li key={g.code}>
                    <Link to={`/game/${g.code}`}>
                      <span className={`color-dot ${g.color || "white"}`} />
                      <span className="grow">
                        {g.opponent ? `vs ${g.opponent.username}` : g.status === "waiting" ? "Waiting for opponent" : "Open game"}
                        <span className="muted small"> · {g.timeControl === "∞" ? "Unlimited" : g.timeControl} · {g.moveCount} moves</span>
                      </span>
                      <span className="muted small">{relativeDate(g.startedAt || g.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      {user?.canUseLiveCoach && (
        <p className="muted small center mt">Live coaching is enabled for your account: look for the Coach panel during games.</p>
      )}
    </div>
  );
}
