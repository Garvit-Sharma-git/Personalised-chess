import Clock from "./Clock.jsx";

export default function PlayerCard({ player, color, isTurn, online, game, receivedAt, you, accuracy, ratingDelta }) {
  const ms = color === "white" ? game?.clock?.whiteMs : game?.clock?.blackMs;
  const running = !!game?.clock?.running && isTurn && game.status === "active";
  return (
    <div className={`player-card ${isTurn && game?.status === "active" ? "player-turn" : ""}`}>
      <div className={`color-dot ${color}`} />
      <div className="player-info">
        <div className="player-name">
          {player ? player.username : <span className="muted">Waiting for opponent…</span>}
          {you && <span className="tag">you</span>}
          {player && game?.status === "active" && (
            <span className={`presence ${online ? "on" : "off"}`} title={online ? "Online" : "Disconnected"} />
          )}
        </div>
        <div className="player-meta">
          {player && <span>{player.rating}</span>}
          {ratingDelta != null && (
            <span className={ratingDelta >= 0 ? "delta-up" : "delta-down"}>
              {ratingDelta >= 0 ? "+" : ""}
              {ratingDelta}
            </span>
          )}
          {accuracy != null && <span className="muted">{accuracy}% accuracy</span>}
          {player && game?.status === "active" && !online && <span className="muted">reconnecting…</span>}
        </div>
      </div>
      {game && (
        <Clock ms={ms} running={running} receivedAt={receivedAt} unlimited={!game.clock?.initial} />
      )}
    </div>
  );
}
