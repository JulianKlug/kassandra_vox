import { describe, it, expect, beforeEach } from "vitest";
import { createRoom, joinRoom, leaveRoom, broadcast, getRoom, getRoomCount, sweepIdleRooms, clearAllRooms, MAX_CLIENTS_PER_ROOM, IDLE_TIMEOUT_MS } from "../src/room.js";

// Minimal WebSocket mock
function mockWs(readyState = 1): any {
  const sent: string[] = [];
  return {
    readyState,
    send: (data: string) => sent.push(data),
    close: () => {},
    _sent: sent,
  };
}

describe("room", () => {
  beforeEach(() => clearAllRooms());

  it("creates a room", () => {
    const room = createRoom("TEST-ROOM-01");
    expect(room.clients.size).toBe(0);
    expect(getRoomCount()).toBe(1);
  });

  it("rejects duplicate room creation", () => {
    createRoom("TEST-ROOM-01");
    expect(() => createRoom("TEST-ROOM-01")).toThrow("already exists");
  });

  it("joins a room (auto-creates if needed)", () => {
    const ws = mockWs();
    const room = joinRoom("NEW-ROOM-42", ws);
    expect(room.clients.size).toBe(1);
    expect(getRoomCount()).toBe(1);
  });

  it("allows 2 clients per room", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    joinRoom("PAIR-TEST-11", ws1);
    const room = joinRoom("PAIR-TEST-11", ws2);
    expect(room.clients.size).toBe(2);
  });

  it("rejects 3rd client", () => {
    joinRoom("FULL-ROOM-99", mockWs());
    joinRoom("FULL-ROOM-99", mockWs());
    expect(() => joinRoom("FULL-ROOM-99", mockWs())).toThrow("full");
  });

  it("removes client on leave", () => {
    const ws = mockWs();
    joinRoom("LEAVE-TEST-01", ws);
    leaveRoom("LEAVE-TEST-01", ws);
    expect(getRoomCount()).toBe(0); // room deleted when empty
  });

  it("keeps room alive if one client remains", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    joinRoom("STAY-ROOM-01", ws1);
    joinRoom("STAY-ROOM-01", ws2);
    leaveRoom("STAY-ROOM-01", ws1);
    expect(getRoomCount()).toBe(1);
    expect(getRoom("STAY-ROOM-01")!.clients.size).toBe(1);
  });

  it("broadcasts to other clients only", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    joinRoom("BCAST-TEST-01", ws1);
    joinRoom("BCAST-TEST-01", ws2);
    const sent = broadcast("BCAST-TEST-01", ws1, "hello");
    expect(sent).toBe(1);
    expect(ws2._sent).toEqual(["hello"]);
    expect(ws1._sent).toEqual([]); // sender doesn't get it
  });

  it("skips closed clients in broadcast", () => {
    const ws1 = mockWs();
    const ws2 = mockWs(3); // CLOSED
    joinRoom("CLOSED-TEST-01", ws1);
    joinRoom("CLOSED-TEST-01", ws2);
    const sent = broadcast("CLOSED-TEST-01", ws1, "data");
    expect(sent).toBe(0);
  });

  it("returns 0 for broadcast to nonexistent room", () => {
    expect(broadcast("NOPE-NOPE-01", mockWs(), "data")).toBe(0);
  });

  it("sweeps idle rooms", () => {
    const ws = mockWs();
    const room = joinRoom("OLD-ROOM-01", ws);
    // Manually age the room
    room.lastActivity = Date.now() - IDLE_TIMEOUT_MS - 1;
    const swept = sweepIdleRooms();
    expect(swept).toBe(1);
    expect(getRoomCount()).toBe(0);
  });

  it("does not sweep active rooms", () => {
    joinRoom("FRESH-ROOM-01", mockWs());
    const swept = sweepIdleRooms();
    expect(swept).toBe(0);
    expect(getRoomCount()).toBe(1);
  });
});
