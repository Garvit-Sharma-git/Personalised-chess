import { useMemo, useRef, useState } from "react";
import { CLASS_META } from "../lib/format.js";

const W = 600;
const H = 120;
const PAD = { top: 6, right: 6, bottom: 6, left: 6 };
const SURFACE = "#75736f";
const NOTABLE = new Set(["inaccuracy", "mistake", "blunder"]);

/**
 * Evaluation over the game as a filled area around the 50% line: white
 * advantage rises as a white area, black advantage sinks as a black area.
 * Markers flag inaccuracies/mistakes/blunders; hover shows a crosshair +
 * tooltip; click navigates. The move list is the table view of this data.
 */
export default function EvalGraph({ points, analysisByPly, currentPly, onSelect }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const n = points?.length || 0;

  const geom = useMemo(() => {
    if (n < 2) return null;
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const x = (ply) => PAD.left + (ply / (n - 1)) * innerW;
    const y = (win) => PAD.top + (1 - win / 100) * innerH;
    const mid = y(50);
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ply).toFixed(1)},${y(p.whiteWin).toFixed(1)}`).join(" ");
    const area = `${line} L${x(n - 1).toFixed(1)},${mid} L${x(0).toFixed(1)},${mid} Z`;
    return { x, y, mid, line, area, innerW, innerH };
  }, [points, n]);

  if (!geom) return null;
  const { x, y, mid, line, area } = geom;

  const markers = points
    .filter((p) => p.ply > 0 && NOTABLE.has(analysisByPly?.[p.ply]?.classification))
    .map((p) => ({ ...p, cls: analysisByPly[p.ply].classification }));

  function plyFromEvent(e) {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const ply = Math.round(((px - PAD.left) / geom.innerW) * (n - 1));
    return Math.max(0, Math.min(n - 1, ply));
  }

  const hp = hover != null ? points[hover] : null;
  const hm = hp && hp.ply > 0 ? analysisByPly?.[hp.ply] : null;

  return (
    <div className="eval-graph">
      <div className="eval-graph-title small muted">Evaluation</div>
      <div className="eval-graph-plot">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Engine evaluation over the course of the game"
          onMouseMove={(e) => setHover(plyFromEvent(e))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => onSelect?.(plyFromEvent(e))}
        >
          <rect x="0" y="0" width={W} height={H} fill={SURFACE} rx="4" />
          <clipPath id="eg-top">
            <rect x="0" y="0" width={W} height={mid} />
          </clipPath>
          <clipPath id="eg-bottom">
            <rect x="0" y={mid} width={W} height={H - mid} />
          </clipPath>
          <path d={area} fill="#f2f0ea" clipPath="url(#eg-top)" />
          <path d={area} fill="#22201d" clipPath="url(#eg-bottom)" />
          <line x1={PAD.left} x2={W - PAD.right} y1={mid} y2={mid} stroke="rgba(0,0,0,0.35)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <path d={line} fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          {currentPly != null && (
            <line x1={x(currentPly)} x2={x(currentPly)} y1={0} y2={H} stroke="#e9e2d0" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          )}
          {hover != null && (
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="rgba(255,255,255,0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          )}
          {markers.map((m) => (
            <circle
              key={m.ply}
              cx={x(m.ply)}
              cy={y(m.whiteWin)}
              r="4.5"
              fill={CLASS_META[m.cls].color}
              stroke={SURFACE}
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              className="eval-marker"
            />
          ))}
        </svg>
        {hp && (
          <div
            className="eval-tooltip"
            style={{ left: `${(x(hp.ply) / W) * 100}%`, transform: `translate(${hp.ply > n / 2 ? "-100%" : "0"}, 0)` }}
          >
            <div className="eval-tooltip-title">
              {hp.ply === 0
                ? "Start"
                : `${Math.ceil(hp.ply / 2)}${hp.ply % 2 === 0 ? "…" : "."} ${hm?.san ?? ""}`}
              {hm && NOTABLE.has(hm.classification) && (
                <span className="eval-tooltip-cls" style={{ color: CLASS_META[hm.classification].color }}>
                  {" "}
                  {CLASS_META[hm.classification].symbol}
                </span>
              )}
            </div>
            <div className="muted">
              {hp.text} · {hp.whiteWin >= 50 ? `White ${Math.round(hp.whiteWin)}%` : `Black ${Math.round(100 - hp.whiteWin)}%`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
