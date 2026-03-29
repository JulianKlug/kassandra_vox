#!/usr/bin/env python3
"""Generate a markdown report from evaluation results."""

import json
import sys
from datetime import datetime
from pathlib import Path

from config import REPORTS_DIR, CORRECTIONS_FILE


def generate_report():
    """Generate markdown report from evaluation.json."""
    eval_file = REPORTS_DIR / "evaluation.json"
    if not eval_file.exists():
        print("No evaluation results found. Run evaluate.py first.")
        sys.exit(1)

    with open(eval_file) as f:
        results = json.load(f)

    # Load corrections count
    corrections_count = 0
    if CORRECTIONS_FILE.exists():
        with open(CORRECTIONS_FILE) as f:
            corrections_count = len(json.load(f))

    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d")

    lines = []
    lines.append(f"# Vox Accuracy Spike Report — {date_str}")
    lines.append("")

    # Summary
    raw = results.get("raw")
    cor = results.get("corrected")

    lines.append("## Summary")
    lines.append("")
    lines.append("| Metric | Raw | Corrected | Delta |")
    lines.append("|--------|-----|-----------|-------|")

    if raw and cor:
        raw_wer = raw["aggregate_wer"]
        cor_wer = cor["aggregate_wer"]
        delta_wer = cor_wer - raw_wer
        lines.append(f"| Overall WER | {raw_wer:.1%} | {cor_wer:.1%} | {delta_wer:+.1%} |")

        if raw["aggregate_medical_accuracy"] is not None:
            raw_med = raw["aggregate_medical_accuracy"]
            cor_med = cor["aggregate_medical_accuracy"]
            delta_med = cor_med - raw_med
            lines.append(f"| Medical Term Accuracy | {raw_med:.1%} | {cor_med:.1%} | {delta_med:+.1%} |")
            lines.append(f"| Medical Terms Correct | {raw['total_medical_correct']}/{raw['total_medical_total']} | {cor['total_medical_correct']}/{cor['total_medical_total']} | |")

        lines.append(f"| Files Evaluated | {raw['file_count']} | {cor['file_count']} | |")
        lines.append(f"| Corrections in Dictionary | | {corrections_count} | |")
    elif raw:
        lines.append(f"| Overall WER | {raw['aggregate_wer']:.1%} | — | — |")
        if raw["aggregate_medical_accuracy"] is not None:
            lines.append(f"| Medical Term Accuracy | {raw['aggregate_medical_accuracy']:.1%} | — | — |")
        lines.append(f"| Files Evaluated | {raw['file_count']} | — | — |")

    lines.append("")

    # Per-file breakdown
    source = cor or raw
    if source:
        lines.append("## Per-File Breakdown")
        lines.append("")
        lines.append("| File | WER | Medical Accuracy | Medical Terms |")
        lines.append("|------|-----|------------------|---------------|")
        for r in source["per_file"]:
            med_str = f"{r['medical_term_accuracy']:.1%}" if r["medical_term_accuracy"] is not None else "N/A"
            lines.append(f"| {r['file']} | {r['overall_wer']:.1%} | {med_str} | {r['medical_terms_correct']}/{r['medical_terms_total']} |")
        lines.append("")

    # Common errors
    if raw and raw.get("common_errors"):
        lines.append("## Most Common Errors (Raw)")
        lines.append("")
        lines.append("These are the most frequent substitution errors whisper makes.")
        lines.append("Each one is a candidate for the correction dictionary.")
        lines.append("")
        lines.append("| Error | Count |")
        lines.append("|-------|-------|")
        for error, count in raw["common_errors"]:
            lines.append(f"| {error} | {count} |")
        lines.append("")

    # Correction effectiveness
    if cor:
        total_corrected = sum(
            len(r.get("corrections_applied", []))
            for r in cor.get("per_file", [])
            if isinstance(r, dict)
        )
        lines.append("## Correction Dictionary Effectiveness")
        lines.append("")
        lines.append(f"- Dictionary entries: {corrections_count}")
        lines.append(f"- Corrections applied: (see corrected/ JSON files for details)")
        if raw and cor:
            wer_improvement = raw["aggregate_wer"] - cor["aggregate_wer"]
            lines.append(f"- WER improvement: {wer_improvement:+.1%}")
        lines.append("")

    # Recommendations
    lines.append("## Recommendations")
    lines.append("")
    if raw:
        if raw["aggregate_wer"] <= 0.05:
            lines.append("- Overall WER is excellent (<5%). The model works well for this content.")
        elif raw["aggregate_wer"] <= 0.15:
            lines.append("- Overall WER is acceptable (5-15%). Correction dictionary can bring this under 5%.")
        else:
            lines.append("- Overall WER is high (>15%). Consider using the --prompt flag or a fine-tuned model.")

        if raw["aggregate_medical_accuracy"] is not None:
            if raw["aggregate_medical_accuracy"] >= 0.95:
                lines.append("- Medical term accuracy is excellent (>=95%). Ready for clinical testing.")
            elif raw["aggregate_medical_accuracy"] >= 0.80:
                lines.append("- Medical term accuracy needs improvement (80-95%). Expand the correction dictionary.")
            else:
                lines.append("- Medical term accuracy is too low (<80%). The model may need fine-tuning for French medical vocabulary.")

    lines.append("- Review the common errors table above and add entries to corrections.json")
    lines.append("- Re-run the pipeline after adding corrections to measure improvement")
    lines.append("")

    # Write report
    report_text = "\n".join(lines)
    report_file = REPORTS_DIR / f"{date_str}.md"
    latest_file = REPORTS_DIR / "latest.md"

    with open(report_file, "w") as f:
        f.write(report_text)
    with open(latest_file, "w") as f:
        f.write(report_text)

    print(f"Report written to {report_file}")
    print(f"Latest report: {latest_file}")

    # Print summary to console
    print("\n" + "=" * 60)
    if raw:
        print(f"  Overall WER (raw):       {raw['aggregate_wer']:.1%}")
    if cor:
        print(f"  Overall WER (corrected): {cor['aggregate_wer']:.1%}")
    if raw and raw["aggregate_medical_accuracy"] is not None:
        print(f"  Medical Accuracy (raw):  {raw['aggregate_medical_accuracy']:.1%}")
    if cor and cor["aggregate_medical_accuracy"] is not None:
        print(f"  Medical Accuracy (cor):  {cor['aggregate_medical_accuracy']:.1%}")
    print("=" * 60)


if __name__ == "__main__":
    generate_report()
