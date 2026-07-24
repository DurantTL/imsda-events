import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getServerEnv } from "@/lib/env";

/**
 * Authenticated encryption for the few values that must be recoverable rather
 * than hashed.
 *
 * A TOTP secret is the first: verifying a code requires the secret itself, so
 * unlike a password or a session token it cannot be stored as a digest. What it
 * can be is useless to anyone holding only a database dump.
 *
 * AES-256-GCM with a random 96-bit nonce per value. The key is derived from
 * `SECRET_ENCRYPTION_KEY` through HKDF with a per-purpose info string, so two
 * kinds of ciphertext are never encrypted under the same key and a value cannot
 * be moved from one column to another.
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const FORMAT = "v1";

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

function derivedKey(purpose: string) {
  const configured = getServerEnv().SECRET_ENCRYPTION_KEY;
  if (!configured) {
    throw new SecretBoxError(
      "SECRET_ENCRYPTION_KEY must be set before encrypted values can be read or written.",
    );
  }
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(configured, "utf8"),
    Buffer.from("imsda-events-secret-box", "utf8"),
    Buffer.from(purpose, "utf8"),
    KEY_BYTES,
  ));
}

/** Returns `v1.<nonce>.<tag>.<ciphertext>`, all base64url. */
export function sealSecret(plaintext: string, purpose: string) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(purpose), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    FORMAT,
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openSecret(sealed: string, purpose: string) {
  const [format, nonce, tag, ciphertext] = sealed.split(".");
  if (format !== FORMAT || !nonce || !tag || !ciphertext) {
    throw new SecretBoxError("The stored value is not in the expected sealed format.");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derivedKey(purpose),
      Buffer.from(nonce, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof SecretBoxError) throw error;
    // A wrong key and a tampered ciphertext are the same event here: the value
    // cannot be trusted, and which of the two it was is not the caller's to know.
    throw new SecretBoxError(
      "The stored value could not be decrypted. The encryption key may have changed.",
    );
  }
}

export function isSecretEncryptionConfigured() {
  return Boolean(getServerEnv().SECRET_ENCRYPTION_KEY);
}
