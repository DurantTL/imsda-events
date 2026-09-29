import { isBirthDateField, type RegistrationFormDefinition, type RegistrationFormField } from "@/modules/forms/definition";

/**
 * Browser-only drafts for public registration forms (#574).
 *
 * A visitor's in-progress answers live in their own browser's localStorage,
 * keyed by event + form + form version. Nothing is sent to the server before
 * submit. Every storage call is wrapped, so a browser with storage blocked or
 * full simply has no draft; the form is unaffected.
 *
 * Fields that are NEVER written to a draft (see `isDraftExcludedField`):
 *  - the payment-method field named by `definition.payment`, and any field
 *    whose key or label mentions payment, card, bank, or routing details;
 *  - medical and health answers (medical, medication, health, allergy,
 *    condition, diagnosis, disability, accessibility, special needs, dietary);
 *  - insurance answers;
 *  - dates of birth (`isBirthDateField`, or a key or label mentioning birth or DOB);
 *  - calculated fields (derived, never typed) and anything not in the form
 *    definition (the spam trap, promo quotes, idempotency keys).
 * The form definition has no explicit "sensitive" flag, so the key/label
 * match errs toward excluding: losing a draft answer is cheap, storing a
 * sensitive one is not.
 */

export const PUBLIC_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const PUBLIC_DRAFT_RESTORED_NOTICE = "We restored your answers from earlier.";
export const PUBLIC_DRAFT_VERSION_CHANGED_NOTICE = "The form changed since you started. Please re-enter your answers.";

const KEY_PREFIX = "imsda-events:draft:v1";
const FORMAT = 1;

const excludedFieldPattern =
  /\b(?:medical|medication|health|allerg\w*|dietary|condition|diagnos\w*|disab\w*|accessib\w*|special\s*needs?|insurance|policy\s*(?:number|holder)|birth\w*|dob|payment|pay\s*method|card|cvv|cvc|bank|routing|ssn|social\s*security|password)\b/i;

export type DraftResponses = Record<string, unknown>;
export type DraftAttendee = { clientId: string; responses: DraftResponses };
export type PublicDraftContent = { responses: DraftResponses; attendees: DraftAttendee[] };
export type PublicDraftIdentity = { eventSlug: string; formSlug: string; versionId: string };

/** The subset of `Storage` the drafts use, so tests can supply a fake. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export type PublicDraftLoad =
  | { status: "none" }
  | { status: "restored"; draft: PublicDraftContent }
  | { status: "version-changed" };

export function isDraftExcludedField(
  field: Pick<RegistrationFormField, "key" | "label" | "type">,
  definition: Pick<RegistrationFormDefinition, "payment">,
) {
  if (field.type === "CALCULATED") return true;
  if (definition.payment?.paymentMethodFieldKey === field.key) return true;
  if (isBirthDateField(field)) return true;
  return excludedFieldPattern.test(`${field.key.replaceAll("_", " ")} ${field.label}`);
}

function draftFields(definition: RegistrationFormDefinition, scope: "REGISTRATION" | "ATTENDEE") {
  return new Map(
    definition.sections
      .flatMap((section) => section.fields)
      .filter((field) => field.scope === scope)
      .filter((field) => !isDraftExcludedField(field, definition))
      .map((field) => [field.key, field] as const),
  );
}

function isPlainValue(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  if (value && typeof value === "object") {
    return Object.values(value).every((item) => typeof item === "string");
  }
  return false;
}

function pickAllowed(responses: unknown, allowed: Map<string, unknown>): DraftResponses {
  const picked: DraftResponses = {};
  if (!responses || typeof responses !== "object" || Array.isArray(responses)) return picked;
  for (const [key, value] of Object.entries(responses)) {
    if (allowed.has(key) && isPlainValue(value)) picked[key] = value;
  }
  return picked;
}

/** Keeps only answers to saveable fields; also used on restore so a tampered draft cannot inject keys. */
export function sanitizeDraftContent(
  definition: RegistrationFormDefinition,
  content: { responses?: unknown; attendees?: unknown },
): PublicDraftContent {
  const registrationFields = draftFields(definition, "REGISTRATION");
  const attendeeFields = draftFields(definition, "ATTENDEE");
  const attendees = Array.isArray(content.attendees)
    ? content.attendees.flatMap((attendee: unknown) => {
      if (!attendee || typeof attendee !== "object") return [];
      const { clientId, responses } = attendee as { clientId?: unknown; responses?: unknown };
      if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 80) return [];
      return [{ clientId, responses: pickAllowed(responses, attendeeFields) }];
    })
    : [];
  return { responses: pickAllowed(content.responses, registrationFields), attendees };
}

function hasContent(content: PublicDraftContent) {
  const filled = (responses: DraftResponses) => Object.values(responses).some((value) => (
    typeof value === "boolean"
      ? value
      : Array.isArray(value)
        ? value.length > 0
        : typeof value === "string"
          ? value.trim().length > 0
          : Boolean(value)
  ));
  return filled(content.responses) || content.attendees.some((attendee) => filled(attendee.responses));
}

function formPrefix({ eventSlug, formSlug }: PublicDraftIdentity) {
  return `${KEY_PREFIX}:${encodeURIComponent(eventSlug)}:${encodeURIComponent(formSlug)}:`;
}

export function publicDraftKey(identity: PublicDraftIdentity) {
  return `${formPrefix(identity)}${encodeURIComponent(identity.versionId)}`;
}

export function getBrowserDraftStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function clearPublicDraft(storage: DraftStorage | null, identity: PublicDraftIdentity) {
  if (!storage) return;
  try {
    storage.removeItem(publicDraftKey(identity));
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

/** Removes drafts saved under another version of this event's form; true when one existed. */
function removeOtherVersions(storage: DraftStorage, identity: PublicDraftIdentity) {
  const prefix = formPrefix(identity);
  const current = publicDraftKey(identity);
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(prefix) && key !== current) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
  return stale.length > 0;
}

export function savePublicDraft(
  storage: DraftStorage | null,
  identity: PublicDraftIdentity,
  definition: RegistrationFormDefinition,
  content: PublicDraftContent,
  now: Date = new Date(),
) {
  if (!storage) return;
  try {
    const safe = sanitizeDraftContent(definition, content);
    if (!hasContent(safe)) {
      storage.removeItem(publicDraftKey(identity));
      return;
    }
    storage.setItem(publicDraftKey(identity), JSON.stringify({
      format: FORMAT,
      versionId: identity.versionId,
      savedAt: now.getTime(),
      ...safe,
    }));
  } catch {
    // Storage blocked or full: the form works without a draft.
  }
}

export function loadPublicDraft(
  storage: DraftStorage | null,
  identity: PublicDraftIdentity,
  definition: RegistrationFormDefinition,
  now: Date = new Date(),
): PublicDraftLoad {
  if (!storage) return { status: "none" };
  try {
    const versionChanged = removeOtherVersions(storage, identity);
    const key = publicDraftKey(identity);
    const raw = storage.getItem(key);
    if (raw) {
      let parsed: { format?: unknown; versionId?: unknown; savedAt?: unknown; responses?: unknown; attendees?: unknown } | null = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (
        parsed
        && parsed.format === FORMAT
        && parsed.versionId === identity.versionId
        && typeof parsed.savedAt === "number"
        && parsed.savedAt <= now.getTime() + 60_000
        && now.getTime() - parsed.savedAt < PUBLIC_DRAFT_TTL_MS
      ) {
        const draft = sanitizeDraftContent(definition, parsed);
        if (hasContent(draft)) return { status: "restored", draft };
      }
      storage.removeItem(key);
    }
    return versionChanged ? { status: "version-changed" } : { status: "none" };
  } catch {
    return { status: "none" };
  }
}
