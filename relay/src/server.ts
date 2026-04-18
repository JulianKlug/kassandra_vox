/**
 * Vox relay server.
 *
 * Stateless WebSocket router that forwards encrypted messages between
 * phone and desktop clients in the same room. Never sees plaintext.
 *
 * Protocol:
 *   Client sends: { type: "join", room: "BLEU-TIGRE-42" }
 *   Server acks:  { type: "join", room: "BLEU-TIGRE-42", clients: 1 }
 *   Client sends: { type: "relay", room: "BLEU-TIGRE-42", payload: "<base64>" }
 *   Server forwards payload to other client(s) in the room.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { joinRoom, leaveRoom, broadcast, getRoomCount, startSweep, stopSweep, getRoom } from "./room.js";
import { isValidRoomCode } from "./words.js";
import { isRateLimited, clearRateLimit, startRateLimitSweep, stopRateLimitSweep } from "./rate-limit.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const MAX_MESSAGE_BYTES = 64 * 1024; // 64 KB — clinical notes are <10 KB

interface RelayMessage {
  type: string;
  room?: string;
  payload?: string;
}

// Track which room each client belongs to
const clientRooms = new Map<WebSocket, string>();

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function sendError(ws: WebSocket, message: string): void {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message }));
  } catch {}
}

function handleMessage(ws: WebSocket, ip: string, data: Buffer): void {
  // Fix #1: reject oversized messages before parsing
  if (data.length > MAX_MESSAGE_BYTES) {
    console.log(`[vox-relay] REJECT ip=${ip} size=${data.length} exceeds ${MAX_MESSAGE_BYTES}`);
    ws.close(4002, "Message too large");
    return;
  }

  const raw = data.toString();

  if (isRateLimited(ip)) {
    console.log(`[vox-relay] RATE_LIMITED ip=${ip}`);
    sendError(ws, "Rate limited. Max 100 messages per minute.");
    return;
  }

  let msg: RelayMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    sendError(ws, "Invalid JSON");
    return;
  }

  if (!msg.type || !msg.room) {
    sendError(ws, "Missing type or room");
    return;
  }

  if (!isValidRoomCode(msg.room)) {
    sendError(ws, "Invalid room code");
    return;
  }

  switch (msg.type) {
    case "join": {
      // Leave any previous room
      const prev = clientRooms.get(ws);
      if (prev) leaveRoom(prev, ws);

      try {
        const room = joinRoom(msg.room, ws);
        clientRooms.set(ws, msg.room);
        console.log(`[vox-relay] JOIN room=${msg.room} clients=${room.clients.size} ip=${ip}`);
        ws.send(JSON.stringify({ type: "join", room: msg.room, clients: room.clients.size }));

        // Notify existing clients that someone joined
        broadcast(msg.room, ws, JSON.stringify({ type: "peer-join", room: msg.room, clients: room.clients.size }));
      } catch (e: any) {
        console.log(`[vox-relay] JOIN_FAILED room=${msg.room} ip=${ip} error=${e.message}`);
        sendError(ws, e.message);
      }
      break;
    }

    case "relay": {
      const room = clientRooms.get(ws);
      if (!room || room !== msg.room) {
        sendError(ws, "Not in this room");
        return;
      }
      if (!msg.payload) {
        sendError(ws, "Missing payload");
        return;
      }
      // Forward the entire message as-is to peers
      broadcast(msg.room, ws, raw);
      break;
    }

    case "ping": {
      ws.send(JSON.stringify({ type: "pong" }));
      break;
    }

    default:
      sendError(ws, `Unknown type: ${msg.type}`);
  }
}

function handleDisconnect(ws: WebSocket, ip: string): void {
  const room = clientRooms.get(ws);
  if (room) {
    const roomObj = getRoom(room);
    leaveRoom(room, ws);
    console.log(`[vox-relay] LEAVE room=${room} ip=${ip} remaining=${roomObj?.clients.size ?? 0}`);
    if (roomObj && roomObj.clients.size > 0) {
      for (const client of roomObj.clients) {
        try {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: "peer-leave", room, clients: roomObj.clients.size }));
          }
        } catch {}
      }
    }
    clientRooms.delete(ws);
  }
  clearRateLimit(ip);
}

// HTTP server for health checks
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: getRoomCount() }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const ip = getClientIp(req);

  ws.on("message", (data: Buffer) => {
    handleMessage(ws, ip, data);
  });

  ws.on("close", () => handleDisconnect(ws, ip));
  ws.on("error", () => handleDisconnect(ws, ip));
});

startSweep();
startRateLimitSweep();

httpServer.listen(PORT, () => {
  console.log(`[vox-relay] Listening on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[vox-relay] Shutting down...");
  stopSweep();
  stopRateLimitSweep();
  wss.close();
  httpServer.close();
});

export { httpServer, wss };
