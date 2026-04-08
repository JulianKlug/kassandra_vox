#!/usr/bin/env python3
"""Extract medical terms from text using dictionary lookup + regex patterns."""

import json
import re
from pathlib import Path

from config import MEDICAL_TERMS_FILE


def load_medical_vocabulary():
    """Load medical terms dictionary."""
    with open(MEDICAL_TERMS_FILE) as f:
        return json.load(f)


def extract_terms(text, vocab=None):
    """Extract medical terms from text. Returns list of {term, position, type}."""
    if vocab is None:
        vocab = load_medical_vocabulary()

    terms = []
    text_lower = text.lower()
    words = text_lower.split()

    # Dictionary lookup for known terms
    for category in ["drugs", "anatomy", "conditions", "clinical", "germs"]:
        for term in vocab.get(category, []):
            term_lower = term.lower()
            idx = text_lower.find(term_lower)
            while idx != -1:
                terms.append({
                    "term": text[idx:idx + len(term)],
                    "normalized": term_lower,
                    "position": idx,
                    "type": category,
                })
                idx = text_lower.find(term_lower, idx + 1)

    # Abbreviation matching (case-sensitive for uppercase abbreviations)
    for abbr in vocab.get("abbreviations", []):
        idx = text.find(abbr)
        while idx != -1:
            terms.append({
                "term": abbr,
                "normalized": abbr,
                "position": idx,
                "type": "abbreviation",
            })
            idx = text.find(abbr, idx + 1)

    # Unit patterns (case-sensitive)
    for unit in vocab.get("units", []):
        pattern = r"\d+\s*" + re.escape(unit)
        for match in re.finditer(pattern, text):
            terms.append({
                "term": match.group(),
                "normalized": match.group().lower(),
                "position": match.start(),
                "type": "unit",
            })

    # Dosage patterns
    for pattern_str in vocab.get("dosage_patterns", []):
        for match in re.finditer(pattern_str, text_lower):
            terms.append({
                "term": text[match.start():match.end()],
                "normalized": match.group(),
                "position": match.start(),
                "type": "dosage",
            })

    # Drug suffix detection (catch unknown drugs by suffix)
    for suffix in vocab.get("drug_suffixes", []):
        suffix_clean = suffix.lstrip("-")
        pattern = r"\b\w+" + re.escape(suffix_clean) + r"\b"
        for match in re.finditer(pattern, text_lower):
            word = match.group()
            # Skip if already matched as a known drug
            if not any(t["normalized"] == word for t in terms):
                terms.append({
                    "term": text[match.start():match.end()],
                    "normalized": word,
                    "position": match.start(),
                    "type": "drug_inferred",
                })

    # Deduplicate by position (keep the most specific match)
    seen_positions = set()
    unique_terms = []
    for t in sorted(terms, key=lambda x: (-len(x["term"]), x["position"])):
        pos_range = range(t["position"], t["position"] + len(t["term"]))
        if not any(p in seen_positions for p in pos_range):
            unique_terms.append(t)
            seen_positions.update(pos_range)

    return sorted(unique_terms, key=lambda x: x["position"])


def extract_term_words(text, vocab=None):
    """Extract just the medical words (lowercased) from text. For WER comparison."""
    terms = extract_terms(text, vocab)
    words = set()
    for t in terms:
        for w in t["term"].lower().split():
            words.add(w)
    return words


if __name__ == "__main__":
    import sys
    text = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else (
        "Patient de 54 ans traite par metformine 500 mg. "
        "HbA1c 7.2%. Tension 138/82 mmHg. Diagnostic: diabete de type 2."
    )
    terms = extract_terms(text)
    print(f"Text: {text}\n")
    print(f"Found {len(terms)} medical terms:")
    for t in terms:
        print(f"  [{t['type']:15}] {t['term']}")
