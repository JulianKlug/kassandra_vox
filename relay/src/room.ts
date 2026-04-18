/**
 * Room management for the relay server.
 *
 * Each room holds up to 2 WebSocket clients (phone + desktop).
 * Rooms are in-memory only — server restart clears all rooms.
 * Idle rooms (no activity for IDLE_TIMEOUT_MS) are swept periodically.
 */

import type { WebSocket } from "ws";

export const MAX_CLIENTS_PER_ROOM = 2;
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // check every minute

export interface Room {
  clients: Set<WebSocket>;
  createdAt: number;
  lastActivity: number;
}

const rooms = new Map<string, Room>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function getRoom(code: string): Room | undefined {
  return rooms.get(code);
}

export function getRoomCount(): number {
  return rooms.size;
}

export function createRoom(code: string): Room {
  if (rooms.has(code)) {
    throw new Error(`Room ${code} already exists`);
  }
  const now = Date.now();
  const room: Room = { clients: new Set(), createdAt: now, lastActivity: now };
  rooms.set(code, room);
  return room;
}

export function joinRoom(code: string, ws: WebSocket): Room {
  let room = rooms.get(code);
  if (!room) {
    room = createRoom(code);
  }
  if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
    throw new Error(`Room ${code} is full`);
  }
  room.clients.add(ws);
  room.lastActivity = Date.now();
  return room;
}

export function leaveRoom(code: string, ws: WebSocket): void {
  const room = rooms.get(code);
  if (!room) return;
  room.clients.delete(ws);
  if (room.clients.size === 0) {
    rooms.delete(code);
  }
}

/**
 * Forward a message to all other clients in the room.
 */
export function broadcast(code: string, sender: WebSocket, data: string): number {
  const room = rooms.get(code);
  if (!room) return 0;
  room.lastActivity = Date.now();
  let sent = 0;
  for (const client of room.clients) {
    if (client !== sender && client.readyState === 1) { // WebSocket.OPEN = 1
      client.send(data);
      sent++;
    }
  }
  return sent;
}

/**
 * Remove idle rooms (no activity for IDLE_TIMEOUT_MS).
 */
export function sweepIdleRooms(): number {
  const now = Date.now();
  let swept = 0;
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > IDLE_TIMEOUT_MS) {
      for (const client of room.clients) {
        client.close(4001, "Room idle timeout");
      }
      rooms.delete(code);
      swept++;
    }
  }
  return swept;
}

export function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepIdleRooms, SWEEP_INTERVAL_MS);
}

export function stopSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Clear all rooms (for testing). */
export function clearAllRooms(): void {
  rooms.clear();
}
