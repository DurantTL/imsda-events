import { sensitiveFieldPattern } from "@/modules/forms/sensitive-fields";
import { isBirthDateField, isFieldVisible, type RegistrationFormDefinition, type RegistrationFormField } from "@/modules/forms/definition";

/**
 * Browser-only drafts for public registration forms (#574).
 *
 * A visitor's in-progress answers live in their own browser's localStorage,
 * keyed by event + form + form version. Nothing is sent to the server before
 * submit. Every storage call is wrapped, so a browser with storage blocked or
 * full simply has no draft; the form is unaffected.
 *
 * WHEN a draft is kept: only after the visitor actually edits the form (never
 * because of prefill alone), and never when the visitor is signed in or the
 * page carries any profile prefill (`draftsAllowed`): a shared computer must
 * never hand one person's profile to the next.
 *
 * WHAT is kept (`isDraftExcludedField`). The rule is deliberately "save less":
 *  1. LONG_TEXT, ADDRESS and CALCULATED fields are never saved.
 *  2. Consent and acknowledgment checkboxes are never saved (any required
 *     checkbox, or a key or label containing acknowledg, consent, agree,
 *     waiver, release or terms).
 *  3. The payment-method field and birth-date fields are never saved.
 *     A conditional follow-up whose controlling question is excluded is
 *     excluded too (transitively), and restored answers whose question is
 *     hidden are dropped.
 *  4. Any field whose key or label (camelCase and underscores split, stems
 *     matched without a trailing word boundary) looks health, insurance,
 *     care, custody or note related is never saved: medic*, health*, insur*,
 *     condition*, accommod*, restrict*, allerg*, dietar*, physician, doctor,
 *     prescri*, meds, EpiPen, inhaler, asthma, seizure, immuniz*, vaccin*,
 *     tetanus, mental, background, guardian, custody, pickup, notes, and
 *     "anything we should know"; plus disability, accessibility, special
 *     needs, diagnosis, and payment or card details.
 *  5. Attendee rows hold other people's details, often minors', so ATTENDEE
 *     answers are saved only from an allowlist: name fields, attendee type,
 *     shirt size, and real session or product choices (SELECT, RADIO,
 *     MULTISELECT, RANKED_CHOICE) that use the attendee-type option list or
 *     carry pricing or availability limits, pass rule 4 and are not age,
 *     gender, sex, grade or minor fields. Plain-TEXT address parts (street,
 *     city, zip, postal, address) are excluded too, except EMAIL fields.
 *  6. The submit idempotency key is never written to storage; it lives only
 *     in the page session, for the network-retry case.
 * Registration-level contact answers (name, email, phone, plain choices) are
 * saved. Anything not in the form definition (the spam trap, promo quotes)
 * is never saved. The form definition has no explicit "sensitive" flag, so
 * the rules above decide; `PUBLIC_DRAFT_STAFF_HELP` states them for staff.
 */

export const PUBLIC_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const PUBLIC_DRAFT_RESTORED_NOTICE = "We restored your answers from earlier.";
export const PUBLIC_DRAFT_VERSION_CHANGED_NOTICE = "The form changed since you started. Please re-enter your answers.";
export const PUBLIC_DRAFT_STAFF_HELP =
  "Visitors' unfinished answers are kept only in their own browser for 14 days, and only after they edit the form. Never kept: long-text, address and calculated fields; consent or acknowledgment checkboxes; payment and birth-date fields; anything that looks medical, health, insurance, dietary, meal, accommodation, guardian, custody, pickup, or notes (and any follow-up question shown because of one); and every attendee answer except name, attendee type, shirt size, and paid or limited session choices. Nothing is kept for signed-in visitors.";

const KEY_PREFIX = "imsda-events:draft:v1";
const FORMAT = 1;

// Stems are matched without a trailing word boundary on purpose.
const excludedFieldPattern = sensitiveFieldPattern([
  "notes?\\b", "anything\\b.*\\bknow", "meal", "food", "payment", "pay\\s*method", "card", "cvv", "cvc",
  "bank", "routing", "password",
]);
// Plain-TEXT address parts; an EMAIL field's "Email address" label is not one.
const addressPartPattern = /\b(?:street|city|zip|postal|address)/i;
const consentPattern = /\b(?:acknowledg|consent|agree|waiver|release|terms)/i;
const demographicPattern = /\b(?:age|gender|sex|grade|minor|d\W?o\W?b)\b/i;
const attendeeNameKeys = new Set(["first_name", "last_name", "middle_name", "preferred_name", "full_name", "name", "attendee_name", "guest_name"]);
const choiceTypes = new Set(["SELECT", "RADIO", "MULTISELECT", "RANKED_CHOICE"]);

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

function fieldText(field: Pick<RegistrationFormField, "key" | "label">) {
  return `${field.key} ${field.label}`
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
}

/** Drafts are off for signed-in visitors and whenever the page carries prefill. */
export function draftsAllowed(input: { signedIn?: boolean; prefill?: Array<Record<string, unknown>> }) {
  if (input.signedIn) return false;
  return !(input.prefill ?? []).some((values) => Object.keys(values).length > 0);
}

/** A save happens only after a real edit, once restore has run, and never after submit. */
export function shouldPersistDraft(state: { enabled: boolean; ready: boolean; dirty: boolean; submitted: boolean }) {
  return state.enabled && state.ready && state.dirty && !state.submitted;
}

type DraftFieldShape = Pick<RegistrationFormField, "key" | "label" | "type">
  & Partial<Pick<RegistrationFormField, "scope" | "required" | "optionSource" | "priceCents" | "choicePricesCents" | "choiceLimits" | "availabilityMode" | "latePricing">>;

const hasPositive = (prices: Record<string, number> | undefined) =>
  prices !== undefined && Object.values(prices).some((cents) => cents > 0);

// Empty pricing objects (the builder's Quick choices preset writes
// `choicePricesCents: {}`) do not make a field a paid or limited choice.
function isSessionOrProductChoice(field: DraftFieldShape) {
  return field.optionSource === "ATTENDEE_TYPES"
    || (field.priceCents ?? 0) > 0
    || hasPositive(field.choicePricesCents)
    || (field.choiceLimits !== undefined && Object.keys(field.choiceLimits).length > 0)
    || (field.availabilityMode !== undefined && field.availabilityMode !== "NONE")
    || (field.latePricing !== undefined
      && ((field.latePricing.priceCents ?? 0) > 0 || hasPositive(field.latePricing.choicePricesCents)));
}

export function isDraftExcludedField(
  field: DraftFieldShape,
  definition: Pick<RegistrationFormDefinition, "payment">,
) {
  if (field.type === "CALCULATED" || field.type === "LONG_TEXT" || field.type === "ADDRESS") return true;
  if (definition.payment?.paymentMethodFieldKey === field.key) return true;
  if (isBirthDateField(field)) return true;
  const text = fieldText(field);
  if (excludedFieldPattern.test(text)) return true;
  if (field.type !== "EMAIL" && addressPartPattern.test(text)) return true;
  if (field.type === "CHECKBOX" && (field.required || consentPattern.test(text))) return true;
  if (field.scope === "ATTENDEE") {
    if (attendeeNameKeys.has(field.key) || field.key === "attendee_type") return false;
    if (/shirt/i.test(field.key)) return false;
    // Only real session or product choices: attendee-type option lists, or
    // choices that carry pricing or availability limits.
    if (choiceTypes.has(field.type) && !demographicPattern.test(text) && isSessionOrProductChoice(field)) return false;
    return true;
  }
  return false;
}

/**
 * Keys of every field that must not be saved: those excluded by
 * `isDraftExcludedField`, plus any field whose "show only when" controller is
 * excluded (followed transitively, so a follow-up to a follow-up is covered;
 * the fixed-point loop terminates on cycles).
 */
export function draftExcludedKeys(definition: RegistrationFormDefinition) {
  const fields = definition.sections.flatMap((section) => section.fields);
  const excluded = new Set(fields.filter((field) => isDraftExcludedField(field, definition)).map((field) => field.key));
  let changed = true;
  while (changed) {
    changed = false;
    for (const field of fields) {
      if (!excluded.has(field.key) && field.conditional && excluded.has(field.conditional.fieldKey)) {
        excluded.add(field.key);
        changed = true;
      }
    }
  }
  return excluded;
}

function draftFields(definition: RegistrationFormDefinition, scope: "REGISTRATION" | "ATTENDEE") {
  const excluded = draftExcludedKeys(definition);
  return new Map(
    definition.sections
      .flatMap((section) => section.fields)
      .filter((field) => field.scope === scope && !excluded.has(field.key))
      .map((field) => [field.key, field] as const),
  );
}

/** Same rule as the form's own pruning: a conditional answer whose question is hidden is dropped. */
function pruneHidden(
  fields: Map<string, RegistrationFormField>,
  responses: DraftResponses,
  shared: DraftResponses,
) {
  const next = { ...responses };
  for (let pass = 0; pass < fields.size; pass += 1) {
    let removed = false;
    for (const field of fields.values()) {
      if (field.conditional && field.key in next && !isFieldVisible(field, { ...shared, ...next })) {
        delete next[field.key];
        removed = true;
      }
    }
    if (!removed) break;
  }
  return next;
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
  const registrationResponses = pruneHidden(registrationFields, pickAllowed(content.responses, registrationFields), {});
  return {
    responses: registrationResponses,
    attendees: attendees.map((attendee) => ({
      clientId: attendee.clientId,
      responses: pruneHidden(attendeeFields, attendee.responses, registrationResponses),
    })),
  };
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

function parseStored(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { format?: unknown; versionId?: unknown; savedAt?: unknown; responses?: unknown; attendees?: unknown } | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isWithinTtl(savedAt: unknown, now: Date) {
  return typeof savedAt === "number"
    && savedAt <= now.getTime() + 60_000
    && now.getTime() - savedAt < PUBLIC_DRAFT_TTL_MS;
}

/**
 * Removes drafts saved under another version of this event's form. True only
 * when a removed draft was a valid, unexpired draft (so the visitor really did
 * lose answers); expired or corrupt leftovers are removed silently.
 */
function removeOtherVersions(storage: DraftStorage, identity: PublicDraftIdentity, now: Date) {
  const prefix = formPrefix(identity);
  const current = publicDraftKey(identity);
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(prefix) && key !== current) stale.push(key);
  }
  let lostValidDraft = false;
  for (const key of stale) {
    const parsed = parseStored(storage.getItem(key));
    if (parsed && parsed.format === FORMAT && isWithinTtl(parsed.savedAt, now)) lostValidDraft = true;
    storage.removeItem(key);
  }
  return lostValidDraft;
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
    const versionChanged = removeOtherVersions(storage, identity, now);
    const key = publicDraftKey(identity);
    const raw = storage.getItem(key);
    if (raw) {
      const parsed = parseStored(raw);
      if (
        parsed
        && parsed.format === FORMAT
        && parsed.versionId === identity.versionId
        && isWithinTtl(parsed.savedAt, now)
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

/**
 * Merges restored attendees over the initial roster: an attendee already in
 * `current` (same client id, e.g. the seeded first row) keeps its initial
 * answers and takes the draft's on top; extra draft attendees are appended in
 * draft order; initial rows the draft doesn't mention are kept.
 */
export function mergeDraftAttendees<T extends { clientId: string; responses: Record<string, unknown> }>(
  current: T[],
  draftAttendees: DraftAttendee[],
): T[] {
  if (draftAttendees.length === 0) return current;
  const byId = new Map(current.map((attendee) => [attendee.clientId, attendee] as const));
  const merged = draftAttendees.map((draft) => {
    const existing = byId.get(draft.clientId);
    return existing
      ? { ...existing, responses: { ...existing.responses, ...draft.responses } }
      : ({ clientId: draft.clientId, responses: draft.responses } as T);
  });
  const mentioned = new Set(draftAttendees.map((draft) => draft.clientId));
  return [...merged, ...current.filter((attendee) => !mentioned.has(attendee.clientId))];
}
