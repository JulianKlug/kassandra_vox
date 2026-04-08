/**
 * Medical vocabulary corrector.
 *
 * Ported from spike/correct.py. Applies a correction dictionary to
 * Whisper output using exact and fuzzy (Levenshtein) matching.
 *
 * Pipeline order (from CEO plan + eng review):
 *   medicalCorrect -> dedup -> punctuate -> voiceCommands
 */

import correctionsData from "./corrections.json";

export interface CorrectionEntry {
  pattern: string;
  correction: string;
  context?: string[];
  edit_distance?: number;
}

export interface AppliedCorrection {
  pattern: string;
  correction: string;
  method: "exact" | "fuzzy";
  editDistance?: number;
  original?: string;
}

export interface CorrectionResult {
  text: string;
  applied: AppliedCorrection[];
}

const corrections = correctionsData as CorrectionEntry[];

/**
 * Levenshtein edit distance (iterative, two-row).
 */
export function editDistance(a: string, b: string): number {
  if (a.length < b.length) return editDistance(b, a);
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 0; i < a.length; i++) {
    const curr = new Array(b.length + 1);
    curr[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(
        curr[j] + 1,           // insertion
        prev[j + 1] + 1,       // deletion
        prev[j] + cost          // substitution
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasContext(words: string[], contextTerms: string[], position: number, window = 10): boolean {
  const start = Math.max(0, position - window);
  const end = Math.min(words.length, position + window);
  const windowText = words.slice(start, end).join(" ").toLowerCase();
  return contextTerms.some((ctx) => windowText.includes(ctx.toLowerCase()));
}

export function applyCorrections(
  inputText: string,
  dict: CorrectionEntry[] = corrections
): CorrectionResult {
  const applied: AppliedCorrection[] = [];
  let text = inputText;

  for (const entry of dict) {
    const { pattern, correction } = entry;
    const maxEd = entry.edit_distance ?? 1;
    const ctx = entry.context ?? [];

    // Try exact match first (case-insensitive)
    const exactRe = new RegExp(escapeRegex(pattern), "gi");
    if (exactRe.test(text)) {
      const newText = text.replace(exactRe, correction);
      if (newText !== text) {
        applied.push({ pattern, correction, method: "exact" });
        text = newText;
      }
      continue;
    }

    // Fuzzy match: scan word windows of pattern length
    const words = text.split(/\s+/);
    const patternWords = pattern.toLowerCase().split(/\s+/);
    const patternLen = patternWords.length;

    const newWords = [...words];
    let fuzzyApplied = false;
    let i = 0;
    while (i <= newWords.length - patternLen) {
      const candidate = newWords.slice(i, i + patternLen).join(" ").toLowerCase();
      const candidateClean = candidate.replace(/[.,;:!?]+$/, "");
      const ed = editDistance(candidateClean, pattern.toLowerCase());

      let threshold = maxEd;
      if (ctx.length > 0 && hasContext(newWords, ctx, i)) {
        threshold = maxEd + 1;
      }

      if (ed > 0 && ed <= threshold) {
        // Preserve trailing punctuation from the last matched word
        const lastWord = newWords[i + patternLen - 1];
        const trailingMatch = lastWord.match(/[.,;:!?]+$/);
        const trailing = trailingMatch ? trailingMatch[0] : "";

        const replacement = correction.split(/\s+/);
        if (trailing) {
          replacement[replacement.length - 1] = replacement[replacement.length - 1] + trailing;
        }

        newWords.splice(i, patternLen, ...replacement);
        applied.push({
          pattern,
          correction,
          method: "fuzzy",
          editDistance: ed,
          original: candidate,
        });
        fuzzyApplied = true;
        i += replacement.length;
      } else {
        i++;
      }
    }

    if (fuzzyApplied) {
      text = newWords.join(" ");
    }
  }

  return { text, applied };
}
