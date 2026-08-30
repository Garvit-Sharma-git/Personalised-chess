/**
 * Live analysis panel. Rendered only when the server reports
 * `viewer.canUseLiveCoach`; the hint endpoint enforces the same rule.
 */
export default function CoachPanel({ enabled, onToggle, hint, loading, error, isMyTurn, showArrow, onToggleArrow }) {
  return (
    <section className="panel coach-panel">
      <div className="panel-head">
        <h3>Coach</h3>
        <label className="switch">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          <span>{enabled ? "On" : "Off"}</span>
        </label>
      </div>
      {!enabled && <p className="muted small">Turn on to see engine suggestions for the current position.</p>}
      {enabled && (
        <div className="coach-body">
          {loading && !hint && <p className="muted small">Thinking…</p>}
          {error && <p className="error small">{error}</p>}
          {hint && (
            <>
              <div className="coach-eval">
                <span className="coach-eval-num">{hint.eval.text}</span>
                <span className="muted small">{hint.eval.description}</span>
                {loading && <span className="spinner" />}
              </div>
              {hint.bestMove && (
                <div className="coach-best">
                  <div className="coach-label">{isMyTurn ? "Recommended" : "Expected reply"}</div>
                  <div className="coach-move">{hint.bestMove.san}</div>
                  <div className="coach-line muted small">{hint.bestMove.line}</div>
                  <label className="check small">
                    <input type="checkbox" checked={showArrow} onChange={(e) => onToggleArrow(e.target.checked)} />
                    Show on board
                  </label>
                </div>
              )}
              {hint.candidates?.length > 1 && (
                <div className="coach-candidates">
                  <div className="coach-label">Candidates</div>
                  {hint.candidates.map((c) => (
                    <div key={c.uci} className="cand-row">
                      <span className="cand-san">{c.san}</span>
                      <span className="cand-eval">{c.evalText}</span>
                      <span className="cand-line muted">{c.line}</span>
                    </div>
                  ))}
                </div>
              )}
              {hint.explanation && (
                <div className="coach-explain">
                  <p>{hint.explanation.idea}</p>
                  {hint.explanation.threat && (
                    <p>
                      <strong>Threat:</strong> {hint.explanation.threat}
                    </p>
                  )}
                  {hint.explanation.plan && (
                    <p>
                      <strong>Plan:</strong> {hint.explanation.plan}
                    </p>
                  )}
                </div>
              )}
              {hint.ideas?.length > 0 && (
                <ul className="coach-ideas small">
                  {hint.ideas.map((i, k) => (
                    <li key={k}>{i}</li>
                  ))}
                </ul>
              )}
              <div className="muted tiny">Stockfish depth {hint.engine?.depth}</div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
