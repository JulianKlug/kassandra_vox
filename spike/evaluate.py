#!/usr/bin/env python3
"""Calculate WER (overall + medical-term-specific) for transcriptions."""

import argparse
import json
import sys
from pathlib import Path

from jiwer import wer, process_words

from config import GROUND_TRUTH_DIR, TRANSCRIPTIONS_DIR, CORRECTED_DIR
from extract_terms import extract_term_words, load_medical_vocabulary


def compute_medical_term_wer(reference, hypothesis, vocab):
    """Compute WER specifically on medical terms.

    Extracts medical terms from the reference, finds the corresponding
    words in the hypothesis, and computes accuracy on those terms only.
    """
    ref_terms = extract_term_words(reference, vocab)
    if not ref_terms:
        return None, 0, 0, 0

    ref_words = reference.lower().split()
    hyp_words = hypothesis.lower().split()

    # Use jiwer alignment to map reference words to hypothesis words
    result = process_words(reference.lower(), hypothesis.lower())

    # Count medical term hits and misses
    correct = 0
    incorrect = 0
    missing = 0

    for term_word in ref_terms:
        if term_word in [w.lower() for w in hyp_words]:
            correct += 1
        else:
            incorrect += 1

    total = correct + incorrect
    if total == 0:
        return None, 0, 0, 0

    term_accuracy = correct / total
    return term_accuracy, correct, incorrect, total


def evaluate_pair(reference, hypothesis, vocab):
    """Evaluate a single reference/hypothesis pair."""
    overall_wer = wer(reference.lower(), hypothesis.lower())

    term_accuracy, correct, incorrect, total = compute_medical_term_wer(
        reference, hypothesis, vocab
    )

    # Find specific errors
    result = process_words(reference.lower(), hypothesis.lower())
    substitutions = []
    if hasattr(result, 'alignments') and result.alignments:
        for alignment in result.alignments:
            for chunk in alignment:
                if chunk.type == "substitute":
                    ref_chunk = " ".join(reference.lower().split()[chunk.ref_start_idx:chunk.ref_end_idx])
                    hyp_chunk = " ".join(hypothesis.lower().split()[chunk.hyp_start_idx:chunk.hyp_end_idx])
                    substitutions.append({"reference": ref_chunk, "hypothesis": hyp_chunk})

    return {
        "overall_wer": overall_wer,
        "medical_term_accuracy": term_accuracy,
        "medical_terms_correct": correct,
        "medical_terms_incorrect": incorrect,
        "medical_terms_total": total,
        "substitutions": substitutions,
    }


def evaluate_directory(source_dir, label):
    """Evaluate all files in a directory against ground truth."""
    vocab = load_medical_vocabulary()
    gt_files = sorted(GROUND_TRUTH_DIR.glob("*.json"))

    if not gt_files:
        print(f"No ground truth files in {GROUND_TRUTH_DIR}")
        print("Run annotate.py first.")
        sys.exit(1)

    results = []
    all_refs = []
    all_hyps = []
    all_substitutions = []

    for gt_file in gt_files:
        with open(gt_file) as f:
            gt_data = json.load(f)

        reference = gt_data["reference"]

        # Get hypothesis from the source directory
        source_file = source_dir / gt_file.name
        if not source_file.exists():
            print(f"  SKIP {gt_file.stem} (no {label} file)")
            continue

        with open(source_file) as f:
            source_data = json.load(f)

        if "corrected_text" in source_data:
            hypothesis = source_data["corrected_text"]
        else:
            hypothesis = source_data["text"]

        eval_result = evaluate_pair(reference, hypothesis, vocab)
        eval_result["file"] = gt_file.stem

        results.append(eval_result)
        all_refs.append(reference.lower())
        all_hyps.append(hypothesis.lower())
        all_substitutions.extend(eval_result["substitutions"])

        med_acc = eval_result["medical_term_accuracy"]
        med_str = f"{med_acc:.1%}" if med_acc is not None else "N/A"
        print(f"  {gt_file.stem}: WER={eval_result['overall_wer']:.1%}, "
              f"Medical={med_str} ({eval_result['medical_terms_correct']}/{eval_result['medical_terms_total']})")

    if not results:
        return None

    # Aggregate
    agg_wer = wer(all_refs, all_hyps) if all_refs else 0
    total_med_correct = sum(r["medical_terms_correct"] for r in results)
    total_med_total = sum(r["medical_terms_total"] for r in results)
    agg_med_accuracy = total_med_correct / total_med_total if total_med_total > 0 else None

    # Count common substitutions
    sub_counts = {}
    for s in all_substitutions:
        key = f"{s['reference']} -> {s['hypothesis']}"
        sub_counts[key] = sub_counts.get(key, 0) + 1
    common_errors = sorted(sub_counts.items(), key=lambda x: -x[1])[:15]

    return {
        "label": label,
        "aggregate_wer": agg_wer,
        "aggregate_medical_accuracy": agg_med_accuracy,
        "total_medical_correct": total_med_correct,
        "total_medical_total": total_med_total,
        "per_file": results,
        "common_errors": common_errors,
        "file_count": len(results),
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate transcription accuracy")
    parser.add_argument("--raw", action="store_true", help="Evaluate raw transcriptions")
    parser.add_argument("--corrected", action="store_true", help="Evaluate corrected transcriptions")
    parser.add_argument("--both", action="store_true", help="Evaluate both and compare")
    args = parser.parse_args()

    if not any([args.raw, args.corrected, args.both]):
        args.both = True

    results = {}

    if args.raw or args.both:
        print("\n=== Raw Transcription Accuracy ===")
        results["raw"] = evaluate_directory(TRANSCRIPTIONS_DIR, "raw")

    if args.corrected or args.both:
        print("\n=== Corrected Transcription Accuracy ===")
        results["corrected"] = evaluate_directory(CORRECTED_DIR, "corrected")

    if args.both and results.get("raw") and results.get("corrected"):
        raw = results["raw"]
        cor = results["corrected"]
        print("\n=== Comparison ===")
        print(f"  Overall WER:     {raw['aggregate_wer']:.1%} -> {cor['aggregate_wer']:.1%} "
              f"({'improved' if cor['aggregate_wer'] < raw['aggregate_wer'] else 'no change'})")
        if raw["aggregate_medical_accuracy"] is not None:
            print(f"  Medical Accuracy: {raw['aggregate_medical_accuracy']:.1%} -> "
                  f"{cor['aggregate_medical_accuracy']:.1%}")

    # Save results as JSON
    from config import REPORTS_DIR
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    output = REPORTS_DIR / "evaluation.json"
    with open(output, "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2, default=str)
    print(f"\nResults saved to {output}")


if __name__ == "__main__":
    main()
