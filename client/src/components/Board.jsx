import { useCallback, useMemo, useState } from "react";
import { Chessboard } from "react-chessboard";

const LIGHT = "#edeed1";
const DARK = "#779952";

/**
 * Board wrapper: legal-move dots, click-to-move and drag, last-move and check
 * highlights, arrows. `legalMoves` is the server-provided {from: [to]} map, so
 * the client only ever offers moves the server will accept.
 */
export default function Board({
  fen,
  orientation = "white",
  interactive = false,
  legalMoves = null,
  lastMove = null,
  checkSquare = null,
  arrows = [],
  highlights = {},
  onMove,
  boardId = "board",
}) {
  const [selected, setSelected] = useState(null);
  const myColor = orientation === "white" ? "w" : "b";

  const targets = useCallback((sq) => (legalMoves && legalMoves[sq]) || [], [legalMoves]);

  const attempt = useCallback(
    (from, to, pieceType) => {
      if (!interactive || !onMove) return false;
      if (!targets(from).includes(to)) return false;
      const isPawn = pieceType?.[1] === "P";
      const lastRank = to[1] === "8" || to[1] === "1";
      onMove({ from, to, promotion: isPawn && lastRank });
      setSelected(null);
      return true;
    },
    [interactive, onMove, targets]
  );

  const pieceAt = useCallback(
    (square) => {
      // Cheap FEN lookup so click-to-move knows what is on a square.
      const [placement] = fen.split(" ");
      const rows = placement.split("/");
      const file = square.charCodeAt(0) - 97;
      const rank = 8 - Number(square[1]);
      let col = 0;
      for (const ch of rows[rank]) {
        if (/\d/.test(ch)) {
          col += Number(ch);
          if (col > file) return null;
        } else {
          if (col === file) return ch;
          col++;
        }
      }
      return null;
    },
    [fen]
  );

  const onSquareClick = useCallback(
    ({ square }) => {
      if (!interactive) return;
      const piece = pieceAt(square);
      const mine = piece && (piece === piece.toUpperCase() ? "w" : "b") === myColor;
      if (selected && targets(selected).includes(square)) {
        const selPiece = pieceAt(selected);
        attempt(selected, square, selPiece ? `${myColor}${selPiece.toUpperCase()}` : null);
        return;
      }
      if (mine && targets(square).length) setSelected(selected === square ? null : square);
      else setSelected(null);
    },
    [interactive, pieceAt, myColor, selected, targets, attempt]
  );

  const squareStyles = useMemo(() => {
    const styles = {};
    if (lastMove) {
      styles[lastMove.from] = { backgroundColor: "rgba(255, 215, 0, 0.35)" };
      styles[lastMove.to] = { backgroundColor: "rgba(255, 215, 0, 0.45)" };
    }
    for (const [sq, color] of Object.entries(highlights || {})) {
      styles[sq] = { backgroundColor: color };
    }
    if (checkSquare) {
      styles[checkSquare] = {
        background: "radial-gradient(circle, rgba(255,0,0,0.75) 0%, rgba(255,0,0,0.35) 55%, transparent 75%)",
      };
    }
    if (selected) {
      styles[selected] = { backgroundColor: "rgba(20, 110, 60, 0.55)" };
      for (const to of targets(selected)) {
        const occupied = pieceAt(to);
        styles[to] = occupied
          ? { background: "radial-gradient(circle, transparent 58%, rgba(0,0,0,0.28) 60%)" }
          : { background: "radial-gradient(circle, rgba(0,0,0,0.28) 22%, transparent 24%)" };
      }
    }
    return styles;
  }, [lastMove, highlights, checkSquare, selected, targets, pieceAt]);

  const options = useMemo(
    () => ({
      id: boardId,
      position: fen,
      boardOrientation: orientation,
      allowDragging: interactive,
      canDragPiece: ({ piece }) => interactive && piece.pieceType[0] === myColor,
      onPieceDrop: ({ piece, sourceSquare, targetSquare }) => {
        if (!targetSquare) return false;
        return attempt(sourceSquare, targetSquare, piece.pieceType);
      },
      onPieceDrag: ({ square }) => setSelected(square),
      onSquareClick,
      squareStyles,
      arrows,
      allowDrawingArrows: true,
      animationDurationInMs: 180,
      showNotation: true,
      boardStyle: { borderRadius: "6px", boxShadow: "0 8px 30px rgba(0,0,0,0.45)" },
      darkSquareStyle: { backgroundColor: DARK },
      lightSquareStyle: { backgroundColor: LIGHT },
      darkSquareNotationStyle: { color: LIGHT, fontSize: "11px", fontWeight: 600 },
      lightSquareNotationStyle: { color: DARK, fontSize: "11px", fontWeight: 600 },
      dropSquareStyle: { boxShadow: "inset 0 0 0 4px rgba(255,255,255,0.65)" },
    }),
    [boardId, fen, orientation, interactive, myColor, attempt, onSquareClick, squareStyles, arrows]
  );

  return (
    <div className="board-wrap">
      <Chessboard options={options} />
    </div>
  );
}
