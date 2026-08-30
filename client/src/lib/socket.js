import { io } from "socket.io-client";

let socket = null;

/** Single shared connection; auth rides on the httpOnly cookie. */
export function getSocket() {
  if (!socket) {
    socket = io({
      withCredentials: true,
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 10000,
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
