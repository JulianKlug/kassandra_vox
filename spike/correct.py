#!/usr/bin/env python3
"""Apply correction dictionary to transcriptions with fuzzy matching."""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    from Levenshtein import distance as levenshtein_distance
except ImportError:
    # Fallback: pure Python Levenshtein
    def levenshtein_distance(s1, s2):
        if len(s1) < len(s2):
            return levenshtein_distance(s2, s1)
        if len(s2) == 0:
            return len(s1)
        prev_row = range(len(s2) + 1)
        for i, c1 in enumerate(s1):
            curr_row = [i + 1]
            for j, c2 in enumerate(s2):
                cost = 0 if c1 == c2 else 1
                curr_row.append(min(
                    curr_row[-1] + 1,
                    prev_row[j + 1] + 1,
                    prev_row[j] + cost,
                ))
            prev_row = curr_row
        return prev_row[-1]

from config import TRANSCRIPTIONS_DIR, CORRECTED_DIR, CORRECTIONS_FILE


def load_corrections():
    """Load correction dictionary."""
    if not CORRECTIONS_FILE.exists():
        return []
    with open(CORRECTIONS_FILE) as f:
        return json.load(f)


def has_context(text_words, context_terms, position, window=10):
    """Check if any context term appears within a word window."""
    start = max(0, position - window)
    end = min(len(text_words), position + window)
    window_text = " ".join(text_words[start:end]).lower()
    return any(ctx.lower() in window_text for ctx in context_terms)


def apply_corrections(text, corrections):
    """Apply correction dictionary to text. Returns corrected text and list of applied corrections."""
    applied = []

    for entry in corrections:
        pattern = entry["pattern"]
        correction = entry["correction"]
        max_ed = entry.get("edit_distance", 1)
        context = entry.get("context", [])

        # Try exact match first (case-insensitive)
        pattern_re = re.compile(re.escape(pattern), re.IGNORECASE)
        if pattern_re.search(text):
            new_text = pattern_re.sub(correction, text)
            if new_text != text:
                applied.append({
                    "pattern": pattern,
                    "correction": correction,
                    "method": "exact",
                })
                text = new_text
            continue

        # Fuzzy match: check each word/word-pair against the pattern
        # Re-split from current text so previous corrections are preserved
        words = text.split()
        pattern_words = pattern.lower().split()
        pattern_len = len(pattern_words)

        i = 0
        new_words = list(words)
        fuzzy_applied = False
        while i <= len(new_words) - pattern_len:
            candidate = " ".join(new_words[i:i + pattern_len]).lower()
            # Strip trailing punctuation from candidate for matching
            candidate_clean = candidate.rstrip(".,;:!?")
            ed = levenshtein_distance(candidate_clean, pattern.lower())

            # Apply if within edit distance threshold
            threshold = max_ed
            # Context boost: lower threshold if context words are nearby
            if context and has_context(new_words, context, i):
                threshold = max_ed + 1

            if 0 < ed <= threshold:
                # Preserve trailing punctuation
                trailing = ""
                last_word = new_words[i + pattern_len - 1]
                for ch in reversed(last_word):
                    if ch in ".,;:!?":
                        trailing = ch + trailing
                    else:
                        break

                replacement = correction.split()
                if trailing:
                    replacement[-1] = replacement[-1] + trailing

                new_words[i:i + pattern_len] = replacement
                applied.append({
                    "pattern": pattern,
                    "original": candidate,
                    "correction": correction,
                    "method": f"fuzzy (ed={ed})",
                })
                fuzzy_applied = True
                i += len(replacement)
            else:
                i += 1

        if fuzzy_applied:
            text = " ".join(new_words)

    return text, applied


def correct_file(stem, corrections):
    """Apply corrections to a single transcription file."""
    input_file = TRANSCRIPTIONS_DIR / f"{stem}.json"
    output_file = CORRECTED_DIR / f"{stem}.json"

    if not input_file.exists():
        print(f"  No transcription for {stem}")
        return None

    with open(input_file) as f:
        data = json.load(f)

    original_text = data["text"]
    corrected_text, applied = apply_corrections(original_text, corrections)

    result = {
        "file": data["file"],
        "original_text": original_text,
        "corrected_text": corrected_text,
        "corrections_applied": applied,
    }

    CORRECTED_DIR.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    return result


def main():
    parser = argparse.ArgumentParser(description="Apply corrections to transcriptions")
    parser.add_argument("--file", type=str, help="Correct a single file (stem name)")
    parser.add_argument("--all", action="store_true", help="Correct all transcriptions")
    args = parser.parse_args()

    if not args.file and not args.all:
        parser.print_help()
        sys.exit(1)

    corrections = load_corrections()
    if not corrections:
        print("No corrections in corrections.json. Copying transcriptions as-is.")

    if args.file:
        stem = Path(args.file).stem
        result = correct_file(stem, corrections)
        if result:
            n = len(result["corrections_applied"])
            print(f"  {stem}: {n} correction(s) applied")
        return

    files = sorted(TRANSCRIPTIONS_DIR.glob("*.json"))
    if not files:
        print(f"No transcriptions in {TRANSCRIPTIONS_DIR}")
        sys.exit(1)

    total_corrections = 0
    for f in files:
        result = correct_file(f.stem, corrections)
        if result:
            n = len(result["corrections_applied"])
            total_corrections += n
            status = f"{n} correction(s)" if n > 0 else "no changes"
            print(f"  {f.stem}: {status}")

    print(f"\nDone. {total_corrections} total corrections applied across {len(files)} files.")


if __name__ == "__main__":
    main()
