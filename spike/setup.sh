#!/bin/bash
set -e

echo "=== Vox Accuracy Spike Setup ==="

# Check and install Homebrew dependencies
echo ""
echo "1. Checking dependencies..."

if ! command -v ffmpeg &>/dev/null; then
    echo "   Installing ffmpeg..."
    brew install ffmpeg
else
    echo "   ffmpeg: OK"
fi

if ! command -v whisper-cpp &>/dev/null; then
    echo "   Installing whisper-cpp (with Metal support)..."
    brew install whisper-cpp
else
    echo "   whisper-cpp: OK"
fi

# Download model
echo ""
echo "2. Checking whisper model..."
MODEL_DIR="$(brew --prefix whisper-cpp)/share/whisper-cpp/models"
if [ ! -f "$MODEL_DIR/ggml-large-v3.bin" ]; then
    echo "   Downloading large-v3 model (~3GB, this will take a few minutes)..."
    whisper-cpp --download-model large-v3
else
    echo "   large-v3 model: OK"
fi

# Python dependencies
echo ""
echo "3. Installing Python dependencies..."
pip3 install -r "$(dirname "$0")/requirements.txt" --quiet

# Create data directories
echo ""
echo "4. Creating data directories..."
SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SPIKE_DIR/data"/{audio,converted,transcriptions,ground_truth,corrected,reports}

# Add .gitkeep files
for dir in audio converted transcriptions ground_truth corrected reports; do
    touch "$SPIKE_DIR/data/$dir/.gitkeep"
done

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy voice memos to spike/data/audio/"
echo "  2. Run: python3 spike/audio.py"
echo "  3. Run: python3 spike/transcribe.py --all --prompt"
echo "  4. Run: python3 spike/annotate.py --all"
echo "  5. Run: ./spike/run.sh"
