export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Square of the king of `color` ('w'|'b') in a FEN, or null. */
export function kingSquare(fen, color) {
  const [placement] = fen.split(" ");
  const target = color === "w" ? "K" : "k";
  const rows = placement.split("/");
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        if (ch === target) return `${String.fromCharCode(97 + file)}${8 - r}`;
        file++;
      }
    }
  }
  return null;
}

export function turnOf(fen) {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}
