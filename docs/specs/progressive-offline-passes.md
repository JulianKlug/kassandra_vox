# Spec: Progressive offline passes

**Date:** 2026-05-14
**Status:** Proposed
**Owner:** unassigned
**Related:** `docs/specs/offline-pass-quality-gate.md`, `docs/issues/unsolved.md` #4 (medical French WER)

## Problem

The hybrid STT engine runs a NeMo CTC offline pass exactly **once per segment**, fired only when the streaming endpoint detector closes the segment or when `MAX_NO_PASS_MS = 30_000` elapses without one. Specifically:

- `mobile/src/stt/hybrid-engine.ts` `tryOfflinePass()` rotates the current segment and schedules a single offline pass on the closed audio.
- `mobile/src/stt/segment-manager.ts` `shouldTriggerOfflinePass()` is consulted once, on rotation.
- `buildTranscript()` only ever consults `seg.offlineText` for **finished** segments — the current (in-flight) segment's text is always the rough streaming output, even after seconds of speech.

The user-visible consequence: a doctor speaks for 15–25 seconds, sees only the streaming zipformer's rough text the whole time, and the medical-grade rewrite arrives several seconds **after** they finish (endpoint debounce + NeMo inference on the full WAV, which is 1–10s on the emulator and longer on cheaper hardware).

There is no technical reason offline passes have to wait for endpoint. NeMo CTC is non-streaming but it doesn't care whether the WAV is "complete" — it transcribes whatever audio you give it. We can run it repeatedly on growing prefixes of the still-open segment and show each result as it lands, gated by the same quality machinery (`gateOfflineText`) that already protects the post-endpoint pass.

## Goal

Deliver gated offline rewrites mid-utterance — refining in place as the doctor speaks — without degrading the final-segment WER, and without a new model or any new native API surface.

Settle two empirical unknowns via a sweep test on the 10 spike recordings:

1. **Latency math.** Extra passes are pure inference cost. Does the perceived-correction speedup outweigh cumulative inference time?
2. **Short-clip regression.** NeMo CTC misfires on <3s clips (multilingual fallback, the same failure mode that motivated `MIN_AUDIO_SAMPLES = 3s`). Map the regression curve at 3 / 5 / 7 / 10 / 15s prefixes and pick the shortest mark whose output still passes the gates often enough to be worth the inference cost.

## Non-goals

- Changing the offline model. (Tracked separately: NeMo FR-only Conformer eval.)
- Per-token confidence gating. Needs sherpa-onnx API surface, separate effort.
- Parallel multi-window ensembles at endpoint (see "Alternatives considered").
- Overlap-deduplicated sliding windows across segment boundaries.

## Design

Four blocks. All implementation-ready; no design decisions deferred.

### Data flow

```
PCM callback (every ~20ms, ~3200 samples)
        │
        ├──> appendSamples(currentSegment, samples)
        │
        ├──> sherpa zipformer (streaming) ──> currentSegment.streamingText
        │
        └──> tryProgressivePass()
                 │
                 │  if (!passState.inFlight && nextProgressivePassMark != null):
                 │     snapshot = snapshotSegmentPrefix(currentSegment, mark)
                 │     passState.firedMarks.add(mark)
                 │     scheduleOfflinePass({ kind: "progressive", seg: snapshot })
                 │
                 ▼
        passState.queue (D2: FIFO array, not single slot)
        ┌──────────────────────────────────────────────┐
        │  scheduleOfflinePass(entry):                  │
        │    if (passState.inFlight):                   │
        │      enqueue(passState, entry)                │
        │        // endpoints always append             │
        │        // progressives replace trailing       │
        │        // progressive entry if present        │
        │    else: doOfflinePass(entry.seg)             │
        └──────────────────────────────────────────────┘
                 │
                 ▼
        doOfflinePass(seg) ── samplesToWav → transcribeFileOffline ─┐
                                                                    ▼
                                            ┌───────────────────────┴───────────────────────┐
                                            │  Write-back (D1):                              │
                                            │  if seg.index == currentSegment.index:        │
                                            │     currentSegment.offlineText = result       │
                                            │  elif seg in finishedSegments && its           │
                                            │       offlineText is null:                     │
                                            │     finishedSegments[i].offlineText = result   │
                                            │  else: discard (a newer pass already won)      │
                                            └────────────────────────────────────────────────┘
                                                                    │
                                                                    ▼
                                                       emit("offline") → buildTranscript

Endpoint detected (sherpa) ──> tryOfflinePass():
   finishedSegments.push(currentSegment)
   currentSegment = createSegment(index + 1)
   onRotate(passState)               // clears passState.firedMarks
   scheduleOfflinePass({ kind: "endpoint", seg: closedSegment })
```

### Block 1: progressive trigger

Define the schedule of in-flight marks and a pure function that asks "given the current segment and what's already fired, what mark (if any) should fire now?"

**Where:** `mobile/src/stt/segment-manager.ts`

```ts
// Progressive offline-pass schedule. A pass fires when the current segment
// first crosses each mark (and the prior pass has finished). Marks are in
// seconds of buffered audio for the CURRENT (still-open) segment.
// The endpoint-triggered pass (existing behavior) always runs on close,
// independent of this schedule.
export const PROGRESSIVE_PASS_MARKS_SEC: readonly number[] = [5, 10, 20];

export function nextProgressivePassMark(
  currentSegment: Segment,
  firedMarks: ReadonlySet<number>,
  marks: readonly number[] = PROGRESSIVE_PASS_MARKS_SEC
): number | null {
  const durS = segmentDurationSec(currentSegment);
  for (const m of marks) {
    if (!firedMarks.has(m) && durS >= m) return m;
  }
  return null;
}
```

The endpoint/timeout path in `tryOfflinePass()` is unchanged in semantics — it still rotates and runs the final pass on the closed segment. `nextProgressivePassMark` only governs *in-flight* passes on a still-open segment.

**Initial values** (`[5, 10, 20]`) are placeholders; the sweep test selects the production values before merge.

### Block 2: in-flight snapshot

Progressive passes must run on an immutable prefix; the live `currentSegment` keeps accumulating PCM samples during inference. Without a snapshot, the pass result writes back text that no longer corresponds to the audio in the buffer.

**Where:** `mobile/src/stt/segment-manager.ts`

```ts
export function snapshotSegmentPrefix(segment: Segment, durationSec: number): Segment {
  const cap = Math.min(segment.audioSamples.length, Math.floor(durationSec * SAMPLE_RATE));
  return {
    index: segment.index,
    streamingText: segment.streamingText,
    offlineText: null,
    audioSamples: segment.audioSamples.slice(0, cap),
  };
}
```

The snapshot preserves the segment's `index`. The hybrid engine uses that index after the pass completes to decide where to write the result back — see `writebackTarget` in Block 4a: if the index still matches `currentSegment`, the result writes there; if the segment rotated mid-pass but its slot in `finishedSegments` is still empty, the result lands there as a stopgap until the endpoint pass arrives; otherwise discard.

### Block 3: current-segment offline in `buildTranscript`

Without this change, an in-flight pass's result is invisible — `buildTranscript` only reads `offlineText` from finished segments.

**Where:** `mobile/src/stt/segment-manager.ts`

```ts
export function buildTranscript(
  finishedSegments: Segment[],
  currentSegment: Segment
): string {
  const parts: string[] = [];
  for (const seg of finishedSegments) {
    const decision = gateOfflineText(seg.streamingText, seg.offlineText);
    if (decision.text) parts.push(decision.text);
    if (decision.rejectionReason && decision.rejectionReason !== "empty") {
      console.log(
        `[vox] Offline rejected (${decision.rejectionReason}) seg #${seg.index}: "${seg.offlineText?.slice(0, 60)}"`
      );
    }
  }
  // Current segment: gate the in-flight offline text the same way.
  // Falls back to streaming when the gate rejects (or when no in-flight
  // pass has completed yet for this segment).
  const curDecision = gateOfflineText(currentSegment.streamingText, currentSegment.offlineText);
  if (curDecision.text) parts.push(curDecision.text);
  if (curDecision.rejectionReason && curDecision.rejectionReason !== "empty") {
    console.log(
      `[vox] Offline rejected in-flight (${curDecision.rejectionReason}) seg #${currentSegment.index}: "${currentSegment.offlineText?.slice(0, 60)}"`
    );
  }
  return parts.join(". ");
}
```

The current-segment gate uses the same `gateOfflineText` machinery as finished segments. The short-segment skip (`MIN_AUDIO_SAMPLES = 3s`) is enforced upstream in `nextProgressivePassMark` (smallest mark in the schedule is at least 3s) and in `doOfflinePass` (existing 3s guard), so the in-flight gate never sees offline text from a <3s prefix.

### Block 4: hybrid-engine wiring

Per **D3**, the stateful orchestration is extracted into a small pure module `mobile/src/stt/progressive-pass-state.ts` so it can be unit-tested without native mocks. `hybrid-engine.ts` reduces to calling that module's functions from the PCM callback and the rotation path.

#### Block 4a: extracted state module

**Where (new):** `mobile/src/stt/progressive-pass-state.ts`

```ts
export type QueueEntry =
  | { kind: "progressive"; seg: Segment }
  | { kind: "endpoint";   seg: Segment };

export interface ProgressivePassState {
  firedMarks: Set<number>;        // per current segment; cleared on rotation
  queue: QueueEntry[];            // FIFO; progressives dedupe to "latest only"
  inFlight: QueueEntry | null;
}

export function createState(): ProgressivePassState { ... }

/**
 * Schedule a pass. Endpoint passes always queue. Progressive passes replace
 * the trailing progressive entry in the queue (older prefix is strictly less
 * informative than the newer one). Endpoint entries are never replaced. (D2)
 */
export function enqueue(state: ProgressivePassState, entry: QueueEntry): void { ... }

/** Pop the next entry to run, or null if the queue is empty. */
export function dequeue(state: ProgressivePassState): QueueEntry | null { ... }

/**
 * Decide where a completed pass's result should land. Returns:
 *   - { target: "current" }       if seg.index === currentSegmentIndex
 *   - { target: "finished", i }   if seg is in finishedSegments AND its offlineText is null (D1)
 *   - { target: "discard" }       otherwise (a newer pass already wrote there, or segment cleaned up)
 */
export function writebackTarget(
  seg: Segment,
  currentSegmentIndex: number,
  finishedSegments: Segment[],
): { target: "current" } | { target: "finished"; i: number } | { target: "discard" } { ... }

/** Reset fired marks on segment rotation. */
export function onRotate(state: ProgressivePassState): void {
  state.firedMarks.clear();
}
```

The `enqueue` semantics (D2) replace the pre-existing single-slot `pendingSegment`, which silently lost endpoint passes when two endpoints fired in quick succession. Progressive passes widen that collision window because every in-flight progressive pass keeps the worker busy for 1–7s; the proper queue closes the bug along the way.

The `writebackTarget` semantics (D1) ensure no completed pass is discarded if its segment is still mutable (either the live current segment, or a finished segment whose offline text hasn't been written yet by a larger pass).

#### Block 4b: hybrid-engine.ts changes

Inside `startHybridTranscription`:

1. `const passState = createState();` — replaces the old `offlinePromise` + `pendingSegment` fields.

2. In the PCM `onData` callback, after `appendSamples(currentSegment, samples)`, call `tryProgressivePass()`:

   ```ts
   function tryProgressivePass() {
     if (stopped || !isWhisperReady() || passState.inFlight) return;
     const mark = nextProgressivePassMark(currentSegment, passState.firedMarks);
     if (mark === null) return;
     passState.firedMarks.add(mark);
     const snapshot = snapshotSegmentPrefix(currentSegment, mark);
     scheduleOfflinePass({ kind: "progressive", seg: snapshot });
   }
   ```

3. `scheduleOfflinePass(entry)` enqueues (or runs immediately if nothing is in flight), and after each pass completes, applies `writebackTarget` to decide where the result lands:

   ```ts
   function applyResult(entry: QueueEntry, result: string) {
     const target = writebackTarget(entry.seg, currentSegment.index, finishedSegments);
     if (target.target === "current") {
       currentSegment.offlineText = result;
     } else if (target.target === "finished") {
       finishedSegments[target.i].offlineText = result;
     } // discard otherwise
   }
   ```

4. Reset on rotation in `tryOfflinePass`:

   ```ts
   function tryOfflinePass() {
     if (stopped) return;
     if (!shouldTriggerOfflinePass(currentSegment, lastPassTime, Date.now())) return;
     const toProcess = currentSegment;
     finishedSegments.push(toProcess);
     currentSegment = createSegment(toProcess.index + 1);
     onRotate(passState);
     scheduleOfflinePass({ kind: "endpoint", seg: toProcess });
     resetMaxTimer();
   }
   ```

#### Block 4c: observability

`doOfflinePass`'s existing `[vox] Offline pass #N: <dur>s of audio` log line gets a kind tag so logcat distinguishes progressive from endpoint passes:

```
[vox] Offline pass #5 (progressive, mark=10s): 10.0s of audio, 160000 samples
[vox] Offline pass #5 (endpoint): 18.4s of audio, 294400 samples
```

`buildTranscript`'s current-segment block gets a parallel rejection log so we can audit why in-flight offline text isn't showing:

```ts
if (curDecision.rejectionReason && curDecision.rejectionReason !== "empty") {
  console.log(
    `[vox] Offline rejected in-flight (${curDecision.rejectionReason}) seg #${currentSegment.index}: "${currentSegment.offlineText?.slice(0, 60)}"`
  );
}
```

Suffix `in-flight` distinguishes from the existing line for finished segments.

## Alternatives considered

- **Multi-window ensemble at endpoint** (run NeMo on last 5s, last 10s, full, pick best by voting or confidence): no perceived-latency win — user still waits for endpoint — and 3× the inference cost. Rejected.
- **Sliding overlapped windows with dedup** (5s windows + 1.5s overlap, stitch via overlap-dedup): requires implementing overlap-dedup correctly across CTC outputs where whitespace boundaries don't align with word boundaries; higher implementation risk for marginal accuracy gain. Rejected for now; revisit if progressive in-flight underperforms.

## Files touched

| File | Change |
|---|---|
| `mobile/src/stt/segment-manager.ts` | Add `PROGRESSIVE_PASS_MARKS_SEC`, `nextProgressivePassMark`, `snapshotSegmentPrefix`. Extend `buildTranscript` to gate the current segment's offline text and log in-flight rejections. |
| `mobile/src/stt/progressive-pass-state.ts` | **New.** Pure module holding `firedMarks`, queue (D2), `writebackTarget` (D1), `onRotate`. All unit-testable without native mocks. |
| `mobile/src/stt/hybrid-engine.ts` | Replace `offlinePromise` + `pendingSegment` with `progressive-pass-state`. Call `tryProgressivePass()` from PCM callback. Apply `writebackTarget` after each pass completes. Tag log lines with `progressive` / `endpoint`. Reset state on rotation. |
| `mobile/src/stt/__tests__/segment-manager.test.ts` | New tests for `nextProgressivePassMark`, `snapshotSegmentPrefix`, `buildTranscript` current-segment branch. |
| `mobile/src/stt/__tests__/progressive-pass-state.test.ts` | **New.** Unit tests for the queue (D2 collision cases), `writebackTarget` (D1 cases), `onRotate`. |
| `mobile/src/test-harness/test-cases.ts` | **New integration test:** feed a known 25s WAV through a stub PCM stream, assert progressive passes fired at expected marks and write-backs targeted the correct segments (D3). |
| `mobile/src/test-harness/progressive-passes-sweep.ts` | **New.** Schedule sweep harness; runs zipformer streaming alongside NeMo for realistic gate inputs (D4). |
| `mobile/src/test-harness/run-tests.ts` | Wire Phase 3: run sweep and print Pareto table. |

No changes to `whisper-offline.ts`, `sherpa-streaming.ts`, `pipeline/correct.ts`, or any native module.

## Test plan

### Unit tests (Jest)

Pure-function tests, no native mocks. Split across two files.

**`segment-manager.test.ts` — `nextProgressivePassMark`:**
- returns the smallest unfired mark whose threshold is met
- returns `null` when segment duration is below the smallest mark
- returns `null` when all marks are already fired
- skips already-fired marks and returns the next one
- respects a custom `marks` parameter

**`segment-manager.test.ts` — `snapshotSegmentPrefix`:**
- truncates samples to `durationSec × SAMPLE_RATE`
- caps at the segment's actual sample length (never reads past the end)
- preserves `index` and `streamingText`
- sets `offlineText: null`
- mutating snapshot's `audioSamples` does not affect the original segment (deep copy)

**`segment-manager.test.ts` — `buildTranscript` (additions):**
- with no current-segment offline text: behaves as before (uses streaming text for current)
- with current-segment offline text that passes the gates: uses offline text for current
- with current-segment offline text that fails the stopword gate: falls back to streaming
- with current-segment offline text that fails the length-ratio gate: falls back to streaming
- existing "finished segments only" cases still pass

**`progressive-pass-state.test.ts` — queue (D2):**
- `enqueue` of an endpoint entry appends; never replaces an existing entry
- `enqueue` of a progressive entry replaces the trailing progressive entry if present
- `enqueue` of a progressive entry appends if the trailing entry is endpoint
- two endpoints enqueued in succession: both retained, both eventually dequeued
- mixed sequence (endpoint, progressive, progressive, endpoint) → final queue is [endpoint, progressive(latest), endpoint]

**`progressive-pass-state.test.ts` — `writebackTarget` (D1):**
- snapshot index matches `currentSegmentIndex` → `{ target: "current" }`
- snapshot is in `finishedSegments` and its `offlineText` is null → `{ target: "finished", i }`
- snapshot is in `finishedSegments` but its `offlineText` is already non-null → `{ target: "discard" }` (newer pass already wrote)
- snapshot index not in current or finished → `{ target: "discard" }`

**`progressive-pass-state.test.ts` — `onRotate`:**
- clears `firedMarks` without touching the queue

### On-device integration test (D3)

**Where:** `mobile/src/test-harness/test-cases.ts`, new case `progressive_passes_orchestration`.

Feed a known 25s WAV through a stub PCM stream that emits chunks at real time (or accelerated time via a time-injected variant of `startHybridTranscription`). Assert:
- Progressive passes fire at the configured marks (e.g., 5s, 10s, 20s).
- Each progressive pass's result writes back to the correct segment (verify via captured `[vox] Offline pass #N` log lines and the final `buildTranscript` output).
- If endpoint fires mid-progressive, the snapshot result writes to `finishedSegments[i].offlineText` (D1 path).
- After rotation, the next segment fires marks fresh (D2 reset path).

### Sweep harness (emulator)

**New file:** `mobile/src/test-harness/progressive-passes-sweep.ts`

Mirrors `benchmark.ts`. For each spike recording, for each candidate schedule, slice the WAV at each mark, run NeMo on the prefix, record time + WER + gate decision.

```ts
export interface PassResult {
  markSec: number | "full";
  audioDurSec: number;
  offlineInferenceMs: number;   // NeMo CTC on the prefix
  streamingInferenceMs: number; // zipformer on the same prefix (D4: gate baseline)
  rawText: string;              // raw NeMo output
  correctedText: string;        // after applyCorrections on NeMo output
  streamingText: string;        // zipformer output, used as gate baseline
  rawWer: number;               // vs FULL ground truth (see caveat)
  correctedWer: number;
  gatePassed: boolean;
  gateReason?: string;
}

export interface ScheduleResult {
  schedule: readonly (number | "full")[];
  perFile: {
    id: string;
    passes: PassResult[];
    totalOfflineInferenceMs: number;     // sum across passes; maps to production cost
    totalStreamingInferenceMs: number;   // reported but not counted toward production cost
    finalCorrectedWer: number;
    msToFirstGatePass: number | null;    // cumulative offline ms only
  }[];
  aggregate: {
    meanTotalOfflineInferenceMs: number;
    meanTotalStreamingInferenceMs: number;
    meanFinalCorrectedWer: number;
    meanMsToFirstGatePass: number | null;
    gatePassRate: number;
  };
}

export const SWEEP_SCHEDULES: readonly (readonly (number | "full")[])[] = [
  ["full"],                       // baseline: today's behavior
  [10, "full"],
  [5, 10, "full"],
  [5, 10, 15, "full"],
  [3, 5, 7, 10, 15, "full"],
];
```

Per recording, per schedule (D4: realistic gate inputs):
1. Read WAV → float32 samples, duration `D`.
2. For each `mark` in schedule: `dur = mark === "full" ? D : min(mark, D)`; if `dur < 3`, skip and record as skipped.
3. `prefix = addDither(samples.slice(0, dur * SAMPLE_RATE))` — same dithering as production (`segment-manager.ts:174`).
4. **Both engines on the prefix:**
   - `streamingText = transcribeFileStreaming(prefixWav)` — reuses `benchmark.ts:70`. Provides the realistic gate baseline.
   - Write temp WAV via `samplesToWav`, call `transcribeFileOffline(wavPath)`, measure offline ms only (streaming runs on every pass but its cost is reported separately and is not counted toward production-equivalent inference time, since in production the streaming engine runs once over the live audio regardless).
5. `corrected = applyCorrections(rawOffline.toLowerCase().trim())`; `wer = computeWer(reference, corrected)` against the **full** ground truth.
6. Gate decision: `gateOfflineText(streamingText, corrected)` — same function as production, with real streaming text as the baseline. No approximation.
7. Record `PassResult` and cumulative *offline-only* inference ms (the sweep's `meanTotalInferenceMs` is the metric that maps to production runtime cost).

Per-file aggregates:
- `totalOfflineInferenceMs`: sum of `offlineInferenceMs` across passes — the metric that maps to production runtime cost.
- `totalStreamingInferenceMs`: sum of `streamingInferenceMs` across passes — reported for transparency, not counted as production cost (production runs streaming continuously regardless of the offline schedule).
- `finalCorrectedWer`: WER of the last gate-passing pass; if none passed, WER of the last pass.
- `msToFirstGatePass`: cumulative `offlineInferenceMs` up to and including the first gate-passing pass; `null` if none.

Per-schedule aggregate: means across files; `gatePassRate` is the fraction of `(file × mark)` pairs that passed the gates.

**Caveats embedded as code comments:**
- WER is computed against full ground truth even for short prefixes; intermediate WER will look high — that's intentional. `finalCorrectedWer` is the accuracy metric; `msToFirstGatePass` is the perceived-latency metric.
- Streaming is run on each prefix solely to provide a realistic gate baseline; its inference time is reported but excluded from `meanTotalInferenceMs` because production runs streaming continuously over the live audio independent of the offline schedule.

**Wiring:** in `mobile/src/test-harness/run-tests.ts`, add a Phase 3 after the benchmark:

```
[VoxTest] --- Progressive Passes Sweep ---
```

`printSweepSummary(sweep)` logs a Pareto table:

```
Schedule                meanOfflineMs   meanFinalWER   meanMsToFirstGatePass   gatePassRate
[full]                         XXXX        XX.X%               XXXX              XX%
[10, full]                     XXXX        XX.X%               XXXX              XX%
[5, 10, full]                  XXXX        XX.X%               XXXX              XX%
[5, 10, 15, full]              XXXX        XX.X%               XXXX              XX%
[3, 5, 7, 10, 15, full]        XXXX        XX.X%               XXXX              XX%
```

Add `sweep: ScheduleResult[] | null` to `TestHarnessResults`.

### On-device verification

Before merging:

1. Push test data and build the app:
   ```
   adb push spike/data/converted/   /data/local/tmp/vox-test/audio/
   adb push spike/data/ground_truth/ /data/local/tmp/vox-test/ground-truth/
   cd mobile && npx expo run:android
   ```
2. Trigger test mode in-app; tail `adb logcat -s VoxTest VoxBench vox`.
3. Read the Pareto table. The winning schedule has the lowest `meanMsToFirstGatePass` with `meanFinalCorrectedWer ≤ baseline`. `gatePassRate` at short marks tells us the smallest mark where >50% of passes survive the gates.
4. Set `PROGRESSIVE_PASS_MARKS_SEC` to the winning schedule's intermediate marks (excluding `"full"`, which the endpoint pass already covers).
5. Rebuild. Dictate a 20s+ French phrase. Verify in logcat that `[vox] Offline pass #N` lines fire at the configured marks, and that the on-screen transcript visibly refines mid-utterance.

## Rollout

Single PR after the sweep picks the schedule. No feature flag — the behavior change is conservative (the same gate machinery decides whether a progressive offline result overrides streaming text, and the streaming text is always available as fallback). Revert is a one-line edit: set `PROGRESSIVE_PASS_MARKS_SEC = []` and the engine reverts to today's endpoint-only behavior.

**Thermal / battery check on real hardware.** Emulator inference is several × slower than a real S22. The sweep will report `meanTotalInferenceMs` per schedule; before merging, compute the duty cycle for a representative 25–60s dictation on a real device and verify it stays under ~25%. If a [3, 5, 7, 10, 15, full] style schedule pushes duty cycle high or causes noticeable handset heat, fall back to a sparser schedule even if WER is marginally better at the dense one.

Observability: each progressive pass logs `[vox] Offline pass #N (progressive, mark=<s>): …` or `(endpoint): …` so logcat distinguishes pass types. Gate rejections log `[vox] Offline rejected (<reason>) seg #N: …` for finished segments and `[vox] Offline rejected in-flight (<reason>) seg #N: …` for current-segment in-flight rejections. Together these audit every pass and every gate decision in logcat.

## Done criteria

- [ ] Spec doc landed at `docs/specs/progressive-offline-passes.md`.
- [ ] `PROGRESSIVE_PASS_MARKS_SEC`, `nextProgressivePassMark`, `snapshotSegmentPrefix` exported from `segment-manager.ts`.
- [ ] `buildTranscript` gates the current segment's offline text and logs in-flight rejections.
- [ ] New `progressive-pass-state.ts` module exports `createState`, `enqueue`, `dequeue`, `writebackTarget`, `onRotate` (D1 + D2).
- [ ] `hybrid-engine.ts` fires in-flight passes from the PCM callback; `applyResult` uses `writebackTarget` to write back to current or finished segments, never silently discarding a result whose target slot is still empty (D1).
- [ ] `hybrid-engine.ts`'s old single-slot `pendingSegment` is gone; `progressive-pass-state.ts` queue used instead (D2).
- [ ] Log lines tag each pass `(progressive, mark=Ns)` or `(endpoint)`.
- [ ] All new Jest tests pass; the existing unit-test suite still passes.
- [ ] On-device integration test `progressive_passes_orchestration` passes (D3).
- [ ] Sweep ran on the emulator and produced a Pareto table with realistic gate decisions (D4: zipformer run alongside NeMo on each prefix).
- [ ] `PROGRESSIVE_PASS_MARKS_SEC` set from sweep results.
- [ ] Live emulator dictation visibly refines mid-utterance.
- [ ] Aggregate prose WER ≤ current benchmark baseline.
- [ ] Real-device duty cycle for a 25–60s dictation ≤ ~25% on S22 (thermal/battery check from Rollout).

## Out of scope

- A French-only offline model (`stt_fr_conformer_ctc_large`).
- Per-token confidence scores (needs sherpa-onnx API surface).
- Pre-empting / cancelling an in-flight NeMo pass when a newer prefix is ready (queueing handles this adequately and cancellation isn't exposed by sherpa-onnx).
- UX changes beyond the transcript refining in place.
