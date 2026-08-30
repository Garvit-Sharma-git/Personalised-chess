import { io } from "socket.io-client";
import { API_BASE, getToken } from "./api.js";

let socket = null;

/**
 * Single shared connection. Auth rides on the httpOnly cookie for same-origin
 * deploys; cross-site deploys pass the token in the handshake instead. `auth`
 * is a callback so a reconnect always picks up the current token.
 */
export function getSocket() {
  if (!socket) {
    socket = io(API_BASE || undefined, {
      withCredentials: true,
      auth: (cb) => {
        const token = getToken();
        cb(token ? { token } : {});
      },
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 20000,
    });
  }
  return socket;
}

export function emitAck(event, payload) {
  return new Promise((resolve) => {
    getSocket().emit(event, payload, (ack) => resolve(ack || { ok: false, error: "No response" }));
  });
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
