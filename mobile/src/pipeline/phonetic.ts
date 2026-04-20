/**
 * French phonetic matching for medical term correction.
 *
 * Converts French text to a phonetic hash, then finds the closest
 * medical term by hash + edit distance. Handles STT errors like
 * "NORDLIN" → "noradrénaline" where the sounds are similar but
 * the spelling is very different.
 *
 * Uses a simplified French phonetic algorithm inspired by Soundex-FR
 * and Phonex, adapted for medical vocabulary.
 */

import { MEDICAL_VOCAB } from "./medical-vocab";
import { editDistance } from "./correct";

/**
 * Convert a French word to a phonetic key.
 *
 * Reduces the word to its approximate sound by:
 * 1. Normalizing accents and case
 * 2. Collapsing phonetically equivalent letter groups
 * 3. Removing silent letters
 */
export function frenchPhoneticKey(word: string): string {
  let s = word.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // strip accents

  // Common French phonetic equivalences
  s = s
    // Multi-char sounds first
    .replace(/ph/g, "f")
    .replace(/qu/g, "k")
    .replace(/ch/g, "S")      // ch → sh sound
    .replace(/sch/g, "S")
    .replace(/th/g, "t")
    .replace(/gn/g, "N")      // gn → ñ sound
    .replace(/tion/g, "sion")
    .replace(/eau/g, "o")
    .replace(/aux/g, "o")
    .replace(/eaux/g, "o")
    .replace(/ou/g, "u")
    .replace(/oi/g, "wa")
    .replace(/ai/g, "e")
    .replace(/ei/g, "e")
    .replace(/au/g, "o")
    .replace(/an/g, "A")      // nasal
    .replace(/am/g, "A")
    .replace(/en/g, "A")
    .replace(/em/g, "A")
    .replace(/in/g, "I")      // nasal
    .replace(/im/g, "I")
    .replace(/yn/g, "I")
    .replace(/ym/g, "I")
    .replace(/un/g, "I")      // similar to in
    .replace(/on/g, "O")      // nasal
    .replace(/om/g, "O")

    // Single char equivalences
    .replace(/y/g, "i")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/g(?=[eiy])/g, "j")
    .replace(/x/g, "ks")
    .replace(/w/g, "v")

    // Remove silent endings
    .replace(/[esdt]$/, "")
    .replace(/ent$/, "")

    // Remove doubles
    .replace(/(.)\1+/g, "$1")

    // Remove h (usually silent in French)
    .replace(/h/g, "")

    // Remove remaining silent vowels between consonants (approximate)
    .trim();

  return s;
}

// Pre-built phonetic index of medical vocabulary
interface PhoneticEntry {
  term: string;
  key: string;
}

let phoneticIndex: PhoneticEntry[] | null = null;

function getPhoneticIndex(): PhoneticEntry[] {
  if (!phoneticIndex) {
    // Deduplicate the vocab
    const unique = [...new Set(MEDICAL_VOCAB.map(t => t.toLowerCase()))];
    phoneticIndex = unique.map(term => ({
      term,
      key: frenchPhoneticKey(term),
    }));
  }
  return phoneticIndex;
}

/**
 * Common French words that should NOT be corrected to medical terms.
 * Prevents false positives like "patient" → "pancréatite".
 */
const COMMON_WORDS = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "en", "à",
  "est", "il", "elle", "nous", "vous", "ils", "elles", "on", "ce", "se",
  "ne", "pas", "plus", "par", "pour", "avec", "dans", "sur", "sous",
  "qui", "que", "quoi", "dont", "où", "mais", "ou", "car", "donc",
  "son", "sa", "ses", "leur", "leurs", "mon", "ma", "mes", "ton", "ta",
  "au", "aux", "chez", "sans", "vers", "entre", "sous", "contre",
  "aussi", "très", "bien", "mal", "peu", "trop", "assez",
  "être", "avoir", "faire", "dire", "aller", "voir", "savoir", "pouvoir",
  "patient", "patiente", "patients", "médecin", "docteur",
  "jour", "jours", "heure", "heures", "fois", "cas",
  "bonne", "bon", "bons", "bonnes", "premier", "première",
  "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
  "point", "points", "ligne", "virgule", "tiret",
  "début", "fin", "suite", "nouveau", "nouvelle",
]);

export interface PhoneticMatch {
  original: string;
  match: string;
  phoneticDistance: number;
  editDist: number;
  confidence: number;
}

/**
 * Find the best phonetic match for a word in the medical vocabulary.
 * Returns null if no good match is found.
 */
export function findPhoneticMatch(
  word: string,
  minWordLength: number = 5,
  maxPhoneticDist: number = 3,
  maxEditDistRatio: number = 0.5,
): PhoneticMatch | null {
  const lower = word.toLowerCase().replace(/[.,;:!?]+$/, "");

  // Skip short words, common words, and words already in vocab
  if (lower.length < minWordLength) return null;
  if (COMMON_WORDS.has(lower)) return null;

  const index = getPhoneticIndex();

  // Check if already a known medical term
  if (index.some(e => e.term === lower)) return null;

  const wordKey = frenchPhoneticKey(lower);
  if (!wordKey || wordKey.length < 2) return null;

  let bestMatch: PhoneticMatch | null = null;

  for (const entry of index) {
    // Skip terms much shorter/longer than the input
    if (Math.abs(entry.term.length - lower.length) > 5) continue;

    const phonDist = editDistance(wordKey, entry.key);
    if (phonDist > maxPhoneticDist) continue;

    const edDist = editDistance(lower, entry.term);
    const ratio = edDist / Math.max(lower.length, entry.term.length);
    if (ratio > maxEditDistRatio) continue;

    // Confidence: lower distance = higher confidence
    const confidence = 1 - (phonDist * 0.3 + ratio * 0.7);

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = {
        original: word,
        match: entry.term,
        phoneticDistance: phonDist,
        editDist: edDist,
        confidence,
      };
    }
  }

  // Only return matches above a confidence threshold
  if (bestMatch && bestMatch.confidence >= 0.4) {
    return bestMatch;
  }
  return null;
}

/**
 * Apply phonetic correction to a text string.
 * Replaces unknown words with their closest medical term match.
 */
export function applyPhoneticCorrections(text: string): {
  text: string;
  matches: PhoneticMatch[];
} {
  const words = text.split(/\s+/);
  const matches: PhoneticMatch[] = [];

  for (let i = 0; i < words.length; i++) {
    const match = findPhoneticMatch(words[i]);
    if (match) {
      // Preserve trailing punctuation
      const trailingMatch = words[i].match(/[.,;:!?]+$/);
      const trailing = trailingMatch ? trailingMatch[0] : "";
      words[i] = match.match + trailing;
      matches.push(match);
    }
  }

  return { text: words.join(" "), matches };
}
