# French ASR Model Comparison for On-Device Android

Research conducted 2026-04-14 via 5 parallel research agents.
Target device: Samsung S22 (Snapdragon 8 Gen 1, 8GB RAM).

## Models That Work on Android + Support French

### Streaming (real-time, for live dictation preview)

| Model | Size | French WER (CV) | Architecture | Speed on S22 | Status |
|---|---|---|---|---|---|
| Zipformer FR 2023 mobile | 351 MB | ~25-30% | Transducer | Real-time | **Works** (only streaming model compatible with react-native-sherpa-onnx 0.4.2) |
| Zipformer FR 2023 full | 380 MB | ~25-30% | Transducer | Real-time | Untested (slightly larger variant) |
| Kroko FR 2025 | 55 MB | Unknown | Zipformer2 Transducer | Real-time | **Crashes** (`attention_dims` metadata missing) |
| NeMo Fast Conformer CTC FR int8 | 98 MB | Unknown | CTC | Real-time | **Crashes** (`window_size` metadata missing) |

### Offline (second-pass, for accuracy after recording)

| Model | Size | French WER (MLS) | French WER (CV) | Params | Architecture | Est. Speed on S22 | Status |
|---|---|---|---|---|---|---|---|
| **NVidia Canary-180M-Flash int8** | **147 MB** | **4.75%** | **8.19%** | **182M** | Enc-Dec (NeMo) | **~2x RT** | **Works** via sherpa-onnx |
| NVidia Parakeet-TDT-0.6B int8 | ~640 MB | 4.97% | — | 600M | Transducer | ~5x slower | Untested, tight on RAM |
| NVidia stt_fr_conformer_ctc_large | ~120 MB | — | 9.63% | 120M | CTC | ~1.5-2x RT | Untested (NeMo export needed) |
| bofenghuang distil-dec2 | 538 MB (GGML q5) | 4.64% | 9.01% | ~800M | Whisper Enc-Dec | ~5-10x slower | Needs ONNX conversion |
| bofenghuang distil-dec4 | 574 MB (GGML q5) | 4.23% | 8.37% | ~800M | Whisper Enc-Dec | ~4-8x slower | Needs ONNX conversion |
| bofenghuang distil-dec8 | 646 MB (GGML q5) | 3.80% | 7.62% | ~900M | Whisper Enc-Dec | ~3-6x slower | Needs ONNX conversion |
| bofenghuang distil-dec16 | 791 MB (GGML q5) | 3.57% | 7.18% | ~1.0B | Whisper Enc-Dec | ~2-4x slower | Needs ONNX conversion |
| eustlb distil-large-v3-fr | ~540 MB (GGML) | ~similar to dec2 | ~similar | ~800M | Whisper Enc-Dec | ~5-10x slower | Needs ONNX conversion, 4500h training data |
| whisper-small (generic) | 610 MB (ONNX) | ~8-10% | ~15-20% | 244M | Whisper Enc-Dec | ~2-3x RT | Available in sherpa-onnx, poor French |
| whisper-turbo | 538 MB (ONNX) | ~4.5% | ~8% | ~800M | Whisper Enc-Dec | ~4x slower | Available in sherpa-onnx, translates to English despite language:"fr" |
| whisper-distil-large-v3.5 | 504 MB (ONNX) | — | — | — | Whisper Enc-Dec | ~4x slower | Available in sherpa-onnx, English-only despite name |

## Models That DON'T Support French

| Model | Why excluded |
|---|---|
| Moonshine v2 | English-only. Community French fine-tune achieves 21.8% WER (poor). |
| SenseVoice Small | Chinese/English/Japanese/Korean/Cantonese only. No French. |
| MMS (Meta) | 1000+ languages but CTC-only, no punctuation, poor quality for French. |
| FireRedASR | Mandarin/Chinese/English only. |
| Dolphin ASR | Eastern languages only (40 Asian/Middle Eastern languages). |
| Moonshine Tiny FR (community) | 21.8% WER. Not production quality. |

## Models Too Large for On-Device Android

| Model | Size | French WER | Why excluded |
|---|---|---|---|
| Cohere Transcribe | ~2 GB (int8) | #1 on ASR leaderboard | 2B params, won't fit in S22 RAM alongside app |
| Voxtral Mini 3B | ~3 GB | Excellent (Mistral, French company) | 3B params, won't fit |
| Qwen3-ASR-0.6B | ~2.5 GB (ONNX) | ~13% avg | Despite name, ONNX files total 2.5 GB |
| Qwen3-ASR-1.7B | ~4 GB | ~4.6% avg | Far too large |
| NVidia Canary-1B | ~2 GB | Better than 180M | Too large for mobile |
| Kyutai STT-1B (en_fr) | ~2 GB | Unknown | No ONNX, no sherpa-onnx support |

## bofenghuang French Whisper Family (Detailed)

Fine-tuned on 2,500+ hours of French speech (CommonVoice, MLS, VoxPopuli, Fleurs, TEDx, MediaSpeech, African Accented French). Predicts casing, punctuation, and numbers natively. French-only = cannot translate to English.

| Variant | Decoder layers | CV FR WER | MLS FR WER | GGML q5 size | Speed vs full |
|---|---|---|---|---|---|
| Full model | 32 | 7.28% | 3.98% | 1.08 GB | 1x |
| distil-dec16 | 16 | **7.18%** | **3.57%** | 791 MB | 2x |
| distil-dec8 | 8 | 7.62% | 3.80% | 646 MB | 3x |
| distil-dec4 | 4 | 8.37% | 4.23% | 574 MB | 4.3x |
| distil-dec2 | 2 | 9.01% | 4.64% | 538 MB | 5.8x |

Note: dec16 **outperforms the full model** on 4 of 5 benchmarks (distillation regularization effect).

Alternative: [eustlb/distil-large-v3-fr](https://huggingface.co/eustlb/distil-large-v3-fr) - 2 decoder layers, 4,515 hours training data (nearly 2x bofenghuang), GGML available.

## Medical French ASR Benchmarks

No published benchmarks exist for any French-finetuned model on medical/clinical speech.

The only published study: Jelassi, Jemai & Demongeot (2024) tested generic Whisper Large-v2 on French radiology dictation and achieved **17.12% WER**. A French-finetuned model would almost certainly do better, but by how much is unknown.

Our spike (10 recordings, whisper-large-v3 on Mac): ~20% WER on Swiss French medical prose, reduced to ~19.7% with a 21-entry correction dictionary.

The [MultiMed dataset](https://arxiv.org/html/2409.14074v1) (ACL 2025) has 150 hours of medical French but no published ASR benchmarks using French-finetuned models.

## Android Performance Data

### Inference Engine Matters More Than Model Size

[VoicePing benchmark](https://voiceping.net/en/blog/research-offline-speech-transcription-benchmark/) (Feb 2026): sherpa-onnx is **51x faster** than whisper.cpp for the same Whisper Tiny model on Android.

| Engine | Backend | Relative Speed |
|---|---|---|
| sherpa-onnx (onnxruntime) | CPU (NEON optimized) | **Fastest** |
| WhisperKit Android (QNN) | Qualcomm NPU | Fastest on supported chips (8 Gen 3+) |
| TFLite + XNNPACK | CPU | Good |
| whisper.cpp (GGML) | CPU only | **Slowest** (no GPU on Android) |
| NNAPI | Deprecated Android 15 | Often slower than CPU for transformers |

### S22 Specific (Snapdragon 8 Gen 1)

- 8 cores (1x X2 3.0GHz, 3x A710 2.5GHz, 4x A510 1.8GHz), 8GB RAM
- Hexagon DSP/NPU is weak for transformers compared to 8 Gen 3
- NNAPI often falls back to CPU for attention operations
- Best path: sherpa-onnx with ONNX Runtime CPU (NEON)

Estimated RTF on S22 via sherpa-onnx:

| Model | Params | Estimated RTF |
|---|---|---|
| Canary-180M-Flash | 182M | ~0.5-1.0 (faster than realtime) |
| whisper-tiny | 75M | ~0.02-0.1 |
| whisper-small | 244M | ~0.3-1.0 |
| whisper-medium | 769M | ~1-3 (slower than realtime) |

## Current Vox Architecture

```
STREAMING (real-time preview):
  mic -> sherpa-onnx zipformer FR 2023 mobile (351 MB) -> rough text -> corrections -> display

OFFLINE (second-pass accuracy, every 5-30s):
  audio buffer -> WAV file -> sherpa-onnx Canary-180M-Flash (147 MB) -> accurate text -> corrections -> replace display
```

## Recommended Future Improvements

1. **Re-test newer models** when react-native-sherpa-onnx updates bundled sherpa-onnx (currently v1.12.34, crashes on metadata for Kroko/NeMo CTC/Canary newer formats)
2. **Convert bofenghuang dec2 to ONNX** for sherpa-onnx if Canary accuracy proves insufficient for medical French
3. **Build medical French test set** using MultiMed dataset to benchmark properly
4. **Test WhisperKit Android** for Qualcomm NPU acceleration (requires newer Snapdragon)

## Sources

- [bofenghuang/whisper-large-v3-french](https://huggingface.co/bofenghuang/whisper-large-v3-french)
- [bofenghuang distil variants](https://huggingface.co/bofenghuang/whisper-large-v3-french-distil-dec2)
- [eustlb/distil-large-v3-fr](https://huggingface.co/eustlb/distil-large-v3-fr)
- [NVidia Canary-180M-Flash](https://huggingface.co/nvidia/canary-180m-flash)
- [NVidia Parakeet-TDT-0.6B-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [VoicePing Offline Benchmark](https://voiceping.net/en/blog/research-offline-speech-transcription-benchmark/)
- [WhisperKit Android](https://huggingface.co/spaces/argmaxinc/whisperkit-android-benchmarks)
- [French Radiology ASR Paper (MDPI 2024)](https://www.mdpi.com/2075-4418/14/9/895)
- [MultiMed: Multilingual Medical ASR (ACL 2025)](https://arxiv.org/html/2409.14074v1)
- [sherpa-onnx Whisper ONNX Export](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/export-onnx.html)
- [Cohere Transcribe](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026)
- [HuggingFace Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard)
