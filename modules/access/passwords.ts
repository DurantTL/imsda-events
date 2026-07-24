import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { checkPasswordAgainstBreachCorpus } from "@/modules/access/password-breach";
import {
  validatePasswordShape,
  type PasswordOwner,
} from "@/modules/access/password-policy";

const KEY_LENGTH = 64;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 192 * 1024 * 1024;

function derivePassword(password: string, salt: Buffer, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * The offline rules, which is all `hashPassword` can enforce. Callers that are
 * setting a password a person chose should use {@link validateChosenPassword},
 * which also consults the breach corpus.
 */
export function validatePassword(password: string, owner: PasswordOwner = {}) {
  return validatePasswordShape(password, owner);
}

/**
 * The full policy: the offline rules, then the breach corpus. Returns
 * operator-facing text naming the rule that was broken, or null.
 */
export async function validateChosenPassword(
  password: string,
  owner: PasswordOwner = {},
): Promise<string | null> {
  const shapeError = validatePasswordShape(password, owner);
  if (shapeError) return shapeError;

  const breach = await checkPasswordAgainstBreachCorpus(password);
  if (breach.breached) {
    return "This password has appeared in a public data breach. Even a strong-looking password is unusable once it is on a public list — choose another.";
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
