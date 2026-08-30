import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { config } from "../config.js";

const require = createRequire(import.meta.url);

const VARIANT_SUFFIX = {
  full: "",
  lite: "-lite",
  single: "-single",
  "lite-single": "-lite-single",
  "single-lite": "-lite-single",
  asm: "-asm",
};

/**
 * Locate a UCI engine. A native binary at STOCKFISH_PATH wins; otherwise we use
 * the WASM build bundled with the `stockfish` package, run under Node. Both
 * speak UCI on stdin/stdout, so the driver below is identical for either.
 */
export function resolveEngine() {
  if (config.engine.path) {
    const p = path.resolve(config.engine.path);
    if (!fs.existsSync(p)) throw new Error(`STOCKFISH_PATH does not exist: ${p}`);
    const isJs = p.endsWith(".js");
    return { command: isJs ? process.execPath : p, args: isJs ? [p] : [], label: p };
  }

  const pkgPath = require.resolve("stockfish/package.json");
  const dir = path.dirname(pkgPath);
  const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).buildVersion;
  const suffix = VARIANT_SUFFIX[config.engine.variant] ?? "-lite";

  const candidates = [
    path.join(dir, "bin", `stockfish-${version}${suffix}.js`),
    path.join(dir, "src", `stockfish-${version}${suffix}.js`),
    path.join(dir, "bin", "stockfish.js"),
    path.join(dir, "src", "stockfish.js"),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error("Could not locate a Stockfish build in node_modules/stockfish");
  return { command: process.execPath, args: [found], label: path.basename(found) };
}

function parseInfoLine(line) {
  // e.g. "info depth 18 seldepth 24 multipv 1 score cp 34 nodes ... pv e2e4 e7e5"
  const t = line.split(/\s+/);
  const info = { multipv: 1 };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "depth":
        info.depth = Number(t[++i]);
        break;
      case "seldepth":
        info.seldepth = Number(t[++i]);
        break;
      case "multipv":
        info.multipv = Number(t[++i]);
        break;
      case "nodes":
        info.nodes = Number(t[++i]);
        break;
      case "score":
        if (t[i + 1] === "cp") {
          info.cp = Number(t[i + 2]);
          i += 2;
        } else if (t[i + 1] === "mate") {
          info.mate = Number(t[i + 2]);
          i += 2;
        }
        break;
      case "pv":
        info.pv = t.slice(i + 1);
        i = t.length;
        break;
      default:
        break;
    }
  }
  return info;
}

class UciEngine extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.proc = null;
    this.buffer = "";
    this.ready = false;
    this.busy = false;
    this.listeners = new Set();
    this.options = {};
  }

  async start() {
    const { command, args, label } = resolveEngine();
    this.label = label;
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.on("data", () => {}); // engines chatter on stderr; ignore
    this.proc.on("exit", () => {
      this.ready = false;
      this.emit("exit");
    });

    await this._expect("uciok", () => this.send("uci"), 30000);
    this.send(`setoption name Threads value ${config.engine.threads}`);
    this.send(`setoption name Hash value ${config.engine.hashMb}`);
    await this.isReady();
    this.ready = true;
    return this;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) for (const fn of this.listeners) fn(line);
    }
  }

  send(cmd) {
    if (!this.proc?.stdin.writable) throw new Error("Engine is not running");
    this.proc.stdin.write(cmd + "\n");
  }

  /** Resolve once `predicate` matches a line; rejects on timeout. */
  _expect(match, trigger, timeoutMs = 15000) {
    const predicate = typeof match === "function" ? match : (l) => l === match || l.startsWith(match);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onLine);
        reject(new Error(`Engine timed out waiting for "${match}"`));
      }, timeoutMs);
      const onLine = (line) => {
        if (predicate(line)) {
          clearTimeout(timer);
          this.listeners.delete(onLine);
          resolve(line);
        }
      };
      this.listeners.add(onLine);
      try {
        trigger?.();
      } catch (err) {
        clearTimeout(timer);
        this.listeners.delete(onLine);
        reject(err);
      }
    });
  }

  isReady(timeoutMs = 20000) {
    return this._expect("readyok", () => this.send("isready"), timeoutMs);
  }

  async setOption(name, value) {
    if (this.options[name] === value) return;
    this.options[name] = value;
    this.send(`setoption name ${name} value ${value}`);
    await this.isReady();
  }

  async newGame() {
    this.send("ucinewgame");
    await this.isReady();
  }

  /**
   * Search a position.
   * Scores are normalised to the side-to-move's point of view (UCI's own
   * convention), and the caller flips them where it needs White's view.
   */
  async search({ fen, moves, depth, movetime, multiPv = 1, onInfo }) {
    await this.setOption("MultiPV", multiPv);

    const best = new Map(); // multipv index -> deepest info seen
    const collect = (line) => {
      if (!line.startsWith("info ") || !line.includes(" pv ")) return;
      const info = parseInfoLine(line);
      if (info.depth == null || !info.pv?.length) return;
      const prev = best.get(info.multipv);
      if (!prev || info.depth >= prev.depth) best.set(info.multipv, info);
      onInfo?.(info);
    };
    this.listeners.add(collect);

    const position = fen ? `position fen ${fen}` : "position startpos";
    const withMoves = moves?.length ? `${position} moves ${moves.join(" ")}` : position;

    const parts = ["go"];
    if (depth) parts.push("depth", String(depth));
    if (movetime) parts.push("movetime", String(movetime));

    // A generous ceiling: the search self-terminates well before this, but a
    // wedged engine must not hang the request forever.
    const budget = (movetime || 0) + (depth ? depth * 1500 : 0) + 20000;

    let bestLine;
    try {
      bestLine = await this._expect(
        (l) => l.startsWith("bestmove"),
        () => {
          this.send(withMoves);
          this.send(parts.join(" "));
        },
        budget
      );
    } finally {
      this.listeners.delete(collect);
    }

    const bestMove = bestLine.split(/\s+/)[1];
    const lines = [...best.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([multipv, info]) => ({
        multipv,
        depth: info.depth,
        cp: info.cp ?? null,
        mate: info.mate ?? null,
        pv: info.pv,
        nodes: info.nodes ?? null,
      }));

    return {
      bestMove: bestMove && bestMove !== "(none)" ? bestMove : null,
      lines,
      depth: lines[0]?.depth ?? null,
    };
  }

  stop() {
    try {
      this.send("stop");
    } catch {
      /* already gone */
    }
  }

  quit() {
    try {
      this.send("quit");
    } catch {
      /* already gone */
    }
    setTimeout(() => this.proc?.kill("SIGKILL"), 1500).unref?.();
  }
}

/**
 * A small pool so a long game analysis and a live hint request don't block each
 * other. Jobs queue when every engine is busy.
 */
class EnginePool {
  constructor(size) {
    this.size = Math.max(1, size);
    this.engines = [];
    this.queue = [];
    this.starting = null;
  }

  async init() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      for (let i = 0; i < this.size; i++) {
        const engine = new UciEngine(i);
        await engine.start();
        engine.on("exit", () => this._replace(engine));
        this.engines.push(engine);
      }
      return this;
    })();
    return this.starting;
  }

  async _replace(dead) {
    const idx = this.engines.indexOf(dead);
    if (idx === -1) return;
    this.engines.splice(idx, 1);
    try {
      const engine = new UciEngine(dead.id);
      await engine.start();
      engine.on("exit", () => this._replace(engine));
      this.engines.push(engine);
      this._drain();
    } catch (err) {
      console.error("[engine] failed to respawn:", err.message);
    }
  }

  _acquire() {
    return this.engines.find((e) => e.ready && !e.busy) || null;
  }

  _drain() {
    while (this.queue.length) {
      const engine = this._acquire();
      if (!engine) return;
      const job = this.queue.shift();
      this._run(engine, job);
    }
  }

  async _run(engine, job) {
    engine.busy = true;
    try {
      const result = await engine.search(job.params);
      job.resolve(result);
    } catch (err) {
      // A timed-out or crashed engine is not trustworthy; recycle it.
      if (/timed out/i.test(err.message)) {
        engine.quit();
        this._replace(engine);
      }
      job.reject(err);
    } finally {
      engine.busy = false;
      this._drain();
    }
  }

  search(params) {
    return new Promise((resolve, reject) => {
      const job = { params, resolve, reject };
      const engine = this._acquire();
      if (engine) this._run(engine, job);
      else this.queue.push(job);
    });
  }

  get info() {
    return {
      engines: this.engines.length,
      busy: this.engines.filter((e) => e.busy).length,
      queued: this.queue.length,
      name: this.engines[0]?.label || null,
    };
  }

  shutdown() {
    for (const e of this.engines) e.quit();
    this.engines = [];
  }
}

export const enginePool = new EnginePool(config.engine.poolSize);

let initPromise = null;
export function ensureEngine() {
  if (!initPromise) {
    initPromise = enginePool.init().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export { UciEngine, EnginePool };
