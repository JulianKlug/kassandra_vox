/**
 * Word Error Rate (WER) calculator.
 *
 * Ported from spike/evaluate.py. Computes WER using word-level edit distance
 * (Levenshtein alignment). Pure TypeScript, no native dependencies.
 *
 * WER = (substitutions + insertions + deletions) / reference_word_count
 */

export interface WerResult {
  wer: number;                    // 0-1 (0 = perfect, 1 = 100% error)
  referenceWords: number;
  hypothesisWords: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  /** Individual word-level errors */
  errors: WerError[];
}

export interface WerError {
  type: "substitution" | "insertion" | "deletion";
  reference?: string;             // expected word (missing for insertions)
  hypothesis?: string;            // actual word (missing for deletions)
  position: number;               // position in reference
}

/**
 * Normalize text for WER comparison.
 * Lowercases, removes punctuation, collapses whitespace.
 */
export function normalizeForWer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:!?\-\u2013\u2014()\[\]{}"'«»…]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute Word Error Rate between reference and hypothesis.
 */
export function computeWer(reference: string, hypothesis: string): WerResult {
  const refWords = normalizeForWer(reference).split(" ").filter(Boolean);
  const hypWords = normalizeForWer(hypothesis).split(" ").filter(Boolean);

  if (refWords.length === 0) {
    return {
      wer: hypWords.length > 0 ? 1 : 0,
      referenceWords: 0,
      hypothesisWords: hypWords.length,
      substitutions: 0,
      insertions: hypWords.length,
      deletions: 0,
      errors: hypWords.map((w, i) => ({
        type: "insertion" as const,
        hypothesis: w,
        position: i,
      })),
    };
  }

  // Dynamic programming: compute edit distance matrix
  const n = refWords.length;
  const m = hypWords.length;

  // dp[i][j] = min edits to transform ref[0..i-1] to hyp[0..j-1]
  const dp: number[][] = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));

  // Backtrack matrix: 0=match, 1=sub, 2=del, 3=ins
  const bt: number[][] = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));

  for (let i = 0; i <= n; i++) {
    dp[i][0] = i;
    bt[i][0] = 2; // deletion
  }
  for (let j = 0; j <= m; j++) {
    dp[0][j] = j;
    bt[0][j] = 3; // insertion
  }
  bt[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
        bt[i][j] = 0; // match
      } else {
        const sub = dp[i - 1][j - 1] + 1;
        const del = dp[i - 1][j] + 1;
        const ins = dp[i][j - 1] + 1;

        if (sub <= del && sub <= ins) {
          dp[i][j] = sub;
          bt[i][j] = 1;
        } else if (del <= ins) {
          dp[i][j] = del;
          bt[i][j] = 2;
        } else {
          dp[i][j] = ins;
          bt[i][j] = 3;
        }
      }
    }
  }

  // Backtrack to find individual errors
  const errors: WerError[] = [];
  let subs = 0;
  let dels = 0;
  let ins = 0;
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (bt[i][j] === 0) {
      // match
      i--;
      j--;
    } else if (bt[i][j] === 1) {
      // substitution
      errors.push({
        type: "substitution",
        reference: refWords[i - 1],
        hypothesis: hypWords[j - 1],
        position: i - 1,
      });
      subs++;
      i--;
      j--;
    } else if (bt[i][j] === 2) {
      // deletion (word in ref but not in hyp)
      errors.push({
        type: "deletion",
        reference: refWords[i - 1],
        position: i - 1,
      });
      dels++;
      i--;
    } else {
      // insertion (word in hyp but not in ref)
      errors.push({
        type: "insertion",
        hypothesis: hypWords[j - 1],
        position: i,
      });
      ins++;
      j--;
    }
  }

  errors.reverse();

  return {
    wer: (subs + dels + ins) / n,
    referenceWords: n,
    hypothesisWords: m,
    substitutions: subs,
    insertions: ins,
    deletions: dels,
    errors,
  };
}

/**
 * Compute aggregate WER across multiple reference/hypothesis pairs.
 */
export function computeAggregateWer(
  pairs: Array<{ reference: string; hypothesis: string }>
): WerResult {
  let totalRef = 0;
  let totalSub = 0;
  let totalIns = 0;
  let totalDel = 0;
  let totalHyp = 0;
  const allErrors: WerError[] = [];

  for (const pair of pairs) {
    const result = computeWer(pair.reference, pair.hypothesis);
    totalRef += result.referenceWords;
    totalHyp += result.hypothesisWords;
    totalSub += result.substitutions;
    totalIns += result.insertions;
    totalDel += result.deletions;
    allErrors.push(...result.errors);
  }

  return {
    wer: totalRef > 0 ? (totalSub + totalIns + totalDel) / totalRef : 0,
    referenceWords: totalRef,
    hypothesisWords: totalHyp,
    substitutions: totalSub,
    insertions: totalIns,
    deletions: totalDel,
    errors: allErrors,
  };
}

/**
 * Format WER result as a human-readable string.
 */
export function formatWer(result: WerResult): string {
  const pct = (result.wer * 100).toFixed(1);
  return `WER: ${pct}% (${result.substitutions}S + ${result.insertions}I + ${result.deletions}D / ${result.referenceWords} words)`;
}
