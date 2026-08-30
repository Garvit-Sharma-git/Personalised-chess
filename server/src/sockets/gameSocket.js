/**
 * Real-time layer. Every event is validated through gameService; the server
 * never trusts client-side legality. Full snapshots are sent on every change,
 * which makes reconnection trivial: re-join and you are up to date.
 */
import { authenticateSocket } from "../lib/auth.js";
import {
  GameError,
  createGame,
  getGameByCode,
  getGameById,
  joinGame,
  makeMove,
  resign,
  handleDraw,
  abortGame,
  checkTimeout,
  computeClocks,
  sideToMove,
  serializeGame,
  canView,
  touchUser,
} from "../services/gameService.js";
import { colorOfUser } from "../lib/gameState.js";

const room = (code) => `game:${code}`;
const flagTimers = new Map(); // gameId -> timeout
const presence = new Map(); // code -> Map<userId, Set<socketId>>

export function setupGameSockets(io) {
  io.use((socket, next) => {
    const user = authenticateSocket(socket);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  function socketsInRoom(code) {
    const ids = io.sockets.adapter.rooms.get(room(code));
    if (!ids) return [];
    return [...ids].map((id) => io.sockets.sockets.get(id)).filter(Boolean);
  }

  /** Personalised snapshot for every socket in the room (legal moves differ per viewer). */
  function broadcastState(game, extra = {}) {
    for (const s of socketsInRoom(game.code)) {
      s.emit("game:state", { ...serializeGame(game, s.data.user), ...extra });
    }
    armFlagTimer(game);
  }

  function presenceOf(game) {
    const users = presence.get(game.code) || new Map();
    const online = (id) => !!id && (users.get(id)?.size || 0) > 0;
    return { white: online(game.white_id), black: online(game.black_id) };
  }

  function broadcastPresence(game) {
    io.to(room(game.code)).emit("game:presence", presenceOf(game));
  }

  function armFlagTimer(game) {
    const existing = flagTimers.get(game.id);
    if (existing) clearTimeout(existing);
    flagTimers.delete(game.id);
    if (game.status !== "active" || game.initial_time <= 0 || !game.turn_started_at) return;
    const clocks = computeClocks(game);
    const remaining = sideToMove(game) === "white" ? clocks.whiteMs : clocks.blackMs;
    const timer = setTimeout(() => {
      flagTimers.delete(game.id);
      const fresh = getGameById(game.id);
      const flagged = checkTimeout(fresh);
      if (flagged) broadcastState(flagged.game, { event: "timeout", ratingChange: flagged.ratingChange });
      else if (fresh) armFlagTimer(fresh);
    }, remaining + 50);
    timer.unref?.();
    flagTimers.set(game.id, timer);
  }

  function withGame(socket, code, fn, ack) {
    try {
      let game = getGameByCode(code);
      if (!game) throw new GameError("Game not found", 404);
      if (!socket.rooms.has(room(game.code))) throw new GameError("Join the game first", 403);
      // Settle an expired clock before acting on anything.
      const flagged = checkTimeout(game);
      if (flagged) {
        broadcastState(flagged.game, { event: "timeout", ratingChange: flagged.ratingChange });
        game = flagged.game;
      }
      const result = fn(game);
      ack?.({ ok: true, ...(result || {}) });
    } catch (err) {
      const status = err instanceof GameError ? err.status : 500;
      if (status === 500) console.error("[socket] unexpected:", err);
      ack?.({ ok: false, error: err.message, status });
    }
  }

  io.on("connection", (socket) => {
    const user = socket.data.user;
    touchUser(user.id);
    socket.emit("session", { userId: user.id, username: user.username });

    socket.on("game:join", ({ code } = {}, ack) => {
      try {
        let game = getGameByCode(code);
        if (!game) throw new GameError("Game not found", 404);

        // Open seat: the joining user becomes the opponent.
        if (game.status === "waiting" && !colorOfUser(game, user.id)) {
          game = joinGame({ code: game.code, userId: user.id });
        }
        if (!canView(game, user.id)) throw new GameError("This game is between two other players", 403);

        // Leave any other game rooms this socket was in.
        for (const r of socket.rooms) if (r.startsWith("game:") && r !== room(game.code)) socket.leave(r);
        socket.join(room(game.code));

        if (colorOfUser(game, user.id)) {
          const users = presence.get(game.code) || new Map();
          const set = users.get(user.id) || new Set();
          set.add(socket.id);
          users.set(user.id, set);
          presence.set(game.code, users);
        }

        const flagged = checkTimeout(game);
        if (flagged) game = flagged.game;

        const justStarted = game.status === "active" && game.move_count === 0 && !game.turn_started_at;
        // Everyone in the room learns about the new opponent / reconnection.
        broadcastState(game, justStarted ? { event: "start" } : {});
        broadcastPresence(game);
        ack?.({ ok: true, game: serializeGame(game, user), presence: presenceOf(game) });
      } catch (err) {
        const status = err instanceof GameError ? err.status : 500;
        if (status === 500) console.error("[socket] join failed:", err);
        ack?.({ ok: false, error: err.message, status });
      }
    });

    socket.on("game:move", ({ code, from, to, promotion } = {}, ack) => {
      withGame(
        socket,
        code,
        (game) => {
          if (typeof from !== "string" || typeof to !== "string") throw new GameError("Invalid move payload");
          if (promotion && !["q", "r", "b", "n"].includes(promotion)) throw new GameError("Invalid promotion");
          const res = makeMove(game, user.id, { from, to, promotion });
          if (res.timedOut) {
            broadcastState(res.game, { event: "timeout", ratingChange: res.ratingChange });
            throw new GameError("You ran out of time");
          }
          broadcastState(res.game, {
            event: res.outcome.over ? "gameover" : "move",
            lastMoveBy: user.id,
            ratingChange: res.ratingChange || undefined,
          });
          return { san: res.move.san, fen: res.move.after };
        },
        ack
      );
    });

    socket.on("game:resign", ({ code } = {}, ack) => {
      withGame(
        socket,
        code,
        (game) => {
          const res = resign(game, user.id);
          broadcastState(res.game, { event: "gameover", ratingChange: res.ratingChange });
        },
        ack
      );
    });

    socket.on("game:draw", ({ code, action } = {}, ack) => {
      withGame(
        socket,
        code,
        (game) => {
          const res = handleDraw(game, user.id, action);
          if (res.game.status === "finished") {
            broadcastState(res.game, { event: "gameover", ratingChange: res.ratingChange });
          } else {
            broadcastState(res.game, { event: res.offered ? "draw_offer" : res.declined ? "draw_declined" : undefined });
          }
        },
        ack
      );
    });

    socket.on("game:abort", ({ code } = {}, ack) => {
      withGame(
        socket,
        code,
        (game) => {
          const res = abortGame(game, user.id);
          broadcastState(res.game, { event: "aborted" });
        },
        ack
      );
    });

    // Rematch: a fresh game with colours swapped; the opponent is invited via the room.
    socket.on("game:rematch", ({ code } = {}, ack) => {
      try {
        const game = getGameByCode(code);
        if (!game) throw new GameError("Game not found", 404);
        const color = colorOfUser(game, user.id);
        if (!color) throw new GameError("You are not a player in this game", 403);
        if (game.status !== "finished" && game.status !== "aborted") throw new GameError("The game is still in progress");
        const next = createGame({
          creatorId: user.id,
          color: color === "white" ? "black" : "white",
          initialTime: game.initial_time,
          increment: game.increment,
          rated: !!game.rated,
        });
        io.to(room(game.code)).emit("game:rematch", { code: next.code, by: user.id, byName: user.username });
        ack?.({ ok: true, code: next.code });
      } catch (err) {
        const status = err instanceof GameError ? err.status : 500;
        if (status === 500) console.error("[socket] rematch failed:", err);
        ack?.({ ok: false, error: err.message, status });
      }
    });

    socket.on("game:sync", ({ code } = {}, ack) => {
      const game = getGameByCode(code);
      if (!game || !socket.rooms.has(room(game.code))) return ack?.({ ok: false, error: "Not in game" });
      ack?.({ ok: true, game: serializeGame(game, user), presence: presenceOf(game) });
    });

    socket.on("disconnecting", () => {
      for (const r of socket.rooms) {
        if (!r.startsWith("game:")) continue;
        const code = r.slice(5);
        const users = presence.get(code);
        const set = users?.get(user.id);
        if (set) {
          set.delete(socket.id);
          if (!set.size) users.delete(user.id);
        }
        const game = getGameByCode(code);
        // Give the client a moment to reconnect before telling the opponent.
        setTimeout(() => {
          const fresh = getGameByCode(code);
          if (fresh) broadcastPresence(fresh);
        }, 1500).unref?.();
        if (game) socket.to(r).emit("game:presence", presenceOf(game));
      }
    });
  });

  // Re-arm clocks for games that were live when the server last stopped.
  return {
    armAllClocks(games) {
      for (const g of games) {
        const flagged = checkTimeout(g);
        if (!flagged) armFlagTimer(g);
      }
    },
    broadcastState,
  };
}
