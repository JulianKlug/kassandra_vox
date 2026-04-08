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
    # Common locations to check
    candidates = [
        Path("/opt/homebrew/share/whisper-cpp/ggml-large-v3.bin"),
        Path("/usr/local/share/whisper-cpp/ggml-large-v3.bin"),
        Path.home() / ".cache" / "whisper" / "ggml-large-v3.bin",
        Path.home() / "models" / "ggml-large-v3.bin",
        Path("models") / "ggml-large-v3.bin",
    ]

    # Try Homebrew prefix
    result = subprocess.run(
        ["brew", "--prefix"],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        brew_prefix = result.stdout.strip()
        candidates.insert(0, Path(brew_prefix) / "share" / "whisper-cpp" / "ggml-large-v3.bin")

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    return None


def transcribe_file(wav_path, model_path, prompt=None):
    """Transcribe a single WAV file with whisper.cpp."""
    # Use a temp output prefix; whisper-cli writes {prefix}.txt
    out_prefix = str(wav_path.parent / f".whisper-out-{wav_path.stem}")
    cmd = [
        WHISPER_CMD,
        "-m", model_path,
        "-l", WHISPER_LANGUAGE,
        "-f", str(wav_path),
        "-otxt",
        "-of", out_prefix,
    ]
    if prompt:
        cmd.extend(["--prompt", prompt])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR transcribing {wav_path.name}: {result.stderr[-500:]}")
        return None

    txt_output = Path(out_prefix + ".txt")
    if not txt_output.exists():
        print(f"  ERROR: no output file produced for {wav_path.name}")
        return None

    text = txt_output.read_text().strip()
    txt_output.unlink()  # cleanup

    # Each line in the txt output is a segment
    segments = [{"text": line.strip()} for line in text.split("\n") if line.strip()]
    full_text = " ".join(s["text"] for s in segments)

    return {
        "file": wav_path.name,
        "text": full_text,
        "segments": segments,
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
