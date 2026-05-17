/**
 * State + queue for the hybrid offline pass.
 *
 * Pure module — no native imports, no side effects. Unit-testable
 * without mocking sherpa, expo, or filesystem.
 *
 * Two responsibilities:
 *   - Track which progressive marks have fired for the current
 *     (still-open) segment. Reset on rotation.
 *   - Serialize offline passes via a FIFO queue. Progressive entries
 *     dedupe to "latest only" because a smaller prefix is strictly
 *     less informative than a newer one. Endpoint entries are never
 *     replaced — losing one drops the medical-grade rewrite for a
 *     finished segment.
 *
 * See docs/specs/progressive-offline-passes.md (D1 + D2).
 */

import type { Segment } from "./segment-manager";

export type QueueEntry =
  | { kind: "progressive"; mark: number; seg: Segment }
  | { kind: "endpoint"; seg: Segment };

export interface ProgressivePassState {
  /** Marks (seconds) already fired for the CURRENT segment. Cleared on rotation. */
  firedMarks: Set<number>;
  /** Pending entries, FIFO. */
  queue: QueueEntry[];
  /** Entry currently being processed, or null if idle. */
  inFlight: QueueEntry | null;
}

export function createState(): ProgressivePassState {
  return { firedMarks: new Set(), queue: [], inFlight: null };
}

/**
 * Push an entry into the queue.
 *
 * Endpoint entries always append.
 *
 * Progressive entries replace the trailing progressive entry if present
 * (the newer snapshot subsumes the older one). If the trailing entry is
 * an endpoint, the progressive appends after it — we must not jump
 * ahead of an endpoint waiting to run.
 */
export function enqueue(state: ProgressivePassState, entry: QueueEntry): void {
  if (entry.kind === "endpoint") {
    state.queue.push(entry);
    return;
  }
  const tail = state.queue[state.queue.length - 1];
  if (tail && tail.kind === "progressive") {
    state.queue[state.queue.length - 1] = entry;
    return;
  }
  state.queue.push(entry);
}

/** Pop the next entry to run, or null if the queue is empty. */
export function dequeue(state: ProgressivePassState): QueueEntry | null {
  return state.queue.shift() ?? null;
}

export type WritebackTarget =
  | { target: "current" }
  | { target: "finished"; i: number }
  | { target: "discard" };

/**
 * Decide where a completed pass's result should land.
 *
 *   - "current" if the snapshot's segment is still the live current segment
 *     (the common case for progressive passes that complete before endpoint).
 *
 *   - "finished" if the segment is in finishedSegments AND either the slot
 *     is still empty, OR this pass is the endpoint pass. Endpoint always
 *     overwrites because it transcribed the full audio; a progressive result
 *     in the slot is a prefix-only backfill that should not survive the
 *     endpoint result.
 *
 *   - "discard" otherwise: a progressive pass arriving after another result
 *     already wrote, or the segment isn't in either place.
 */
export function writebackTarget(
  seg: Segment,
  currentSegmentIndex: number,
  finishedSegments: Segment[],
  kind: QueueEntry["kind"] = "progressive",
): WritebackTarget {
  if (seg.index === currentSegmentIndex) return { target: "current" };
  const i = finishedSegments.findIndex((s) => s.index === seg.index);
  if (i !== -1) {
    if (kind === "endpoint" || finishedSegments[i].offlineText == null) {
      return { target: "finished", i };
    }
  }
  return { target: "discard" };
}

/** Reset fired marks on segment rotation. Queue is untouched. */
export function onRotate(state: ProgressivePassState): void {
  state.firedMarks.clear();
}
