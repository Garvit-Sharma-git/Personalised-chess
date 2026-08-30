const PIECES = [
  ["q", "Queen", "♕"],
  ["r", "Rook", "♖"],
  ["b", "Bishop", "♗"],
  ["n", "Knight", "♘"],
];

export default function PromotionDialog({ color, onChoose, onCancel }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal promo" onClick={(e) => e.stopPropagation()}>
        <h3>Promote to</h3>
        <div className="promo-choices">
          {PIECES.map(([code, name, glyph]) => (
            <button key={code} className={`promo-btn ${color}`} onClick={() => onChoose(code)} title={name}>
              <span className="promo-glyph">{glyph}</span>
              <span>{name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
