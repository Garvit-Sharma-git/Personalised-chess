import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { db } from "../db.js";
import {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  publicUser,
  optionalAuth,
} from "../lib/auth.js";

const router = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  username: z
    .string()
    .trim()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers and underscores only"),
  password: z.string().min(8).max(128),
});

const LoginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});

const INSERT_USER = db.prepare(
  "INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)"
);
const BY_EMAIL = db.prepare("SELECT * FROM users WHERE email = ?");
const BY_USERNAME = db.prepare("SELECT * FROM users WHERE lower(username) = lower(?)");
const BY_ID = db.prepare("SELECT * FROM users WHERE id = ?");

function validationError(res, err) {
  const issue = err.issues?.[0];
  return res.status(400).json({ error: issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid input" });
}

router.post(
  "/register",
  limiter,
  asyncHandler(async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const { email, username, password } = parsed.data;

    if (BY_EMAIL.get(email)) return res.status(409).json({ error: "An account with that email already exists" });
    if (BY_USERNAME.get(username)) return res.status(409).json({ error: "That username is taken" });

    const hash = await hashPassword(password);
    const info = INSERT_USER.run(email, username, hash);
    const user = BY_ID.get(info.lastInsertRowid);
    const token = signToken(user);
    setAuthCookie(res, token);
    // The token is also returned so a browser app hosted on a different site
    // (where third-party cookies are blocked) can send it as a Bearer header.
    res.status(201).json({ user: publicUser(user), token });
  })
);

router.post(
  "/login",
  limiter,
  asyncHandler(async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const { identifier, password } = parsed.data;

    const user = identifier.includes("@") ? BY_EMAIL.get(identifier.toLowerCase()) : BY_USERNAME.get(identifier);
    const ok = user && (await verifyPassword(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token });
  })
);

router.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// 200 with user:null when logged out, so the client can probe without console noise.
router.get("/me", optionalAuth, (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

export default router;
