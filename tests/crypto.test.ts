import assert from "node:assert/strict";
import test from "node:test";
import { decryptBuffer, decryptString, deriveEncryptionKey, encryptBuffer, encryptString } from "../src/crypto.js";

test("AES-256-GCM helpers round-trip buffers and strings", () => {
  const key = "test-only-state-encryption-key-with-enough-entropy";
  const plain = Buffer.from("durable browser state \u0000 binary", "utf8");
  const encrypted = encryptBuffer(plain, key);
  assert.notDeepEqual(encrypted, plain);
  assert.deepEqual(decryptBuffer(encrypted, key), plain);

  const encoded = encryptString("cookie state", key);
  assert.match(encoded, /^enc:v1:/);
  assert.equal(decryptString(encoded, key), "cookie state");
  assert.equal(deriveEncryptionKey(key).length, 32);
});

test("AES-256-GCM rejects tampering and the wrong key", () => {
  const encrypted = encryptBuffer(Buffer.from("sensitive"), "key one");
  const last = encrypted.length - 1;
  encrypted[last] = (encrypted[last] ?? 0) ^ 1;
  assert.throws(() => decryptBuffer(encrypted, "key one"));
  assert.throws(() => decryptBuffer(encryptBuffer(Buffer.from("sensitive"), "key one"), "key two"));
});
