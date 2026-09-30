import type { RegistrationFormDefinition, RegistrationFormField } from "@/modules/forms/definition";

/**
 * Pre-filling a club registration's contact fields from the signed-in
 * director's own account (#618). One small table maps a field's key or type
 * to a source, so any club event's form benefits without per-event code.
 *
 * Only the director's name, email and mobile phone are used. Birth dates are
 * never pre-filled: club registration refuses forms that ask for one and
 * takes age from the roster (ADR 0005 Addendum A, decision 1).
 */
export type DirectorContact = {
  firstName: string;
  lastName: string;
  email: string;
  /** The account profile's phone number. */
  mobile: string;
};

type Source = "fullName" | "firstName" | "lastName" | "email" | "mobile";

/** Field keys that name the director's own details. */
const KEY_SOURCES: Record<string, Source> = {
  director_name: "fullName",
  club_director: "fullName",
  director: "fullName",
  contact_name: "fullName",
  primary_contact_name: "fullName",
  primary_contact: "fullName",
  director_first_name: "firstName",
  primary_contact_first_name: "firstName",
  director_last_name: "lastName",
  primary_contact_last_name: "lastName",
  email: "email",
  contact_email: "email",
  director_email: "email",
  phone: "mobile",
  phone_number: "mobile",
  mobile: "mobile",
  mobile_phone: "mobile",
  cell_phone: "mobile",
  contact_phone: "mobile",
  director_phone: "mobile",
  director_mobile: "mobile",
};

/** A contact field about someone other than the director is left alone. */
const SOMEONE_ELSE = /emergency|treasurer|pastor|secretary|chaplain|counselor|church|alternate|backup|second|deputy|guardian|parent|billing|sponsor/i;

function registrationFields(definition: RegistrationFormDefinition) {
  return definition.sections.flatMap((section) => section.fields).filter((field) => field.scope === "REGISTRATION");
}

function describes(field: RegistrationFormField) {
  return `${field.key.replaceAll("_", " ")} ${field.label}`;
}

function sourceFor(field: RegistrationFormField): Source | null {
  const byKey = KEY_SOURCES[field.key];
  if (byKey && (field.type === "TEXT" || field.type === "EMAIL" || field.type === "PHONE")) return byKey;
  return null;
}

function valueFor(source: Source, contact: DirectorContact) {
  switch (source) {
    case "fullName": return `${contact.firstName} ${contact.lastName}`.trim();
    case "firstName": return contact.firstName;
    case "lastName": return contact.lastName;
    case "email": return contact.email;
    case "mobile": return contact.mobile;
  }
}

/**
 * What to start each registration-scope contact field with. A field is
 * matched by its key, or else by its type: an EMAIL or PHONE field with no
 * other person named in its key or label. When a form has several fields of
 * one type and none matched by key, only the first is filled.
 */
export function directorContactPrefill(definition: RegistrationFormDefinition, contact: DirectorContact): Record<string, string> {
  const prefill: Record<string, string> = {};
  const fields = registrationFields(definition).filter((field) => !field.optionSource);
  const put = (field: RegistrationFormField, source: Source) => {
    const value = valueFor(source, contact);
    if (value && !SOMEONE_ELSE.test(describes(field))) prefill[field.key] = value;
  };
  const byType: Array<[RegistrationFormField["type"], Source]> = [["EMAIL", "email"], ["PHONE", "mobile"]];
  for (const field of fields) {
    const source = sourceFor(field);
    if (source) put(field, source);
  }
  for (const [type, source] of byType) {
    const candidates = fields.filter((field) => field.type === type && !SOMEONE_ELSE.test(describes(field)));
    if (candidates.length === 0 || candidates.some((field) => sourceFor(field) === source)) continue;
    put(candidates[0]!, source);
  }
  return prefill;
}

/**
 * Lays a prefill under answers a person already has: a value they typed (or a
 * saved draft holds) is never replaced, only blank or missing answers fill in.
 */
export function fillBlankAnswers<T extends Record<string, unknown>>(typed: T | undefined | null, prefill: Record<string, string>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(typed ?? {}) };
  for (const [key, value] of Object.entries(prefill)) {
    const current = merged[key];
    if (current === undefined || current === null || (typeof current === "string" && current.trim() === "")) merged[key] = value;
  }
  return merged;
}
