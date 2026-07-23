import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 192 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

const blockedPasswords = new Set([
  "123456789012",
  "password1234",
  "password123!",
  "qwertyuiop12",
  "letmein123456",
]);

function derivePassword(password: string, salt: Buffer, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function validatePassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Use no more than ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (blockedPasswords.has(password.toLowerCase())) {
    return "Choose a less common password.";
  }
  return null;
}

export async function hashPassword(password: string) {
  const validationError = validatePassword(password);
  if (validationError) throw new Error(validationError);

  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, nValue, rValue, pValue, saltValue, hashValue] = storedHash.split("$");
  const n = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);

  if (algorithm !== "scrypt" || !saltValue || !hashValue || !Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = await derivePassword(password, Buffer.from(saltValue, "base64url"), n, r, p);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function spendPasswordCheck(password: string) {
  await derivePassword(password, Buffer.from("imsda-auth-dummy", "utf8"));
}
