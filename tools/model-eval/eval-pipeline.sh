#!/usr/bin/env bash
#
# Model evaluation pipeline: Desktop → Emulator → Phone
#
# Usage:
#   # Full pipeline (desktop + emulator):
#   ./tools/model-eval/eval-pipeline.sh \
#     --model-dir /path/to/model \
#     --model-type nemo_ctc \
#     --model-id nemo-ctc-fr-int8
#
#   # Desktop only (fast compatibility check):
#   ./tools/model-eval/eval-pipeline.sh \
#     --model-dir /path/to/model \
#     --model-type nemo_ctc \
#     --model-id my-model \
#     --desktop-only
#
#   # Skip desktop, just run on emulator:
#   ./tools/model-eval/eval-pipeline.sh \
#     --model-dir /path/to/model \
#     --model-type nemo_ctc \
#     --model-id my-model \
#     --device-only
#
#   # Regenerate results doc from existing registry:
#   ./tools/model-eval/eval-pipeline.sh --update-docs
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ADB="${HOME}/Library/Android/sdk/platform-tools/adb"

MODEL_DIR=""
MODEL_TYPE=""
MODEL_ID=""
STREAMING=""
DESKTOP_ONLY=""
DEVICE_ONLY=""
UPDATE_DOCS=""
DEVICE_PATH=""

usage() {
  echo "Usage: $0 --model-dir DIR --model-type TYPE --model-id ID [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --model-dir DIR       Path to model directory on this machine"
  echo "  --model-type TYPE     nemo_ctc, whisper, transducer, nemo_transducer"
  echo "  --model-id ID         Registry ID (e.g., nemo-ctc-fr-int8)"
  echo "  --streaming           Evaluate as a streaming model"
  echo "  --desktop-only        Only run desktop evaluation"
  echo "  --device-only         Skip desktop, push to device and run"
  echo "  --device-path PATH    Path on device (default: /data/local/tmp/\$MODEL_ID)"
  echo "  --update-docs         Just regenerate MODEL_EVAL_RESULTS.md"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --model-dir)   MODEL_DIR="$2"; shift 2 ;;
    --model-type)  MODEL_TYPE="$2"; shift 2 ;;
    --model-id)    MODEL_ID="$2"; shift 2 ;;
    --streaming)   STREAMING="--streaming"; shift ;;
    --desktop-only) DESKTOP_ONLY=1; shift ;;
    --device-only) DEVICE_ONLY=1; shift ;;
    --device-path) DEVICE_PATH="$2"; shift 2 ;;
    --update-docs) UPDATE_DOCS=1; shift ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [[ -n "$UPDATE_DOCS" ]]; then
  echo "=== Regenerating results doc ==="
  python3 "$SCRIPT_DIR/eval-desktop.py" --update-docs
  exit 0
fi

if [[ -z "$MODEL_DIR" || -z "$MODEL_TYPE" || -z "$MODEL_ID" ]]; then
  usage
fi

if [[ ! -d "$MODEL_DIR" ]]; then
  echo "ERROR: Model directory not found: $MODEL_DIR"
  exit 1
fi

DEVICE_PATH="${DEVICE_PATH:-/data/local/tmp/$MODEL_ID}"

echo "========================================"
echo "  Vox Model Evaluation Pipeline"
echo "========================================"
echo "Model:       $MODEL_ID"
echo "Directory:   $MODEL_DIR"
echo "Type:        $MODEL_TYPE"
echo "Device path: $DEVICE_PATH"
echo ""

# ─── Tier 1: Desktop ───────────────────────────────────

if [[ -z "$DEVICE_ONLY" ]]; then
  echo "=== TIER 1: Desktop Evaluation ==="
  echo ""

  if ! python3 -c "import sherpa_onnx" 2>/dev/null; then
    echo "WARNING: sherpa-onnx Python package not installed."
    echo "Install with: pip install sherpa-onnx"
    echo "Skipping desktop tier."
    echo ""
  else
    python3 "$SCRIPT_DIR/eval-desktop.py" \
      --model-dir "$MODEL_DIR" \
      --model-type "$MODEL_TYPE" \
      --model-id "$MODEL_ID" \
      $STREAMING

    echo ""

    if [[ -n "$DESKTOP_ONLY" ]]; then
      echo "Desktop-only mode. Done."
      exit 0
    fi
  fi
fi

# ─── Tier 2: Device (Emulator or Phone) ────────────────

echo "=== TIER 2: Device Evaluation ==="
echo ""

# Check adb
if [[ ! -x "$ADB" ]]; then
  echo "ERROR: adb not found at $ADB"
  exit 1
fi

DEVICES=$("$ADB" devices | grep -v "List" | grep -v "^$" | wc -l | tr -d ' ')
if [[ "$DEVICES" -eq 0 ]]; then
  echo "ERROR: No Android devices connected."
  echo "Start an emulator or connect a phone."
  exit 1
fi

DEVICE_NAME=$("$ADB" devices | grep -v "List" | grep -v "^$" | head -1 | awk '{print $1}')
echo "Device: $DEVICE_NAME"

# Push model to device
echo "Pushing model to $DEVICE_PATH..."
"$ADB" shell "mkdir -p $DEVICE_PATH" 2>/dev/null || true
for f in "$MODEL_DIR"/*; do
  fname=$(basename "$f")
  echo "  $fname ($(du -sh "$f" | awk '{print $1}'))"
  "$ADB" push "$f" "$DEVICE_PATH/$fname" 2>/dev/null
done
echo ""

# Push test data
echo "Pushing test data..."
"$ADB" shell "mkdir -p /data/local/tmp/vox-test/audio" 2>/dev/null || true
"$ADB" shell "mkdir -p /data/local/tmp/vox-test/ground-truth" 2>/dev/null || true

AUDIO_DIR="$REPO_ROOT/spike/data/converted"
GT_DIR="$REPO_ROOT/spike/data/ground_truth"

if [[ -d "$AUDIO_DIR" ]]; then
  "$ADB" push "$AUDIO_DIR/." "/data/local/tmp/vox-test/audio/" 2>/dev/null
  echo "  Audio files pushed."
fi
if [[ -d "$GT_DIR" ]]; then
  "$ADB" push "$GT_DIR/." "/data/local/tmp/vox-test/ground-truth/" 2>/dev/null
  echo "  Ground truth pushed."
fi

# Set test mode flag
"$ADB" shell "touch /data/local/tmp/vox-test-mode" 2>/dev/null

echo ""
echo "Model and test data are on device."
echo ""
echo "Next steps:"
echo "  1. Update mobile/src/test-harness/model-config.ts with:"
echo "     localPath: \"$DEVICE_PATH\""
echo "     modelType: \"$MODEL_TYPE\""
echo "     id: \"$MODEL_ID\""
echo ""
echo "  2. Build and launch:"
echo "     cd mobile && npx expo run:android"
echo ""
echo "  3. Read results from logcat:"
echo "     $ADB logcat -v brief | grep VoxBench"
echo ""
echo "  4. After run, update registry with results:"
echo "     python3 tools/model-eval/eval-desktop.py --update-docs"
echo ""
