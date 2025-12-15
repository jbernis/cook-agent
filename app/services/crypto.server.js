import crypto from "node:crypto";

const ENCRYPTION_KEY_ENV = "APP_SETTINGS_ENCRYPTION_KEY";
const PREFIX = "v1:";

function decodeKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Accept 64 hex chars (32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // Accept base64 (should decode to 32 bytes)
  try {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === 32) return buf;
  } catch {
    // ignore
  }

  return null;
}

function getKeyOrThrow() {
  const raw = process.env[ENCRYPTION_KEY_ENV];
  const key = decodeKey(raw);
  if (!key) {
    throw new Error(
      `Missing/invalid ${ENCRYPTION_KEY_ENV}. Set it to a 32-byte key (base64) or 64 hex chars.`
    );
  }
  return key;
}

/**
 * Encrypt a secret string using AES-256-GCM.
 * Output format: "v1:<base64(iv)>.<base64(tag)>.<base64(ciphertext)>"
 * @param {string} plaintext
 * @returns {string}
 */
export function encryptSecret(plaintext) {
  const text = typeof plaintext === "string" ? plaintext : "";
  const key = getKeyOrThrow();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

/**
 * Decrypt a secret string produced by encryptSecret().
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function decryptSecret(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const raw = value.trim();
  if (!raw.startsWith(PREFIX)) return null;

  const rest = raw.slice(PREFIX.length);
  const parts = rest.split(".");
  if (parts.length !== 3) return null;

  const [ivB64, tagB64, dataB64] = parts;
  const key = getKeyOrThrow();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}

