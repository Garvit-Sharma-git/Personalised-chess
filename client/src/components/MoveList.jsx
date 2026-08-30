import { useEffect, useRef } from "react";
import { CLASS_META } from "../lib/format.js";

/**
 * Two-column move list. `moves` are game moves; `analysis` (optional) is a map
 * ply -> move analysis for classification badges.
 */
export default function MoveList({ moves, currentPly, onSelect, analysis }) {
  const activeRef = useRef(null);

  useEffect(() => {
    const el = activeRef.current;
    const list = el?.closest(".move-list");
    if (!el || !list) return;
    // Scroll the list itself; scrollIntoView would also scroll the page on mobile.
    const top = el.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight;
  }, [currentPly]);

  const rows = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ number: moves[i].moveNumber, white: moves[i], black: moves[i + 1] });
  }

  const cell = (m) => {
    if (!m) return <span className="move-cell empty" />;
    const a = analysis?.[m.ply];
    const meta = a ? CLASS_META[a.classification] : null;
    const active = m.ply === currentPly;
    const notable = meta && ["inaccuracy", "mistake", "blunder", "brilliant", "great"].includes(a.classification);
    return (
      <button
        ref={active ? activeRef : null}
        className={`move-cell ${active ? "active" : ""} ${notable ? "notable" : ""}`}
        style={notable ? { "--cls": meta.color } : undefined}
        onClick={() => onSelect?.(m.ply)}
        title={meta ? meta.label : undefined}
      >
        {m.san}
        {notable && <span className="move-sym">{meta.symbol}</span>}
      </button>
    );
  };

  if (!moves.length) return <div className="move-list empty muted">No moves yet</div>;

  return (
    <div className="move-list">
      {rows.map((r) => (
        <div className="move-row" key={r.number}>
          <span className="move-no">{r.number}.</span>
          {cell(r.white)}
          {cell(r.black)}
        </div>
      ))}
    </div>
  );
}
