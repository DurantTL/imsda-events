import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";
import {
  CLUB_CONDITION_KEY,
  FORM_NOTIFICATIONS_MAX_PER_FORM,
  LOCATION_CONDITION_KEY,
  checkNotificationRecipients,
  conditionFieldChoices,
  conditionStillAllowed,
  isAllowedConditionKey,
  notificationsPutSchema,
  type FormNotificationConfig,
  type NotificationInput,
} from "@/modules/registration-form-notifications/domain";

/**
 * Reading and saving a registration form's notifications (#1081). The route has already checked the permission
 * (CONFIGURE_EVENT: event administrators, and system administrators who pass every check); everything that decides what
 * is stored is checked here, on the server, against the form's own definition.
 */

export class FormNotificationError extends Error {
  constructor(message: string, readonly code: "FORM_NOT_FOUND" | "INVALID_NOTIFICATIONS") {
    super(message);
    this.name = "FormNotificationError";
  }
}

/** A notification as the panel shows it, with what the staff member should know about it. */
export type FormNotificationView = FormNotificationConfig & {
  warnings: string[];
  /** The condition's club no longer exists (#1097): the panel shows "(club removed)" and the notification is skipped. */
  clubRemoved: boolean;
};

export type FormNotificationsPanel = {
  notifications: FormNotificationView[];
  /** What a condition may look at, and what a notification may include. Nothing sensitive is offered. */
  fields: Array<{ key: string; label: string; options: string[] }>;
  sections: Array<{ id: string; title: string }>;
  locations: Array<{ id: string; name: string }>;
  /** The clubs a Club condition can pick (#1097), by name: empty when the form's registrations carry no club. */
  clubs: Array<{ id: string; name: string }>;
};

function toConfig(row: { id: string; name: string; recipients: string[]; conditionFieldKey: string | null; conditionOperator: string | null; conditionValue: string | null; sectionIds: string[] }): FormNotificationConfig {
  const operator = row.conditionOperator === "NOT_EQUALS" ? "NOT_EQUALS" : "EQUALS";
  return {
    id: row.id,
    name: row.name,
    recipients: row.recipients,
    condition: row.conditionFieldKey ? { fieldKey: row.conditionFieldKey, operator, value: row.conditionValue ?? "" } : null,
    sectionIds: row.sectionIds,
  };
}

/** The form's latest definition that parses: what the panel offers is the form as it is being built. */
async function loadForm(eventId: string, formId: string) {
  const form = await getPrisma().registrationForm.findFirst({
    where: { id: formId, eventId },
    select: {
      id: true,
      versions: { orderBy: { versionNumber: "desc" }, select: { definition: true, status: true } },
      notifications: { orderBy: { position: "asc" } },
    },
  });
  if (!form) throw new FormNotificationError("That registration form was not found.", "FORM_NOT_FOUND");
  let definition: RegistrationFormDefinition | null = null;
  let published: RegistrationFormDefinition | null = null;
  for (const version of form.versions) {
    const parsed = registrationFormDefinitionSchema.safeParse(version.definition);
    if (!parsed.success) continue;
    definition ??= parsed.data;
    if (version.status === "PUBLISHED") {
      published = parsed.data;
      break;
    }
  }
  return { form, definition, published };
}

/** Why a stored notification may not do what its owner expects: a condition no longer allowed, or a draft-only part. */
function warningsFor(config: FormNotificationConfig, definition: RegistrationFormDefinition | null, published: RegistrationFormDefinition | null) {
  const warnings: string[] = [];
  const key = { conditionFieldKey: config.condition?.fieldKey ?? null };
  if (published && !conditionStillAllowed(published, key)) {
    warnings.push("This condition looks at a question that is now sensitive or no longer in the form, so this notification is not being sent. Change or remove the condition.");
  } else if (definition && !conditionStillAllowed(definition, key)) {
    warnings.push(published
      ? "This condition looks at a question that is sensitive or removed in the unpublished draft. This notification will stop being sent once the draft is published. Change or remove the condition."
      : "This condition looks at a question that is now sensitive or no longer in the form, so this notification is not being sent. Change or remove the condition.");
  }
  if (published && definition) {
    const publishedSections = new Set(published.sections.map((section) => section.id));
    const draftOnlySection = config.sectionIds.some((id) => !publishedSections.has(id));
    const draftOnlyCondition = Boolean(config.condition) && !isAllowedConditionKey(published, config.condition!.fieldKey)
      && isAllowedConditionKey(definition, config.condition!.fieldKey);
    if (draftOnlySection || draftOnlyCondition) {
      warnings.push("Part of this notification (a section or the condition's question) exists only in the unpublished draft. Until that version is published, registrations on the live form do not have it: a notification whose sections are all missing includes the full registration, and a missing condition question does not match.");
    }
  }
  return warnings;
}

type ClubData = { clubs: Array<{ id: string; name: string }>; existingIds: Set<string> };

function panelFor(definition: RegistrationFormDefinition | null, published: RegistrationFormDefinition | null, notifications: FormNotificationConfig[], locations: Array<{ id: string; name: string }>, clubData: ClubData): FormNotificationsPanel {
  return {
    notifications: notifications.map((config) => {
      const warnings = warningsFor(config, definition, published);
      const clubRemoved = config.condition?.fieldKey === CLUB_CONDITION_KEY && !clubData.existingIds.has(config.condition.value);
      if (clubRemoved) warnings.push("This notification's club was removed, so it is not being sent. Choose another club or remove the condition.");
      return { ...config, warnings, clubRemoved };
    }),
    clubs: clubData.clubs,
    fields: definition ? conditionFieldChoices(definition) : [],
    sections: definition ? definition.sections.map((section) => ({ id: section.id, title: section.title })) : [],
    locations,
  };
}

/**
 * The clubs for the panel (#1097): the active clubs in the directory, offered only when the event is a club event (its
 * registrations carry a club) or a notification already routes on one. A stored club that is inactive but still a club
 * is kept in the list so its name shows; one that is gone from the directory is in neither, so the panel marks it removed.
 */
async function loadClubData(eventId: string, notifications: FormNotificationConfig[]): Promise<ClubData> {
  const prisma = getPrisma();
  const storedIds = [...new Set(notifications.flatMap((config) => (config.condition?.fieldKey === CLUB_CONDITION_KEY ? [config.condition.value] : [])))];
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { audience: true } });
  const active = event?.audience === "CLUB" || storedIds.length > 0
    ? await prisma.organization.findMany({ where: { type: "CLUB", isActive: true }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true } })
    : [];
  const activeIds = new Set(active.map((club) => club.id));
  const stored = storedIds.length > 0
    ? await prisma.organization.findMany({ where: { id: { in: storedIds }, type: "CLUB" }, select: { id: true, name: true } })
    : [];
  const clubs = [...active, ...stored.filter((club) => !activeIds.has(club.id))];
  return { clubs, existingIds: new Set(stored.map((club) => club.id)) };
}

async function eventLocations(eventId: string) {
  return getPrisma().eventLocation.findMany({ where: { eventId, isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } });
}

export async function getFormNotificationsPanel(eventId: string, formId: string): Promise<FormNotificationsPanel> {
  const { form, definition, published } = await loadForm(eventId, formId);
  const configs = form.notifications.map(toConfig);
  return panelFor(definition, published, configs, await eventLocations(eventId), await loadClubData(eventId, configs));
}

/**
 * Replaces the form's whole notification list. Rows keep their id when the request names it (so what each one already
 * sent is remembered), new ones are created, and rows left out are removed. Audited with ids and counts only: never an
 * address, a name or a condition value.
 */
export async function replaceFormNotifications(eventId: string, formId: string, actorUserId: string, body: unknown): Promise<FormNotificationsPanel> {
  const parsed = notificationsPutSchema.safeParse(body);
  if (!parsed.success) throw new FormNotificationError(parsed.error.issues[0]?.message ?? "The notifications could not be read.", "INVALID_NOTIFICATIONS");
  const { form, definition, published } = await loadForm(eventId, formId);
  if (!definition) throw new FormNotificationError("Fix this form's questions and save it before adding notifications.", "INVALID_NOTIFICATIONS");
  const locations = await eventLocations(eventId);
  const sectionIds = new Set(definition.sections.map((section) => section.id));
  const existingIds = new Set(form.notifications.map((row) => row.id));
  const allLocationIds = new Set((await getPrisma().eventLocation.findMany({ where: { eventId }, select: { id: true } })).map((row) => row.id));
  // A Club condition's value is checked against the real club organizations (#1097), never trusted from the client.
  const clubValues = [...new Set(parsed.data.notifications.flatMap((input) => (input.condition?.fieldKey === CLUB_CONDITION_KEY ? [input.condition.value] : [])))];
  const storedClubKeys = new Set(form.notifications.filter((row) => row.conditionFieldKey === CLUB_CONDITION_KEY).map((row) => row.id));
  const clubsAllowed = clubValues.length === 0
    || (await getPrisma().event.findUnique({ where: { id: eventId }, select: { audience: true } }))?.audience === "CLUB";
  const realClubIds = new Set(clubValues.length === 0 ? [] : (await getPrisma().organization.findMany({ where: { id: { in: clubValues }, type: "CLUB" }, select: { id: true } })).map((row) => row.id));

  const namedIds = parsed.data.notifications.flatMap((input) => (input.id ? [input.id] : []));
  if (new Set(namedIds).size !== namedIds.length) {
    throw new FormNotificationError("A notification is listed twice. Reload the page and try again.", "INVALID_NOTIFICATIONS");
  }
  const checked = parsed.data.notifications.map((input: NotificationInput, index) => {
    const label = `Notification ${index + 1}`;
    // Judged against what this notification has stored now, never against anything the browser says (#1193).
    const recipients = checkNotificationRecipients(input.recipients, form.notifications.find((row) => row.id === input.id)?.recipients ?? []);
    if (!recipients.ok) throw new FormNotificationError(`${label}: ${recipients.message}`, "INVALID_NOTIFICATIONS");
    if (input.id && !existingIds.has(input.id)) throw new FormNotificationError(`${label} no longer exists. Reload the page and try again.`, "INVALID_NOTIFICATIONS");
    if (input.condition) {
      if (!isAllowedConditionKey(definition, input.condition.fieldKey)) {
        throw new FormNotificationError(`${label}: choose a question from the list for the condition.`, "INVALID_NOTIFICATIONS");
      }
      if (input.condition.fieldKey === LOCATION_CONDITION_KEY && !allLocationIds.has(input.condition.value)) {
        throw new FormNotificationError(`${label}: choose one of this event's locations.`, "INVALID_NOTIFICATIONS");
      }
      // Only club events carry a club; a notification already routing on one may still be re-saved.
      if (input.condition.fieldKey === CLUB_CONDITION_KEY && !clubsAllowed && !(input.id && storedClubKeys.has(input.id))) {
        throw new FormNotificationError(`${label}: this event's registrations do not have a club, so a club condition is not available.`, "INVALID_NOTIFICATIONS");
      }
      if (input.condition.fieldKey === CLUB_CONDITION_KEY && !realClubIds.has(input.condition.value)) {
        throw new FormNotificationError(`${label}: choose one of the clubs in the directory.`, "INVALID_NOTIFICATIONS");
      }
    }
    const chosenSections = [...new Set(input.sectionIds)];
    if (chosenSections.some((id) => !sectionIds.has(id))) {
      throw new FormNotificationError(`${label}: a chosen section is not in this form.`, "INVALID_NOTIFICATIONS");
    }
    return { input, emails: recipients.emails, sections: chosenSections, index };
  });
  if (checked.length > FORM_NOTIFICATIONS_MAX_PER_FORM) {
    throw new FormNotificationError(`A form has at most ${FORM_NOTIFICATIONS_MAX_PER_FORM} notifications.`, "INVALID_NOTIFICATIONS");
  }

  const saved = await getPrisma().$transaction(async (tx) => {
    const keptIds = checked.flatMap((entry) => (entry.input.id ? [entry.input.id] : []));
    const removed = await tx.registrationFormNotification.deleteMany({ where: { formId, id: { notIn: keptIds } } });
    const ids: string[] = [];
    for (const entry of checked) {
      const data = {
        position: entry.index,
        name: entry.input.name,
        recipients: entry.emails,
        conditionFieldKey: entry.input.condition?.fieldKey ?? null,
        conditionOperator: entry.input.condition?.operator ?? null,
        conditionValue: entry.input.condition?.value ?? null,
        sectionIds: entry.sections,
      };
      if (entry.input.id) {
        await tx.registrationFormNotification.update({ where: { id: entry.input.id }, data });
        ids.push(entry.input.id);
      } else {
        const created = await tx.registrationFormNotification.create({ data: { ...data, formId }, select: { id: true } });
        ids.push(created.id);
      }
    }
    await writeAuditLog({
      eventId,
      actorUserId,
      action: "REGISTRATION_FORM_NOTIFICATIONS_CHANGED",
      entityType: "RegistrationForm",
      entityId: formId,
      summary: "Changed a registration form's notifications.",
      // Ids and counts only: never an address, a notification name or a condition value.
      metadata: {
        formId,
        notificationIds: ids,
        notificationCount: ids.length,
        removedCount: removed.count,
        recipientCount: checked.reduce((sum, entry) => sum + entry.emails.length, 0),
        conditionCount: checked.filter((entry) => entry.input.condition).length,
        sectionFilterCount: checked.filter((entry) => entry.sections.length > 0).length,
      },
    }, tx);
    return tx.registrationFormNotification.findMany({ where: { formId }, orderBy: { position: "asc" } });
  }).catch((error: unknown) => {
    // A notification (or the form) deleted by someone else between the load and this save is a conflict, not a server error.
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2025" || error.code === "P2003")) {
      throw new FormNotificationError("A notification was changed or removed by someone else. Reload the page and try again.", "INVALID_NOTIFICATIONS");
    }
    throw error;
  });
  const savedConfigs = saved.map(toConfig);
  return panelFor(definition, published, savedConfigs, locations, await loadClubData(eventId, savedConfigs));
}
