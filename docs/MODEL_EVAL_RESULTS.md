# Model Evaluation Results

> Auto-generated from `tools/model-eval/registry.json`.
> Do not edit manually. Re-generate with `python tools/model-eval/eval-desktop.py --update-docs`.

## Current Best

- **Streaming:** `zipformer-fr-2023-mobile`
- **Offline:** `nemo-ctc-fr-int8`

## Baselines

| Name | Device | Prose WER (raw) | Prose WER (corrected) |
|------|--------|-----------------|----------------------|
| whisper-large-v3 (Mac, Python) | Mac (spike evaluation) | 44.9% | 42.3% |

## Models

### Zipformer FR 2023 Mobile (`zipformer-fr-2023-mobile`)

- **Type:** streaming | **Size:** 351 MB | **Languages:** fr
- **Notes:** General-purpose French streaming model. Poor on medical terms without correction dictionary.

_No evaluation results yet._

### NeMo Fast Conformer CTC int8 (`nemo-ctc-fr-int8`)

- **Type:** offline | **Size:** 126 MB | **Languages:** en, de, es, fr
- **Notes:** NVidia multilingual CTC. Fast, reliable. Current offline model.

| Tier | Date | Device | Files | Avg Inference | Overall WER | Prose WER | Status |
|------|------|--------|-------|---------------|-------------|-----------|--------|
| emulator | 2026-04-16 | Android 14 emulator (x86_64) | 10/10 | 1816ms | 57.4% | 46.1% (44.8% corrected) | PASS |
| phone | 2026-04-17 | Samsung S22 (Snapdragon 8 Gen 1, 8GB RAM) | 10/10 | 2133ms | 58.2% | 46.7% (45.9% corrected) | PASS |

### NVidia Canary-180M-Flash int8 (`canary-180m-flash-int8`)

- **Type:** offline | **Size:** 147 MB | **Languages:** en, fr, de, es
- **Notes:** Best published WER (4.75% MLS FR) but returns empty on 7/10 test files. Upstream bug in sherpa-onnx.

| Tier | Date | Device | Files | Avg Inference | Overall WER | Prose WER | Status |
|------|------|--------|-------|---------------|-------------|-----------|--------|
| phone | 2026-04-15 | Samsung S22 (Snapdragon 8 Gen 1) | 3/10 | — | — | — | PASS |

### Kroko FR Zipformer2 (`kroko-fr-zipformer2`)

- **Type:** streaming | **Size:** 55 MB | **Languages:** fr
- **Notes:** Newer French-specific streaming model. BLOCKED: requires sherpa-onnx > v1.12.34 (attention_dims metadata crash).

| Tier | Date | Device | Files | Avg Inference | Overall WER | Prose WER | Status |
|------|------|--------|-------|---------------|-------------|-----------|--------|
| emulator | 2026-04-16 | Android 14 emulator (x86_64) | — | — | — | — | CRASHED |

### bofenghuang whisper-large-v3-french-distil-dec2 (`bofenghuang-whisper-large-v3-fr-distil-dec2`)

- **Type:** offline | **Size:** 1000 MB | **Languages:** fr
- **Notes:** Best French-specific Whisper distillation. ONNX conversion done but model too large (637 MB encoder int8 + 363 MB decoder int8). Not tested on device.

_No evaluation results yet._

## Evaluation Pipeline

```bash
# 1. Desktop eval (fast, catches compatibility issues)
python tools/model-eval/eval-desktop.py \
  --model-dir /path/to/model --model-type nemo_ctc --model-id my-model

# 2. Push model + test data to emulator, run in-app benchmark
adb push /path/to/model /data/local/tmp/model-name
adb push spike/data/converted/ /data/local/tmp/vox-test/audio/
adb push spike/data/ground_truth/ /data/local/tmp/vox-test/ground-truth/
# Then launch app in test mode

# 3. Push to real phone, same as emulator
# Results logged via logcat, add to registry manually or via --update-registry

# Re-generate this doc after adding results:
python tools/model-eval/eval-desktop.py --update-docs
```
