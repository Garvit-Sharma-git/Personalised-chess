import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.jsx";
import { CLASS_META, resultText, REASON_LABEL, formatDate } from "../lib/format.js";
import { kingSquare, START_FEN, turnOf } from "../lib/chessUtil.js";
import Board from "../components/Board.jsx";
import MoveList from "../components/MoveList.jsx";
import EvalBar from "../components/EvalBar.jsx";
import EvalGraph from "../components/EvalGraph.jsx";
import ReviewPanel from "../components/ReviewPanel.jsx";
import Summary from "../components/Summary.jsx";
import Coaching from "../components/Coaching.jsx";

const PENDING = new Set(["pending", "running", "coaching"]);

export default function ReviewPage() {
  const { code } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [ply, setPly] = useState(0);
  const [showBest, setShowBest] = useState(false);
  const [orientation, setOrientation] = useState(null);
  const [coachColor, setCoachColor] = useState(null);
  const [rerunning, setRerunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api(`/games/${code.toUpperCase()}/analysis`);
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, [code]);

  useEffect(() => {
    let timer;
    let stopped = false;
    const tick = async () => {
      const d = await load();
      if (stopped) return;
      if (!d || PENDING.has(d.analysis?.status)) timer = setTimeout(tick, d ? 1500 : 4000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load]);

  const game = data?.game;
  const analysis = data?.analysis;
  const viewerColor = game?.viewer?.color || null;

  useEffect(() => {
    if (game && orientation == null) setOrientation(viewerColor || "white");
    if (game && coachColor == null) setCoachColor(viewerColor || "white");
    if (game && ply === 0 && game.moves.length && analysis?.status === "done") {
      // Land on the first key moment for the viewer when the review is ready.
      const first = analysis.summary?.keyMoments?.find((k) => !k.positive && (!viewerColor || k.color === viewerColor[0]));
      if (first) setPly(first.ply);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, analysis?.status]);

  const byPly = useMemo(() => {
    const m = {};
    for (const a of analysis?.moves || []) m[a.ply] = a;
    return m;
  }, [analysis]);

  const moves = game?.moves || [];
  const current = ply > 0 ? byPly[ply] : null;
  const evalPoint = analysis?.summary?.evalGraph?.[ply];

  const goTo = useCallback(
    (p) => {
      setPly(Math.max(0, Math.min(moves.length, p)));
      setShowBest(false);
    },
    [moves.length]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft") goTo(ply - 1);
      else if (e.key === "ArrowRight") goTo(ply + 1);
      else if (e.key === "Home") goTo(0);
      else if (e.key === "End") goTo(moves.length);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, ply, moves.length]);

  if (error) {
    return (
      <div className="panel center-box">
        <h2>Cannot open review</h2>
        <p className="error">{error}</p>
        <Link className="btn btn-primary" to="/history">
          Back to history
        </Link>
      </div>
    );
  }
  if (!data) return <div className="page-loading">Loading…</div>;

  const showingBefore = showBest && current;
  const fen = showingBefore ? current.fenBefore : ply === 0 ? START_FEN : moves[ply - 1].fen;
  const lastMove = !showingBefore && ply > 0 ? { from: moves[ply - 1].from, to: moves[ply - 1].to } : null;
  const meta = current ? CLASS_META[current.classification] : null;
  const highlights =
    current && !showingBefore && meta && ["inaccuracy", "mistake", "blunder", "great", "brilliant"].includes(current.classification)
      ? { [moves[ply - 1].from]: `${meta.color}66`, [moves[ply - 1].to]: `${meta.color}99` }
      : {};
  const arrows = showingBefore
    ? [
        { startSquare: current.bestMoveUci.slice(0, 2), endSquare: current.bestMoveUci.slice(2, 4), color: "rgba(76, 194, 122, 0.95)" },
        { startSquare: current.uci.slice(0, 2), endSquare: current.uci.slice(2, 4), color: "rgba(245, 73, 58, 0.8)" },
      ]
    : [];
  const checkSquare = (() => {
    if (showingBefore) return null;
    const m = ply > 0 ? moves[ply - 1] : null;
    return m?.check ? kingSquare(fen, turnOf(fen)) : null;
  })();

  const status = analysis?.status;
  const progress = Math.round((analysis?.progress || 0) * 100);
  const keyMoments = analysis?.summary?.keyMoments || [];
  const isPlayer = !!viewerColor;

  async function rerun() {
    setRerunning(true);
    try {
      await api(`/games/${code.toUpperCase()}/analysis`, { method: "POST", body: { force: true } });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setRerunning(false);
    }
  }

  return (
    <div className="review-page">
      <div className="review-header">
        <div>
          <h1>
            <span className="color-dot white" /> {game.white?.username || "White"} vs {game.black?.username || "Black"}{" "}
            <span className="color-dot black" />
          </h1>
          <div className="muted small">
            {resultText(game, null)} · {game.result} · {Math.ceil(game.moveCount / 2)} moves · {formatDate(game.endedAt)}
          </div>
        </div>
        <div className="btn-row">
          <a className="btn btn-sm" href={`/api/games/${game.code}/pgn`} download>
            Download PGN
          </a>
          {isPlayer && (status === "done" || status === "error") && (
            <button className="btn btn-sm" onClick={rerun} disabled={rerunning}>
              {rerunning ? "Queued…" : "Re-run analysis"}
            </button>
          )}
          <Link className="btn btn-sm btn-ghost" to={`/game/${game.code}`}>
            Game page
          </Link>
        </div>
      </div>

      {PENDING.has(status) && (
        <div className="progress-panel panel">
          <div className="progress-text">
            {status === "coaching" ? "Engine pass complete — writing coaching notes…" : `Stockfish is analysing every move… ${progress}%`}
          </div>
          <div className="progress-bar">
            <div style={{ width: `${status === "coaching" ? 100 : progress}%` }} />
          </div>
        </div>
      )}
      {status === "error" && (
        <div className="notice notice-error">
          Analysis failed: {analysis.error}. {isPlayer ? "You can re-run it." : ""}
        </div>
      )}

      {analysis?.summary && <Summary analysis={analysis} game={game} />}

      <div className="review-grid">
        <div className="review-board-col">
          <div className="board-with-bar">
            {evalPoint && <EvalBar whiteCp={evalPoint.whiteCp} text={evalPoint.text} orientation={orientation || "white"} />}
            <div className="board-area">
              <Board
                fen={fen}
                orientation={orientation || "white"}
                interactive={false}
                lastMove={lastMove}
                checkSquare={checkSquare}
                arrows={arrows}
                highlights={highlights}
                boardId="review"
              />
            </div>
          </div>
          <div className="review-controls">
            <button className="btn btn-sm" onClick={() => goTo(0)} title="Start (Home)">
              ⏮
            </button>
            <button className="btn btn-sm" onClick={() => goTo(ply - 1)} title="Previous (←)">
              ◀
            </button>
            <span className="ply-indicator">
              {ply === 0 ? "Start" : `${moves[ply - 1].moveNumber}${moves[ply - 1].color === "b" ? "…" : "."} ${moves[ply - 1].san}`}
              {showingBefore && <span className="muted"> (before)</span>}
            </span>
            <button className="btn btn-sm" onClick={() => goTo(ply + 1)} title="Next (→)">
              ▶
            </button>
            <button className="btn btn-sm" onClick={() => goTo(moves.length)} title="End (End)">
              ⏭
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))} title="Flip">
              ⇅
            </button>
          </div>
          {analysis?.summary?.evalGraph && (
            <EvalGraph points={analysis.summary.evalGraph} analysisByPly={byPly} currentPly={ply} onSelect={goTo} />
          )}
        </div>

        <div className="review-side-col">
          <ReviewPanel move={current} showBest={showBest} onToggleBest={() => setShowBest((s) => !s)} status={status} />

          {keyMoments.length > 0 && (
            <section className="panel key-moments">
              <h3>Key moments</h3>
              <ul>
                {keyMoments.map((k) => {
                  const m = CLASS_META[k.classification];
                  const a = byPly[k.ply];
                  return (
                    <li key={k.ply}>
                      <button className={`km ${k.ply === ply ? "active" : ""}`} style={{ "--cls": m.color }} onClick={() => goTo(k.ply)}>
                        <span className="km-move">
                          {k.moveNumber}
                          {k.color === "b" ? "…" : "."} {k.san}
                        </span>
                        <span className="km-cls">
                          {m.symbol} {m.label}
                          {k.isTurningPoint ? " · turning point" : ""}
                        </span>
                        {a?.headline && <span className="km-head muted">{a.headline}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="panel moves-panel">
            <h3>Moves</h3>
            <MoveList moves={moves} currentPly={ply} onSelect={goTo} analysis={byPly} />
          </section>
        </div>
      </div>

      {analysis?.coaching && coachColor && (
        <Coaching coaching={analysis.coaching} color={coachColor} onColor={setCoachColor} game={game} viewerColor={viewerColor} />
      )}

      {game.resultReason && (
        <p className="muted tiny center">
          Result: {game.result} {REASON_LABEL[game.resultReason]}.
        </p>
      )}
    </div>
  );
}
