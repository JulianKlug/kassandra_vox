#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Vox Accuracy Spike Pipeline ==="
echo ""

# Check for audio files
AUDIO_COUNT=$(find data/audio -type f \( -name "*.m4a" -o -name "*.mp3" -o -name "*.wav" -o -name "*.ogg" -o -name "*.flac" \) 2>/dev/null | wc -l | tr -d ' ')
if [ "$AUDIO_COUNT" = "0" ]; then
    echo "ERROR: No audio files found in data/audio/"
    echo "Copy your voice memos there first."
    exit 1
fi
echo "Found $AUDIO_COUNT audio file(s)."

# Step 1: Convert audio
echo ""
echo "--- Step 1: Converting audio to 16kHz mono WAV ---"
python3 audio.py data/audio/

# Step 2: Transcribe
echo ""
echo "--- Step 2: Transcribing with whisper.cpp ---"
python3 transcribe.py --all --prompt

# Step 3: Check for ground truth
GT_COUNT=$(find data/ground_truth -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
if [ "$GT_COUNT" = "0" ]; then
    echo ""
    echo "--- Step 3: Ground truth annotation needed ---"
    echo "No ground truth found. Starting annotation tool..."
    echo "(You'll listen to each recording and verify/correct the transcription)"
    echo ""
    python3 annotate.py --all
fi

# Step 4: Apply corrections
echo ""
echo "--- Step 4: Applying correction dictionary ---"
python3 correct.py --all

# Step 5: Evaluate
echo ""
echo "--- Step 5: Evaluating accuracy ---"
python3 evaluate.py --both

# Step 6: Generate report
echo ""
echo "--- Step 6: Generating report ---"
python3 report.py

echo ""
echo "=== Pipeline complete ==="
echo "Report: data/reports/latest.md"
