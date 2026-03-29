#!/usr/bin/env python3
"""Run whisper.cpp on converted audio files and save transcriptions."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from config import (
    CONVERTED_DIR, TRANSCRIPTIONS_DIR, WHISPER_CMD,
    WHISPER_LANGUAGE, PROMPT_FILE,
)


def find_model_path():
    """Find the whisper model file."""
    # Homebrew location
    result = subprocess.run(
        ["brew", "--prefix", "whisper-cpp"],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        brew_prefix = result.stdout.strip()
        model_path = Path(brew_prefix) / "share" / "whisper-cpp" / "models" / "ggml-large-v3.bin"
        if model_path.exists():
            return str(model_path)

    # Common locations
    for candidate in [
        Path.home() / ".cache" / "whisper" / "ggml-large-v3.bin",
        Path.home() / "models" / "ggml-large-v3.bin",
        Path("models") / "ggml-large-v3.bin",
    ]:
        if candidate.exists():
            return str(candidate)

    return None


def transcribe_file(wav_path, model_path, prompt=None):
    """Transcribe a single WAV file with whisper.cpp."""
    cmd = [
        WHISPER_CMD,
        "-m", model_path,
        "-l", WHISPER_LANGUAGE,
        "-f", str(wav_path),
        "--output-json",
        "--no-timestamps",
    ]
    if prompt:
        cmd.extend(["--prompt", prompt])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR transcribing {wav_path.name}: {result.stderr[:300]}")
        return None

    # whisper-cpp writes JSON to {input}.json
    json_output = Path(str(wav_path) + ".json")
    if not json_output.exists():
        # Try parsing stdout as fallback
        text = result.stdout.strip()
        return {"file": wav_path.name, "text": text, "segments": []}

    with open(json_output) as f:
        data = json.load(f)

    # Clean up the auto-generated JSON file
    json_output.unlink()

    # Normalize the output format
    text = data.get("text", "")
    if not text and "transcription" in data:
        segments = data["transcription"]
        text = " ".join(s.get("text", "").strip() for s in segments)
    elif not text and "segments" in data:
        segments = data["segments"]
        text = " ".join(s.get("text", "").strip() for s in segments)

    return {
        "file": wav_path.name,
        "text": text.strip(),
        "segments": data.get("transcription", data.get("segments", [])),
    }


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio files with whisper.cpp")
    parser.add_argument("--file", type=str, help="Transcribe a single file")
    parser.add_argument("--all", action="store_true", help="Transcribe all converted files")
    parser.add_argument("--prompt", action="store_true", help="Use medical vocabulary prompt")
    parser.add_argument("--force", action="store_true", help="Re-transcribe existing files")
    args = parser.parse_args()

    if not args.file and not args.all:
        parser.print_help()
        sys.exit(1)

    model_path = find_model_path()
    if not model_path:
        print("ERROR: Could not find whisper model.")
        print("Run: whisper-cpp --download-model large-v3")
        sys.exit(1)
    print(f"Using model: {model_path}")

    prompt = None
    if args.prompt and PROMPT_FILE.exists():
        prompt = PROMPT_FILE.read_text().strip()
        print(f"Using prompt ({len(prompt)} chars)")

    TRANSCRIPTIONS_DIR.mkdir(parents=True, exist_ok=True)

    if args.file:
        files = [Path(args.file)]
    else:
        files = sorted(CONVERTED_DIR.glob("*.wav"))

    if not files:
        print(f"No WAV files found in {CONVERTED_DIR}")
        sys.exit(1)

    print(f"\nTranscribing {len(files)} file(s)...\n")

    for wav in files:
        output = TRANSCRIPTIONS_DIR / f"{wav.stem}.json"
        if output.exists() and not args.force:
            print(f"  SKIP {wav.name} (already transcribed, use --force to redo)")
            continue

        print(f"  Transcribing {wav.name}...")
        result = transcribe_file(wav, model_path, prompt)
        if result:
            with open(output, "w") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            preview = result["text"][:80] + "..." if len(result["text"]) > 80 else result["text"]
            print(f"    -> {preview}")

    print("\nDone.")


if __name__ == "__main__":
    main()
