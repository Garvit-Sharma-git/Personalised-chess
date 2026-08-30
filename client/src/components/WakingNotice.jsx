/** Shown when a request is taking long enough that the server is probably asleep. */
export default function WakingNotice({ compact = false }) {
  return (
    <div className={`waking ${compact ? "waking-compact" : ""}`}>
      <span className="spinner" />
      <div>
        <strong>Waking the server…</strong>
        <div className="muted small">
          The free hosting tier sleeps when idle, so the first request can take up to a minute. It stays fast after
          this.
        </div>
      </div>
    </div>
  );
}
