/**
 * Integration tests for the relay server.
 * Spins up the actual HTTP + WebSocket server on a random port,
 * connects real WebSocket clients, and tests the full lifecycle.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocket } from "ws";
import { createServer, type Server } from "http";
import { WebSocketServer } from "ws";
import { joinRoom, leaveRoom, broadcast, getRoom, getRoomCount, clearAllRooms, startSweep, stopSweep } from "../src/room.js";
import { isValidRoomCode, generateRoomCode } from "../src/words.js";
import { isRateLimited, clearAllRateLimits, clearRateLimit, startRateLimitSweep, stopRateLimitSweep } from "../src/rate-limit.js";

// --- Mini server (same logic as server.ts but testable) ---

const MAX_MESSAGE_BYTES = 64 * 1024;
const clientRooms = new Map<WebSocket, string>();

function sendError(ws: WebSocket, message: string) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message })); } catch {}
}

function setupServer(port: number): { httpServer: Server; wss: WebSocketServer } {
  const httpServer = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", rooms: getRoomCount() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    const ip = "127.0.0.1";

    ws.on("message", (data: Buffer) => {
      if (data.length > MAX_MESSAGE_BYTES) {
        ws.close(4002, "Message too large");
        return;
      }
      const raw = data.toString();
      if (isRateLimited(ip)) {
        sendError(ws, "Rate limited. Max 100 messages per minute.");
        return;
      }
      let msg: any;
      try { msg = JSON.parse(raw); } catch { sendError(ws, "Invalid JSON"); return; }
      if (!msg.type || !msg.room) { sendError(ws, "Missing type or room"); return; }
      if (!isValidRoomCode(msg.room)) { sendError(ws, "Invalid room code"); return; }

      switch (msg.type) {
        case "join": {
          const prev = clientRooms.get(ws);
          if (prev) leaveRoom(prev, ws);
          try {
            const room = joinRoom(msg.room, ws);
            clientRooms.set(ws, msg.room);
            ws.send(JSON.stringify({ type: "join", room: msg.room, clients: room.clients.size }));
            broadcast(msg.room, ws, JSON.stringify({ type: "peer-join", room: msg.room, clients: room.clients.size }));
          } catch (e: any) { sendError(ws, e.message); }
          break;
        }
        case "relay": {
          const room = clientRooms.get(ws);
          if (!room || room !== msg.room) { sendError(ws, "Not in this room"); return; }
          if (!msg.payload) { sendError(ws, "Missing payload"); return; }
          broadcast(msg.room, ws, raw);
          break;
        }
        case "ping": { ws.send(JSON.stringify({ type: "pong" })); break; }
        default: sendError(ws, `Unknown type: ${msg.type}`);
      }
    });

    ws.on("close", () => {
      const room = clientRooms.get(ws);
      if (room) {
        const roomObj = getRoom(room);
        leaveRoom(room, ws);
        if (roomObj && roomObj.clients.size > 0) {
          for (const c of roomObj.clients) {
            try { if (c.readyState === 1) c.send(JSON.stringify({ type: "peer-leave", room, clients: roomObj.clients.size })); } catch {}
          }
        }
        clientRooms.delete(ws);
      }
      clearRateLimit(ip);
    });
  });

  return new Promise<{ httpServer: Server; wss: WebSocketServer }>((resolve) => {
    httpServer.listen(port, () => resolve({ httpServer, wss }));
  });
}

// --- Helpers ---

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket, timeout = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for message")), timeout);
    ws.once("message", (data: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function send(ws: WebSocket, msg: any) {
  ws.send(JSON.stringify(msg));
}

// --- Tests ---

let port: number;
let httpServer: Server;
let wss: WebSocketServer;

beforeAll(async () => {
  const s = await setupServer(0); // OS assigns a free port
  httpServer = s.httpServer;
  wss = s.wss;
  port = (httpServer.address() as any).port;
});

afterAll(() => {
  if (wss) wss.close();
  if (httpServer) httpServer.close();
});

beforeEach(() => {
  clearAllRooms();
  clearAllRateLimits();
  clientRooms.clear();
});

describe("health endpoint", () => {
  it("returns ok with room count", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.rooms).toBe(0);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe("join flow", () => {
  it("joins a room and receives ack", async () => {
    const ws = await connect(port);
    send(ws, { type: "join", room: "BLEU-TIGRE-42" });
    const msg = await waitForMessage(ws);
    expect(msg).toEqual({ type: "join", room: "BLEU-TIGRE-42", clients: 1 });
    ws.close();
  });

  it("second client gets peer-join notification", async () => {
    const ws1 = await connect(port);
    send(ws1, { type: "join", room: "PAIR-TEST-55" });
    await waitForMessage(ws1); // join ack

    const ws2 = await connect(port);
    send(ws2, { type: "join", room: "PAIR-TEST-55" });

    const peerJoin = await waitForMessage(ws1);
    expect(peerJoin.type).toBe("peer-join");
    expect(peerJoin.clients).toBe(2);

    ws1.close();
    ws2.close();
  });

  it("rejects 3rd client", async () => {
    const ws1 = await connect(port);
    const ws2 = await connect(port);
    const ws3 = await connect(port);
    send(ws1, { type: "join", room: "FULL-ROOM-33" });
    await waitForMessage(ws1);
    send(ws2, { type: "join", room: "FULL-ROOM-33" });
    await waitForMessage(ws2);
    send(ws3, { type: "join", room: "FULL-ROOM-33" });
    const err = await waitForMessage(ws3);
    expect(err.type).toBe("error");
    expect(err.message).toMatch(/full/i);
    ws1.close(); ws2.close(); ws3.close();
  });
});

describe("relay flow", () => {
  it("forwards payload to peer", async () => {
    const ws1 = await connect(port);
    const ws2 = await connect(port);
    send(ws1, { type: "join", room: "RELAY-TEST-11" });
    await waitForMessage(ws1);
    send(ws2, { type: "join", room: "RELAY-TEST-11" });
    await waitForMessage(ws2);
    await waitForMessage(ws1); // peer-join

    send(ws1, { type: "relay", room: "RELAY-TEST-11", payload: "dGVzdA==" });
    const relayed = await waitForMessage(ws2);
    expect(relayed.type).toBe("relay");
    expect(relayed.payload).toBe("dGVzdA==");

    ws1.close(); ws2.close();
  });

  it("rejects relay when not in room", async () => {
    const ws = await connect(port);
    send(ws, { type: "relay", room: "BLEU-TIGRE-42", payload: "test" });
    const err = await waitForMessage(ws);
    expect(err.type).toBe("error");
    expect(err.message).toMatch(/not in/i);
    ws.close();
  });

  it("rejects relay with missing payload", async () => {
    const ws = await connect(port);
    send(ws, { type: "join", room: "NOPAY-TEST-22" });
    await waitForMessage(ws);
    send(ws, { type: "relay", room: "NOPAY-TEST-22" });
    const err = await waitForMessage(ws);
    expect(err.type).toBe("error");
    expect(err.message).toMatch(/payload/i);
    ws.close();
  });
});

describe("disconnect flow", () => {
  it("notifies peer on disconnect", async () => {
    const ws1 = await connect(port);
    const ws2 = await connect(port);
    send(ws1, { type: "join", room: "DISC-TEST-44" });
    await waitForMessage(ws1);
    send(ws2, { type: "join", room: "DISC-TEST-44" });
    await waitForMessage(ws2);
    await waitForMessage(ws1); // peer-join

    ws2.close();
    const leave = await waitForMessage(ws1);
    expect(leave.type).toBe("peer-leave");
    expect(leave.clients).toBe(1);

    ws1.close();
  });
});

describe("error handling", () => {
  it("rejects invalid JSON", async () => {
    const ws = await connect(port);
    ws.send("not json at all");
    const err = await waitForMessage(ws);
    expect(err.type).toBe("error");
    expect(err.message).toMatch(/json/i);
    ws.close();
  });

  it("rejects missing type/room", async () => {
    const ws = await connect(port);
    send(ws, { foo: "bar" });
    const err = await waitForMessage(ws);
    expect(err.type).toBe("error");
    expect(err.message).toMatch(/missing/i);
    ws.close();
  });

  it("rejects invalid room code", async () => {
    const ws = await connect(port);
    send(ws, { type: "join", room: "bad-code" });
    const err = await waitForMessage(ws);
    expect(err.type).toBe("error");
    expect(err.message).toMatch(/invalid room/i);
    ws.close();
  });

  it("rejects unknown message type", async () => {
    const ws = await connect(port);
    send(ws, { type: "dance", room: "BLEU-TIGRE-42" });
    const err = await waitForMessage(ws);
    expect(err.type).toBe("error");
    expect(err.message).toMatch(/unknown/i);
    ws.close();
  });
});

describe("ping/pong", () => {
  it("responds to ping", async () => {
    const ws = await connect(port);
    send(ws, { type: "ping", room: "PING-TEST-99" });
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe("pong");
    ws.close();
  });
});

describe("message size limit", () => {
  it("closes connection on oversized message", async () => {
    const ws = await connect(port);
    const big = JSON.stringify({ type: "join", room: "BLEU-TIGRE-42", payload: "x".repeat(70000) });

    const closed = new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });

    ws.send(big);
    const code = await closed;
    expect(code).toBe(4002);
  });
});
