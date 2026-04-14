#!/bin/bash
# Push test audio and ground truth to the device/emulator.
# Run this before launching test mode.
set -e

ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
SPIKE_DIR="$(cd "$(dirname "$0")/../spike" && pwd)"
DEVICE_DIR="/data/local/tmp/vox-test"

echo "=== Pushing test data to device ==="

# Determine target device
DEVICE_FLAG=""
if [ -n "$1" ]; then
  DEVICE_FLAG="-s $1"
  echo "Target: $1"
else
  DEVICE_COUNT=$($ADB devices | grep -c "device$")
  if [ "$DEVICE_COUNT" -gt 1 ]; then
    echo "Multiple devices found. Specify one:"
    $ADB devices
    echo "Usage: $0 <device-id>"
    exit 1
  fi
  echo "Target: (default device)"
fi

# Create directories on device
$ADB $DEVICE_FLAG shell "mkdir -p $DEVICE_DIR/audio $DEVICE_DIR/ground-truth"

# Push audio files
echo ""
echo "Pushing audio files..."
for f in "$SPIKE_DIR/data/converted/"*.wav; do
  name=$(basename "$f")
  echo "  $name"
  $ADB $DEVICE_FLAG push "$f" "$DEVICE_DIR/audio/$name" 2>/dev/null
done

# Push ground truth
echo ""
echo "Pushing ground truth..."
for f in "$SPIKE_DIR/data/ground_truth/"*.json; do
  name=$(basename "$f")
  echo "  $name"
  $ADB $DEVICE_FLAG push "$f" "$DEVICE_DIR/ground-truth/$name" 2>/dev/null
done

echo ""
echo "=== Done. Test data at $DEVICE_DIR ==="
echo ""
echo "Verify: adb shell ls $DEVICE_DIR/audio/"
