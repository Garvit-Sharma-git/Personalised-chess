export default function Coaching({ coaching, color, onColor, game, viewerColor }) {
  if (!coaching?.players) return null;
  const report = coaching.players[color];
  if (!report) return null;
  const name = game[color]?.username || color;
  const provider = coaching.provider || "template";
  return (
    <section className="panel coaching-panel">
      <div className="panel-head">
        <h3>Coaching report</h3>
        <div className="seg seg-sm">
          {["white", "black"].map((c) => (
            <button key={c} className={`seg-btn ${color === c ? "active" : ""}`} onClick={() => onColor(c)}>
              {game[c]?.username || c}
              {viewerColor === c ? " (you)" : ""}
            </button>
          ))}
        </div>
      </div>
      <p className="coaching-overview">{report.overview}</p>
      <div className="coaching-cols">
        {report.strengths?.length > 0 && (
          <div>
            <div className="review-label">What went well</div>
            <ul>
              {report.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {report.weaknesses?.length > 0 && (
          <div>
            <div className="review-label">What to fix</div>
            <ul>
              {report.weaknesses.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {report.lessons?.length > 0 && (
        <div className="lessons">
          <div className="review-label">Lessons from this game for {name}</div>
          <ol>
            {report.lessons.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        </div>
      )}
      {report.focus && (
        <div className="focus-box">
          <strong>Focus next:</strong> {report.focus}
        </div>
      )}
      {report.patternNote && <p className="small pattern-note">{report.patternNote}</p>}
      <div className="muted tiny">
        {provider.startsWith("groq")
          ? `Engine analysis by Stockfish; explanations by ${provider.replace("groq:", "Groq · ")}.`
          : "Explanations generated from the engine analysis. Set GROQ_API_KEY on the server for AI-written coaching."}
      </div>
    </section>
  );
}
