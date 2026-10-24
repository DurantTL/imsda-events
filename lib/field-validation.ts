import { z } from "zod";

/**
 * One shared set of value types and validators (#855): phone, email, number,
 * date, ZIP and URL. The same functions run in the browser, for the inline
 * message, and on the server, which is authoritative. Pure and free of I/O so
 * both sides can import it.
 *
 * Messages describe the problem and never echo the value, so a failed check
 * is safe to log or return even for medical fields.
 */

export const fieldValueTypes = ["phone", "email", "number", "date", "zip", "url"] as const;
export type FieldValueType = (typeof fieldValueTypes)[number];

/** `value` is the normalised form to store. `problem` reads after a label: "Phone <problem>". */
export type FieldCheck = { ok: true; value: string } | { ok: false; problem: string };

export const PHONE_PROBLEM = "must be a 10-digit US number, like (515) 555-0134, or an international number starting with +";
export const EMAIL_PROBLEM = "must be a valid email address";
export const DATE_PROBLEM = "must be a valid date";
export const ZIP_PROBLEM = "must be a 5-digit ZIP code, like 50010, or ZIP+4";
export const URL_PROBLEM = "must be a web address starting with http:// or https://";

export const MAX_PHONE_LENGTH = 40;
export const MAX_EMAIL_LENGTH = 160;
export const MAX_URL_LENGTH = 500;

const ok = (value: string): FieldCheck => ({ ok: true, value });
const bad = (problem: string): FieldCheck => ({ ok: false, problem });

/** "Phone" + "must be ..." -> "Phone must be ...." (a label-first sentence). */
export function problemMessage(label: string, problem: string) {
  return `${label.trim() || "This field"} ${problem}.`;
}

/**
 * A phone number (#855), in one of two forms:
 * - US or Canada: 10 digits (a leading 1 or +1 is allowed), the area code and
 *   exchange not starting with 0 or 1. Stored as "(515) 555-0134".
 * - International: starts with "+" and a country code other than 1, 8 to 15
 *   digits in all (E.164). Stored as "+" and the digits in their groups, single
 *   spaces between, e.g. "+52 55 1234 5678".
 * Either may end in an extension (x, ext, ext. or extension, then 1 to 6
 * digits), stored as " x2". Spaces, dots, dashes (including en and em dashes),
 * slashes and parentheses are accepted as separators.
 */
export function validatePhone(raw: string): FieldCheck {
  let text = raw.trim();
  if (text.length > MAX_PHONE_LENGTH) return bad(PHONE_PROBLEM);
  let extension = "";
  const ext = /^(.*?)[\s,]*(?:x|ext\.?|extension)\s*(\d{1,6})$/i.exec(text);
  if (ext) {
    text = ext[1].trim();
    extension = ` x${ext[2]}`;
  }
  if (!/^\+?[\d\s().\-\u2013\u2014/]+$/.test(text)) return bad(PHONE_PROBLEM);
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+") && !(digits.length === 11 && digits.startsWith("1"))) {
    if (digits.startsWith("1") || digits.startsWith("0") || digits.length < 8 || digits.length > 15) return bad(PHONE_PROBLEM);
    const grouped = text.slice(1).replace(/[^\d]+/g, " ").trim();
    return ok(`+${grouped}${extension}`);
  }
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10 || !/^[2-9]\d\d[2-9]/.test(national)) return bad(PHONE_PROBLEM);
  return ok(`(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}${extension}`);
}

export function validateEmail(raw: string): FieldCheck {
  const text = raw.trim();
  if (text.length > MAX_EMAIL_LENGTH || !z.email().safeParse(text).success) return bad(EMAIL_PROBLEM);
  return ok(text);
}

export type NumberRules = { min?: number; max?: number; integer?: boolean };

/** Plain decimal numbers only: no exponents, hex, thousands separators or text. */
export function validateNumber(raw: string | number, rules: NumberRules = {}): FieldCheck {
  const text = String(raw).trim();
  const numeric = typeof raw === "number" ? raw : /^-?(\d+(\.\d*)?|\.\d+)$/.test(text) ? Number(text) : Number.NaN;
  const kind = rules.integer ? "whole number" : "number";
  const range = rules.min !== undefined && rules.max !== undefined
    ? ` from ${rules.min} to ${rules.max}`
    : rules.min !== undefined ? ` of ${rules.min} or more` : rules.max !== undefined ? ` of ${rules.max} or less` : "";
  const problem = `must be a ${kind}${range}`;
  if (!Number.isFinite(numeric) || (rules.integer && !Number.isInteger(numeric))) return bad(problem);
  if ((rules.min !== undefined && numeric < rules.min) || (rules.max !== undefined && numeric > rules.max)) return bad(problem);
  return ok(text);
}

/** A real calendar date in the stored YYYY-MM-DD form. */
export function validateDate(raw: string): FieldCheck {
  const text = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return bad(DATE_PROBLEM);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) return bad(DATE_PROBLEM);
  return ok(text);
}

export function validateZip(raw: string): FieldCheck {
  const text = raw.trim();
  return /^\d{5}(-\d{4})?$/.test(text) ? ok(text) : bad(ZIP_PROBLEM);
}

export function validateUrl(raw: string): FieldCheck {
  const text = raw.trim();
  if (text.length > MAX_URL_LENGTH) return bad(URL_PROBLEM);
  try {
    const url = new URL(text);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname.includes(".")) return bad(URL_PROBLEM);
    return ok(text);
  } catch {
    return bad(URL_PROBLEM);
  }
}

/** Checks one value by type. A blank value is the caller's "required" rule, so it passes here. */
export function validateByType(type: FieldValueType, raw: string, rules: NumberRules = {}): FieldCheck {
  if (raw.trim() === "") return ok("");
  switch (type) {
    case "phone": return validatePhone(raw);
    case "email": return validateEmail(raw);
    case "number": return validateNumber(raw, rules);
    case "date": return validateDate(raw);
    case "zip": return validateZip(raw);
    case "url": return validateUrl(raw);
  }
}

/**
 * Existing data (#855): an answer stored before the check existed stays as it
 * is. Only a value the person changed has to pass, so saving a record never
 * fails on a field they did not touch.
 */
export function isUnchangedFromStored(submitted: unknown, stored: unknown) {
  if (stored === undefined || stored === null || stored === "") return false;
  return typeof submitted === typeof stored && String(submitted).trim() === String(stored).trim();
}

/** The shared phone message for a fixed phone field (#871), worded for a field with its own label. */
export const PHONE_FIELD_MESSAGE = "Enter a 10-digit US number, like (515) 555-0134, or an international number starting with +.";
export const EMAIL_FIELD_MESSAGE = "Enter a valid email address.";

/** A phone with its formatting taken away, for comparing an old unusable value with its re-typed self. */
function phoneSkeleton(value: string) {
  return value.trim().toLowerCase().replace(/[\s().\-–—/]+/g, "");
}

/**
 * Whether a submitted phone is the stored one (#871), decided by the server from the persisted value and never by a
 * client flag. Equal after the shared normalisation counts, so "515.555.0134" is the same number as "(515) 555-0134".
 * An old value that does not pass is also unchanged when only its spacing, dashes, dots or brackets differ, so
 * re-formatting it is not a change. A blank stored value is never "unchanged".
 */
export function isUnchangedPhone(submitted: unknown, stored: unknown): boolean {
  if (typeof submitted !== "string" || typeof stored !== "string") return false;
  const was = stored.trim();
  const now = submitted.trim();
  if (was === "" || now === "") return false;
  if (was === now) return true;
  const before = validatePhone(was);
  const after = validatePhone(now);
  if (before.ok && after.ok) return before.value === after.value;
  if (before.ok !== after.ok) return false;
  return phoneSkeleton(was) === phoneSkeleton(now);
}

/**
 * The phone to store for a submitted one, and the check that goes with it (#871). Blank is allowed (a "required"
 * rule is the caller's) and stores as "". A changed phone has to pass and is stored normalised. A phone that is the
 * stored one (see `isUnchangedPhone`) is kept exactly as stored, valid or not, so saving a record never fails on a number
 * nobody touched. `stored` must come from the database, never from the request.
 */
export function resolvePhoneChange(submitted: string, stored: string | null | undefined): { ok: true; value: string } | { ok: false; message: string } {
  const text = submitted.trim();
  if (text === "") return { ok: true, value: "" };
  if (isUnchangedPhone(text, stored)) {
    // Kept exactly as stored, valid or not, so an untouched number is never rewritten and never recorded as a change.
    return { ok: true, value: (stored ?? "").trim() };
  }
  const check = validatePhone(text);
  return check.ok ? { ok: true, value: check.value } : { ok: false, message: PHONE_FIELD_MESSAGE };
}

/** `resolvePhoneChange` for server code: the value to store, or a ZodError at `path` that never carries the number. */
export function phoneToStore(path: Array<string | number>, submitted: string, stored: string | null | undefined): string {
  const result = resolvePhoneChange(submitted, stored);
  if (!result.ok) throw new z.ZodError([{ code: "custom", path, message: result.message }]);
  return result.value;
}

/** Whether a submitted email is the stored one (#871): the same address, ignoring case and surrounding spaces. Decided from the stored value. */
export function isUnchangedEmail(submitted: unknown, stored: unknown): boolean {
  if (typeof submitted !== "string" || typeof stored !== "string") return false;
  const was = stored.trim().toLowerCase();
  return was !== "" && was === submitted.trim().toLowerCase();
}

/**
 * The email to store for a submitted one (#871), for a field that keeps the address as typed. Blank stores as "".
 * A changed email has to pass the shared check. The stored one, even an old one over the shared length cap, may stay,
 * exactly as stored. The ZodError never carries the address.
 */
export function emailToStore(path: Array<string | number>, submitted: string, stored: string | null | undefined): string {
  const text = submitted.trim();
  if (text === "") return "";
  if (isUnchangedEmail(text, stored)) return (stored ?? "").trim();
  const check = validateEmail(text);
  if (!check.ok) throw new z.ZodError([{ code: "custom", path, message: EMAIL_FIELD_MESSAGE }]);
  return check.value;
}

/** The browser message for a phone field (#871): a changed bad phone blocks once `shown`; an old one left alone only warns. */
export function inlinePhoneProblem(
  label: string,
  value: string,
  stored: string | null | undefined,
  shown: boolean,
): { message: string; blocking: boolean } {
  if (value.trim() === "") return { message: "", blocking: false };
  const check = validatePhone(value);
  if (check.ok) return { message: "", blocking: false };
  const text = problemMessage(label, check.problem);
  if (isUnchangedPhone(value, stored)) return { message: `${text} This saved number needs correcting.`, blocking: false };
  return { message: shown ? text : "", blocking: true };
}

/** A new phone (nothing stored to compare with): blank passes, anything else must be valid. Stored normalised. */
export const newPhoneSchema = z.string().trim().max(MAX_PHONE_LENGTH, PHONE_FIELD_MESSAGE).transform((value, context) => {
  const check = validateByType("phone", value);
  if (!check.ok) {
    context.addIssue({ code: "custom", message: PHONE_FIELD_MESSAGE });
    return z.NEVER;
  }
  return check.value;
});

/** An email through the shared check, lower-cased. Blank passes; a caller that requires one says so itself. */
export const emailAddressSchema = z.string().trim().max(MAX_EMAIL_LENGTH, `Email must be ${MAX_EMAIL_LENGTH} characters or fewer.`).transform((value, context) => {
  const check = validateByType("email", value);
  if (!check.ok) {
    context.addIssue({ code: "custom", message: EMAIL_FIELD_MESSAGE });
    return z.NEVER;
  }
  return check.value.toLowerCase();
});

/** The value type a form field type is checked as, or null for text and choice fields. */
export function valueTypeForFieldType(fieldType: string): FieldValueType | null {
  switch (fieldType) {
    case "EMAIL": return "email";
    case "PHONE": return "phone";
    case "DATE": return "date";
    case "NUMBER": return "number";
    default: return null;
  }
}

/**
 * The inline browser message for one typed value (#855). A changed value that
 * fails is `blocking` and its message shows once `shown` (after blur or a save
 * attempt). An old stored value left alone is never blocking, but is always
 * flagged "needs correcting".
 */
export function inlineFieldProblem(
  label: string,
  type: FieldValueType,
  value: unknown,
  stored: unknown,
  shown: boolean,
  rules: NumberRules = {},
): { message: string; blocking: boolean } {
  if (value === undefined || value === null || value === "") return { message: "", blocking: false };
  const check = validateByType(type, String(value), rules);
  if (check.ok) return { message: "", blocking: false };
  const text = problemMessage(label, check.problem);
  if (isUnchangedFromStored(value, stored)) return { message: `${text} This saved answer needs correcting.`, blocking: false };
  return { message: shown ? text : "", blocking: true };
}

/** A valid phone in its stored form; anything else comes back as it was, for the validator to judge. */
export function normalizePhoneAnswer<T>(value: T): T | string {
  if (typeof value !== "string") return value;
  const check = validatePhone(value);
  return check.ok ? check.value : value;
}

/** Input attributes for a value type, so phones get a phone keypad and autofill, and so on. */
export function inputAttributesFor(type: FieldValueType, options: { integer?: boolean } = {}) {
  switch (type) {
    case "phone": return { type: "tel", inputMode: "tel", autoComplete: "tel" } as const;
    case "email": return { type: "email", inputMode: "email", autoComplete: "email" } as const;
    case "number": return { type: "number", inputMode: options.integer === false ? "decimal" : "numeric", autoComplete: undefined } as const;
    case "date": return { type: "date", inputMode: undefined, autoComplete: undefined } as const;
    case "zip": return { type: "text", inputMode: "numeric", autoComplete: "postal-code" } as const;
    case "url": return { type: "url", inputMode: "url", autoComplete: "url" } as const;
  }
}

type ContactLike = { firstName?: unknown; lastName?: unknown; phone?: unknown };

const contactName = (contact: ContactLike) =>
  `${String(contact.firstName ?? "").trim()} ${String(contact.lastName ?? "").trim()}`.toLowerCase();

/**
 * The stored phone an emergency contact's phone is compared against (#855): the
 * contact at the same position, or the one with the same first and last name
 * (trimmed, any case), so removing another contact does not shift a stored
 * phone onto the wrong one. Undefined when neither has the same phone, so a
 * stored bad phone never excuses the same text typed for a different contact.
 */
export function storedContactPhone(stored: readonly ContactLike[], index: number, contact: ContactLike): string | undefined {
  const phone = String(contact.phone ?? "").trim();
  const same = (candidate: ContactLike | undefined) => candidate !== undefined && typeof candidate.phone === "string" && candidate.phone.trim() === phone;
  if (same(stored[index])) return phone;
  const name = contactName(contact);
  if (name.trim() !== "" && stored.some((candidate) => contactName(candidate) === name && same(candidate))) return phone;
  return undefined;
}
