/**
 * Hermes-compatible base64 encode/decode.
 *
 * Hermes (React Native's JS engine) doesn't handle binary strings
 * with characters > 127 correctly in btoa(), producing empty or
 * corrupt output. These manual implementations work reliably.
 */

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function uint8ToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  const parts: string[] = [];

  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;

    parts.push(CHARS[b0 >> 2]);
    parts.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)]);
    parts.push(i + 1 < len ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=");
    parts.push(i + 2 < len ? CHARS[b2 & 63] : "=");
  }

  return parts.join("");
}

export function base64ToUint8(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let j = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = CHARS.indexOf(clean[i]);
    const b = CHARS.indexOf(clean[i + 1]);
    const c = i + 2 < clean.length ? CHARS.indexOf(clean[i + 2]) : 0;
    const d = i + 3 < clean.length ? CHARS.indexOf(clean[i + 3]) : 0;
    bytes[j++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) bytes[j++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) bytes[j++] = ((c & 3) << 6) | d;
  }
  return bytes.slice(0, j);
}
