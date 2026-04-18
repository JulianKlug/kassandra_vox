/**
 * Room code generation for the phone side.
 * Must match the validation in relay/src/words.ts.
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
  const num = String(Math.floor(Math.random() * 90) + 10);
  return `${w1}-${w2}-${num}`.toUpperCase();
}
