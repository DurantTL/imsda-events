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
