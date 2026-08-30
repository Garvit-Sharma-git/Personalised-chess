/**
 * API client.
 *
 * Same-origin deploys (local dev, or server-serves-client) authenticate with
 * the httpOnly cookie, which JavaScript cannot read and XSS cannot steal.
 * When the app is hosted on a different site than the API (Vercel + Render,
 * say), browsers block that cookie as third-party, so we fall back to a Bearer
 * token kept in localStorage. The server accepts either.
 */
export const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

/** Cross-site deploys have no usable cookie, so they need the token. */
export const USE_TOKEN_AUTH = API_BASE !== "";

const TOKEN_KEY = "chess_token";

export function getToken() {
  if (!USE_TOKEN_AUTH) return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  if (!USE_TOKEN_AUTH) return;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing */
  }
}

export function authHeaders() {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new ApiError(data?.error || res.statusText || "Request failed", res.status);
  // Auth endpoints hand back a token for the cross-site case.
  if (data?.token) setToken(data.token);
  return data;
}

/**
 * Download a game's PGN. A plain <a download> cannot carry the Authorization
 * header, so fetch it and hand the browser a blob.
 */
export async function downloadPgn(code) {
  const res = await fetch(`${API_BASE}/api/games/${code}/pgn`, {
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new ApiError("Could not download the PGN", res.status);
  const text = await res.text();
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-chess-pgn" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `game-${code}.pgn`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
