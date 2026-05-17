import {
  createState,
  enqueue,
  dequeue,
  writebackTarget,
  onRotate,
  QueueEntry,
} from "../progressive-pass-state";
import { createSegment, Segment } from "../segment-manager";

function progressive(index: number, mark: number): QueueEntry {
  return { kind: "progressive", mark, seg: { ...createSegment(index) } };
}
function endpoint(index: number): QueueEntry {
  return { kind: "endpoint", seg: { ...createSegment(index) } };
}

// ── createState ─────────────────────────────────────────

describe("createState", () => {
  test("returns empty state", () => {
    const s = createState();
    expect(s.firedMarks.size).toBe(0);
    expect(s.queue).toEqual([]);
    expect(s.inFlight).toBeNull();
  });
});

// ── enqueue ─────────────────────────────────────────────

describe("enqueue", () => {
  test("endpoint appends to an empty queue", () => {
    const s = createState();
    enqueue(s, endpoint(0));
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0].kind).toBe("endpoint");
  });

  test("endpoint never replaces an existing endpoint", () => {
    const s = createState();
    enqueue(s, endpoint(0));
    enqueue(s, endpoint(1));
    expect(s.queue).toHaveLength(2);
    expect(s.queue.map((e) => e.kind)).toEqual(["endpoint", "endpoint"]);
  });

  test("progressive replaces a trailing progressive", () => {
    const s = createState();
    enqueue(s, progressive(0, 5));
    enqueue(s, progressive(0, 10));
    expect(s.queue).toHaveLength(1);
    const tail = s.queue[0];
    expect(tail.kind).toBe("progressive");
    if (tail.kind === "progressive") expect(tail.mark).toBe(10);
  });

  test("progressive appends after a trailing endpoint", () => {
    const s = createState();
    enqueue(s, endpoint(0));
    enqueue(s, progressive(1, 5));
    expect(s.queue).toHaveLength(2);
    expect(s.queue.map((e) => e.kind)).toEqual(["endpoint", "progressive"]);
  });

  test("endpoint never replaces a trailing progressive", () => {
    const s = createState();
    enqueue(s, progressive(0, 5));
    enqueue(s, endpoint(0));
    expect(s.queue).toHaveLength(2);
    expect(s.queue.map((e) => e.kind)).toEqual(["progressive", "endpoint"]);
  });

  test("mixed sequence [E, P, P, E] collapses the middle progressives", () => {
    const s = createState();
    enqueue(s, endpoint(0));
    enqueue(s, progressive(1, 5));
    enqueue(s, progressive(1, 10));
    enqueue(s, endpoint(1));
    expect(s.queue).toHaveLength(3);
    expect(s.queue.map((e) => e.kind)).toEqual(["endpoint", "progressive", "endpoint"]);
    const middle = s.queue[1];
    if (middle.kind === "progressive") expect(middle.mark).toBe(10);
  });

  test("two endpoints in succession both retained", () => {
    const s = createState();
    enqueue(s, endpoint(0));
    enqueue(s, endpoint(1));
    const first = dequeue(s);
    const second = dequeue(s);
    expect(first?.kind).toBe("endpoint");
    expect(second?.kind).toBe("endpoint");
    expect(dequeue(s)).toBeNull();
  });
});

// ── dequeue ─────────────────────────────────────────────

describe("dequeue", () => {
  test("returns null on empty queue", () => {
    const s = createState();
    expect(dequeue(s)).toBeNull();
  });

  test("pops FIFO", () => {
    const s = createState();
    enqueue(s, endpoint(0));
    enqueue(s, progressive(1, 5));
    expect(dequeue(s)?.kind).toBe("endpoint");
    expect(dequeue(s)?.kind).toBe("progressive");
    expect(dequeue(s)).toBeNull();
  });
});

// ── writebackTarget ─────────────────────────────────────

describe("writebackTarget", () => {
  test("snapshot index matches current → current", () => {
    const seg = createSegment(3);
    const result = writebackTarget(seg, 3, []);
    expect(result).toEqual({ target: "current" });
  });

  test("snapshot in finishedSegments with empty offlineText → finished slot", () => {
    const finished: Segment[] = [
      { ...createSegment(0), offlineText: "done" },
      createSegment(1), // offlineText null
    ];
    const snapshot = createSegment(1);
    expect(writebackTarget(snapshot, 2, finished)).toEqual({ target: "finished", i: 1 });
  });

  test("snapshot in finishedSegments with non-null offlineText → discard", () => {
    const finished: Segment[] = [
      { ...createSegment(0), offlineText: "already written" },
    ];
    const snapshot = createSegment(0);
    expect(writebackTarget(snapshot, 1, finished)).toEqual({ target: "discard" });
  });

  test("snapshot not in current or finished → discard", () => {
    const finished: Segment[] = [createSegment(0)];
    const snapshot = createSegment(99);
    expect(writebackTarget(snapshot, 1, finished)).toEqual({ target: "discard" });
  });

  test("current takes priority over finished match", () => {
    // Defensive: if the segment somehow exists in both places, prefer current.
    const finished: Segment[] = [createSegment(3)];
    const snapshot = createSegment(3);
    expect(writebackTarget(snapshot, 3, finished)).toEqual({ target: "current" });
  });

  // Regression: endpoint pass transcribed the full segment audio. A progressive
  // pass result already in the slot is prefix-only and must not block it.
  test("endpoint pass overwrites a progressive result in the finished slot", () => {
    const finished: Segment[] = [
      { ...createSegment(0), offlineText: "prefix-only from progressive" },
    ];
    const snapshot = createSegment(0);
    expect(writebackTarget(snapshot, 1, finished, "endpoint")).toEqual({
      target: "finished",
      i: 0,
    });
  });

  test("progressive pass does NOT overwrite an existing result", () => {
    const finished: Segment[] = [
      { ...createSegment(0), offlineText: "earlier result" },
    ];
    const snapshot = createSegment(0);
    expect(writebackTarget(snapshot, 1, finished, "progressive")).toEqual({
      target: "discard",
    });
  });

  test("default kind keeps prior progressive-style behavior", () => {
    const finished: Segment[] = [
      { ...createSegment(0), offlineText: "already there" },
    ];
    const snapshot = createSegment(0);
    expect(writebackTarget(snapshot, 1, finished)).toEqual({ target: "discard" });
  });
});

// ── onRotate ────────────────────────────────────────────

describe("onRotate", () => {
  test("clears firedMarks", () => {
    const s = createState();
    s.firedMarks.add(5);
    s.firedMarks.add(10);
    onRotate(s);
    expect(s.firedMarks.size).toBe(0);
  });

  test("does not touch the queue", () => {
    const s = createState();
    enqueue(s, endpoint(0));
    enqueue(s, progressive(1, 5));
    onRotate(s);
    expect(s.queue).toHaveLength(2);
  });

  test("does not touch inFlight", () => {
    const s = createState();
    s.inFlight = endpoint(0);
    onRotate(s);
    expect(s.inFlight?.kind).toBe("endpoint");
  });
});
