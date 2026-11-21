import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { open, rm, stat } from "node:fs/promises";

const MAGIC = Buffer.from("AGENT1", "ascii");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function deriveEncryptionKey(input: string): Buffer {
  const trimmed = input.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) return decoded;
  } catch {
    // Fall through to a deterministic KDF for passphrase-style configuration.
  }
  return createHash("sha256").update(input, "utf8").digest();
}

export function encryptBuffer(plain: Uint8Array, keyInput: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveEncryptionKey(keyInput), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBuffer(payload: Uint8Array, keyInput: string): Buffer {
  const input = Buffer.from(payload);
  const minimum = MAGIC.length + IV_LENGTH + TAG_LENGTH;
  if (input.length < minimum || !input.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid encrypted state payload");
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_LENGTH;
  const dataStart = tagStart + TAG_LENGTH;
  const decipher = createDecipheriv("aes-256-gcm", deriveEncryptionKey(keyInput), input.subarray(ivStart, tagStart));
  decipher.setAuthTag(input.subarray(tagStart, dataStart));
  return Buffer.concat([decipher.update(input.subarray(dataStart)), decipher.final()]);
}

export function encryptString(value: string, keyInput: string): string {
  return `enc:v1:${encryptBuffer(Buffer.from(value, "utf8"), keyInput).toString("base64url")}`;
}

export function decryptString(value: string, keyInput: string): string {
  if (!value.startsWith("enc:v1:")) throw new Error("Unknown encrypted string format");
  return decryptBuffer(Buffer.from(value.slice(7), "base64url"), keyInput).toString("utf8");
}

export async function encryptFile(source: string, destination: string, keyInput: string): Promise<void> {
  const input = await open(source, "r");
  const output = await open(destination, "w", 0o600);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveEncryptionKey(keyInput), iv);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    await output.write(Buffer.concat([MAGIC, iv]));
    let position = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const encrypted = cipher.update(buffer.subarray(0, bytesRead));
      if (encrypted.length > 0) await output.write(encrypted);
    }
    const final = cipher.final();
    if (final.length > 0) await output.write(final);
    await output.write(cipher.getAuthTag());
  } catch (error) {
    await output.close().catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await input.close();
    await output.close().catch(() => undefined);
  }
}

export async function decryptFile(source: string, destination: string, keyInput: string): Promise<void> {
  const metadata = await stat(source);
  const headerLength = MAGIC.length + IV_LENGTH;
  if (metadata.size < headerLength + TAG_LENGTH) throw new Error("Encrypted file is too short");
  const input = await open(source, "r");
  const output = await open(destination, "w", 0o600);
  try {
    const header = Buffer.allocUnsafe(headerLength);
    await input.read(header, 0, header.length, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid encrypted file header");
    const tag = Buffer.allocUnsafe(TAG_LENGTH);
    await input.read(tag, 0, TAG_LENGTH, metadata.size - TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", deriveEncryptionKey(keyInput), header.subarray(MAGIC.length));
    decipher.setAuthTag(tag);

    const ciphertextLength = metadata.size - headerLength - TAG_LENGTH;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < ciphertextLength) {
      const wanted = Math.min(buffer.length, ciphertextLength - position);
      const { bytesRead } = await input.read(buffer, 0, wanted, headerLength + position);
      if (bytesRead === 0) throw new Error("Unexpected end of encrypted file");
      position += bytesRead;
      const plain = decipher.update(buffer.subarray(0, bytesRead));
      if (plain.length > 0) await output.write(plain);
    }
    const final = decipher.final();
    if (final.length > 0) await output.write(final);
  } catch (error) {
    await output.close().catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await input.close();
    await output.close().catch(() => undefined);
  }
}
