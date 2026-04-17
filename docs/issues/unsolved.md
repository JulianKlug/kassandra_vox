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

## 4. Canary model max 40-second input
**Date:** 2026-04-15
**Symptom:** NVidia documents that Canary-180M-Flash should be used with audio < 40 seconds. For longer audio, chunked inference is needed.
**Severity:** Medium — affects long dictation segments.

### Current behavior
The hybrid engine segments audio at speech pauses (5-30s segments), so most segments are within the 40s limit. But long continuous speech without pauses could exceed it.

### Fix needed
Add audio chunking in the offline pass: if segment > 35 seconds, split into 30-second chunks with 5-second overlap, transcribe each, deduplicate overlap, concatenate.
