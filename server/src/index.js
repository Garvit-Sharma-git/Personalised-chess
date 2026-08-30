import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import { Server as SocketServer } from "socket.io";
import { config, ROOT, isAllowedOrigin } from "./config.js";
import { db, dbInfo } from "./db.js";
import { cookieParser } from "./lib/auth.js";
import authRoutes from "./routes/auth.js";
import gameRoutes from "./routes/games.js";
import userRoutes from "./routes/users.js";
import { setupGameSockets } from "./sockets/gameSocket.js";
import { ensureEngine, enginePool } from "./services/engine.js";
import { resumePendingAnalyses } from "./services/analysis.js";
import { reviewService } from "./services/chessReview.js";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Allow the configured client origins plus whatever origin this server is
// itself served from (browsers send Origin on same-origin requests too).
// Anything else simply gets no CORS headers, which the browser then blocks.
function originAllowed(origin, req) {
  if (isAllowedOrigin(origin)) return true;
  return origin === `${req.protocol}://${req.get("host")}`;
}
app.use((req, res, next) => {
  cors({
    origin: (origin, cb) => cb(null, originAllowed(origin, req)),
    credentials: true,
  })(req, res, next);
});
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    engine: enginePool.info,
    llm: reviewService.providerName,
    llmModels: reviewService.provider?.fastModel
      ? { review: reviewService.provider.model, hints: reviewService.provider.fastModel, fallback: reviewService.provider.fallbackModel }
      : null,
    llmUsage: reviewService.provider?.stats || null,
    liveCoachAccounts: config.coachAccounts.length,
  });
});
app.use("/api/auth", authRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/users", userRoutes);

// Serve the built client when it exists (production single-origin deploy).
const clientDist = path.join(ROOT, "client", "dist");
if (fs.existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON" });
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), credentials: true },
  pingInterval: 10000,
  pingTimeout: 20000,
});
const sockets = setupGameSockets(io);

server.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port} (${config.env})`);
  console.log(`[server] allowed browser origins: ${config.clientOrigins.join(", ")}`);
  console.log(`[server] database: ${dbInfo.kind} (${dbInfo.location})`);
  console.log(`[server] live coaching enabled for: ${config.coachAccounts.join(", ")}`);
  console.log(`[server] explanations: ${reviewService.providerName}${config.groq.apiKey ? "" : " (set GROQ_API_KEY to enable Groq)"}`);
  if (/^(dev-only|change-me)/.test(config.jwtSecret)) console.warn("[server] WARNING: using the default JWT secret; set JWT_SECRET in .env");

  ensureEngine()
    .then(() => {
      console.log(`[engine] ready: ${enginePool.info.name} x${enginePool.info.engines}`);
      const pending = resumePendingAnalyses();
      if (pending) console.log(`[analysis] resumed ${pending} pending analyses`);
    })
    .catch((err) => console.error("[engine] failed to start:", err.message));

  const live = db.prepare("SELECT * FROM games WHERE status = 'active'").all();
  sockets.armAllClocks(live);
});

function shutdown() {
  console.log("[server] shutting down");
  io.close();
  enginePool.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A transient failure (a stale database connection, a dropped socket) must not
// take the server down: the data layer reconnects on its own, and dying here
// would drop every live game. Log loudly and keep serving.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection:", reason);
});
