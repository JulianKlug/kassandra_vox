#!/usr/bin/env python3
"""Interactive ground truth annotation tool.

Plays audio, shows whisper transcription, and lets you type the correct version.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from config import (
    CONVERTED_DIR, TRANSCRIPTIONS_DIR, GROUND_TRUTH_DIR,
)

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.text import Text
    console = Console()
    HAS_RICH = True
except ImportError:
    HAS_RICH = False
    class FallbackConsole:
        def print(self, *args, **kwargs):
            text = args[0] if args else ""
            if hasattr(text, 'plain'):
                print(text.plain)
            elif isinstance(text, Panel):
                print(str(text))
            else:
                print(text)
        def rule(self, text=""):
            print(f"\n{'='*60}")
            if text:
                print(f"  {text}")
            print(f"{'='*60}")
    console = FallbackConsole()


def play_audio(wav_path):
    """Play audio file using macOS afplay."""
    subprocess.run(["afplay", str(wav_path)], capture_output=True)


def annotate_file(stem):
    """Annotate a single file interactively."""
    transcription_file = TRANSCRIPTIONS_DIR / f"{stem}.json"
    wav_file = CONVERTED_DIR / f"{stem}.wav"
    gt_file = GROUND_TRUTH_DIR / f"{stem}.json"

    if not transcription_file.exists():
        print(f"  No transcription for {stem}. Run transcribe.py first.")
        return False

    with open(transcription_file) as f:
        transcription = json.load(f)

    hypothesis = transcription["text"]

    # Load existing ground truth if re-editing
    existing_reference = None
    if gt_file.exists():
        with open(gt_file) as f:
            existing = json.load(f)
            existing_reference = existing.get("reference", "")

    console.rule(f"Annotating: {stem}")

    # Play audio if available
    if wav_file.exists():
        console.print("\n[Playing audio...]")
        play_audio(wav_file)
    else:
        console.print(f"\n[Audio file not found: {wav_file}]")

    # Show transcription
    console.print(f"\nWhisper output:")
    console.print(f"  {hypothesis}")

    if existing_reference:
        console.print(f"\nExisting ground truth:")
        console.print(f"  {existing_reference}")

    # Get user input
    console.print("\nOptions:")
    console.print("  [Enter]     = Whisper output is correct")
    console.print("  [Type text] = Enter the correct transcription")
    console.print("  [r]         = Replay audio")
    console.print("  [s]         = Skip this file")
    console.print("  [q]         = Quit annotation")

    while True:
        user_input = input("\n> ").strip()

        if user_input.lower() == "q":
            return None  # Signal to quit
        elif user_input.lower() == "s":
            print("  Skipped.")
            return False
        elif user_input.lower() == "r":
            if wav_file.exists():
                play_audio(wav_file)
            continue
        elif user_input == "":
            reference = hypothesis
            print("  Marked as correct.")
        else:
            reference = user_input
            print(f"  Ground truth: {reference}")

        # Save ground truth
        GROUND_TRUTH_DIR.mkdir(parents=True, exist_ok=True)
        gt_data = {
            "file": f"{stem}.wav",
            "reference": reference,
            "hypothesis": hypothesis,
        }
        with open(gt_file, "w") as f:
            json.dump(gt_data, f, ensure_ascii=False, indent=2)

        print(f"  Saved to {gt_file.name}")
        return True


def main():
    parser = argparse.ArgumentParser(description="Annotate transcriptions with ground truth")
    parser.add_argument("--file", type=str, help="Annotate a single file (stem name)")
    parser.add_argument("--all", action="store_true", help="Annotate all unannotated files")
    parser.add_argument("--redo", action="store_true", help="Re-annotate existing ground truth")
    args = parser.parse_args()

    if not args.file and not args.all:
        parser.print_help()
        sys.exit(1)

    if args.file:
        stem = Path(args.file).stem
        annotate_file(stem)
        return

    # Find files to annotate
    transcriptions = sorted(TRANSCRIPTIONS_DIR.glob("*.json"))
    if not transcriptions:
        print(f"No transcriptions found in {TRANSCRIPTIONS_DIR}")
        print("Run transcribe.py first.")
        sys.exit(1)

    to_annotate = []
    for t in transcriptions:
        gt = GROUND_TRUTH_DIR / t.name
        if not gt.exists() or args.redo:
            to_annotate.append(t.stem)

    if not to_annotate:
        print("All files already annotated. Use --redo to re-annotate.")
        return

    print(f"\n{len(to_annotate)} file(s) to annotate.\n")

    annotated = 0
    for stem in to_annotate:
        result = annotate_file(stem)
        if result is None:  # quit
            break
        if result:
            annotated += 1

    print(f"\nAnnotated {annotated} file(s).")


if __name__ == "__main__":
    main()
