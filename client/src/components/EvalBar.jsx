import { evalToPercent } from "../lib/format.js";

export default function EvalBar({ whiteCp, text, orientation = "white" }) {
  const pct = evalToPercent(whiteCp);
  const whiteOnBottom = orientation === "white";
  return (
    <div className={`eval-bar ${whiteOnBottom ? "" : "flipped"}`} title={`Evaluation ${text}`}>
      <div className="eval-fill">
        <div className="eval-white" style={{ height: `${pct}%` }} />
      </div>
      <span className={`eval-text ${pct >= 50 ? "on-white" : "on-black"}`}>{text}</span>
    </div>
  );
}
