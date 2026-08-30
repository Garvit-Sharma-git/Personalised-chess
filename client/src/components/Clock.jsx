import { useEffect, useState } from "react";
import { formatClock } from "../lib/format.js";

/** Counts down locally from the last server snapshot; the server stays authoritative. */
export default function Clock({ ms, running, receivedAt, unlimited }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running]);

  if (unlimited) return <div className="clock clock-unlimited">∞</div>;
  const remaining = running ? ms - (now - receivedAt) : ms;
  const low = remaining < 20000;
  return (
    <div className={`clock ${running ? "clock-running" : ""} ${low ? "clock-low" : ""}`}>
      {formatClock(remaining)}
    </div>
  );
}
