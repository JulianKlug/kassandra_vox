/**
 * French word list for room code generation.
 * Common nouns/adjectives — no medical terms to avoid confusion.
 */

const WORDS = [
  "bleu", "rouge", "vert", "blanc", "noir", "gris", "rose", "jaune",
  "tigre", "loup", "aigle", "ours", "cerf", "chat", "chien", "lion",
  "lune", "soleil", "etoile", "nuage", "pluie", "neige", "vent", "lac",
  "arbre", "fleur", "herbe", "pierre", "sable", "vague", "mont", "pont",
  "brave", "calme", "forte", "grand", "libre", "noble", "sage", "vif",
  "table", "livre", "lampe", "cloche", "plume", "roue", "voile", "tour",
  "nord", "sud", "est", "ouest", "haut", "clair", "doux", "frais",
  "bois", "fer", "or", "sel",
];

export function generateRoomCode(): string {
  const w1 = WORDS[Math.floor(Math.random() * WORDS.length)];
  let w2 = w1;
  while (w2 === w1) {
    w2 = WORDS[Math.floor(Math.random() * WORDS.length)];
  }
  const num = String(Math.floor(Math.random() * 90) + 10); // 10-99
  return `${w1}-${w2}-${num}`.toUpperCase();
}

const ROOM_CODE_RE = /^[A-Z]+-[A-Z]+-\d{2}$/;

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_RE.test(code);
}
