import {
  COMMON_PASSWORD_BASES,
  LEET_SUBSTITUTIONS,
} from "@/modules/access/password-denylist";

/**
 * What counts as an acceptable password.
 *
 * The previous policy was twelve characters against five blocked strings, which
 * accepted `Password12345` and every other padded dictionary word. This module
 * replaces it with the two halves the review asked for: a substantially higher
 * floor with structural rules that see through padding, and — in
 * `password-breach.ts` — a live check against a public breach corpus.
 *
 * Deliberately absent: composition rules. Requiring a digit and a symbol is
 * what produces `Password1!`; NIST has recommended against them since SP
 * 800-63B, and length plus a breach check is what actually works.
 */

export const MIN_PASSWORD_LENGTH = 14;
export const MAX_PASSWORD_LENGTH = 128;
/** Below this, the password is some short unit repeated. */
const MIN_DISTINCT_CHARACTERS = 5;
/** A name or address fragment shorter than this is too generic to act on. */
const MIN_PERSONAL_FRAGMENT = 4;

export type PasswordOwner = {
  email?: string | null;
  displayName?: string | null;
};

function normalize(password: string) {
  return password.normalize("NFKC");
}

/** Code points, so an emoji or an accented letter counts once. */
function characterCount(password: string) {
  return [...password].length;
}

function hasControlCharacters(password: string) {
  return /[\u0000-\u001F\u007F]/.test(password);
}

function applyLeetSubstitutions(value: string) {
  let substituted = "";
  for (const character of value) {
    substituted += LEET_SUBSTITUTIONS.get(character) ?? character;
  }
  return substituted;
}

/**
 * The words a password might be padding around: the padding at either end is
 * stripped first, then letter substitutions are undone, then what is left is
 * reduced to letters.
 *
 * The order matters. Undoing substitutions first turns the `1234!` on the end
 * of `P@ssw0rd1234!` into `ieaii` and buries the word this is meant to expose —
 * which is exactly the case it exists for.
 */
export function passwordCandidates(password: string) {
  const lowered = normalize(password).toLowerCase();
  // Padding is whatever is not a letter at either end — `1234`, `!!!!`, `2026`.
  const unpadded = lowered.replace(/^[^a-z]+/, "").replace(/[^a-z]+$/, "");
  const candidates = new Set([
    applyLeetSubstitutions(unpadded).replace(/[^a-z]/g, ""),
    applyLeetSubstitutions(lowered).replace(/[^a-z]/g, ""),
    lowered.replace(/[^a-z0-9]/g, ""),
  ]);
  for (const candidate of [...candidates]) {
    const unit = repeatingUnit(candidate);
    if (unit.length >= 3) candidates.add(unit);
  }
  candidates.delete("");
  return [...candidates];
}

/** The shortest unit the string is a whole repetition of. `abcabc` -> `abc`. */
export function repeatingUnit(value: string) {
  for (let size = 1; size <= value.length / 2; size += 1) {
    if (value.length % size !== 0) continue;
    const unit = value.slice(0, size);
    if (unit.repeat(value.length / size) === value) return unit;
  }
  return value;
}

/** True when the whole string runs up or down the alphabet or the digits. */
function isSequential(value: string) {
  if (value.length < 4) return false;
  const codes = [...value].map((character) => character.codePointAt(0)!);
  const step = codes[1] - codes[0];
  if (step !== 1 && step !== -1) return false;
  return codes.every((code, index) => index === 0 || code - codes[index - 1] === step);
}

function personalFragments(owner: PasswordOwner) {
  const fragments: string[] = [];
  const localPart = owner.email?.split("@")[0] ?? "";
  const domain = owner.email?.split("@")[1]?.split(".")[0] ?? "";
  for (const source of [localPart, domain, owner.displayName ?? ""]) {
    for (const token of source.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= MIN_PERSONAL_FRAGMENT) fragments.push(token);
    }
  }
  return fragments;
}

/**
 * The offline half of the policy. Returns operator-facing text naming the rule
 * that was broken, or null. Never echoes the password.
 */
export function validatePasswordShape(
  password: string,
  owner: PasswordOwner = {},
): string | null {
  const length = characterCount(password);
  if (length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. A short phrase of ordinary words is easier to remember and harder to guess than a short password with symbols in it.`;
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return `Use no more than ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (hasControlCharacters(password)) {
    return "Remove control characters. Letters, digits, punctuation, and spaces are all allowed.";
  }

  const normalized = normalize(password);
  const distinct = new Set([...normalized.toLowerCase()]).size;
  const unit = repeatingUnit(normalized);
  if (unit !== normalized || distinct < MIN_DISTINCT_CHARACTERS) {
    return "Choose something less repetitive. Repeating a short sequence to reach the length does not make it harder to guess.";
  }
  if (isSequential(normalized)) {
    return "Choose something that is not a straight run of the keyboard or the alphabet.";
  }

  if (passwordCandidates(password).some((candidate) => COMMON_PASSWORD_BASES.has(candidate))) {
    return "Choose a less common password. This one is a well-known word with padding, which is the first thing an attacker tries.";
  }

  const haystack = normalized.toLowerCase();
  for (const fragment of personalFragments(owner)) {
    if (haystack.includes(fragment)) {
      return "Choose something that does not contain your name or email address.";
    }
  }

  return null;
}
