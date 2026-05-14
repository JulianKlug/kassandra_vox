# Spec: Offline-pass quality gate

**Date:** 2026-05-05
**Status:** Proposed
**Owner:** unassigned
**Related:** `docs/issues/unsolved.md` #4 (medical French WER)

## Problem

The hybrid STT engine runs a streaming zipformer pass live and a NeMo CTC offline pass when a segment closes. `buildTranscript` (`mobile/src/stt/segment-manager.ts:41`) replaces the streaming text with the offline text whenever the offline text is non-empty:

```ts
const t = (seg.offlineText && seg.offlineText.trim()) || seg.streamingText;
```

There is a guard for *empty* offline output, but not for *bad-but-non-empty* offline output. Mean WER says NeMo CTC FR int8 (46.1% prose) beats the streaming zipformer (52.7% prose) by ~6 points, but per-file WER ranges 38.5%-94.2%. Some segments flip backwards on override, which is what the doctor sees as "the second pass made it worse."

Three structural reasons offline can lose on a given segment:

1. **NeMo CTC is multilingual (en/de/es/fr).** No language hint, short clips can language-detect wrong.
2. **Endpoint-cut segments lose context.** Streaming is stateful, offline gets the WAV in isolation.
3. **Short or list-style segments hurt CTC.** Structured segments hit 76-94% WER vs prose 38-65%.

## Goal

Stop letting low-quality offline output win the override, without losing the wins on segments where offline is genuinely better. Cheap. No model swap, no native API changes.

## Non-goals

- Changing the offline model. Tracked separately (NeMo FR-only Conformer eval).
- Per-token confidence gating. Needs sherpa-onnx API surface, separate effort.
- Hotwords, fine-tuning, or anything that touches model weights.

## Design

Three independent gates, all in pure functions, all unit-testable in `segment-manager.test.ts` with no native mocks.

### Gate 1: skip offline pass for short segments

Bump the minimum segment duration that triggers the offline pass from 1s to 3s. Streaming text is good enough on short utterances and the offline model regresses hardest there.

**Where:** `mobile/src/stt/segment-manager.ts`

```ts
// Before
export const MIN_AUDIO_SAMPLES = SAMPLE_RATE * 1; // 1 second

// After
export const MIN_AUDIO_SAMPLES = SAMPLE_RATE * 3; // 3 seconds
```

`shouldTriggerOfflinePass` and the validation guards in `doOfflinePass` (hybrid-engine.ts:90, :132) already use this constant, so no other code needs to change.

**Risk:** A doctor who pauses every 1-2 seconds will get pure streaming output. That output is still correctable via the dictionary pipeline. Acceptable.

### Gate 2: French function-word check

If the offline output is long enough that we'd expect at least one French stopword, require one. This catches the multilingual CTC misfire mode where the model falls back to en/de/es phonemes.

**Where:** new helper in `segment-manager.ts`, called from `buildTranscript`.

```ts
const FRENCH_STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du",
  "et", "ou", "à", "au", "aux", "en", "dans", "sur",
  "pour", "par", "avec", "sans", "est", "sont", "n'",
  "ne", "pas", "plus", "que", "qui", "ce", "cette",
  "ces", "je", "tu", "il", "elle", "on", "nous", "vous",
  "ils", "elles", "se", "sa", "son", "ses", "mon", "ma",
  "mes", "lui", "leur", "leurs", "y",
]);

const STOPWORD_CHECK_MIN_WORDS = 5;

function hasFrenchStopword(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/[\s,.;:!?'"()]+/)
    .filter((t) => t.length > 0);
  if (tokens.length < STOPWORD_CHECK_MIN_WORDS) return true; // skip check
  return tokens.some((t) => FRENCH_STOPWORDS.has(t));
}
```

**Why min-5-words escape:** medical dictation produces legitimate short outputs that have no stopwords ("noradrénaline, dobutamine, adrénaline"). The check would reject those. Five words is the threshold where a French sentence essentially must contain a stopword.

**Risk:** A 5+ word French utterance without any stopword exists but is rare. False rejection here just keeps the streaming text, which on average is only 6 WER points worse. Acceptable.

### Gate 3: length-ratio sanity check

Reject offline text if its word count is wildly different from streaming. Catches truncations (offline cut short) and hallucinations (offline repeats or invents).

**Where:** new helper in `segment-manager.ts`.

```ts
const LENGTH_RATIO_MIN = 0.5;
const LENGTH_RATIO_MAX = 2.0;

function isLengthRatioOk(streaming: string, offline: string): boolean {
  const streamingWords = streaming.trim().split(/\s+/).filter(Boolean).length;
  const offlineWords = offline.trim().split(/\s+/).filter(Boolean).length;
  if (streamingWords === 0) return true; // nothing to compare against
  const ratio = offlineWords / streamingWords;
  return ratio >= LENGTH_RATIO_MIN && ratio <= LENGTH_RATIO_MAX;
}
```

**Threshold rationale:** WER of 100% means every word is wrong, but length should still be roughly preserved. A 0.5-2x window catches the catastrophic cases (single-word output for a 20-word utterance, or 50-word repetition loop) without rejecting normal disagreements.

**Risk:** Streaming itself can be wildly wrong on length (drops trailing words, repeats). If streaming happens to be 5 words for a 15-word utterance and offline correctly produces 15, the ratio is 3.0 and we'd reject the better answer. Mitigation: log every rejection so we can audit and tune. Worst case we relax `LENGTH_RATIO_MAX` to 3.0 after seeing data.

### Composition

A single helper composes the three gates. `buildTranscript` calls it instead of the existing inline `||`:

```ts
export interface OfflineGateDecision {
  text: string;
  source: "offline" | "streaming-fallback";
  rejectionReason?: "empty" | "no-french-stopword" | "length-mismatch";
}

export function gateOfflineText(
  streamingText: string,
  offlineText: string | null
): OfflineGateDecision {
  const offline = offlineText?.trim() ?? "";
  const streaming = streamingText.trim();

  if (!offline) {
    return { text: streaming, source: "streaming-fallback", rejectionReason: "empty" };
  }
  if (!hasFrenchStopword(offline)) {
    return { text: streaming, source: "streaming-fallback", rejectionReason: "no-french-stopword" };
  }
  if (!isLengthRatioOk(streaming, offline)) {
    return { text: streaming, source: "streaming-fallback", rejectionReason: "length-mismatch" };
  }
  return { text: offline, source: "offline" };
}
```

`buildTranscript` becomes:

```ts
for (const seg of finishedSegments) {
  const decision = gateOfflineText(seg.streamingText, seg.offlineText);
  if (decision.text) parts.push(decision.text);
  if (decision.rejectionReason && decision.rejectionReason !== "empty") {
    console.log(`[vox] Offline rejected (${decision.rejectionReason}) seg #${seg.index}: "${seg.offlineText?.slice(0, 60)}"`);
  }
}
```

Logging is the observability mechanism. Every override-rejection lands in logcat with the segment index and the rejected offline text, so we can review whether the gates fire correctly on real recordings.

## Files touched

| File | Change |
|---|---|
| `mobile/src/stt/segment-manager.ts` | Bump `MIN_AUDIO_SAMPLES` to `SAMPLE_RATE * 3`. Add `gateOfflineText`, `hasFrenchStopword`, `isLengthRatioOk`, and constants. Update `buildTranscript` to call the gate. |
| `mobile/src/stt/__tests__/segment-manager.test.ts` | New test blocks for each gate and the composed `gateOfflineText`. Update existing `buildTranscript` tests to reflect the new behavior (the "prefers offline" test now needs offline text that passes the gates). |

No changes to `hybrid-engine.ts` (the gate runs inside `buildTranscript`).
No changes to `whisper-offline.ts`, `sherpa-streaming.ts`, or any native module.

## Test plan

### Unit tests (Jest)

All in `segment-manager.test.ts`. Each gate gets its own describe block, plus an integration block for the composed function and the updated `buildTranscript`.

**`hasFrenchStopword`:**
- returns true for normal French sentence ("le patient arrive aux urgences")
- returns false for English ("the patient arrives in the emergency room") with 5+ words
- returns true for short medical list under threshold ("noradrénaline dobutamine")
- returns true for stopword-less but short text ("hémodialyse")
- returns false for 5+ word non-French ("Dies ist ein deutscher Satz hier")

**`isLengthRatioOk`:**
- returns true for similar lengths (10 vs 12 words)
- returns false for truncation (5 vs 20 words, ratio 0.25)
- returns false for hallucination (40 vs 10 words, ratio 4.0)
- returns true at boundaries (ratio = 0.5 exactly, ratio = 2.0 exactly)
- returns true when streaming is empty (nothing to compare)

**`gateOfflineText`:**
- empty offline → streaming with reason `"empty"`
- offline fails stopword check → streaming with reason `"no-french-stopword"`
- offline fails length check → streaming with reason `"length-mismatch"`
- all gates pass → offline with no reason
- short offline (under stopword threshold) passes the stopword gate

**`buildTranscript` (existing tests, updated):**
- "prefers offline text over streaming text" — offline must now contain at least one stopword and be similar length
- All other existing tests should still pass without changes (they use `null` offlineText or empty string).

**`shouldTriggerOfflinePass` (new case):**
- returns false for 2.5s of audio (under new 3s threshold)
- returns true for 3s of audio exactly
- the existing "not enough audio" test needs its sample count updated

### On-device verification

Before merging:

1. Push the build to the connected S22.
2. Record three test cases:
   - **Long French prose** (15-30s): expect offline to win on most segments.
   - **Short utterances** (~1-2s each): expect no offline pass to fire (gate 3).
   - **Mid-length list of medical terms** ("noradrénaline, adrénaline, dobutamine, vasopressine"): expect offline to pass the stopword gate via the under-5-words escape.
3. Tail logcat for `[vox] Offline rejected` lines. Inspect each: was the rejection correct?
4. Run the desktop benchmark via `tools/model-eval/eval-desktop.py` if applicable, and compare aggregate WER before/after. Expectation: aggregate prose WER should be roughly the same (we're keeping the wins) or slightly better (we're cutting the losses).

If the benchmark shows aggregate WER got *worse*, the gates are over-rejecting. Loosen `LENGTH_RATIO_MAX` to 3.0 and re-test.

## Rollout

Single PR. No feature flag. Behavior change is conservative (we only ever reject offline text, never invent new text), so the worst case is "we kept streaming when offline was actually fine" which is a 6-WER-point regression on those segments. The logging makes the impact observable.

If the on-device test or benchmark reveals over-rejection, tune the thresholds in a follow-up commit.

## Out of scope

- Switching to a French-only offline model (`stt_fr_conformer_ctc_large`).
- Adding a real confidence score from CTC log-probs (needs sherpa-onnx API surface).
- Edit-distance threshold between streaming and offline text (deferred until we see whether 1+2+3 is sufficient).
- UX-level "show both, let the doctor pick" — large product change, not a quality fix.

## Done criteria

- [ ] All three gates implemented with constants exported for testability.
- [ ] All new unit tests pass; existing 117 tests still pass.
- [ ] On-device sanity check on S22: short / long / list segments behave as described.
- [ ] Aggregate desktop benchmark prose WER ≤ current baseline (46.1%).
- [ ] Logcat shows rejection lines on the segments where they should fire (and nowhere else, to within manual review).
