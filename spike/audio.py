#!/usr/bin/env python3
"""Convert audio files to 16kHz mono WAV for whisper.cpp."""

import subprocess
import sys
from pathlib import Path

from config import AUDIO_DIR, CONVERTED_DIR, SAMPLE_RATE, CHANNELS

AUDIO_EXTENSIONS = {".m4a", ".mp3", ".wav", ".ogg", ".flac", ".aac", ".wma"}


def convert_file(input_path, output_path):
    """Convert audio file to 16kHz mono WAV using ffmpeg."""
    cmd = [
        "ffmpeg", "-i", str(input_path),
        "-ar", str(SAMPLE_RATE),
        "-ac", str(CHANNELS),
        "-c:a", "pcm_s16le",
        "-y",  # overwrite
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR converting {input_path.name}: {result.stderr[:200]}")
        return False
    return True


def convert_directory(input_dir):
    """Convert all audio files in a directory."""
    input_dir = Path(input_dir)
    if not input_dir.exists():
        print(f"Directory not found: {input_dir}")
        return

    files = sorted(
        f for f in input_dir.iterdir()
        if f.suffix.lower() in AUDIO_EXTENSIONS and not f.name.startswith(".")
    )

    if not files:
        print(f"No audio files found in {input_dir}")
        print(f"Supported formats: {', '.join(AUDIO_EXTENSIONS)}")
        return

    CONVERTED_DIR.mkdir(parents=True, exist_ok=True)

    converted = 0
    skipped = 0
    for f in files:
        output = CONVERTED_DIR / f"{f.stem}.wav"
        if output.exists():
            print(f"  SKIP {f.name} (already converted)")
            skipped += 1
            continue
        print(f"  Converting {f.name}...")
        if convert_file(f, output):
            converted += 1

    print(f"\nDone: {converted} converted, {skipped} skipped, {len(files)} total")


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else str(AUDIO_DIR)
    target_path = Path(target)

    if target_path.is_file():
        output = CONVERTED_DIR / f"{target_path.stem}.wav"
        CONVERTED_DIR.mkdir(parents=True, exist_ok=True)
        if convert_file(target_path, output):
            print(f"Converted: {output}")
    elif target_path.is_dir():
        convert_directory(target_path)
    else:
        print(f"Not found: {target}")
        sys.exit(1)
