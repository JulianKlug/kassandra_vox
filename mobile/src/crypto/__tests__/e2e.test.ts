import nacl from "tweetnacl";
import {
  generateKeyPair,
  encodePubKey,
  decodePubKey,
  encrypt,
  decrypt,
  isKeyExchange,
  computeFingerprint,
} from "../e2e";

describe("E2E encryption", () => {
  const alice = nacl.box.keyPair();
  const bob = nacl.box.keyPair();

  it("generates valid keypairs", () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toHaveLength(32);
    expect(kp.secretKey).toHaveLength(32);
  });

  it("encodes and decodes public keys", () => {
    const encoded = encodePubKey(alice.publicKey);
    expect(typeof encoded).toBe("string");
    expect(isKeyExchange(encoded)).toBe(true);

    const decoded = decodePubKey(encoded);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!)).toEqual(Array.from(alice.publicKey));
  });

  it("encrypts and decrypts a message", () => {
    const plaintext = "Le patient arrive hémodynamiquement instable";
    const ciphertext = encrypt(plaintext, bob.publicKey, alice.secretKey);

    expect(typeof ciphertext).toBe("string");
    expect(isKeyExchange(ciphertext)).toBe(false);

    const decrypted = decrypt(ciphertext, alice.publicKey, bob.secretKey);
    expect(decrypted).toBe(plaintext);
  });

  it("decryption fails with wrong key", () => {
    const plaintext = "texte secret";
    const ciphertext = encrypt(plaintext, bob.publicKey, alice.secretKey);

    const eve = nacl.box.keyPair();
    const result = decrypt(ciphertext, eve.publicKey, bob.secretKey);
    expect(result).toBeNull();
  });

  it("handles empty string", () => {
    const ciphertext = encrypt("", bob.publicKey, alice.secretKey);
    const decrypted = decrypt(ciphertext, alice.publicKey, bob.secretKey);
    expect(decrypted).toBe("");
  });

  it("handles unicode (French medical text)", () => {
    const text = "cathéter, noradrénaline, hémodialyse, à, è, ù, ç, ë, ï, ü";
    const ciphertext = encrypt(text, bob.publicKey, alice.secretKey);
    const decrypted = decrypt(ciphertext, alice.publicKey, bob.secretKey);
    expect(decrypted).toBe(text);
  });

  it("produces different ciphertext each time (random nonce)", () => {
    const plaintext = "même texte";
    const c1 = encrypt(plaintext, bob.publicKey, alice.secretKey);
    const c2 = encrypt(plaintext, bob.publicKey, alice.secretKey);
    expect(c1).not.toBe(c2); // different nonces
  });

  it("supports bidirectional correction flow", () => {
    // Simulate: phone sends transcript, desktop sends correction back
    const phoneKp = generateKeyPair();
    const desktopKp = generateKeyPair();

    // Phone → desktop: transcript
    const transcript = JSON.stringify({ type: "transcript", text: "le patient arrive", ts: 1 });
    const encrypted1 = encrypt(transcript, desktopKp.publicKey, phoneKp.secretKey);
    const decrypted1 = decrypt(encrypted1, phoneKp.publicKey, desktopKp.secretKey);
    expect(JSON.parse(decrypted1!).text).toBe("le patient arrive");

    // Desktop → phone: correction
    const correction = JSON.stringify({ type: "correction", text: "le patient arrive hemodynamiquement instable", ts: 2 });
    const encrypted2 = encrypt(correction, phoneKp.publicKey, desktopKp.secretKey);
    const decrypted2 = decrypt(encrypted2, desktopKp.publicKey, phoneKp.secretKey);
    expect(JSON.parse(decrypted2!).type).toBe("correction");
    expect(JSON.parse(decrypted2!).text).toBe("le patient arrive hemodynamiquement instable");
  });

  it("computes matching fingerprints from both sides", () => {
    const fp1 = computeFingerprint(alice.publicKey, bob.publicKey);
    const fp2 = computeFingerprint(bob.publicKey, alice.publicKey);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^\d{4}$/);
  });

  it("rejects garbage as key exchange", () => {
    expect(decodePubKey("not-base64!!!")).toBeNull();
  });

  it("rejects garbage as encrypted payload", () => {
    expect(decrypt("not-base64!!!", alice.publicKey, bob.secretKey)).toBeNull();
  });
});
