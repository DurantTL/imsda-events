/**
 * Registration form notifications (#1081): the rules, as plain data. Pure, with no server-only import and no database,
 * so the settings panel, the routes, the queueing code and the tests all read one set of rules.
 *
 * A notification is a name, 1 to 10 typed addresses, an optional single condition (field / is / value, the same shape
 * as a field's own condition), and the sections of the registration PDF it includes (none chosen = all).
 */
import { z } from "zod";
import { conditionMatches, type RegistrationFormDefinition } from "@/modules/forms/definition";
import { excludedFieldKeys } from "@/modules/registration-pdf/model";
import { parseAlertRecipients } from "@/modules/club-forms/alert-recipients";
import {
  CLUB_CONDITION_KEY,
  FORM_NOTIFICATIONS_MAX_PER_FORM,
  LOCATION_CONDITION_KEY,
  notificationConditionOperators,
} from "@/modules/registration-form-notifications/constants";

export { CLUB_CONDITION_KEY, FORM_NOTIFICATIONS_MAX_PER_FORM, LOCATION_CONDITION_KEY, notificationConditionOperators };

export type NotificationCondition = {
  fieldKey: string;
  operator: (typeof notificationConditionOperators)[number];
  value: string;
};

export type FormNotificationConfig = {
  id: string;
  name: string;
  recipients: string[];
  condition: NotificationCondition | null;
  /** Empty means every section. */
  sectionIds: string[];
};

export const notificationInputSchema = z.object({
  id: z.string().trim().min(1).max(60).optional(),
  name: z.string().trim().min(2, "Give every notification a name.").max(80, "A notification name is at most 80 characters."),
  recipients: z.array(z.string().max(200)).max(50),
  condition: z.object({
    fieldKey: z.string().trim().min(2).max(60),
    operator: z.enum(notificationConditionOperators),
    value: z.string().trim().min(1, "Choose the value a condition looks for.").max(120),
  }).nullable().default(null),
  sectionIds: z.array(z.string().trim().min(3).max(80)).max(12).default([]),
});

export const notificationsPutSchema = z.object({
  notifications: z.array(notificationInputSchema).max(FORM_NOTIFICATIONS_MAX_PER_FORM, `A form has at most ${FORM_NOTIFICATIONS_MAX_PER_FORM} notifications.`),
});

export type NotificationInput = z.infer<typeof notificationInputSchema>;

/** The addresses of one notification, checked: at least one, at most ten, each valid. */
export function checkNotificationRecipients(raw: readonly string[], stored: readonly string[] = []): { ok: true; emails: string[] } | { ok: false; message: string } {
  // `stored` is the addresses already saved on this notification (#1193): an old one left alone passes.
  const result = parseAlertRecipients([...raw], stored);
  if (!result.ok) return result;
  if (result.emails.length === 0) return { ok: false, message: "Add at least one email address to every notification." };
  return result;
}

/**
 * The questions a condition may look at: registration-level answers that are not excluded from the PDF. A sensitive
 * answer is never one, because who gets an email would reveal it. The location is offered separately by the panel.
 */
export function conditionFieldChoices(definition: RegistrationFormDefinition) {
  const excluded = excludedFieldKeys(definition);
  const seen = new Set<string>();
  const choices: Array<{ key: string; label: string; options: string[] }> = [];
  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (field.scope !== "REGISTRATION" || excluded.has(field.key) || seen.has(field.key)) continue;
      if (field.type === "ACKNOWLEDGMENT" || field.type === "ADDRESS" || field.type === "CALCULATED") continue;
      seen.add(field.key);
      choices.push({ key: field.key, label: field.label, options: field.options });
    }
  }
  return choices;
}

export function isAllowedConditionKey(definition: RegistrationFormDefinition, key: string) {
  return key === LOCATION_CONDITION_KEY || key === CLUB_CONDITION_KEY || conditionFieldChoices(definition).some((choice) => choice.key === key);
}

/**
 * Whether a stored notification may still route on its condition (#1081). A condition is checked when it is saved, but the
 * form can change afterwards: the question may now be sensitive, sit in a health section, follow a sensitive question, or be
 * gone. Such a notification is skipped (never sent unconditioned), because who gets an email would reveal the answer.
 */
export function conditionStillAllowed(definition: RegistrationFormDefinition, row: { conditionFieldKey: string | null }) {
  return !row.conditionFieldKey || isAllowedConditionKey(definition, row.conditionFieldKey);
}

/**
 * The chosen sections that exist in THIS form version. Never widened: when sections were chosen and none of them exist in
 * the registration's version (it was made on an older one), `noMatch` is true and the notification goes as a summary with
 * no PDF, never as the full registration.
 */
export function resolveSections(definition: RegistrationFormDefinition, sectionIds: readonly string[]): { sectionIds: string[]; noMatch: boolean } {
  if (sectionIds.length === 0) return { sectionIds: [], noMatch: false };
  const present = new Set(definition.sections.map((section) => section.id));
  const found = sectionIds.filter((id) => present.has(id));
  return { sectionIds: found, noMatch: found.length === 0 };
}

/**
 * Whether a stored notification's club still exists (#1097). Not part of `conditionStillAllowed` because that is pure and
 * synchronous; the callers look the clubs up and pass the answer. A notification that routes on a club that is gone is
 * skipped, never sent unconditioned. Any other condition is not affected.
 */
export function clubConditionStillExists(row: { conditionFieldKey: string | null; conditionValue: string | null }, existingClubIds: ReadonlySet<string>) {
  return row.conditionFieldKey !== CLUB_CONDITION_KEY || (row.conditionValue !== null && existingClubIds.has(row.conditionValue));
}

/**
 * Whether a notification applies to a registration with these answers, this location and this club (an organization id).
 * No condition always applies. A registration with no club (a Group registration, say) never matches "is" and always
 * matches "is not".
 */
export function notificationApplies(
  condition: NotificationCondition | null,
  answers: Record<string, unknown>,
  locationId: string | null,
  organizationId: string | null = null,
) {
  if (!condition) return true;
  const responses = condition.fieldKey === LOCATION_CONDITION_KEY
    ? { [LOCATION_CONDITION_KEY]: locationId ?? "" }
    : condition.fieldKey === CLUB_CONDITION_KEY
    ? { [CLUB_CONDITION_KEY]: organizationId ?? "" }
    : answers;
  return conditionMatches({ fieldKey: condition.fieldKey, operator: condition.operator, value: condition.value }, responses);
}

/** A stable text for "which sections", so a change of the notification's sections is told apart from a change of content. */
export function sectionSignature(sectionIds: readonly string[]) {
  return [...sectionIds].sort().join(",");
}

/** What the section filter looks like to a reader, for the email: "The full registration" or "Camping details, Roster". */
export function includesText(sectionIds: readonly string[], sectionTitles: ReadonlyMap<string, string>) {
  if (sectionIds.length === 0) return "The full registration";
  const titles = sectionIds.map((id) => sectionTitles.get(id)).filter((title): title is string => Boolean(title));
  return titles.length > 0 ? titles.join(", ") : "The chosen sections";
}

export type NotificationEmailInput = {
  notificationName: string;
  eventName: string;
  formTitle: string;
  registrantName: string;
  locationName: string | null;
  includes: string;
  updated: boolean;
  /** False when the PDF could not be made: the email then says so. */
  hasPdf: boolean;
  /** The chosen sections are not in this registration's form version: no PDF, and the email says why. */
  noMatchingSections?: boolean;
};

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The email: a short summary, never an answer. The detail is in the attached PDF, which follows the PDF's own exclusion
 * rules. `source` is Markdown source with every typed name passed through `escape`; the caller derives both the HTML
 * and the plain-text part from it.
 */
export function notificationEmailContent(input: NotificationEmailInput, escape: (value: string) => string) {
  const e = (value: string) => escape(oneLine(value));
  const subject = `${input.updated ? "Updated: " : ""}New registration: ${oneLine(input.eventName)} (${oneLine(input.notificationName)})`;
  const lines = [
    input.updated ? "A registration was changed." : "Someone registered.",
    "",
    `Event: ${e(input.eventName)}`,
    `Form: ${e(input.formTitle)}`,
    `Registered by: ${e(input.registrantName)}`,
    ...(input.locationName ? [`Location: ${e(input.locationName)}`] : []),
    `Notification: ${e(input.notificationName)}`,
    `Includes: ${e(input.includes)}`,
    "",
    input.noMatchingSections
      ? "None of the sections chosen for this notification were in this registration's form version, so there is no PDF. Open the registration in IMSDA Events for the details."
      : input.hasPdf
      ? (input.updated ? "The attached PDF is the updated copy." : "The details are in the attached PDF.")
      : "The PDF could not be attached. Open the registration in IMSDA Events for the details.",
  ];
  return { subject, source: lines.join("\n") };
}
