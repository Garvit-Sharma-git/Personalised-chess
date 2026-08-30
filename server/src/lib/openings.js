/**
 * Compact opening book keyed by SAN move sequence. Used only to name the
 * opening in reviews and to spot when a player leaves known theory early.
 */
const BOOK = [
  ["e4 e5 Nf3 Nc6 Bb5", "Ruy Lopez"],
  ["e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7", "Ruy Lopez: Closed"],
  ["e4 e5 Nf3 Nc6 Bb5 a6 Bxc6", "Ruy Lopez: Exchange Variation"],
  ["e4 e5 Nf3 Nc6 Bb5 Nf6", "Ruy Lopez: Berlin Defence"],
  ["e4 e5 Nf3 Nc6 Bc4", "Italian Game"],
  ["e4 e5 Nf3 Nc6 Bc4 Bc5", "Italian Game: Giuoco Piano"],
  ["e4 e5 Nf3 Nc6 Bc4 Bc5 b4", "Evans Gambit"],
  ["e4 e5 Nf3 Nc6 Bc4 Nf6", "Italian Game: Two Knights Defence"],
  ["e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5", "Two Knights: Fried Liver Attack Setup"],
  ["e4 e5 Nf3 Nc6 d4", "Scotch Game"],
  ["e4 e5 Nf3 Nc6 Nc3", "Three Knights Game"],
  ["e4 e5 Nf3 Nc6 Nc3 Nf6", "Four Knights Game"],
  ["e4 e5 Nf3 Nf6", "Petrov's Defence"],
  ["e4 e5 Nf3 d6", "Philidor Defence"],
  ["e4 e5 Nf3 f5", "Latvian Gambit"],
  ["e4 e5 Nc3", "Vienna Game"],
  ["e4 e5 Bc4", "Bishop's Opening"],
  ["e4 e5 f4", "King's Gambit"],
  ["e4 e5 f4 exf4", "King's Gambit Accepted"],
  ["e4 e5 d4", "Centre Game"],
  ["e4 e5 d4 exd4 c3", "Danish Gambit"],
  ["e4 c5", "Sicilian Defence"],
  ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", "Sicilian Defence: Najdorf"],
  ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6", "Sicilian Defence: Dragon"],
  ["e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5", "Sicilian Defence: Sveshnikov"],
  ["e4 c5 Nf3 e6", "Sicilian Defence: French Variation"],
  ["e4 c5 Nf3 Nc6", "Sicilian Defence: Open Sicilian"],
  ["e4 c5 c3", "Sicilian Defence: Alapin"],
  ["e4 c5 Nc3", "Sicilian Defence: Closed"],
  ["e4 c5 d4", "Sicilian Defence: Smith-Morra Gambit"],
  ["e4 e6", "French Defence"],
  ["e4 e6 d4 d5 Nc3", "French Defence: Classical/Winawer"],
  ["e4 e6 d4 d5 e5", "French Defence: Advance Variation"],
  ["e4 e6 d4 d5 exd5", "French Defence: Exchange Variation"],
  ["e4 e6 d4 d5 Nd2", "French Defence: Tarrasch"],
  ["e4 c6", "Caro-Kann Defence"],
  ["e4 c6 d4 d5 e5", "Caro-Kann: Advance Variation"],
  ["e4 c6 d4 d5 exd5", "Caro-Kann: Exchange Variation"],
  ["e4 c6 d4 d5 Nc3 dxe4 Nxe4", "Caro-Kann: Classical"],
  ["e4 d5", "Scandinavian Defence"],
  ["e4 d6", "Pirc Defence"],
  ["e4 g6", "Modern Defence"],
  ["e4 Nf6", "Alekhine's Defence"],
  ["e4 Nc6", "Nimzowitsch Defence"],
  ["d4 d5 c4", "Queen's Gambit"],
  ["d4 d5 c4 dxc4", "Queen's Gambit Accepted"],
  ["d4 d5 c4 e6", "Queen's Gambit Declined"],
  ["d4 d5 c4 c6", "Slav Defence"],
  ["d4 d5 c4 e6 Nc3 c6", "Semi-Slav Defence"],
  ["d4 d5 c4 Nc6", "Chigorin Defence"],
  ["d4 d5 Nf3 Nf6 Bf4", "London System"],
  ["d4 Nf6 Nf3 e6 Bf4", "London System"],
  ["d4 d5 Bf4", "London System"],
  ["d4 d5 Nf3 Nf6 e3", "Colle System"],
  ["d4 Nf6 c4 e6 Nc3 Bb4", "Nimzo-Indian Defence"],
  ["d4 Nf6 c4 e6 Nf3 b6", "Queen's Indian Defence"],
  ["d4 Nf6 c4 g6", "King's Indian Defence"],
  ["d4 Nf6 c4 g6 Nc3 d5", "Grünfeld Defence"],
  ["d4 Nf6 c4 c5", "Benoni Defence"],
  ["d4 Nf6 c4 c5 d5 b5", "Benko Gambit"],
  ["d4 Nf6 c4 e6 g3", "Catalan Opening"],
  ["d4 f5", "Dutch Defence"],
  ["d4 Nf6 Bg5", "Trompowsky Attack"],
  ["d4 d5 e4", "Blackmar-Diemer Gambit"],
  ["d4 e5", "Englund Gambit"],
  ["c4", "English Opening"],
  ["c4 e5", "English Opening: Reversed Sicilian"],
  ["c4 c5", "English Opening: Symmetrical"],
  ["Nf3", "Réti Opening"],
  ["Nf3 d5 g3", "King's Indian Attack"],
  ["b3", "Nimzo-Larsen Attack"],
  ["f4", "Bird's Opening"],
  ["g3", "Hungarian Opening"],
  ["b4", "Polish Opening"],
  ["e4", "King's Pawn Opening"],
  ["d4", "Queen's Pawn Opening"],
];

const ENTRIES = BOOK.map(([line, name]) => ({ moves: line.split(" "), name }));

/** Longest matching book line for a SAN move list. */
export function identifyOpening(sans) {
  let best = null;
  for (const entry of ENTRIES) {
    if (entry.moves.length > sans.length) continue;
    let ok = true;
    for (let i = 0; i < entry.moves.length; i++) {
      if (sans[i] !== entry.moves[i]) {
        ok = false;
        break;
      }
    }
    if (ok && (!best || entry.moves.length > best.plies)) {
      best = { name: entry.name, plies: entry.moves.length };
    }
  }
  return best;
}
