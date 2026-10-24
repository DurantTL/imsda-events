import "server-only";

import { loadEventEmailSettings } from "@/modules/communications/effective-delivery";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { effectivePermissions } from "@/modules/access/authorization";
import {
  AUDIENCE_QUERY_VERSION,
  AudienceFilterNotAvailableError,
  audienceQueryHash,
  normalizeAudienceQuery,
  type NormalizedAudienceQuery,
} from "@/modules/communications/audience-query";
import { classifyAttendeeType, normalizeAudienceEmail } from "@/modules/communications/audience-resolve";
import { evaluateEventAudience, type AudienceEvaluationOptions } from "@/modules/communications/audience-repository";
import { BATCH_TRANSACTION_MAX_WAIT_MS, BATCH_TRANSACTION_TIMEOUT_MS } from "@/modules/communications/batch-transaction";
import { MessagingError } from "@/modules/communications/messaging-error";
import {
  captureMessageIdsLocally,
  ensureEventMessagingDefaults,
} from "@/modules/communications/messaging-repository";
import {
  SCHEDULED_EMAIL_STALE_CLAIM_MS,
  SCHEDULED_EMAIL_MAX_LATE_MS,
  SCHEDULED_EMAIL_STATUS_LABELS,
  SCHEDULED_EMAIL_TEMPLATE_LABELS,
  SCHEDULED_EMAIL_TRIGGER_LABELS,
  SCHEDULE_EXCLUSION_LABELS,
  ScheduleProjectionError,
  assertSendTimeUsable,
  canEditSchedule,
  decideRecipientEligibility,
  eventTimingChanged,
  formatInstantInZone,
  projectSchedule,
  refusedYouthTargets,
  ruleFromColumns,
  ruleToColumns,
  scheduleReviewFingerprint,
  scheduledEmailActivateSchema,
  scheduledEmailContentSchema,
  scheduledEmailCreateSchema,
  scheduledEmailUpdateSchema,
  targetKey,
  type CurrentAudienceView,
  type EventMinors,
  type YouthCheckRegistration,
  type ScheduleExclusionCode,
  type ScheduleProjection,
  type ScheduleRule,
  type ScheduledEmailStatus,
  type ScheduledEmailTemplateKey,
} from "@/modules/communications/scheduled-email-domain";
import { assertAnnouncementTextSendable } from "@/modules/communications/announcement-send-check";
import { enqueueSelectedAudienceMessage } from "@/modules/communications/transactional-messages";

/**
 * Scheduled email batches (#177): reviewed, human-approved email that goes out at a time written in the event's own
 * time zone, to an audience that is checked again at the moment it is queued and again just before each message is sent.
 *
 * It extends the reviewed audience builder (#176: the query, the audience, its fingerprint) and the durable outbox
 * (one `MessageOutbox` row per recipient, delivered by the same worker as every other message). It adds a schedule
 * and a fixed list of approved recipients; it does not add a second way to render or deliver a message.
 *
 * HUMAN GATE. Bulk communication needs a person. A schedule is written as SCHEDULED, which sends nothing. Only an
 * authorized staff member's explicit activation (with the review fingerprint they were shown) makes it ACTIVE, and the
 * only automatic step is the sweep sending a schedule that is already ACTIVE at its time. Nothing here activates.
 *
 * YOUTH. These emails never go to a minor's own address (owner decision, issue #177). The audience builder excludes
 * minor attendees by attendee type; this module checks again, independently, at schedule time, when a recipient is
 * queued and again right before the send, so no single rule is the only thing between a child and a message.
 *
 * SAFETY OF A RUN. One worker claims a due batch with a conditional update; a second claim fails. Recipients are rows
 * with a unique key, each queued message is an idempotent upsert on a key derived from the batch and registration, and
 * pause and cancel use the same conditional update on the batch row, so they serialize with the claim.
 */

type Client = PrismaClient | Prisma.TransactionClient;

const AUDIT_ACTIONS = {
  created: "SCHEDULED_EMAIL_CREATED",
  updated: "SCHEDULED_EMAIL_UPDATED",
  activated: "SCHEDULED_EMAIL_ACTIVATED",
  paused: "SCHEDULED_EMAIL_PAUSED",
  cancelled: "SCHEDULED_EMAIL_CANCELLED",
  sent: "SCHEDULED_EMAIL_QUEUED",
  completed: "SCHEDULED_EMAIL_COMPLETED",
  failed: "SCHEDULED_EMAIL_FAILED",
  recipientDropped: "SCHEDULED_EMAIL_RECIPIENTS_DROPPED",
} as const;

const SEND_CHUNK_SIZE = 25;
const MANAGE = "MANAGE_COMMUNICATIONS";

/* ------------------------------------------------------------------------------------------------------------------
 * Review: what staff see before they save or approve.
 * ---------------------------------------------------------------------------------------------------------------- */

export type ScheduleTarget = {
  email: string;
  registrationId: string;
  confirmationCode: string;
  name: string;
  roles: string[];
  balanceCents: number;
};

export type ScheduleExclusionSummary = { code: string; label: string; count: number };

export type ScheduledEmailReview = {
  reviewFingerprint: string;
  generatedAt: string;
  projection: {
    sendAt: string;
    sendAtLabel: string;
    eventTimezone: string;
    localDate: string;
    localTime: string;
    dstBehavior: ScheduleProjection["dstBehavior"];
    dstNote: string;
    anchorAt: string | null;
  };
  template: {
    key: ScheduledEmailTemplateKey;
    label: string;
    versionNumber: number | null;
    enabled: boolean;
  };
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  audience: { fingerprint: string; queryHash: string; queryVersion: string; query: NormalizedAudienceQuery };
  eligibleCount: number;
  exclusionCount: number;
  exclusions: ScheduleExclusionSummary[];
  /** Internal: the approved list. Never part of the API response. */
  targets: ScheduleTarget[];
};

/** The same review with the address-bearing list removed, which is all a response or the UI ever needs. */
export type ScheduledEmailReviewView = Omit<ScheduledEmailReview, "targets">;

export function toReviewView(review: ScheduledEmailReview): ScheduledEmailReviewView {
  const { targets: _targets, ...view } = review;
  void _targets;
  return view;
}

async function loadEventFacts(client: Client, eventId: string) {
  const event = await client.event.findUnique({
    where: { id: eventId },
    select: { id: true, timezone: true, startsAt: true, registrationClosesOn: true, paymentDueOn: true, billingMode: true },
  });
  if (!event) throw new MessagingError("MESSAGE_NOT_FOUND", "That event is no longer available.");
  return event;
}

async function loadTemplateSource(client: Client, eventId: string, templateKey: ScheduledEmailTemplateKey) {
  const template = await client.eventMessageTemplate.findFirst({
    where: { eventId, key: templateKey },
    select: {
      isEnabled: true,
      versions: { where: { status: "PUBLISHED" }, orderBy: { versionNumber: "desc" }, take: 1, select: { id: true, versionNumber: true } },
    },
  });
  const version = template?.versions[0] ?? null;
  if (templateKey === "CUSTOM_MESSAGE" && !version) {
    throw new MessagingError(
      "TEMPLATE_NOT_PUBLISHED",
      "The Custom message template has not been published for this event. Write and publish it in Communications, then try again.",
    );
  }
  return { versionId: version?.id ?? null, versionNumber: version?.versionNumber ?? null, enabled: template?.isEnabled ?? true };
}

async function loadDeliveryMode(client: Client, eventId: string) {
  // The one effective-delivery decision (#1043). An event with no settings row keeps the capture-only fallback.
  const settings = await loadEventEmailSettings(client, eventId);
  return settings?.deliveryMode ?? "LOCAL_CAPTURE";
}

/**
 * Independent youth check, separate from the audience builder's own rule so a recipient is never sent to on one rule's
 * say-so alone. Owner decision (#177): a youth's own address is written to only when an adult also uses it in that send (the
 * adult registration contact, an adult attendee of the registration, a group billing or organization contact); if the only
 * person behind the address is a minor, never. Ages come from the attendee type, never a birth date (ADR 0005 Addendum A).
 * The rule itself is `refusedYouthTargets`. Returns the refused targets.
 */
export async function findMinorTargets(
  client: Client,
  eventId: string,
  targets: ReadonlyArray<{ email: string; registrationId: string; roles: readonly string[] }>,
): Promise<Set<string>> {
  if (targets.length === 0) return new Set();
  const [types, registrations] = await Promise.all([
    client.eventAttendeeType.findMany({ where: { eventId }, select: { code: true, minimumAge: true, maximumAge: true } }),
    client.registration.findMany({
      where: { eventId, id: { in: [...new Set(targets.map((target) => target.registrationId))] } },
      select: {
        id: true,
        accountHolderPersonId: true,
        contactSnapshot: true,
        accountHolderPerson: { select: { normalizedEmail: true } },
        attendees: {
          select: { personId: true, attendeeTypeDefinition: { select: { code: true } }, person: { select: { normalizedEmail: true } } },
        },
      },
    }),
  ]);
  const ageClass = new Map(types.map((type) => [type.code, classifyAttendeeType(type)] as const));
  // The whole event's non-adult attendees (a type that is not an adult type, or no type at all), read once for this evaluation:
  // an account holder who attends as a minor anywhere is a minor everywhere, and their address is a youth address.
  const adultCodes = types.filter((type) => ageClass.get(type.code) === "ADULT").map((type) => type.code);
  const eventMinorRows = await client.registrationAttendee.findMany({
    where: { eventId, OR: [{ attendeeTypeDefinitionId: null }, { attendeeTypeDefinition: { code: { notIn: adultCodes } } }] },
    select: { personId: true, person: { select: { normalizedEmail: true } } },
  });
  const eventMinors: EventMinors = {
    personIds: new Set(eventMinorRows.map((row) => row.personId)),
    emails: new Set(eventMinorRows.map((row) => normalizeAudienceEmail(row.person.normalizedEmail)).filter(Boolean)),
  };
  const byRegistration = new Map<string, YouthCheckRegistration>();
  for (const registration of registrations) {
    const snapshot = registration.contactSnapshot && typeof registration.contactSnapshot === "object" && !Array.isArray(registration.contactSnapshot)
      ? registration.contactSnapshot as Record<string, unknown>
      : {};
    byRegistration.set(registration.id, {
      registrationId: registration.id,
      accountHolderPersonId: registration.accountHolderPersonId,
      holderEmail: normalizeAudienceEmail(registration.accountHolderPerson.normalizedEmail),
      snapshotEmail: normalizeAudienceEmail(typeof snapshot.email === "string" ? snapshot.email : ""),
      attendees: registration.attendees.map((attendee) => {
        const code = attendee.attendeeTypeDefinition?.code;
        return {
          personId: attendee.personId,
          email: normalizeAudienceEmail(attendee.person.normalizedEmail),
          // No type definition at all is unknown, which is never an adult.
          age: (code ? ageClass.get(code) : undefined) ?? "UNKNOWN",
        };
      }),
    });
  }
  return refusedYouthTargets(targets, byRegistration, eventMinors);
}

function builderExclusionCode(code: string): ScheduleExclusionCode | null {
  switch (code) {
    case "NO_EMAIL":
    case "INVALID_EMAIL":
    case "OPTED_OUT_EVENT":
    case "OPTED_OUT_ALL":
    case "PROVIDER_BOUNCED":
    case "PROVIDER_COMPLAINED":
      return code;
    case "MINOR_ATTENDEE":
      return "MINOR_RECIPIENT";
    default:
      return null;
  }
}

/**
 * The kind of message decides which opt-outs apply, so the template decides it, not the query: only an announcement can
 * be opted out of (#838); a balance reminder or custom message goes to everyone it is for. A query that says otherwise
 * is overridden rather than trusted.
 */
export function queryForTemplate(templateKey: ScheduledEmailTemplateKey, query: unknown): unknown {
  if (!query || typeof query !== "object" || Array.isArray(query)) return query;
  return { ...(query as Record<string, unknown>), messageKind: templateKey === "EVENT_ANNOUNCEMENT" ? "ANNOUNCEMENT" : "OPERATIONAL" };
}

type ReviewContent = {
  templateKey: ScheduledEmailTemplateKey;
  announcementTitle: string;
  announcementBody: string;
  rule: ScheduleRule;
  query: unknown;
};

/**
 * Builds the review for a schedule: the projected send time in the event's zone with its daylight-saving note, the
 * audience as the builder resolves it right now (through the caller's own permissions), the template version, and what
 * would be dropped and why. It writes nothing.
 */
export async function buildScheduledEmailReview(
  eventId: string,
  permissions: readonly string[],
  content: ReviewContent,
  options: AudienceEvaluationOptions & { now?: Date; requireFutureSendTime?: boolean } = {},
): Promise<ScheduledEmailReview> {
  const now = options.now ?? new Date();
  const prisma = getPrisma();
  await ensureEventMessagingDefaults(eventId);
  // The typed announcement text gets the send check's errors (#836), whether the schedule is created, edited or approved.
  if (content.templateKey === "EVENT_ANNOUNCEMENT") {
    await assertAnnouncementTextSendable(prisma, eventId, { title: content.announcementTitle, body: content.announcementBody });
  }
  const event = await loadEventFacts(prisma, eventId);
  let projection: ScheduleProjection;
  try {
    projection = projectSchedule(content.rule, event);
    if (options.requireFutureSendTime !== false) assertSendTimeUsable(projection.sendAt, now);
  } catch (error) {
    if (error instanceof ScheduleProjectionError) throw new MessagingError("SCHEDULE_INVALID", error.message);
    throw error;
  }
  const [template, deliveryMode, evaluated] = await Promise.all([
    loadTemplateSource(prisma, eventId, content.templateKey),
    loadDeliveryMode(prisma, eventId),
    evaluateEventAudience(eventId, permissions, queryForTemplate(content.templateKey, content.query), { now, batchSize: options.batchSize }),
  ]);

  const exclusionCounts = new Map<string, number>();
  const addExclusion = (code: string, count = 1) => exclusionCounts.set(code, (exclusionCounts.get(code) ?? 0) + count);
  for (const exclusion of evaluated.result.exclusions) addExclusion(builderExclusionCode(exclusion.code) ?? exclusion.code, exclusion.contactCount);

  let candidates: ScheduleTarget[] = evaluated.result.recipients.flatMap((recipient) => recipient.registrations.map((entry) => ({
    email: recipient.email,
    registrationId: entry.registrationId,
    confirmationCode: entry.confirmationCode,
    name: recipient.displayName,
    roles: entry.roles as string[],
    balanceCents: entry.balanceCents,
  })));

  const isOrganizationBilled = event.billingMode === "DEFERRED_ORGANIZATION_INVOICE";
  // Owing a balance is what a balance reminder is for, and what a batch counted back from the payment due date requires (#993).
  if (content.templateKey === "BALANCE_REMINDER" || content.rule.trigger === "BEFORE_PAYMENT_DUE") {
    const kept: ScheduleTarget[] = [];
    for (const target of candidates) {
      if (isOrganizationBilled) addExclusion("ORGANIZATION_BILLED");
      else if (target.balanceCents <= 0) addExclusion("NO_BALANCE_DUE");
      else kept.push(target);
    }
    candidates = kept;
  }
  const minors = await findMinorTargets(prisma, eventId, candidates);
  const targets = candidates.filter((target) => {
    if (!minors.has(targetKey(target.email, target.registrationId))) return true;
    addExclusion("MINOR_RECIPIENT");
    return false;
  });

  const labelFor = (code: string) => (SCHEDULE_EXCLUSION_LABELS as Record<string, string>)[code]
    ?? evaluated.result.exclusions.find((exclusion) => exclusion.code === code)?.label
    ?? code;
  const exclusions = [...exclusionCounts.entries()]
    .map(([code, count]) => ({ code, label: labelFor(code), count }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const announcementTitle = content.templateKey === "EVENT_ANNOUNCEMENT" ? content.announcementTitle : "";
  const announcementBody = content.templateKey === "EVENT_ANNOUNCEMENT" ? content.announcementBody : "";
  const reviewFingerprint = scheduleReviewFingerprint({
    eventId,
    audienceFingerprint: evaluated.result.fingerprint,
    queryHash: evaluated.queryHash,
    templateKey: content.templateKey,
    templateVersionId: template.versionId,
    announcementTitle,
    announcementBody,
    deliveryMode,
    rule: content.rule,
    sendAt: projection.sendAt,
    eventTimezone: projection.eventTimezone,
    targetKeys: targets.map((target) => targetKey(target.email, target.registrationId)),
  });

  return {
    reviewFingerprint,
    generatedAt: now.toISOString(),
    projection: {
      sendAt: projection.sendAt.toISOString(),
      sendAtLabel: projection.sendAtLabel,
      eventTimezone: projection.eventTimezone,
      localDate: projection.localDate,
      localTime: projection.localTime,
      dstBehavior: projection.dstBehavior,
      dstNote: projection.dstNote,
      anchorAt: projection.anchorAt?.toISOString() ?? null,
    },
    template: {
      key: content.templateKey,
      label: SCHEDULED_EMAIL_TEMPLATE_LABELS[content.templateKey],
      versionNumber: template.versionNumber,
      enabled: template.enabled,
    },
    deliveryMode,
    audience: {
      fingerprint: evaluated.result.fingerprint,
      queryHash: evaluated.queryHash,
      queryVersion: AUDIENCE_QUERY_VERSION,
      query: evaluated.query,
    },
    eligibleCount: targets.length,
    exclusionCount: exclusions.reduce((sum, entry) => sum + entry.count, 0),
    exclusions,
    targets,
  };
}

/** Preview only: the review for content staff are writing. Nothing is saved, queued or scheduled. */
export async function previewScheduledEmail(
  eventId: string,
  permissions: readonly string[],
  rawContent: unknown,
  options: { now?: Date } = {},
): Promise<ScheduledEmailReviewView> {
  const content = scheduledEmailContentSchema.parse(rawContent);
  return toReviewView(await buildScheduledEmailReview(eventId, permissions, content, options));
}

/* ------------------------------------------------------------------------------------------------------------------
 * Records
 * ---------------------------------------------------------------------------------------------------------------- */

type BatchRow = Prisma.ScheduledEmailBatchGetPayload<Record<string, never>>;

export type ScheduledEmailRecord = {
  id: string;
  name: string;
  templateKey: ScheduledEmailTemplateKey;
  templateLabel: string;
  announcementTitle: string;
  announcementBody: string;
  status: ScheduledEmailStatus;
  statusLabel: string;
  triggerLabel: string;
  rule: ScheduleRule;
  revision: number;
  sendAt: string;
  sendAtLabel: string;
  eventTimezone: string;
  dstBehavior: string;
  dstNote: string | null;
  eligibleCount: number;
  excludedCount: number;
  /** A send has begun: pause is no longer possible, and cancel stops only what has not been sent. */
  claimed: boolean;
  pauseReason: string | null;
  failureReason: string | null;
  activatedAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** The event's time zone or dates changed since this was reviewed; it needs a new review before it can send. */
  timingStale: boolean;
  recipientCounts: Record<"PLANNED" | "QUEUED" | "EXCLUDED" | "CANCELLED", number>;
  exclusions: ScheduleExclusionSummary[];
  /** Outbox status of the queued messages: how many were sent, captured, are still waiting or failed. */
  deliveryCounts: Record<string, number>;
  query: unknown;
};

async function toRecord(client: Client, row: BatchRow): Promise<ScheduledEmailRecord> {
  const rule = ruleFromColumns(row);
  const [byStatus, byCode, delivery, event] = await Promise.all([
    client.scheduledEmailRecipient.groupBy({ by: ["status"], where: { batchId: row.id }, _count: { _all: true } }),
    client.scheduledEmailRecipient.groupBy({ by: ["exclusionCode"], where: { batchId: row.id, status: "EXCLUDED" }, _count: { _all: true } }),
    client.messageOutbox.groupBy({ by: ["status"], where: { scheduledEmailRecipient: { batchId: row.id } }, _count: { _all: true } }),
    client.event.findUnique({ where: { id: row.eventId }, select: { timezone: true, startsAt: true, registrationClosesOn: true, paymentDueOn: true } }),
  ]);
  const recipientCounts = { PLANNED: 0, QUEUED: 0, EXCLUDED: 0, CANCELLED: 0 };
  for (const entry of byStatus) recipientCounts[entry.status] = entry._count._all;
  let timingStale = false;
  if (event && (row.status === "SCHEDULED" || row.status === "ACTIVE" || row.status === "PAUSED") && !row.claimToken) {
    try {
      timingStale = eventTimingChanged(row, projectSchedule(rule, event));
    } catch {
      timingStale = true;
    }
  }
  return {
    id: row.id,
    name: row.name,
    templateKey: row.templateKey as ScheduledEmailTemplateKey,
    templateLabel: SCHEDULED_EMAIL_TEMPLATE_LABELS[row.templateKey as ScheduledEmailTemplateKey] ?? row.templateKey,
    announcementTitle: row.announcementTitle ?? "",
    announcementBody: row.announcementBody ?? "",
    status: row.status,
    statusLabel: SCHEDULED_EMAIL_STATUS_LABELS[row.status],
    triggerLabel: SCHEDULED_EMAIL_TRIGGER_LABELS[row.trigger],
    rule,
    revision: row.revision,
    sendAt: row.sendAt.toISOString(),
    sendAtLabel: formatInstantInZone(row.sendAt, row.eventTimezone),
    eventTimezone: row.eventTimezone,
    dstBehavior: row.dstBehavior,
    dstNote: row.dstNote,
    eligibleCount: row.eligibleCount,
    excludedCount: row.excludedCount,
    claimed: row.claimToken !== null,
    pauseReason: row.pauseReason,
    failureReason: row.failureReason,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    timingStale,
    recipientCounts,
    exclusions: byCode
      .filter((entry) => entry.exclusionCode)
      .map((entry) => ({
        code: entry.exclusionCode!,
        label: (SCHEDULE_EXCLUSION_LABELS as Record<string, string>)[entry.exclusionCode!] ?? entry.exclusionCode!,
        count: entry._count._all,
      })),
    deliveryCounts: Object.fromEntries(delivery.map((entry) => [entry.status, entry._count._all])),
    query: row.audienceQuery,
  };
}

export async function listScheduledEmails(eventId: string, limit = 50): Promise<ScheduledEmailRecord[]> {
  const prisma = getPrisma();
  const rows = await prisma.scheduledEmailBatch.findMany({
    where: { eventId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: Math.min(Math.max(limit, 1), 200),
  });
  return Promise.all(rows.map((row) => toRecord(prisma, row)));
}

export async function getScheduledEmail(eventId: string, scheduleId: string): Promise<ScheduledEmailRecord> {
  const prisma = getPrisma();
  const row = await prisma.scheduledEmailBatch.findFirst({ where: { id: scheduleId, eventId } });
  if (!row) throw new MessagingError("MESSAGE_NOT_FOUND", "That schedule is not on this event.");
  return toRecord(prisma, row);
}

async function requireBatch(client: Client, eventId: string, scheduleId: string) {
  // Scoped by event as well as id: another event's schedule reads as not found, never as one to act on.
  const row = await client.scheduledEmailBatch.findFirst({ where: { id: scheduleId, eventId } });
  if (!row) throw new MessagingError("MESSAGE_NOT_FOUND", "That schedule is not on this event.");
  return row;
}

function stateError(message: string) {
  return new MessagingError("SCHEDULE_STATE", message);
}

/** Retries a serializable transaction that PostgreSQL asked to be repeated. */
async function serializable<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const prisma = getPrisma();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(run, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: BATCH_TRANSACTION_TIMEOUT_MS,
        maxWait: BATCH_TRANSACTION_MAX_WAIT_MS,
      });
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!retryable || attempt >= 2) throw error;
    }
  }
}

function previewChanged(review: ScheduledEmailReview) {
  return new MessagingError(
    "PREVIEW_CHANGED",
    "The schedule, the audience or the template changed since you reviewed it. Check the new review before continuing.",
    { currentFingerprint: review.reviewFingerprint, review: toReviewView(review) },
  );
}

/* ------------------------------------------------------------------------------------------------------------------
 * Create, edit, approve, pause, cancel (every one a person's own request)
 * ---------------------------------------------------------------------------------------------------------------- */

function contentColumns(content: ReviewContent & { name: string }, review: ScheduledEmailReview) {
  return {
    name: content.name,
    templateKey: content.templateKey,
    announcementTitle: content.templateKey === "EVENT_ANNOUNCEMENT" ? content.announcementTitle : null,
    announcementBody: content.templateKey === "EVENT_ANNOUNCEMENT" ? content.announcementBody : null,
    templateVersionId: null as string | null,
    templateVersionNumber: review.template.versionNumber,
    ...ruleToColumns(content.rule),
    eventTimezone: review.projection.eventTimezone,
    anchorAt: review.projection.anchorAt ? new Date(review.projection.anchorAt) : null,
    sendAt: new Date(review.projection.sendAt),
    dstBehavior: review.projection.dstBehavior,
    dstNote: review.projection.dstNote,
    audienceQuery: review.audience.query as unknown as Prisma.InputJsonValue,
    audienceQueryVersion: review.audience.queryVersion,
    audienceQueryHash: review.audience.queryHash,
    audienceFingerprint: review.audience.fingerprint,
    eligibleCount: review.eligibleCount,
    excludedCount: review.exclusionCount,
  };
}

function sameContent(row: BatchRow, content: ReviewContent & { name: string }, queryHash: string) {
  const rule = ruleToColumns(content.rule);
  return row.name === content.name
    && row.templateKey === content.templateKey
    && (row.announcementTitle ?? "") === (content.templateKey === "EVENT_ANNOUNCEMENT" ? content.announcementTitle : "")
    && (row.announcementBody ?? "") === (content.templateKey === "EVENT_ANNOUNCEMENT" ? content.announcementBody : "")
    && row.trigger === rule.trigger
    && row.localDate === rule.localDate
    && row.localTime === rule.localTime
    && row.daysBefore === rule.daysBefore
    && row.audienceQueryHash === queryHash;
}

/**
 * Saves a reviewed schedule as SCHEDULED, which sends nothing. Needs the review fingerprint staff were shown: if the
 * audience, template, timing or delivery mode moved, nothing is saved (PREVIEW_CHANGED). The same UUID with the same
 * content returns the original; the same UUID with other content is IDEMPOTENCY_KEY_REUSED.
 */
export async function createScheduledEmail(
  eventId: string,
  actorUserId: string,
  permissions: readonly string[],
  rawInput: unknown,
  options: { now?: Date } = {},
): Promise<{ schedule: ScheduledEmailRecord; replayed: boolean }> {
  const input = scheduledEmailCreateSchema.parse(rawInput);
  const prisma = getPrisma();
  const reuse = () => new MessagingError("IDEMPOTENCY_KEY_REUSED", "That schedule id was already used for a different schedule.");
  const existing = await prisma.scheduledEmailBatch.findUnique({ where: { id: input.scheduleId } });
  if (existing) {
    // Another event's schedule is never revealed: its id reads as not found here, like every other read of it.
    if (existing.eventId !== eventId) throw new MessagingError("MESSAGE_NOT_FOUND", "That schedule is not on this event.");
    const queryHash = audienceQueryHash(normalizeAudienceQuery(queryForTemplate(input.templateKey, input.query)));
    if (!sameContent(existing, input, queryHash)) throw reuse();
    return { schedule: await toRecord(prisma, existing), replayed: true };
  }

  const review = await buildScheduledEmailReview(eventId, permissions, input, options);
  if (review.reviewFingerprint !== input.previewFingerprint) throw previewChanged(review);
  if (review.eligibleCount === 0) {
    throw new MessagingError("EMPTY_AUDIENCE", "Nobody in this audience can receive this message, so there is nothing to schedule.", { review: toReviewView(review) });
  }
  const template = await loadTemplateSource(prisma, eventId, input.templateKey);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.scheduledEmailBatch.create({
        data: {
          id: input.scheduleId,
          eventId,
          createdByUserId: actorUserId,
          status: "SCHEDULED",
          ...contentColumns(input, review),
          templateVersionId: template.versionId,
        },
      });
      await tx.auditLog.create({
        data: {
          eventId,
          actorUserId,
          action: AUDIT_ACTIONS.created,
          entityType: "ScheduledEmailBatch",
          entityId: row.id,
          correlationId: randomUUID(),
          summary: "Saved a scheduled email batch for review. Nothing will be sent until a person approves it.",
          metadata: { templateKey: row.templateKey, trigger: row.trigger, sendAt: row.sendAt.toISOString(), eligibleCount: row.eligibleCount, fingerprint: review.reviewFingerprint },
        },
      });
      return row;
    });
    return { schedule: await toRecord(prisma, created), replayed: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.scheduledEmailBatch.findUnique({ where: { id: input.scheduleId } });
      if (raced && raced.eventId !== eventId) throw new MessagingError("MESSAGE_NOT_FOUND", "That schedule is not on this event.");
      if (raced && sameContent(raced, input, review.audience.queryHash)) {
        return { schedule: await toRecord(prisma, raced), replayed: true };
      }
      throw reuse();
    }
    throw error;
  }
}

/**
 * Edits a schedule that has not started. An edit always puts it back to SCHEDULED: whatever was approved is no longer
 * what is written, so it needs a new review and a new approval. Two editors cannot overwrite each other (the revision).
 */
export async function updateScheduledEmail(
  eventId: string,
  actorUserId: string,
  permissions: readonly string[],
  rawInput: unknown,
  options: { now?: Date } = {},
): Promise<ScheduledEmailRecord> {
  const input = scheduledEmailUpdateSchema.parse(rawInput);
  const prisma = getPrisma();
  const current = await requireBatch(prisma, eventId, input.scheduleId);
  if (!canEditSchedule(current.status) || current.claimToken) {
    throw stateError("A schedule that has started sending, or has finished, cannot be edited. Cancel it and create a new schedule instead.");
  }
  if (current.revision !== input.expectedRevision) {
    throw stateError("Someone else changed this schedule. Reload it and review the new version before editing.");
  }
  const review = await buildScheduledEmailReview(eventId, permissions, input, options);
  if (review.reviewFingerprint !== input.previewFingerprint) throw previewChanged(review);
  if (review.eligibleCount === 0) {
    throw new MessagingError("EMPTY_AUDIENCE", "Nobody in this audience can receive this message, so there is nothing to schedule.", { review: toReviewView(review) });
  }
  const template = await loadTemplateSource(prisma, eventId, input.templateKey);
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.scheduledEmailBatch.updateMany({
      where: { id: input.scheduleId, eventId, revision: input.expectedRevision, status: { in: ["SCHEDULED", "PAUSED", "ACTIVE"] }, claimToken: null },
      data: {
        ...contentColumns(input, review),
        templateVersionId: template.versionId,
        revision: { increment: 1 },
        status: "SCHEDULED",
        activatedByUserId: null,
        activatedAt: null,
        pausedAt: null,
        pauseReason: null,
      },
    });
    if (changed.count !== 1) throw stateError("The schedule changed while you were editing it. Reload it and try again.");
    await tx.scheduledEmailRecipient.deleteMany({ where: { batchId: input.scheduleId, status: "PLANNED" } });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: AUDIT_ACTIONS.updated,
        entityType: "ScheduledEmailBatch",
        entityId: input.scheduleId,
        correlationId: randomUUID(),
        summary: "Edited a scheduled email batch. Its approval was withdrawn; it must be reviewed and approved again.",
        metadata: { fromRevision: input.expectedRevision, sendAt: review.projection.sendAt, eligibleCount: review.eligibleCount },
      },
    });
    return tx.scheduledEmailBatch.findUniqueOrThrow({ where: { id: input.scheduleId } });
  });
  return toRecord(prisma, updated);
}

/** The review of a stored schedule as it would be approved now: the thing the approver must be shown. */
export async function reviewStoredScheduledEmail(
  eventId: string,
  permissions: readonly string[],
  scheduleId: string,
  options: { now?: Date } = {},
): Promise<ScheduledEmailReviewView> {
  const row = await requireBatch(getPrisma(), eventId, scheduleId);
  return toReviewView(await buildScheduledEmailReview(eventId, permissions, storedContent(row), options));
}

function storedContent(row: BatchRow): ReviewContent & { name: string } {
  return {
    name: row.name,
    templateKey: row.templateKey as ScheduledEmailTemplateKey,
    announcementTitle: row.announcementTitle ?? "",
    announcementBody: row.announcementBody ?? "",
    rule: ruleFromColumns(row),
    query: row.audienceQuery,
  };
}

/**
 * Approval. The only thing that makes a schedule ACTIVE, and it is always an authorized person's own request: it
 * re-reviews the schedule as it stands, needs the fingerprint the approver was shown (PREVIEW_CHANGED otherwise), freezes
 * the reviewed recipients as the approved list, and records who approved and when. A paused schedule is approved the same
 * way, which is what "resume" means: a fresh review, never a quiet restart.
 */
export async function activateScheduledEmail(
  eventId: string,
  actorUserId: string,
  permissions: readonly string[],
  scheduleId: string,
  rawInput: unknown,
  options: { now?: Date } = {},
): Promise<{ schedule: ScheduledEmailRecord; replayed: boolean }> {
  const input = scheduledEmailActivateSchema.parse(rawInput);
  const prisma = getPrisma();
  const current = await requireBatch(prisma, eventId, scheduleId);
  if (current.status === "ACTIVE" && current.revision === input.expectedRevision && current.activatedByUserId === actorUserId) {
    return { schedule: await toRecord(prisma, current), replayed: true };
  }
  if (current.status !== "SCHEDULED" && current.status !== "PAUSED") {
    throw stateError(`A ${current.status.toLowerCase()} schedule cannot be approved.`);
  }
  if (current.claimToken) throw stateError("This schedule has already started sending.");
  if (current.revision !== input.expectedRevision) {
    throw stateError("The schedule changed since you reviewed it. Reload it and review the new version.");
  }

  const content = storedContent(current);
  const review = await buildScheduledEmailReview(eventId, permissions, content, options);
  if (review.reviewFingerprint !== input.previewFingerprint) throw previewChanged(review);
  if (review.eligibleCount === 0) {
    throw new MessagingError("EMPTY_AUDIENCE", "Nobody in this audience can receive this message any more, so it cannot be approved.", { review: toReviewView(review) });
  }
  const template = await loadTemplateSource(prisma, eventId, content.templateKey);
  const now = options.now ?? new Date();

  await serializable(async (tx) => {
    const changed = await tx.scheduledEmailBatch.updateMany({
      where: { id: scheduleId, eventId, revision: input.expectedRevision, status: { in: ["SCHEDULED", "PAUSED"] }, claimToken: null },
      data: {
        ...contentColumns(content, review),
        templateVersionId: template.versionId,
        status: "ACTIVE",
        activatedByUserId: actorUserId,
        activatedAt: now,
        pausedAt: null,
        pauseReason: null,
        failureReason: null,
      },
    });
    if (changed.count !== 1) throw stateError("The schedule changed while it was being approved. Reload it and review it again.");
    // The approved list: fixed here, so what happens at send time can only remove people from it, never add anyone.
    await tx.scheduledEmailRecipient.deleteMany({ where: { batchId: scheduleId, status: "PLANNED" } });
    await tx.scheduledEmailRecipient.createMany({
      data: review.targets.map((target) => ({
        batchId: scheduleId,
        eventId,
        registrationId: target.registrationId,
        recipientEmail: target.email,
        recipientName: target.name,
        roles: target.roles,
      })),
      skipDuplicates: true,
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: AUDIT_ACTIONS.activated,
        entityType: "ScheduledEmailBatch",
        entityId: scheduleId,
        correlationId: randomUUID(),
        summary: "Approved a scheduled email batch. It will be sent at its scheduled time unless it is paused or cancelled first.",
        metadata: {
          revision: input.expectedRevision,
          fingerprint: review.reviewFingerprint,
          sendAt: review.projection.sendAt,
          eventTimezone: review.projection.eventTimezone,
          dstBehavior: review.projection.dstBehavior,
          eligibleCount: review.eligibleCount,
          excludedCount: review.exclusionCount,
          deliveryMode: review.deliveryMode,
        },
      },
    });
  });
  return { schedule: await getScheduledEmail(eventId, scheduleId), replayed: false };
}

/**
 * Pause, only before a send has begun. The conditional update on the batch row is the same one a worker's claim makes,
 * so a pause either wins (the worker finds it paused) or loses (the batch is already claimed, and the answer says so).
 */
export async function pauseScheduledEmail(eventId: string, actorUserId: string, scheduleId: string): Promise<ScheduledEmailRecord> {
  const prisma = getPrisma();
  const paused = await prisma.scheduledEmailBatch.updateMany({
    where: { id: scheduleId, eventId, status: "ACTIVE", claimToken: null },
    data: { status: "PAUSED", pausedAt: new Date(), pauseReason: "Paused by staff." },
  });
  if (paused.count !== 1) {
    const row = await requireBatch(prisma, eventId, scheduleId);
    if (row.status === "PAUSED") return toRecord(prisma, row);
    if (row.status === "ACTIVE" && row.claimToken) {
      throw stateError("This schedule has already started sending, so it cannot be paused. Cancel it to stop the messages that have not gone out yet.");
    }
    throw stateError(`A ${row.status.toLowerCase()} schedule cannot be paused.`);
  }
  await prisma.auditLog.create({
    data: {
      eventId,
      actorUserId,
      action: AUDIT_ACTIONS.paused,
      entityType: "ScheduledEmailBatch",
      entityId: scheduleId,
      correlationId: randomUUID(),
      summary: "Paused a scheduled email batch before it was sent.",
      metadata: {},
    },
  });
  return getScheduledEmail(eventId, scheduleId);
}

/**
 * Cancel, before or after a send has begun. Before: nothing was queued, the batch just stops. After partial delivery:
 * messages already sent (or being sent) stay exactly as they are, and only what is still waiting is cancelled, in the
 * outbox and on the recipient rows, so the record never says a delivered message was cancelled.
 */
export async function cancelScheduledEmail(eventId: string, actorUserId: string, scheduleId: string): Promise<ScheduledEmailRecord> {
  const prisma = getPrisma();
  const outcome = await prisma.$transaction(async (tx) => {
    const stopped = await tx.scheduledEmailBatch.updateMany({
      where: { id: scheduleId, eventId, status: { in: ["SCHEDULED", "ACTIVE", "PAUSED"] } },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: actorUserId },
    });
    if (stopped.count !== 1) {
      const row = await requireBatch(tx, eventId, scheduleId);
      if (row.status === "CANCELLED") return { already: true, cancelledMessages: 0, cancelledRecipients: 0, keptMessages: 0 };
      throw stateError(`A ${row.status.toLowerCase()} schedule cannot be cancelled.`);
    }
    const cancelledMessages = await tx.messageOutbox.updateMany({
      where: { status: "PENDING", OR: [{ scheduledEmailRecipient: { batchId: scheduleId } }, { metadata: { path: ["scheduledEmailBatchId"], equals: scheduleId } }] },
      data: { status: "CANCELLED", lockedAt: null, lockToken: null, lastError: "The schedule was cancelled before this was sent." },
    });
    const cancelledRecipients = await tx.scheduledEmailRecipient.updateMany({
      where: { batchId: scheduleId, OR: [{ status: "PLANNED" }, { status: "QUEUED", message: { status: "CANCELLED" } }] },
      data: { status: "CANCELLED" },
    });
    const keptMessages = await tx.messageOutbox.count({
      where: { status: { not: "CANCELLED" }, scheduledEmailRecipient: { batchId: scheduleId } },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: AUDIT_ACTIONS.cancelled,
        entityType: "ScheduledEmailBatch",
        entityId: scheduleId,
        correlationId: randomUUID(),
        summary: "Cancelled a scheduled email batch. Messages already sent were left as they were; only the rest were cancelled.",
        metadata: { cancelledMessages: cancelledMessages.count, cancelledRecipients: cancelledRecipients.count, keptMessages },
      },
    });
    return { already: false, cancelledMessages: cancelledMessages.count, cancelledRecipients: cancelledRecipients.count, keptMessages };
  });
  void outcome;
  return getScheduledEmail(eventId, scheduleId);
}

/* ------------------------------------------------------------------------------------------------------------------
 * Send time
 * ---------------------------------------------------------------------------------------------------------------- */

/** The approver's permissions for this event right now; empty when the account or membership is gone or inactive. */
export async function loadApproverPermissions(client: Client, userId: string | null, eventId: string): Promise<string[]> {
  if (!userId) return [];
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, globalRole: true, accountStatus: true },
  });
  if (!user || user.accountStatus !== "ACTIVE") return [];
  const authUser = { id: user.id, email: user.email, displayName: user.displayName, globalRole: user.globalRole };
  if (user.globalRole === "SYSTEM_ADMIN") return effectivePermissions(authUser, null);
  const membership = await client.eventMembership.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { eventId: true, userId: true, role: true, status: true, permissions: true },
  });
  if (!membership || membership.status !== "ACTIVE") return [];
  return effectivePermissions(authUser, membership);
}

/** What the audience is now, for the registrations of reviewed recipients: the input of `decideRecipientEligibility`. */
async function buildCurrentView(
  client: Client,
  eventId: string,
  evaluated: Awaited<ReturnType<typeof evaluateEventAudience>>,
  reviewed: ReadonlyArray<{ registrationId: string; email: string; roles: readonly string[] }>,
): Promise<CurrentAudienceView> {
  const registrationIds = [...new Set(reviewed.map((recipient) => recipient.registrationId))];
  const [registrations, event] = await Promise.all([
    client.registration.findMany({ where: { eventId, id: { in: registrationIds } }, select: { id: true, status: true } }),
    loadEventFacts(client, eventId),
  ]);
  const targets = new Map<string, { balanceCents: number; roles: readonly string[] }>();
  const withTarget = new Set<string>();
  for (const recipient of evaluated.result.recipients) {
    for (const entry of recipient.registrations) {
      targets.set(targetKey(recipient.email, entry.registrationId), { balanceCents: entry.balanceCents, roles: entry.roles });
      withTarget.add(entry.registrationId);
    }
  }
  const exclusionByEmail = new Map<string, ScheduleExclusionCode>();
  for (const exclusion of evaluated.result.exclusions) {
    const code = builderExclusionCode(exclusion.code);
    if (code && exclusion.email) exclusionByEmail.set(exclusion.email, code);
  }
  return {
    targets,
    registrations: new Map(registrations.map((registration) => [registration.id, { active: registration.status === "SUBMITTED" || registration.status === "CONFIRMED" }] as const)),
    exclusionByEmail,
    registrationsWithOtherTarget: withTarget,
    // The reviewed recipients are what is being decided, so the youth check runs over them, not over what the audience lists.
    // Judged on the roles each recipient holds NOW (from the current audience), not those stored at approval, so a role that
    // lapsed (a group leader or organization contact who is no longer one) cannot vouch for a youth address.
    minorTargets: await findMinorTargets(client, eventId, reviewed.map((recipient) => ({
      ...recipient,
      roles: targets.get(targetKey(recipient.email, recipient.registrationId))?.roles ?? [],
    }))),
    isOrganizationBilled: event.billingMode === "DEFERRED_ORGANIZATION_INVOICE",
  };
}

/** A filter that is gone (stale, or the approver lost permission to use it) or an audience grown too broad: a stop, not a crash. */
function isFilterUnavailable(error: unknown) {
  return error instanceof AudienceFilterNotAvailableError || (error instanceof MessagingError && error.code === "AUDIENCE_TOO_BROAD");
}

export type ScheduledMessageObsolescence = { code: ScheduleExclusionCode; reason: string };

/**
 * Checked immediately before a scheduled message goes out (the way a lodging notice or an invoice email is): is this
 * recipient still someone the approved schedule should reach? It re-reads the reviewed recipient's registration through
 * the audience builder's own rules (status, contact, balance, opt-outs and bounces, minors) as the approver's current
 * permissions allow, and the batch's own state. Returns why not, or null to send. It throws when it cannot tell; the
 * caller retries instead of sending or cancelling on a guess.
 */
export async function scheduledEmailObsoleteReason(messageId: string, now = new Date()): Promise<ScheduledMessageObsolescence | null> {
  const prisma = getPrisma();
  const drop = (code: ScheduleExclusionCode) => ({ code, reason: SCHEDULE_EXCLUSION_LABELS[code] });
  const recipient = await prisma.scheduledEmailRecipient.findUnique({
    where: { outboxMessageId: messageId },
    include: { batch: true },
  });
  if (!recipient) {
    // A message that says it belongs to a schedule but is not linked to an approved recipient is never sent: fail closed.
    const message = await prisma.messageOutbox.findUnique({ where: { id: messageId }, select: { metadata: true } });
    const claimed = message?.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>).scheduledEmailBatchId
      : undefined;
    if (typeof claimed !== "string" || !claimed) return null;
    return drop("SCHEDULE_NOT_ACTIVE");
  }
  const { batch } = recipient;
  if (batch.status === "CANCELLED" || batch.status === "PAUSED" || batch.status === "FAILED" || batch.status === "SCHEDULED") {
    return drop("SCHEDULE_NOT_ACTIVE");
  }
  // A message that waited in the queue past its window, or past the moment it counts back from, is dropped, not sent late.
  if (now.getTime() - batch.sendAt.getTime() > SCHEDULED_EMAIL_MAX_LATE_MS) return drop("SCHEDULE_TOO_LATE");
  if (batch.anchorAt && now.getTime() >= batch.anchorAt.getTime()) return drop("ANCHOR_PASSED");
  const permissions = await loadApproverPermissions(prisma, batch.activatedByUserId, batch.eventId);
  if (!permissions.includes(MANAGE)) return drop("APPROVER_NOT_PERMITTED");

  let evaluated: Awaited<ReturnType<typeof evaluateEventAudience>>;
  try {
    evaluated = await evaluateEventAudience(batch.eventId, permissions, queryForTemplate(batch.templateKey as ScheduledEmailTemplateKey, batch.audienceQuery), {
      now,
      onlyRegistrationIds: [recipient.registrationId],
    });
  } catch (error) {
    // The audience's own filters can no longer be applied: the message is cancelled with a code, never sent and never retried forever.
    if (isFilterUnavailable(error)) return drop("FILTER_UNAVAILABLE");
    throw error;
  }
  const view = await buildCurrentView(prisma, batch.eventId, evaluated, [
    { registrationId: recipient.registrationId, email: recipient.recipientEmail, roles: recipient.roles },
  ]);
  const code = decideRecipientEligibility(
    { registrationId: recipient.registrationId, email: recipient.recipientEmail, roles: recipient.roles },
    batch.templateKey as ScheduledEmailTemplateKey,
    view,
    batch.trigger,
  );
  return code ? drop(code) : null;
}

/**
 * Ends a scheduled message that is no longer wanted: the outbox row becomes CANCELLED (only if it is still the row the
 * caller holds), the recipient row records the code, and one audit row records ids and the code, never the address.
 */
export async function cancelObsoleteScheduledMessage(
  client: Client,
  input: { messageId: string; eventId: string | null; code: ScheduleExclusionCode; reason: string; where?: Prisma.MessageOutboxWhereInput },
): Promise<boolean> {
  const cancelled = await client.messageOutbox.updateMany({
    where: { id: input.messageId, status: { in: ["PENDING", "PROCESSING"] }, ...(input.where ?? {}) },
    data: { status: "CANCELLED", lockedAt: null, lockToken: null, lastError: input.reason },
  });
  if (cancelled.count !== 1) return false;
  await client.scheduledEmailRecipient.updateMany({
    where: { outboxMessageId: input.messageId },
    data: { status: "EXCLUDED", exclusionCode: input.code },
  });
  await client.auditLog.create({
    data: {
      eventId: input.eventId,
      action: AUDIT_ACTIONS.recipientDropped,
      entityType: "MessageOutbox",
      entityId: input.messageId,
      correlationId: randomUUID(),
      summary: "Cancelled a scheduled email because the recipient was no longer eligible when it was about to be sent.",
      metadata: { messageId: input.messageId, code: input.code },
    },
  });
  return true;
}

export type ScheduledDispatchResult = {
  batchId: string;
  outcome: "completed" | "paused" | "failed" | "skipped" | "partial";
  queued: number;
  excluded: number;
  messageIds: string[];
  reason?: string;
};

/**
 * Pauses a claimed batch for a new review, releasing the claim. Only possible while nothing has been queued: once a message
 * exists (a worker queued some, stopped, and another took over) a pause would let the batch be edited or approved again
 * under messages already in the queue, so it is failed instead, which stops the rest and keeps what was sent.
 */
async function releaseAndPause(prisma: PrismaClient, batch: BatchRow, claimToken: string, reason: string): Promise<"paused" | "failed"> {
  const started = await prisma.scheduledEmailRecipient.count({ where: { batchId: batch.id, status: "QUEUED" } });
  if (started > 0) {
    await failBatch(prisma, batch, claimToken, `${reason} Some messages had already been queued, so this schedule cannot be paused; the rest were cancelled. Create a new schedule if it is still wanted.`);
    return "failed";
  }
  const paused = await prisma.scheduledEmailBatch.updateMany({
    where: { id: batch.id, claimToken, status: "ACTIVE" },
    data: { status: "PAUSED", pausedAt: new Date(), pauseReason: reason, claimToken: null, claimedAt: null },
  });
  if (paused.count === 1) {
    await prisma.auditLog.create({
      data: {
        eventId: batch.eventId,
        action: AUDIT_ACTIONS.paused,
        entityType: "ScheduledEmailBatch",
        entityId: batch.id,
        correlationId: randomUUID(),
        summary: "Paused a scheduled email batch at its send time because it needs a new review.",
        metadata: { reason },
      },
    });
  }
  return "paused";
}

async function failBatch(prisma: PrismaClient, batch: BatchRow, claimToken: string, reason: string) {
  const failed = await prisma.$transaction(async (tx) => {
    const updated = await tx.scheduledEmailBatch.updateMany({
      where: { id: batch.id, claimToken, status: "ACTIVE" },
      data: { status: "FAILED", failedAt: new Date(), failureReason: reason },
    });
    if (updated.count !== 1) return false;
    await tx.scheduledEmailRecipient.updateMany({ where: { batchId: batch.id, status: "PLANNED" }, data: { status: "CANCELLED" } });
    // What is still waiting is stopped too; what was sent stays sent.
    await tx.messageOutbox.updateMany({
      where: { status: "PENDING", OR: [{ scheduledEmailRecipient: { batchId: batch.id } }, { metadata: { path: ["scheduledEmailBatchId"], equals: batch.id } }] },
      data: { status: "CANCELLED", lockedAt: null, lockToken: null, lastError: "The schedule failed before this was sent." },
    });
    await tx.scheduledEmailRecipient.updateMany({ where: { batchId: batch.id, status: "QUEUED", message: { status: "CANCELLED" } }, data: { status: "CANCELLED" } });
    await tx.auditLog.create({
      data: {
        eventId: batch.eventId,
        action: AUDIT_ACTIONS.failed,
        entityType: "ScheduledEmailBatch",
        entityId: batch.id,
        correlationId: randomUUID(),
        summary: "A scheduled email batch could not be sent.",
        metadata: { reason },
      },
    });
    return true;
  });
  return failed;
}

/**
 * Sends one due, approved batch. Safe to call from several workers and to call again after a crash: the claim is a
 * conditional update, every recipient is a unique row, every message is an idempotent outbox upsert, and each chunk of
 * messages is queued in a transaction that first re-confirms this worker still holds the claim on an ACTIVE batch.
 *
 * Order: gates (the approver may still send, the schedule is not stale, the event's timing and the template are what was
 * reviewed), then the whole audience is re-evaluated and each approved recipient is kept or dropped with a code, then
 * the kept ones are queued. The outbox worker delivers them, re-checking each right before it sends.
 */
export async function runScheduledEmailBatch(batchId: string, options: { now?: Date; deadline?: number } = {}): Promise<ScheduledDispatchResult> {
  const now = options.now ?? new Date();
  const prisma = getPrisma();
  const claimToken = randomUUID();
  const claimed = await prisma.scheduledEmailBatch.updateMany({
    where: {
      id: batchId,
      status: "ACTIVE",
      sendAt: { lte: now },
      OR: [
        { claimToken: null },
        { claimedAt: { lt: new Date(now.getTime() - SCHEDULED_EMAIL_STALE_CLAIM_MS) }, recipients: { some: { status: "PLANNED" } } },
      ],
    },
    data: { claimToken, claimedAt: now },
  });
  if (claimed.count !== 1) return { batchId, outcome: "skipped", queued: 0, excluded: 0, messageIds: [] };
  const batch = await prisma.scheduledEmailBatch.findUniqueOrThrow({ where: { id: batchId } });
  const result: ScheduledDispatchResult = { batchId, outcome: "completed", queued: 0, excluded: 0, messageIds: [] };

  // 1. Gates. Each one stops the send; none of them sends anything on a guess.
  const permissions = await loadApproverPermissions(prisma, batch.activatedByUserId, batch.eventId);
  if (!permissions.includes(MANAGE)) {
    const stopped = await releaseAndPause(prisma, batch, claimToken, "The person who approved this schedule no longer has permission to send it. Someone with permission must review and approve it again.");
    return { ...result, outcome: stopped, reason: "APPROVER_NOT_PERMITTED" };
  }
  if (now.getTime() - batch.sendAt.getTime() > SCHEDULED_EMAIL_MAX_LATE_MS) {
    await failBatch(prisma, batch, claimToken, "The schedule was not sent within six hours of its time, so it was not sent at all. Create a new schedule if it is still wanted.");
    return { ...result, outcome: "failed", reason: "MISSED_WINDOW" };
  }
  const rule = ruleFromColumns(batch);
  const event = await loadEventFacts(prisma, batch.eventId);
  let stale = false;
  try {
    stale = eventTimingChanged(batch, projectSchedule(rule, event));
  } catch {
    stale = true;
  }
  if (stale) {
    const stopped = await releaseAndPause(prisma, batch, claimToken, "The event's time zone, dates or payment due date changed after this was approved, so its send time is no longer the one that was reviewed. Review the new time and approve it again.");
    return { ...result, outcome: stopped, reason: "EVENT_TIMING_CHANGED" };
  }
  const template = await loadTemplateSource(prisma, batch.eventId, batch.templateKey as ScheduledEmailTemplateKey).catch(() => null);
  if (!template || template.versionId !== batch.templateVersionId) {
    const stopped = await releaseAndPause(prisma, batch, claimToken, "The message template was published again after this was approved. Review the current wording and approve it again.");
    return { ...result, outcome: stopped, reason: "TEMPLATE_CHANGED" };
  }

  // 2. Re-evaluate every approved recipient against the audience as it is now.
  const planned = await prisma.scheduledEmailRecipient.findMany({
    where: { batchId, status: "PLANNED" },
    orderBy: [{ registrationId: "asc" }, { recipientEmail: "asc" }],
    select: { id: true, registrationId: true, recipientEmail: true, recipientName: true, roles: true },
  });
  let evaluated: Awaited<ReturnType<typeof evaluateEventAudience>>;
  try {
    evaluated = await evaluateEventAudience(batch.eventId, permissions, queryForTemplate(batch.templateKey as ScheduledEmailTemplateKey, batch.audienceQuery), { now });
  } catch (error) {
    if (!isFilterUnavailable(error)) throw error;
    const stopped = await releaseAndPause(prisma, batch, claimToken, "A filter this schedule uses is no longer available: it changed, the audience grew too large to check, or the approver no longer has permission to use it. Review the schedule's audience and approve it again.");
    return { ...result, outcome: stopped, reason: "FILTER_UNAVAILABLE" };
  }
  const view = await buildCurrentView(
    prisma,
    batch.eventId,
    evaluated,
    planned.map((recipient) => ({ registrationId: recipient.registrationId, email: recipient.recipientEmail, roles: recipient.roles })),
  );
  const keep: typeof planned = [];
  const dropped = new Map<ScheduleExclusionCode, string[]>();
  for (const recipient of planned) {
    const code = decideRecipientEligibility(
      { registrationId: recipient.registrationId, email: recipient.recipientEmail, roles: recipient.roles },
      batch.templateKey as ScheduledEmailTemplateKey,
      view,
      batch.trigger,
    );
    if (!code) {
      keep.push(recipient);
      continue;
    }
    dropped.set(code, [...(dropped.get(code) ?? []), recipient.id]);
  }
  for (const [code, ids] of dropped) {
    const marked = await prisma.scheduledEmailRecipient.updateMany({ where: { id: { in: ids }, status: "PLANNED" }, data: { status: "EXCLUDED", exclusionCode: code } });
    result.excluded += marked.count;
  }
  if (result.excluded > 0) {
    await prisma.auditLog.create({
      data: {
        eventId: batch.eventId,
        action: AUDIT_ACTIONS.recipientDropped,
        entityType: "ScheduledEmailBatch",
        entityId: batch.id,
        correlationId: randomUUID(),
        summary: "Dropped approved recipients that were no longer eligible when the scheduled email was due.",
        metadata: { counts: Object.fromEntries([...dropped.entries()].map(([code, ids]) => [code, ids.length])) },
      },
    });
  }

  // 3. Queue the rest, a chunk per transaction, each re-confirming the claim.
  const deliveryMode = await loadDeliveryMode(prisma, batch.eventId);
  for (let offset = 0; offset < keep.length; offset += SEND_CHUNK_SIZE) {
    const chunk = keep.slice(offset, offset + SEND_CHUNK_SIZE);
    const queued = await prisma.$transaction(async (tx) => {
      const held = await tx.scheduledEmailBatch.updateMany({
        where: { id: batchId, claimToken, status: "ACTIVE" },
        data: { claimedAt: new Date() },
      });
      if (held.count !== 1) return null;
      const ids: string[] = [];
      for (const recipient of chunk) {
        const message = await enqueueSelectedAudienceMessage(tx, {
          eventId: batch.eventId,
          registrationId: recipient.registrationId,
          templateKey: batch.templateKey as "BALANCE_REMINDER" | "EVENT_ANNOUNCEMENT" | "CUSTOM_MESSAGE",
          batchId: batch.id,
          correlationId: batch.id,
          recipientEmail: recipient.recipientEmail,
          recipientName: recipient.recipientName,
          announcementTitle: batch.templateKey === "EVENT_ANNOUNCEMENT" ? batch.announcementTitle ?? undefined : undefined,
          announcementBody: batch.templateKey === "EVENT_ANNOUNCEMENT" ? batch.announcementBody ?? undefined : undefined,
          metadata: {
            trigger: "SCHEDULED_EMAIL_BATCH",
            scheduledEmailBatchId: batch.id,
            scheduledEmailRecipientId: recipient.id,
            selectedTemplateKey: batch.templateKey,
          },
        });
        const messageId = message.messageIds[0];
        if (!messageId) {
          await tx.scheduledEmailRecipient.updateMany({ where: { id: recipient.id, status: "PLANNED" }, data: { status: "EXCLUDED", exclusionCode: "NO_EMAIL" } });
          continue;
        }
        const marked = await tx.scheduledEmailRecipient.updateMany({
          where: { id: recipient.id, status: "PLANNED" },
          data: { status: "QUEUED", outboxMessageId: messageId },
        });
        if (marked.count === 1) ids.push(messageId);
      }
      return ids;
    }, { timeout: BATCH_TRANSACTION_TIMEOUT_MS, maxWait: BATCH_TRANSACTION_MAX_WAIT_MS });
    if (queued === null) {
      // Paused, cancelled or taken over: stop at once and leave every other row exactly as it is.
      return { ...result, outcome: "partial", reason: "CLAIM_LOST" };
    }
    result.queued += queued.length;
    result.messageIds.push(...queued);
  }

  // 4. Everything is queued or dropped. The batch stays ACTIVE (sending), and cancellable, until nothing it queued is
  // still waiting; the messages are now ordinary outbox rows. A local-capture event captures right away, and real email
  // is delivered by the outbox worker that follows the sweep.
  if (deliveryMode === "LOCAL_CAPTURE" && result.messageIds.length > 0) {
    // Past the time budget the rest stay queued; the sweep's own queue pass captures them next time.
    await captureMessageIdsLocally(result.messageIds, { deadline: options.deadline }).catch((error: unknown) => {
      logError("Capturing scheduled email locally failed; the outbox sweep will retry.", error);
    });
  }
  if (await finalizeScheduledEmailIfDone(prisma, batchId, new Date())) result.outcome = "completed";
  else result.outcome = "partial";
  return result;
}

/**
 * COMPLETED means nothing is left to do: no approved recipient is waiting to be queued and no queued message is still
 * waiting or being sent. Until then the batch is ACTIVE (sending) and can still be cancelled, which stops exactly what
 * has not gone out. Safe to call repeatedly; only the call that finds it finished records it.
 */
export async function finalizeScheduledEmailIfDone(client: Client, batchId: string, now: Date): Promise<boolean> {
  const batch = await client.scheduledEmailBatch.findUnique({ where: { id: batchId }, select: { id: true, eventId: true, status: true, claimToken: true } });
  if (!batch || batch.status !== "ACTIVE" || !batch.claimToken) return false;
  const [planned, waiting] = await Promise.all([
    client.scheduledEmailRecipient.count({ where: { batchId, status: "PLANNED" } }),
    client.messageOutbox.count({ where: { status: { in: ["PENDING", "PROCESSING"] }, scheduledEmailRecipient: { batchId } } }),
  ]);
  if (planned > 0 || waiting > 0) return false;
  const done = await client.scheduledEmailBatch.updateMany({
    where: { id: batchId, status: "ACTIVE", claimToken: batch.claimToken },
    data: { status: "COMPLETED", completedAt: now },
  });
  if (done.count !== 1) return false;
  const [queued, excluded] = await Promise.all([
    client.scheduledEmailRecipient.count({ where: { batchId, status: "QUEUED" } }),
    client.scheduledEmailRecipient.count({ where: { batchId, status: "EXCLUDED" } }),
  ]);
  await client.auditLog.create({
    data: {
      eventId: batch.eventId,
      action: AUDIT_ACTIONS.completed,
      entityType: "ScheduledEmailBatch",
      entityId: batchId,
      correlationId: randomUUID(),
      summary: "Every approved recipient of a scheduled email batch was sent, dropped or cancelled.",
      metadata: { queued, excluded },
    },
  });
  return true;
}

/** Records every sending batch whose messages have all left the queue. Run by the sweep after delivery. */
export async function finalizeFinishedScheduledEmails(now = new Date()): Promise<number> {
  const prisma = getPrisma();
  const running = await prisma.scheduledEmailBatch.findMany({
    where: { status: "ACTIVE", claimToken: { not: null } },
    select: { id: true },
    take: 100,
  });
  let finished = 0;
  for (const { id } of running) if (await finalizeScheduledEmailIfDone(prisma, id, now)) finished += 1;
  return finished;
}

/** Every approved batch that is due, oldest first. A failure in one batch is logged and never stops the others. */
export async function dispatchDueScheduledEmails(options: { now?: Date; limit?: number; budgetMs?: number } = {}): Promise<ScheduledDispatchResult[]> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const prisma = getPrisma();
  const due = await prisma.scheduledEmailBatch.findMany({
    where: {
      status: "ACTIVE",
      sendAt: { lte: now },
      // A claim taken over is one whose worker stopped with recipients still to queue; a batch that has queued everyone
      // and is only waiting for delivery has nothing to run.
      OR: [
        { claimToken: null },
        { claimedAt: { lt: new Date(now.getTime() - SCHEDULED_EMAIL_STALE_CLAIM_MS) }, recipients: { some: { status: "PLANNED" } } },
      ],
    },
    orderBy: [{ sendAt: "asc" }, { id: "asc" }],
    take: options.limit ?? 20,
    select: { id: true },
  });
  const results: ScheduledDispatchResult[] = [];
  for (const { id } of due) {
    // No new batch is started once the time budget is spent; it stays due for the next sweep.
    if (options.budgetMs !== undefined && Date.now() - startedAt >= options.budgetMs) break;
    try {
      results.push(await runScheduledEmailBatch(id, { now, deadline: options.budgetMs === undefined ? undefined : startedAt + options.budgetMs }));
    } catch (error) {
      logError("A scheduled email batch could not be run; it will be retried.", error);
      results.push({ batchId: id, outcome: "skipped", queued: 0, excluded: 0, messageIds: [], reason: "ERROR" });
    }
  }
  return results;
}
