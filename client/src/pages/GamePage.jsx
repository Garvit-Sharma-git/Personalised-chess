import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Chess } from "chess.js";
import { useAuth } from "../lib/auth.jsx";
import { api } from "../lib/api.js";
import { getSocket, emitAck } from "../lib/socket.js";
import { resultText, moveLabel } from "../lib/format.js";
import { kingSquare, START_FEN } from "../lib/chessUtil.js";
import Board from "../components/Board.jsx";
import PlayerCard from "../components/PlayerCard.jsx";
import MoveList from "../components/MoveList.jsx";
import PromotionDialog from "../components/PromotionDialog.jsx";
import CoachPanel from "../components/CoachPanel.jsx";
import WakingNotice from "../components/WakingNotice.jsx";
import { useSlowLoad } from "../lib/useSlowLoad.js";

export default function GamePage() {
  const { code } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [game, setGame] = useState(null);
  const [receivedAt, setReceivedAt] = useState(Date.now());
  const [presence, setPresence] = useState({ white: false, black: false });
  const [conn, setConn] = useState("connecting");
  const [fatal, setFatal] = useState(null);
  const [notice, setNotice] = useState(null);
  const [localFen, setLocalFen] = useState(null);
  const [promo, setPromo] = useState(null);
  const [viewPly, setViewPly] = useState(null);
  const [flipped, setFlipped] = useState(false);
  const [ratingChange, setRatingChange] = useState(null);
  const [rematch, setRematch] = useState(null);
  const [copied, setCopied] = useState(false);

  const [coachOn, setCoachOn] = useState(() => {
    try {
      return localStorage.getItem("coachOn") === "1";
    } catch {
      return false;
    }
  });
  const [hint, setHint] = useState(null);
  const [hintLoading, setHintLoading] = useState(false);
  const [hintError, setHintError] = useState(null);
  const [showArrow, setShowArrow] = useState(true);
  const hintReq = useRef(0);

  const upperCode = code.toUpperCase();
  const connectingSlowly = useSlowLoad(!game && !fatal);

  // --- socket lifecycle -------------------------------------------------
  useEffect(() => {
    const socket = getSocket();
    let cancelled = false;

    const applyState = (g) => {
      if (cancelled) return;
      setGame(g);
      setReceivedAt(Date.now());
      setLocalFen(null);
      setViewPly(null);
      if (g.ratingChange) setRatingChange(g.ratingChange);
      if (g.event === "draw_declined") flash("Draw offer declined");
      if (g.event === "timeout") flash("Time ran out");
    };

    const join = () => {
      socket.emit("game:join", { code: upperCode }, (ack) => {
        if (cancelled) return;
        if (!ack?.ok) {
          setFatal(ack?.error || "Could not join the game");
          return;
        }
        setConn("connected");
        setFatal(null);
        applyState(ack.game);
        setPresence(ack.presence);
      });
    };
    const onConnect = () => join();
    const onDisconnect = () => setConn("reconnecting");
    const onError = (err) => {
      if (err?.message === "unauthorized") setFatal("Please log in again");
      else setConn("reconnecting");
    };
    const onPresence = (p) => setPresence(p);
    const onRematch = ({ code: newCode, by, byName }) => {
      if (by === user.id) navigate(`/game/${newCode}`);
      else setRematch({ code: newCode, byName });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onError);
    socket.on("game:state", applyState);
    socket.on("game:presence", onPresence);
    socket.on("game:rematch", onRematch);

    if (socket.connected) join();
    else socket.connect();

    return () => {
      cancelled = true;
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onError);
      socket.off("game:state", applyState);
      socket.off("game:presence", onPresence);
      socket.off("game:rematch", onRematch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upperCode]);

  const noticeTimer = useRef(null);
  function flash(text, type = "info") {
    setNotice({ text, type });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }

  // --- derived state ----------------------------------------------------
  const viewer = game?.viewer;
  const myColor = viewer?.color || null;
  const orientation = (myColor || "white") === "white" ? (flipped ? "black" : "white") : flipped ? "white" : "black";
  const isMyTurn = !!game && game.status === "active" && !!myColor && game.turn === myColor;
  const browsing = viewPly != null && game && viewPly < game.moves.length;

  const displayFen = useMemo(() => {
    if (!game) return START_FEN;
    if (browsing) return viewPly === 0 ? START_FEN : game.moves[viewPly - 1].fen;
    return localFen || game.fen;
  }, [game, browsing, viewPly, localFen]);

  const displayLastMove = useMemo(() => {
    if (!game) return null;
    if (browsing) return viewPly === 0 ? null : { from: game.moves[viewPly - 1].from, to: game.moves[viewPly - 1].to };
    return game.lastMove;
  }, [game, browsing, viewPly]);

  const checkSquare = useMemo(() => {
    if (!game || browsing || localFen) return null;
    if (!game.inCheck) return null;
    return kingSquare(game.fen, game.turn === "white" ? "w" : "b");
  }, [game, browsing, localFen]);

  const interactive = isMyTurn && !browsing && !promo && !localFen;

  // --- moves --------------------------------------------------------------
  const sendMove = useCallback(
    (from, to, promotion) => {
      try {
        const c = new Chess(game.fen);
        c.move({ from, to, promotion });
        setLocalFen(c.fen());
      } catch {
        /* server decides */
      }
      getSocket().emit("game:move", { code: upperCode, from, to, promotion }, (ack) => {
        if (!ack?.ok) {
          setLocalFen(null);
          flash(ack?.error || "Move rejected", "error");
        }
      });
    },
    [game, upperCode]
  );

  const onBoardMove = useCallback(
    ({ from, to, promotion }) => {
      if (promotion) setPromo({ from, to });
      else sendMove(from, to);
    },
    [sendMove]
  );

  async function act(event, payload = {}, successMsg) {
    const ack = await emitAck(event, { code: upperCode, ...payload });
    if (!ack.ok) flash(ack.error || "Action failed", "error");
    else if (successMsg) flash(successMsg);
    return ack;
  }

  async function doRematch() {
    const ack = await act("game:rematch");
    if (ack.ok) navigate(`/game/${ack.code}`);
  }

  // --- live coaching (only offered when the server says so) --------------
  const canCoach = !!viewer?.canUseLiveCoach;
  useEffect(() => {
    try {
      localStorage.setItem("coachOn", coachOn ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [coachOn]);

  useEffect(() => {
    if (!canCoach || !coachOn || !game || game.status !== "active") {
      setHint(null);
      return;
    }
    const id = ++hintReq.current;
    setHintLoading(true);
    setHintError(null);
    // Engine lines on every position; the Groq explanation only on your own turn.
    api(`/games/${upperCode}/hint`, { method: "POST", body: { explain: game.turn === game.viewer?.color } })
      .then((d) => {
        if (hintReq.current !== id) return;
        setHint(d.hint);
      })
      .catch((e) => {
        if (hintReq.current !== id) return;
        setHintError(e.message);
      })
      .finally(() => {
        if (hintReq.current === id) setHintLoading(false);
      });
  }, [canCoach, coachOn, game?.fen, game?.status, upperCode]);

  const arrows = useMemo(() => {
    if (!canCoach || !coachOn || !showArrow || !hint?.bestMove || browsing || localFen) return [];
    if (hint.fen !== game?.fen) return [];
    return [{ startSquare: hint.bestMove.from, endSquare: hint.bestMove.to, color: "rgba(76, 194, 122, 0.9)" }];
  }, [canCoach, coachOn, showArrow, hint, browsing, localFen, game?.fen]);

  // --- keyboard navigation of the move list ------------------------------
  useEffect(() => {
    if (!game) return undefined;
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const n = game.moves.length;
      const cur = viewPly == null ? n : viewPly;
      if (e.key === "ArrowLeft") setViewPly(Math.max(0, cur - 1));
      else if (e.key === "ArrowRight") setViewPly(cur + 1 >= n ? null : cur + 1);
      else if (e.key === "Home") setViewPly(0);
      else if (e.key === "End") setViewPly(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game, viewPly]);

  // --- rendering ----------------------------------------------------------
  if (fatal) {
    return (
      <div className="panel center-box">
        <h2>Cannot open game</h2>
        <p className="error">{fatal}</p>
        <Link className="btn btn-primary" to="/">
          Back to lobby
        </Link>
      </div>
    );
  }
  if (!game) return <div className="page-loading">{connectingSlowly ? <WakingNotice /> : "Connecting…"}</div>;

  const shareUrl = `${window.location.origin}/game/${game.code}`;
  const topColor = orientation === "white" ? "black" : "white";
  const bottomColor = orientation;
  const players = { white: game.white, black: game.black };
  const opponentColor = myColor === "white" ? "black" : "white";
  const drawPending = game.status === "active" && game.drawOfferBy && game.drawOfferBy !== myColor && myColor;
  const drawOffered = game.status === "active" && game.drawOfferBy && game.drawOfferBy === myColor;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      flash("Copy failed; select the link manually", "error");
    }
  }

  return (
    <div className="game-page">
      <div className="game-main">
        <PlayerCard
          player={players[topColor]}
          color={topColor}
          isTurn={game.turn === topColor}
          online={presence[topColor]}
          game={game}
          receivedAt={receivedAt}
          you={myColor === topColor}
          ratingDelta={ratingChange?.[topColor]}
        />
        <div className="board-area">
          <Board
            fen={displayFen}
            orientation={orientation}
            interactive={interactive}
            legalMoves={game.legalMoves}
            lastMove={displayLastMove}
            checkSquare={checkSquare}
            arrows={arrows}
            onMove={onBoardMove}
            boardId="live"
          />
          {browsing && (
            <div className="board-overlay-note">
              Viewing move {viewPly} of {game.moves.length} ·{" "}
              <button className="link" onClick={() => setViewPly(null)}>
                back to live
              </button>
            </div>
          )}
        </div>
        <PlayerCard
          player={players[bottomColor]}
          color={bottomColor}
          isTurn={game.turn === bottomColor}
          online={presence[bottomColor]}
          game={game}
          receivedAt={receivedAt}
          you={myColor === bottomColor}
          ratingDelta={ratingChange?.[bottomColor]}
        />
      </div>

      <aside className="game-side">
        <div className="side-top">
          <div className={`conn conn-${conn}`}>
            <span className="conn-dot" />
            {conn === "connected" ? "Connected" : conn === "reconnecting" ? "Reconnecting…" : "Connecting…"}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setFlipped((f) => !f)} title="Flip board">
            ⇅ Flip
          </button>
        </div>

        {game.status === "waiting" && (
          <section className="panel status-panel">
            <h3>Waiting for your opponent</h3>
            <p className="muted small">Send this link (or the code) to a friend. The game starts as soon as they open it.</p>
            <div className="share-row">
              <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
              <button className="btn btn-primary" onClick={copyLink}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="room-code">
              Room code <strong>{game.code}</strong>
            </div>
            <button className="btn btn-ghost btn-sm mt" onClick={() => act("game:abort")}>
              Cancel game
            </button>
          </section>
        )}

        {game.status === "active" && (
          <section className="panel status-panel">
            <div className="turn-line">
              {myColor ? (
                isMyTurn ? (
                  <strong className="your-turn">Your move{game.inCheck ? " — you are in check!" : ""}</strong>
                ) : (
                  <span>
                    Waiting for {players[opponentColor]?.username || "opponent"}
                    {game.inCheck ? " (in check)" : ""}…
                  </span>
                )
              ) : (
                <span>
                  {game.turn === "white" ? "White" : "Black"} to move{game.inCheck ? " (check)" : ""}
                </span>
              )}
            </div>
            {drawPending && (
              <div className="draw-offer">
                <span>{players[opponentColor]?.username} offers a draw</span>
                <div className="btn-row">
                  <button className="btn btn-primary btn-sm" onClick={() => act("game:draw", { action: "accept" })}>
                    Accept
                  </button>
                  <button className="btn btn-sm" onClick={() => act("game:draw", { action: "decline" })}>
                    Decline
                  </button>
                </div>
              </div>
            )}
            {drawOffered && <div className="muted small">Draw offered — waiting for a reply…</div>}
          </section>
        )}

        {(game.status === "finished" || game.status === "aborted") && (
          <section className="panel status-panel result-panel">
            <h3>{game.status === "aborted" ? "Game aborted" : resultText(game, myColor)}</h3>
            {game.status === "finished" && (
              <p className="muted small">
                {game.result} · {Math.ceil(game.moveCount / 2)} moves
                {ratingChange && myColor && (
                  <>
                    {" "}
                    · rating{" "}
                    <span className={ratingChange[myColor] >= 0 ? "delta-up" : "delta-down"}>
                      {ratingChange[myColor] >= 0 ? "+" : ""}
                      {ratingChange[myColor]}
                    </span>
                  </>
                )}
              </p>
            )}
            <div className="btn-row wrap">
              {game.status === "finished" && game.moveCount > 0 && (
                <Link className="btn btn-primary" to={`/review/${game.code}`}>
                  Review game
                </Link>
              )}
              {myColor && (
                <button className="btn" onClick={doRematch}>
                  Rematch
                </button>
              )}
              <Link className="btn btn-ghost" to="/">
                New game
              </Link>
            </div>
            {rematch && (
              <div className="draw-offer mt">
                <span>{rematch.byName} wants a rematch</span>
                <Link className="btn btn-primary btn-sm" to={`/game/${rematch.code}`}>
                  Accept
                </Link>
              </div>
            )}
          </section>
        )}

        {notice && <div className={`notice notice-${notice.type}`}>{notice.text}</div>}

        <section className="panel moves-panel">
          <div className="panel-head">
            <h3>Moves</h3>
            <div className="nav-btns">
              <button className="btn btn-ghost btn-xs" onClick={() => setViewPly(0)} title="Start">
                ⏮
              </button>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setViewPly(Math.max(0, (viewPly ?? game.moves.length) - 1))}
                title="Previous"
              >
                ◀
              </button>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => {
                  const next = (viewPly ?? game.moves.length) + 1;
                  setViewPly(next >= game.moves.length ? null : next);
                }}
                title="Next"
              >
                ▶
              </button>
              <button className="btn btn-ghost btn-xs" onClick={() => setViewPly(null)} title="Live">
                ⏭
              </button>
            </div>
          </div>
          <MoveList moves={game.moves} currentPly={browsing ? viewPly : game.moves.length} onSelect={(p) => setViewPly(p >= game.moves.length ? null : p)} />
          {game.lastMove && !browsing && game.moves.length > 0 && (
            <div className="muted small last-move">Last: {moveLabel(game.moves[game.moves.length - 1])}</div>
          )}
        </section>

        {game.status === "active" && myColor && (
          <section className="panel actions-panel">
            <div className="btn-row wrap">
              {!drawOffered && !drawPending && (
                <button className="btn btn-sm" onClick={() => act("game:draw", { action: "offer" }, "Draw offered")}>
                  Offer draw
                </button>
              )}
              {game.moveCount < 2 ? (
                <button className="btn btn-sm" onClick={() => act("game:abort")}>
                  Abort
                </button>
              ) : null}
              <button
                className="btn btn-danger btn-sm"
                onClick={() => {
                  if (window.confirm("Resign this game?")) act("game:resign");
                }}
              >
                Resign
              </button>
            </div>
          </section>
        )}

        {canCoach && game.status === "active" && (
          <CoachPanel
            enabled={coachOn}
            onToggle={setCoachOn}
            hint={hint}
            loading={hintLoading}
            error={hintError}
            isMyTurn={isMyTurn}
            showArrow={showArrow}
            onToggleArrow={setShowArrow}
          />
        )}
      </aside>

      {promo && (
        <PromotionDialog
          color={myColor}
          onChoose={(p) => {
            const { from, to } = promo;
            setPromo(null);
            sendMove(from, to, p);
          }}
          onCancel={() => setPromo(null)}
        />
      )}
    </div>
  );
}
