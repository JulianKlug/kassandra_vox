# Solved Issues

## 1. Whisper hallucination: "bruit de la machine qui s'éteint"
**Date:** 2026-04-09
**Symptom:** Every recording transcribed as "*bruit de la machine qui s'éteint*" regardless of actual speech.
**Root cause:** expo-av's `HIGH_QUALITY` preset records M4A/AAC at 44.1kHz stereo. whisper.rn expects 16kHz mono PCM. The format mismatch caused whisper to receive garbage audio and hallucinate common training-data labels.
**Fix:** Replaced expo-av recording with whisper.rn's built-in `transcribeRealtime` which captures audio in the correct format. Later replaced with sherpa-onnx `createPcmLiveStream`.

## 2. whisper.rn deprecated API: "transcribeRealtime is deprecated"
**Date:** 2026-04-09
**Symptom:** Warning about deprecated API, no transcription produced.
**Root cause:** whisper.rn v0.5.x replaced `context.transcribeRealtime()` with the new `RealtimeTranscriber` class.
**Fix:** Migrated to `RealtimeTranscriber` + `AudioPcmStreamAdapter` from `whisper.rn/src/realtime-transcription`.

## 3. Metro import resolution: "whisper.rn/realtime-transcription" not found
**Date:** 2026-04-09
**Symptom:** Metro bundling failed on `import from "whisper.rn/realtime-transcription"`.
**Root cause:** whisper.rn's `exports` field in package.json only has `./*` which maps directories, but Metro resolves to files. The `lib/module/realtime-transcription` path doesn't resolve as a file.
**Fix:** Import from `whisper.rn/src/realtime-transcription` (file-based fallback) per README guidance.

## 4. whisper.rn too slow on Android CPU
**Date:** 2026-04-13
**Symptom:** whisper-medium took 30-60+ seconds for 30s of audio on S22. Unusable for real-time or near-real-time.
**Root cause:** whisper.rn uses whisper.cpp which is CPU-only on Android (no Metal/NNAPI). VoicePing benchmark shows 51x speed difference between onnxruntime and whisper.cpp on Android.
**Fix:** Switched streaming STT to sherpa-onnx (zipformer FR via onnxruntime) for real-time, and sherpa-onnx with Canary-180M-Flash for offline second-pass.

## 5. Zipformer ALL CAPS output
**Date:** 2026-04-13
**Symptom:** Streaming transcription produced uppercase text: "LE PATIENT ARRIVE ÉMODYNÈQUEMENT..."
**Root cause:** The French zipformer model was trained on uppercase-only text (CommonVoice).
**Fix:** `toLowerCase()` on all zipformer output before passing to correction pipeline.

## 6. Streaming text duplication
**Date:** 2026-04-13
**Symptom:** Last section of transcript appeared twice.
**Root cause:** Endpoint segments were appended to the array AND shown as partial simultaneously. `segments[segments.length]` always appends a new element.
**Fix:** Rewrote segment accumulation: finalized segments stored separately, current partial shown alongside.

## 7. WAV file written as 0 bytes (btoa on Hermes)
**Date:** 2026-04-14
**Symptom:** `writeAsStringAsync` with base64 encoding produced 0-byte files on Android.
**Root cause:** Hermes JS engine doesn't handle `btoa()` correctly for binary strings with bytes > 127. The `String.fromCharCode` approach produced a binary string that `btoa()` silently corrupted.
**Fix:** Replaced `btoa()` with a manual base64 encoder that operates directly on `Uint8Array` bytes.

## 8. sherpa-onnx can't read file:// URIs
**Date:** 2026-04-14
**Symptom:** "Audio file does not exist or is empty (size=0)" despite file being correctly written.
**Root cause:** expo-file-system uses `file://` URI prefixes. sherpa-onnx's native `transcribeFile` expects plain filesystem paths (`/data/user/0/...`). The native code tried to open `file:///data/...` as a literal path.
**Fix:** Strip `file://` prefix in `transcribeFileOffline()` before passing to sherpa-onnx.

## 9. Concurrent whisper transcription crash
**Date:** 2026-04-14
**Symptom:** "Context is already transcribing" error, offline passes failing.
**Root cause:** whisper.rn doesn't allow concurrent transcriptions on the same context. Fire-and-forget offline passes overlapped.
**Fix:** Serialized all offline passes through a promise chain with `offlinePromise` guard. One pass at a time, pending segments queued.

## 10. Empty offline text replaces good streaming text
**Date:** 2026-04-14
**Symptom:** When offline pass returned empty, the segment showed nothing instead of the streaming text.
**Root cause:** `buildTranscript` used `??` to check `offlineText`, but `""` (empty string) is not nullish. `?? ` doesn't catch it.
**Fix:** Changed to `||` so empty offline results fall back to streaming text. Found by unit test.

## 11. React hooks ordering crash
**Date:** 2026-04-14
**Symptom:** "Rendered fewer hooks than expected" crash on emulator.
**Root cause:** Test mode `if (testMode) return` was placed before `useEffect` hooks. React requires all hooks to be called in the same order every render.
**Fix:** Moved test mode early return after all hooks.

## 12. sherpa-onnx newer model crashes (Kroko, NeMo CTC)
**Date:** 2026-04-13
**Symptom:** App crashes with SIGABRT on model init.
**Root cause:** Bundled sherpa-onnx v1.12.34 in react-native-sherpa-onnx 0.4.2 expects metadata fields (`attention_dims`, `window_size`) that newer models don't have. The C++ code crashes (destroyed mutex) instead of returning an error.
**Fix:** Use older models compatible with the bundled version (zipformer FR 2023 for streaming, Canary-180M-Flash for offline).

## 13. Whisper models translating to English
**Date:** 2026-04-14
**Symptom:** Offline whisper pass produced English text instead of French.
**Root cause:** Whisper defaults to English translation mode without explicit language/task settings. `distil-large-v3.5` is actually English-only despite the name.
**Fix:** Set `modelOptions: { whisper: { language: "fr", task: "transcribe" } }`. Switched to Canary which uses `srcLang`/`tgtLang`.

## 14. Download percentages > 100%
**Date:** 2026-04-13
**Symptom:** Download progress showed values like "5000%".
**Root cause:** sherpa-onnx download manager reports `percent` as 0-100, but our code multiplied by 100 again (leftover from the whisper.rn code where percent was 0-1).
**Fix:** Display `percent` directly, clamp to 100 max.

## 15. French accents not displaying on UI screens
**Date:** 2026-04-14
**Symptom:** "Modele" instead of "Modèle" on download/loading screens.
**Root cause:** Used `\u00e8` unicode escapes in JSX text content. JSX doesn't process unicode escapes between tags (only in JS string literals).
**Fix:** Replaced all unicode escapes with actual UTF-8 characters.

## 16. Double engine initialization
**Date:** 2026-04-14
**Symptom:** "Canary-180M-Flash offline engine ready" logged twice.
**Root cause:** Two concurrent calls to `initOfflineEngine` both passed the `if (sttEngine) return` guard before either set `sttEngine`.
**Fix:** Added `initPromise` guard: concurrent calls await the same promise.
