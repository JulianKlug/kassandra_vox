#!/bin/bash
# Launch the app in test mode and stream test results from logcat.
set -e

ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
PACKAGE="com.vox.dictation"

DEVICE_FLAG=""
if [ -n "$1" ]; then
  DEVICE_FLAG="-s $1"
fi

echo "=== Vox Device Test Runner ==="

# 1. Push test data first
echo "Step 1: Pushing test data..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$SCRIPT_DIR/push-test-data.sh" "$1"

# 2. Clear old logcat
$ADB $DEVICE_FLAG logcat -c

# 3. Force-stop the app (clean state)
$ADB $DEVICE_FLAG shell am force-stop $PACKAGE

# 4. Launch app with test mode deep link
echo ""
echo "Step 2: Launching app in test mode..."
$ADB $DEVICE_FLAG shell am start \
  -a android.intent.action.VIEW \
  -d "exp+vox://test?mode=test" \
  $PACKAGE/.MainActivity

# 5. Stream logcat filtered to our test output
echo ""
echo "Step 3: Waiting for test results..."
echo "(Press Ctrl+C to stop)"
echo ""
$ADB $DEVICE_FLAG logcat -s ReactNativeJS:I | grep --line-buffered "VoxTest\|VoxBench"
