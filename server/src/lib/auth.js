import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import cookie from "cookie-parser";
import { config, isCoachAccount } from "../config.js";
import { db } from "../db.js";

const SELECT_USER = db.prepare(
  "SELECT id, email, username, rating, created_at FROM users WHERE id = ?"
);

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/** Shape a user row for the wire. `canUseLiveCoach` is derived server-side only. */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    rating: row.rating,
    createdAt: row.created_at,
    canUseLiveCoach: isCoachAccount(row.email),
  };
}

export function setAuthCookie(res, token) {
  // SameSite=None is only honoured on Secure cookies; fall back to Lax when the
  // deployment is not HTTPS so local development keeps working.
  const sameSite = config.cookieSameSite === "none" && config.cookieSecure ? "none" : config.cookieSameSite;
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite,
    secure: config.cookieSecure,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(config.cookieName, { path: "/" });
}

function tokenFromRequest(req) {
  const fromCookie = req.cookies?.[config.cookieName];
  if (fromCookie) return fromCookie;
  const header = req.headers?.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

/** Resolve the user from a request; returns null when unauthenticated. */
export function userFromRequest(req) {
  const token = tokenFromRequest(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload?.sub) return null;
  return SELECT_USER.get(Number(payload.sub)) || null;
}

export function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  req.user = user;
  next();
}

export function optionalAuth(req, _res, next) {
  req.user = userFromRequest(req) || null;
  next();
}

export const cookieParser = cookie;

/**
 * Socket.IO handshake auth. Accepts the httpOnly cookie (same-origin) and
 * falls back to an explicit auth token for cross-origin dev setups.
 */
export function authenticateSocket(socket) {
  const raw = socket.handshake.headers?.cookie;
  let token = socket.handshake.auth?.token || null;
  if (!token && raw) {
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === config.cookieName) {
        token = decodeURIComponent(v.join("="));
        break;
      }
    }
  }
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload?.sub) return null;
  return SELECT_USER.get(Number(payload.sub)) || null;
}
