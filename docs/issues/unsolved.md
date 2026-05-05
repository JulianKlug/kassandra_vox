# Unsolved Issues

## 1. Canary-180M-Flash returns empty for 7/10 test recordings
**Date:** 2026-04-14 — 2026-04-15
**Symptom:** Canary produces accurate French text for 3 of 10 spike recordings but returns empty string for the other 7. The 3 working files are consistently the same ones across runs, regardless of order.
**Severity:** High — limits offline second-pass accuracy improvement.

### What we know
- Files 1-3 (28s, 30s, 44s): always produce French text (WER 30-39%)
- Files 4-10 (39-93s): always return empty string
- Order doesn't matter (failing file fails even when processed first and alone)
- File content is valid (all WAV files have identical format, correct sizes, valid headers)
- Audio content is clear French medical speech (verified by listening)
- Not a file permission issue (all files in app's document directory, verified)
- Not a WAV header issue (byte-identical headers except size fields)
- Not an audio length issue (10s/15s/20s/25s clips of working audio also fail)
- Not a dithering issue (added dither=0.001, files still empty but inference times increased, showing model does process them)
- Not an engine state issue (empty even on freshly initialized engine)

### Known related upstream issues
- [sherpa-onnx #2258](https://github.com/k2-fsa/sherpa-onnx/issues/2258): Empty transcription with NeMo Parakeet model on some files. **Dithering workaround suggested but doesn't help for our Canary case.**
- [sherpa-onnx #2415](https://github.com/k2-fsa/sherpa-onnx/issues/2415): Empty transcript in Flutter (was user error, not relevant).
- [sherpa-onnx PR #2897](https://github.com/k2-fsa/sherpa-onnx/pull/2897): Added defensive early-return when Canary encoder produces empty output. This is why empty results are silent (no error, no crash).

### Possible causes still to investigate
- **FeatureConfig featureDim mismatch**: react-native-sherpa-onnx hardcodes `featureDim = 80` but Canary uses 128-dim log-mel features. If the feature extractor produces 80-dim features while the encoder expects 128-dim, the encoder output could be empty. However, the 3 working files produce text with the same config, so this may not be the issue.
- **Audio characteristics**: The 3 working files may have specific characteristics (speech patterns, energy distribution, frequency content) that happen to produce valid features despite the potential dim mismatch.
- **Canary model max input limit**: NVidia documents 40-second max. The working 44s file exceeds this, but shorter failing files (39s) are within it. May not be strictly enforced.
- **Upstream sherpa-onnx C++ bug**: The NeMo offline recognizer implementation may have content-dependent issues that only manifest with certain audio patterns.

### Workarounds in place
- When Canary returns empty, the streaming zipformer text is used as fallback (`buildTranscript` uses `||` to fall through empty `offlineText`).
- Auto-reset: if Canary returns empty, the engine is destroyed and recreated before retry (doesn't help for per-file failures but handles transient state issues).

### Potential next steps
1. Convert bofenghuang whisper-large-v3-french-distil-dec2 to ONNX for sherpa-onnx (different model, different code path, bypasses NeMo issues entirely)
2. Test with the non-int8 Canary model (full precision, if available)
3. File a bug on react-native-sherpa-onnx with reproduction steps
4. Test with latest sherpa-onnx version (may have fixes beyond v1.12.34)
5. Investigate whether adding audio padding or normalization before transcription helps

## 2. Streaming zipformer accuracy is poor for medical French
**Date:** 2026-04-13
**Symptom:** Streaming zipformer produces errors like "CATANAYSE" for "cathéter", "NORD REINE" for "noradrénaline", "BICARDONAL DE SOLDUM" for "bicarbonate de sodium".
**Severity:** Medium — partially mitigated by correction dictionary.

### Root cause
The French zipformer model (sherpa-onnx-streaming-zipformer-fr-2023-04-14-mobile) is a general-purpose French model trained on CommonVoice. It was never trained on medical vocabulary.

### Workaround
Medical correction dictionary with 35+ entries handles the most common errors. Each new medical term needs a dictionary entry the first time it's encountered.

### Long-term fix
When react-native-sherpa-onnx updates the bundled sherpa-onnx to support newer models, try:
- NeMo Fast Conformer CTC FR int8 (98MB, NVidia-trained, streaming via nemo_ctc)
- Kroko FR 2025 (55MB, newer zipformer2, likely better accuracy)

## 3. Kroko FR streaming model crashes sherpa-onnx v1.12.34
**Date:** 2026-04-16
**Symptom:** Loading the current Kroko French zipformer2 model (70 MB encoder) via `createStreamingSTT({ modelType: "transducer" })` aborts the app with:

```
sherpa-onnx: 'attention_dims' does not exist in the metadata
online-zipformer-transducer-model.cc:InitEncoder:107
ActivityManager: Process com.vox.dictation has died: fg TOP
```

**Severity:** Low — we already have a working streaming model (zipformer FR 2023).

### Root cause
Same class of bug as solved #12: react-native-sherpa-onnx 0.4.2 bundles sherpa-onnx v1.12.34, which expects `attention_dims` / `window_size` in encoder ONNX metadata. Newer Kroko builds ship without those fields; the C++ init path aborts the process instead of returning an error.

### What we verified
- Model files copied into the app's document directory cleanly (encoder 70 MB, plus decoder/joiner/tokens).
- Native path resolver found all 4 files (`resolveFilePath: resolved=..., contents=[encoder.onnx, decoder.onnx, joiner.onnx, tokens.txt]`).
- Crash fires ~2 seconds after `InitEncoder` starts reading metadata.

### Fix requires one of
- react-native-sherpa-onnx updates bundled sherpa-onnx to a version that tolerates missing metadata (or Kroko ships encoders with the legacy fields).
- Fork + bump the native dependency ourselves (large scope, native build risk).
- Find an older Kroko build that still ships `attention_dims`.

Keeping current streaming model (sherpa-onnx-streaming-zipformer-fr-2023-04-14-mobile) until upstream moves.

## 4. Medical French WER is ~46% (unusable for production)
**Date:** 2026-04-19 — 2026-04-20
**Symptom:** All available on-device STT models produce ~45-55% WER on Swiss French medical dictation. Doctors need <15-20% WER for the output to be usable with light editing.
**Severity:** High — the core product promise (accurate medical dictation) is not met.

### What we tested (desktop benchmark, 10 recordings)

| Model | Type | Size | Prose WER | Notes |
|-------|------|------|-----------|-------|
| zipformer FR 2023 | streaming transducer | 351 MB | 52.7% | Current streaming model |
| NeMo CTC FR int8 | offline CTC | 126 MB | 46.1% | Current offline model |
| whisper-small | offline whisper | 610 MB | 53.9% avg | 3-5x slower, truncates at 30s |
| SenseVoice | offline | 1.1 GB | N/A | Doesn't support French despite docs |

### What we tried to improve quality

**Hotwords / contextual biasing (Layer 1):**
- The zipformer FR 2023 model didn't ship a `bpe.vocab` file. sherpa-onnx silently ignored all hotwords.
- We downloaded `bpe.model` from the original icefall training repo and generated `bpe.vocab`.
- With bpe.vocab + modified_beam_search + 203 medical French hotwords: **no WER improvement**.
- Tested boost scores 2.5, 5.0, 10.0, 20.0. Higher scores made WER worse (over-biasing).
- **Root cause:** The errors aren't near-misses. The model hears "NORDLIN" not "noradrénaline". The phonetic gap is too large for beam search biasing to bridge. Hotwords help when the model is acoustically close to the right word. For medical vocabulary the model has never seen, it produces entirely different phonemes.

**Model search:**
- No streaming transducer model supporting French + hotwords exists besides zipformer FR 2023.
- No French-specific model achieves <40% WER on medical text on-device.
- The quality ceiling for untrained general-purpose models on medical French is ~40-50% WER.
- sherpa-onnx GitHub Issue #3144 confirms this gap: no good French streaming model exists.

### What might work (not yet tried)

1. **Expanded correction dictionary (Layer 2):** Grow from 35 to 500+ entries using MeSH French medical vocabulary. Works on text output, not decoder internals. Expected 5-10% WER reduction.

2. **French phonetic matching (Layer 3):** Soundex-FR or phonetic hash to match STT errors to medical terms. Handles "NORDLIN" → "noradrénaline" by phonetic similarity. Expected 5-15% WER reduction.

3. **~~CamemBERT-bio scoring (Layer 4):~~** Tested and rejected. See Issue #6 below.

4. **On-device LLM correction:** Small LLM (1-2 GB, e.g., Qwen 2.5 1.5B) to rewrite STT output. Highest quality ceiling but heaviest approach.

5. **User-adaptive corrections:** Learn from doctor's edits over time. When doctor corrects "NORDLIN" → "noradrénaline" once, apply automatically forever.

6. **Fine-tune the model:** Use icefall's `pruned_transducer_stateless7_streaming` recipe to fine-tune the zipformer on French medical audio. Would need a medical French speech corpus.

### Key insight
The bottleneck is NOT the model architecture or inference engine. It's the **training data**. All models were trained on general French (CommonVoice, news, etc.) and have never seen medical vocabulary. Post-processing correction is the practical path until a medical French model exists.

## 5. Canary model max 40-second input
**Date:** 2026-04-15
**Symptom:** NVidia documents that Canary-180M-Flash should be used with audio < 40 seconds. For longer audio, chunked inference is needed.
**Severity:** Medium — affects long dictation segments.

### Current behavior
The hybrid engine segments audio at speech pauses (5-30s segments), so most segments are within the 40s limit. But long continuous speech without pauses could exceed it.

### Fix needed
Add audio chunking in the offline pass: if segment > 35 seconds, split into 30-second chunks with 5-second overlap, transcribe each, deduplicate overlap, concatenate.

## 6. CamemBERT-bio on-device: too slow and hurts accuracy
**Date:** 2026-04-21
**Symptom:** CamemBERT-bio (French biomedical BERT, 130 MB INT8 ONNX) was implemented as a correction validator using pseudo-log-likelihood scoring. It is both too slow for real-time use and makes accuracy worse.
**Severity:** Closed — approach abandoned.

### What we built
Custom Kotlin native module (`CamembertModule`) that reuses sherpa-onnx's bundled ONNX Runtime (`libonnxruntime.so`). No extra native libraries. The module exposes `loadModel()`, `scoreMaskedPosition()`, and `release()` to JS. The log-softmax computation runs on the native side so only a single double crosses the bridge per forward pass.

Files: `CamembertHelper.kt`, `CamembertModule.kt`, `CamembertPackage.kt`, `camembert.ts`.

### Latency results

Pseudo-log-likelihood scoring requires N forward passes per sentence (one per masked token).

| Device | Short (5 tokens) | Medium (12 tokens) | Per forward pass |
|--------|-------------------|---------------------|------------------|
| Emulator (x86 host CPU) | 232ms total, 46ms/pass | 2,449ms total, 204ms/pass | 46-204ms |
| Samsung S22 (Snapdragon 8 Gen 1) | 718ms total, 144ms/pass | 6,616ms total, 551ms/pass | 144-551ms |

S22 is 3x slower than emulator because the emulator runs on the Mac's native x86 CPU while the S22 runs ARM with CPU-only ORT (no NNAPI optimization for this model).

A typical correction validation requires 2 sentence scores (original + corrected). For a 15-word medical sentence (~20 subword tokens), that's ~40 forward passes = **22 seconds on S22**. With 2-3 corrections per dictation segment, CamemBERT adds **45-65 seconds** to each offline pass.

### Accuracy results

CamemBERT-bio **rejected correct corrections** in all observed cases:

| STT output | Phonetic correction | CamemBERT decision | Correct? |
|------------|---------------------|---------------------|----------|
| "pouts perçus" | "pouls perçus" (pulse) | Rejected (delta=-0.05) | WRONG — pouls is correct |
| "nor ine" | "noradrénaline" | Rejected (delta=-0.02) | WRONG — noradrénaline is correct |
| sodium → sodium | (identity) | Rejected (delta=0.00) | N/A |
| vergule → metformine | | Rejected (delta=-0.02) | Correct rejection (wrong context) |

**Root cause:** The STT output is so garbled that the surrounding context doesn't help the language model. CamemBERT was trained on well-formed biomedical French text. When the input sentence contains multiple misspellings, the model has no good signal to prefer the corrected word. It often scores the garbled version higher because the subword tokens are more "expected" given the equally garbled neighbors.

This matches our desktop Python benchmark which showed only marginal improvement (52.2% → 50.6% WER). The 5/5 accuracy on clean hand-crafted test sentences didn't transfer to real STT output.

### Decision
CamemBERT-bio on-device is not viable for this use case. The code remains in the codebase (graceful degradation: if model not loaded, all corrections accepted) but is effectively disabled — the model files won't be shipped.

### What would make it work
1. **Much faster inference:** NNAPI/GPU delegate for ORT, or a distilled CamemBERT (6 layers instead of 12). Target: <20ms per forward pass.
2. **Better STT quality first:** If raw WER drops to <25%, the context around each correction would be clean enough for the language model to help.
3. **Different scoring approach:** Instead of PLL (N passes per sentence), use a single-pass approach like computing the loss on the masked position only. Would need model architecture changes.
