/**
 * E2E encryption for the Vox relay protocol.
 *
 * Uses tweetnacl's box (X25519 + XSalsa20-Poly1305) for authenticated
 * encryption between phone and desktop. The relay never sees plaintext.
 *
 * Wire format:
 *   0x00 + 32-byte public key      (key exchange, unencrypted)
 *   0x01 + 24-byte nonce + ciphertext (NaCl box)
 */

import nacl from "tweetnacl";
import { uint8ToBase64, base64ToUint8 } from "../utils/base64";

const PREFIX_PUBKEY = 0x00;
const PREFIX_BOX = 0x01;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

/**
 * Encode a public key for the key exchange step.
 * Returns a base64 string suitable for the relay payload field.
 */
export function encodePubKey(publicKey: Uint8Array): string {
  const msg = new Uint8Array(1 + publicKey.length);
  msg[0] = PREFIX_PUBKEY;
  msg.set(publicKey, 1);
  return uint8ToBase64(msg);
}

/**
 * Try to decode a public key from an incoming payload.
 * Returns the 32-byte public key, or null if this isn't a key exchange message.
 */
export function decodePubKey(base64Payload: string): Uint8Array | null {
  const bytes = base64ToUint8(base64Payload);
  if (bytes.length < 33 || bytes[0] !== PREFIX_PUBKEY) return null;
  return bytes.slice(1, 33);
}

/**
 * Encrypt a plaintext string for the peer.
 * Returns base64-encoded blob: 0x01 + nonce + ciphertext.
 */
export function encrypt(
  plaintext: string,
  peerPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.box(messageBytes, nonce, peerPublicKey, mySecretKey);
  if (!ciphertext) throw new Error("Encryption failed");

  const blob = new Uint8Array(1 + nonce.length + ciphertext.length);
  blob[0] = PREFIX_BOX;
  blob.set(nonce, 1);
  blob.set(ciphertext, 1 + nonce.length);
  return uint8ToBase64(blob);
}

/**
 * Decrypt a base64 payload from the peer.
 * Returns the plaintext string, or null if decryption fails.
 */
export function decrypt(
  base64Payload: string,
  peerPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): string | null {
  const blob = base64ToUint8(base64Payload);
  if (blob.length < 1 + nacl.box.nonceLength + 1 || blob[0] !== PREFIX_BOX) return null;

  const nonce = blob.slice(1, 1 + nacl.box.nonceLength);
  const ciphertext = blob.slice(1 + nacl.box.nonceLength);
  const plainBytes = nacl.box.open(ciphertext, nonce, peerPublicKey, mySecretKey);
  if (!plainBytes) return null;

  return new TextDecoder().decode(plainBytes);
}

/**
 * Check if a payload is a key exchange message (vs encrypted data).
 */
export function isKeyExchange(base64Payload: string): boolean {
  const bytes = base64ToUint8(base64Payload);
  return bytes.length > 0 && bytes[0] === PREFIX_PUBKEY;
}

/**
 * Compute a 4-digit verification fingerprint from the shared secret.
 * Both sides display this number so the doctor can visually verify
 * there's no MITM (like Signal's safety number, but simpler).
 */
export function computeFingerprint(
  myPublicKey: Uint8Array,
  peerPublicKey: Uint8Array
): string {
  // Combine both public keys in sorted order (so both sides get the same input)
  const sorted = [myPublicKey, peerPublicKey].sort((a, b) => {
    for (let i = 0; i < 32; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  });
  const combined = new Uint8Array(64);
  combined.set(sorted[0], 0);
  combined.set(sorted[1], 32);

  // Use nacl.hash (SHA-512) and take first 2 bytes as a 4-digit number
  const hash = nacl.hash(combined);
  const num = ((hash[0] << 8) | hash[1]) % 10000;
  return String(num).padStart(4, "0");
}

