import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  IN_SCOPE_STATUSES,
  LATE_ADDITION_GRACE_MS,
  reviewPending,
  rosterMismatchReasons,
  type PromoSource,
  RECONCILIATION_RULE_VERSION,
  blockerReasonLabel,
  filterResultByLocation,
  fingerprintInput,
  planCorrection,
  reconcileEvent,
  responsibilityBlockers,
  versionFreshness,
  type CorrectionKind,
  type CreditSource,
  type GroupSource,
  type PersonSource,
  type ReconciliationResult,
  type RegistrationSource,
  type ResponsibilityBlocker,
  type VersionStatus,
} from "@/modules/attendance-reconciliation/domain";
import { getBillingResponsibilityView } from "@/modules/billing-responsibility/repository";
import { lineLabel } from "@/modules/billing-responsibility/domain";
import { moneyToCents } from "@/modules/payments/square-domain";
import { storedRegistrationResponses } from "@/modules/registrations/amendments-repository";

/**
 * Reviewed attendance and billable-unit reconciliation (#166). Every function takes the event the
 * caller was authorized for (MANAGE_FINANCE is checked by the route or page) and refuses a
 * registration, attendee or version that does not belong to that event. Audit entries carry ids
 * and counts only. Nothing here finalizes, numbers or sends an invoice (#167, #168).
 */

export type AttendanceReconciliationErrorCode =
  | "EVENT_NOT_FOUND"
  | "NOT_DEFERRED_EVENT"
  | "ATTENDEE_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "NO_CHANGE"
  | "NOTHING_TO_CLEAR"
  | "RESPONSIBILITY_NOT_READY"
  | "NOTHING_TO_RECONCILE"
  | "FACTS_CHANGED"
  | "REVIEW_REQUIRED"
  | "REGISTRATION_NOT_FOUND"
  | "NO_REVIEW_NEEDED"
  | "VERSION_SUPERSEDED"
  | "CONCURRENT_CHANGE";

export class AttendanceReconciliationError extends Error {
  constructor(
    message: string,
    public readonly code: AttendanceReconciliationErrorCode,
    public readonly blockers: ResponsibilityBlocker[] = [],
  ) {
    super(message);
    this.name = "AttendanceReconciliationError";
  }
}

type Client = Prisma.TransactionClient | PrismaClient;

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const concurrent = () => new AttendanceReconciliationError("Someone else just changed this. Reload and try again.", "CONCURRENT_CHANGE");

async function requireDeferredEvent(client: Client, eventId: string) {
  const event = await client.event.findUnique({ where: { id: eventId }, select: { id: true, billingMode: true, invoiceGrouping: true } });
  if (!event) throw new AttendanceReconciliationError("That event does not exist.", "EVENT_NOT_FOUND");
  if (event.billingMode !== "DEFERRED_ORGANIZATION_INVOICE") {
    throw new AttendanceReconciliationError("This event is not billed to organizations after the event.", "NOT_DEFERRED_EVENT");
  }
  return event;
}

// ---------------------------------------------------------------------------------------------
// Source facts
// ---------------------------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const personName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim();

function attendeeName(attendee: { profileSnapshot: unknown; person: { firstName: string; lastName: string } }) {
  const profile = record(attendee.profileSnapshot);
  const first = typeof profile.firstName === "string" ? profile.firstName : attendee.person.firstName;
  const last = typeof profile.lastName === "string" ? profile.lastName : attendee.person.lastName;
  return `${first} ${last}`.trim() || "Attendee";
}

/** The credit fields of a form definition, by field key (#409's per-unit credit, such as a meal sponsorship). */
function creditFields(definition: unknown) {
  const fields = new Map<string, { centsPerUnit: number; capAtHeadcount: boolean }>();
  const sections = record(definition).sections;
  if (!Array.isArray(sections)) return fields;
  for (const section of sections) {
    const list = record(section).fields;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const field = record(raw);
      if (typeof field.key === "string" && typeof field.creditCentsPerUnit === "number" && field.creditCentsPerUnit < 0) {
        fields.set(field.key, { centsPerUnit: field.creditCentsPerUnit, capAtHeadcount: field.capUnitsAtAttendeeCount === true });
      }
    }
  }
  return fields;
}

const factsSelect = {
  id: true,
  confirmationCode: true,
  status: true,
  totalAmount: true,
  submittedAt: true,
  createdAt: true,
  locationId: true,
  location: { select: { name: true } },
  accountHolderPerson: { select: { firstName: true, lastName: true } },
  clubRegistration: { select: { organization: { select: { id: true, name: true } } } },
  attendees: {
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      createdAt: true,
      profileSnapshot: true,
      person: { select: { firstName: true, lastName: true } },
      checkIns: { where: { undoneAt: null }, select: { id: true } },
      attendanceCorrections: {
        where: { supersededAt: null },
        select: { id: true, kind: true },
      },
    },
  },
  adjustments: { select: { amountCents: true, registrationAttendeeId: true } },
  publicFormSubmission: { select: { responses: true, pricingSnapshot: true, createdAt: true, formVersion: { select: { definition: true } } } },
  operations: { where: { type: "AMENDMENT" }, orderBy: { createdAt: "desc" }, take: 1, select: { afterSnapshot: true, createdAt: true } },
  promoCodeRedemption: {
    select: { codeSnapshot: true, discountTypeSnapshot: true, discountValueSnapshot: true, maximumDiscountCentsSnapshot: true, discountAmountCents: true },
  },
} satisfies Prisma.RegistrationSelect;

type FactsRow = Prisma.RegistrationGetPayload<{ select: typeof factsSelect }>;

/** What the reconciliation knows about the registrations beyond the registration rows themselves. */
type SourceContext = {
  substitutedAttendeeIds: ReadonlySet<string>;
  /** Approved member transfers that touched each registration, with when they were decided. */
  transfersByRegistration: ReadonlyMap<string, Array<{ id: string; decidedAt: Date | null }>>;
  /** Roster-review acknowledgements by registration, as review key to acknowledgement id. */
  acknowledgements: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

function sourceFor(row: FactsRow, context: SourceContext): { source: RegistrationSource; reviewKey: string | null } {
  const substitutedAttendeeIds = context.substitutedAttendeeIds;
  const amended = record(record(row.operations[0]?.afterSnapshot).pricingSnapshot);
  const snapshot = Object.keys(amended).length > 0 ? amended : record(row.publicFormSubmission?.pricingSnapshot);
  const lines = (Array.isArray(snapshot.lineItems) ? snapshot.lineItems.map(record) : [])
    .filter((line) => typeof line.amountCents === "number");
  const definitionCredits = creditFields(row.publicFormSubmission?.formVersion.definition);
  const responses = storedRegistrationResponses(row);
  const submittedAt = (row.submittedAt ?? row.createdAt).getTime();

  const people: PersonSource[] = row.attendees.map((attendee, index) => {
    const own = lines.filter((line) => line.attendeeIndex === index);
    const correction = attendee.attendanceCorrections[0] ?? null;
    return {
      attendeeId: attendee.id,
      name: attendeeName(attendee),
      checkedIn: attendee.checkIns.length > 0,
      correction: correction && correction.kind !== "CLEAR" ? { id: correction.id, kind: correction.kind } : null,
      addedAfterSubmission: attendee.createdAt.getTime() > submittedAt + LATE_ADDITION_GRACE_MS,
      substituted: substitutedAttendeeIds.has(attendee.id),
      chargeCents: own.reduce((total, line) => total + (line.amountCents as number), 0),
      lateRate: own.some((line) => typeof line.pricingLabel === "string"),
      adjustmentCents: row.adjustments
        .filter((adjustment) => adjustment.registrationAttendeeId === attendee.id)
        .reduce((total, adjustment) => total + adjustment.amountCents, 0),
    };
  });

  const registrationLines = lines.filter((line) => typeof line.attendeeIndex !== "number");
  const credits: CreditSource[] = registrationLines
    .filter((line) => (line.amountCents as number) < 0)
    .map((line) => {
      const key = typeof line.key === "string" ? line.key : "";
      const definition = definitionCredits.get(key);
      const entered = responses[key];
      return {
        key,
        label: typeof line.label === "string" ? line.label : "Credit",
        centsPerUnit: definition?.centsPerUnit ?? null,
        rawUnits: definition ? Math.max(0, Math.trunc(Number(entered) || 0)) : null,
        capAtHeadcount: definition?.capAtHeadcount ?? false,
        recordedCents: line.amountCents as number,
      };
    });
  // Prices are matched to people by their place on the roster; a member transfer shifts places.
  const pricedAt = row.operations[0]?.createdAt ?? row.publicFormSubmission?.createdAt ?? row.createdAt;
  const transfersAfterPricing = (context.transfersByRegistration.get(row.id) ?? []).filter((move) => move.decidedAt === null || move.decidedAt > pricedAt);
  const reasons = rosterMismatchReasons({
    priceLines: lines.flatMap((line) => (typeof line.attendeeIndex === "number"
      ? [{ attendeeIndex: line.attendeeIndex, attendeeLabel: typeof line.attendeeLabel === "string" ? line.attendeeLabel : null }]
      : [])),
    attendees: people.map((person) => ({ name: person.name, substituted: person.substituted })),
    transfersAfterPricing: transfersAfterPricing.length,
  });
  const reviewKey = reasons.length > 0
    ? `${reasons.join(",")}|${pricedAt.toISOString()}|${transfersAfterPricing.map((move) => move.id).sort().join(",")}`
    : null;
  const acknowledgementId = reviewKey ? context.acknowledgements.get(row.id)?.get(reviewKey) ?? null : null;

  // A whole-registration promo code is the redemption; per-person codes are adjustment rows, counted with the adjustments.
  const recordedDiscount = typeof snapshot.discountAmountCents === "number" ? snapshot.discountAmountCents : row.promoCodeRedemption?.discountAmountCents ?? 0;
  const redemption = row.promoCodeRedemption;
  const promo: PromoSource | null = redemption && recordedDiscount > 0
    ? {
        code: redemption.codeSnapshot,
        type: redemption.discountTypeSnapshot,
        value: redemption.discountValueSnapshot,
        maximumDiscountCents: redemption.maximumDiscountCentsSnapshot,
        recordedCents: recordedDiscount,
      }
    : null;

  const source: RegistrationSource = {
    registrationId: row.id,
    confirmationCode: row.confirmationCode,
    status: row.status,
    label: row.clubRegistration?.organization.name ?? personName(row.accountHolderPerson),
    clubId: row.clubRegistration?.organization.id ?? null,
    locationId: row.locationId,
    locationName: row.location?.name ?? null,
    estimatedCents: moneyToCents(row.totalAmount),
    people,
    registrationCharges: registrationLines
      .filter((line) => (line.amountCents as number) > 0)
      .map((line) => ({ label: typeof line.label === "string" ? line.label : "Charge", cents: line.amountCents as number })),
    credits,
    promo,
    review: reasons.length > 0 ? { reasons, acknowledged: acknowledgementId !== null, acknowledgementId } : null,
    // Whole-registration adjustments only; a person's own are counted with that person, and only when they attended.
    registrationAdjustmentCents: row.adjustments
      .filter((adjustment) => adjustment.registrationAttendeeId === null)
      .reduce((total, adjustment) => total + adjustment.amountCents, 0),
    hasPriceLines: lines.length > 0,
  };
  return { source, reviewKey };
}

/**
 * The facts for the whole event (never filtered by location, so a reconciliation is one thing for
 * the event): registrations grouped the way the Billing responsibility screen (#165) groups them,
 * with the RECORDED responsible party. Registrations that are not billed (waitlisted, cancelled)
 * are out of scope.
 */
export async function loadReconciliationFacts(client: Client, eventId: string) {
  const event = await requireDeferredEvent(client, eventId);
  const billing = await getBillingResponsibilityView(eventId);
  const rows = await client.registration.findMany({
    where: { eventId, status: { in: [...IN_SCOPE_STATUSES] } },
    select: factsSelect,
    orderBy: { confirmationCode: "asc" },
  });
  const substitutions = await client.registrationOperation.findMany({
    where: { eventId, type: "ATTENDEE_SUBSTITUTION", registrationId: { in: rows.map((row) => row.id) } },
    select: { attendeeId: true },
  });
  const substituted = new Set(substitutions.flatMap((entry) => (entry.attendeeId ? [entry.attendeeId] : [])));
  const registrationIds = rows.map((row) => row.id);
  const moves = await client.memberTransferRegistrationMove.findMany({
    where: { eventId, status: "APPROVED", OR: [{ fromRegistrationId: { in: registrationIds } }, { toRegistrationId: { in: registrationIds } }] },
    select: { id: true, fromRegistrationId: true, toRegistrationId: true, decidedAt: true },
  });
  const transfersByRegistration = new Map<string, Array<{ id: string; decidedAt: Date | null }>>();
  for (const move of moves) {
    for (const registrationId of new Set([move.fromRegistrationId, move.toRegistrationId])) {
      if (!registrationId) continue;
      transfersByRegistration.set(registrationId, [...(transfersByRegistration.get(registrationId) ?? []), { id: move.id, decidedAt: move.decidedAt }]);
    }
  }
  const acknowledgementRows = await client.attendanceReviewAcknowledgement.findMany({
    where: { eventId },
    select: { id: true, registrationId: true, reviewKey: true },
  });
  const acknowledgements = new Map<string, Map<string, string>>();
  for (const entry of acknowledgementRows) {
    acknowledgements.set(entry.registrationId, (acknowledgements.get(entry.registrationId) ?? new Map()).set(entry.reviewKey, entry.id));
  }
  const context: SourceContext = { substitutedAttendeeIds: substituted, transfersByRegistration, acknowledgements };
  const built = new Map(rows.map((row) => [row.id, sourceFor(row, context)]));
  const byId = new Map([...built].map(([id, entry]) => [id, entry.source]));
  const reviewKeys = new Map([...built].flatMap(([id, entry]) => (entry.reviewKey ? [[id, entry.reviewKey] as const] : [])));

  const blockers = responsibilityBlockers(billing.groups.flatMap((group) => group.lines.map((line) => ({
    registrationId: line.registrationId,
    confirmationCode: line.confirmationCode,
    label: lineLabel(line),
    status: line.status,
    recorded: line.recorded,
    outdated: line.outdated,
    unresolved: group.party.kind === "UNRESOLVED",
  }))));

  const groups: GroupSource[] = [];
  for (const group of billing.groups) {
    const registrations = group.lines.flatMap((line) => {
      const source = byId.get(line.registrationId);
      return source ? [source] : [];
    });
    if (registrations.length === 0) continue;
    groups.push({
      key: group.key,
      title: group.party.kind === "UNRESOLVED" ? "Unresolved" : group.title,
      partyKind: group.party.kind,
      partyId: group.party.kind === "UNRESOLVED" ? null : group.party.id,
      partyName: group.party.kind === "UNRESOLVED" ? "Unresolved" : group.party.name,
      clubId: group.clubId,
      registrations,
    });
  }
  const result = reconcileEvent(groups, event.invoiceGrouping);
  const fingerprint = createHash("sha256").update(fingerprintInput(result)).digest("hex");
  return { event, result, fingerprint, blockers, reviewPending: reviewPending(result), reviewKeys };
}

/** One lock per event for everything that changes or approves the reconciliation, so it is one thing at a time. */
async function lockEvent(tx: Prisma.TransactionClient, eventId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`attendance-reconciliation:${eventId}`}))`;
}

const LONG_TRANSACTION = { timeout: 30_000, maxWait: 10_000 } as const;

// ---------------------------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------------------------

/**
 * Staff correct one registered person's attendance: marked attended (came, missed at check-in),
 * marked not attended (checked in by mistake), or withdraw an earlier correction. A reason is
 * required and the actor recorded; a correction is appended and supersedes the person's previous
 * one, never edited. A correction that would change nothing is refused. The write is safe against
 * two staff acting at once (the database keeps one active correction per person).
 */
export async function recordAttendanceCorrection(input: {
  eventId: string;
  attendeeId: string;
  kind: CorrectionKind;
  reason: string;
  actorUserId: string;
}) {
  const reason = input.reason.trim();
  if (!reason) throw new AttendanceReconciliationError("Say why you are correcting this person's attendance.", "NO_CHANGE");
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      await requireDeferredEvent(tx, input.eventId);
      await lockEvent(tx, input.eventId);
      const attendee = await tx.registrationAttendee.findFirst({
        where: { id: input.attendeeId, eventId: input.eventId, registration: { eventId: input.eventId, status: { in: [...IN_SCOPE_STATUSES] } } },
        select: { id: true, registrationId: true },
      });
      if (!attendee) throw new AttendanceReconciliationError("That person is not on a billed registration for this event.", "ATTENDEE_NOT_FOUND");
      const checkedIn = Boolean(await tx.checkIn.findFirst({ where: { registrationAttendeeId: attendee.id, undoneAt: null }, select: { id: true } }));
      const active = await tx.attendanceCorrection.findFirst({
        where: { registrationAttendeeId: attendee.id, supersededAt: null },
        select: { id: true, kind: true },
      });
      const plan = planCorrection(
        { checkedIn, correction: active && active.kind !== "CLEAR" ? { id: active.id, kind: active.kind } : null },
        input.kind,
      );
      if (!plan.ok) {
        throw new AttendanceReconciliationError(
          plan.error === "NOTHING_TO_CLEAR"
            ? "There is no staff correction to withdraw for this person."
            : input.kind === "MARK_ATTENDED"
              ? "This person already counts as attended."
              : "This person already counts as not attended.",
          plan.error,
        );
      }
      const id = randomUUID();
      const now = new Date();
      if (active) {
        // Supersede first: the database allows one active correction per person.
        const result = await tx.attendanceCorrection.updateMany({
          where: { id: active.id, supersededAt: null },
          data: { supersededAt: now, supersededByCorrectionId: id },
        });
        if (result.count === 0) throw concurrent();
      }
      await tx.attendanceCorrection.create({
        data: {
          id,
          eventId: input.eventId,
          registrationId: attendee.registrationId,
          registrationAttendeeId: attendee.id,
          kind: input.kind,
          reason,
          actorUserId: input.actorUserId,
          createdAt: now,
        },
      });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "ATTENDANCE_CORRECTED",
        entityType: "AttendanceCorrection",
        entityId: id,
        summary: input.kind === "MARK_ATTENDED"
          ? "Marked a registered person as attended."
          : input.kind === "MARK_NOT_ATTENDED" ? "Marked a registered person as not attended." : "Withdrew an attendance correction.",
        metadata: { eventId: input.eventId, registrationId: attendee.registrationId, attendeeId: attendee.id, kind: input.kind, supersededCorrectionId: active?.id ?? null },
      }, tx);
      return { correctionId: id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw concurrent();
    throw error;
  }
}

/**
 * Staff acknowledge that a registration's prices may not belong to the people now on its roster
 * (a member was transferred after pricing). That registration is billed on its prorated estimate,
 * and approval waits for this record. A reason is required and the actor recorded; it is append-only
 * and names exactly the mismatch seen, so a later transfer needs a new acknowledgement. Idempotent.
 */
export async function acknowledgeRosterReview(input: { eventId: string; registrationId: string; reason: string; actorUserId: string }) {
  const reason = input.reason.trim();
  if (!reason) throw new AttendanceReconciliationError("Say why you accept the prorated figure for this registration.", "NO_CHANGE");
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      await requireDeferredEvent(tx, input.eventId);
      await lockEvent(tx, input.eventId);
      const facts = await loadReconciliationFacts(tx, input.eventId);
      const registration = facts.result.groups.flatMap((group) => group.registrations).find((entry) => entry.registrationId === input.registrationId);
      if (!registration) throw new AttendanceReconciliationError("That registration is not a billed registration of this event.", "REGISTRATION_NOT_FOUND");
      const reviewKey = facts.reviewKeys.get(input.registrationId);
      if (!registration.review || !reviewKey) throw new AttendanceReconciliationError("This registration does not need a roster review.", "NO_REVIEW_NEEDED");
      if (registration.review.acknowledged) return { changed: false as const, acknowledgementId: registration.review.acknowledgementId };
      const created = await tx.attendanceReviewAcknowledgement.create({
        data: { eventId: input.eventId, registrationId: input.registrationId, reviewKey, reason, actorUserId: input.actorUserId },
        select: { id: true },
      });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "ATTENDANCE_ROSTER_REVIEW_ACKNOWLEDGED",
        entityType: "AttendanceReviewAcknowledgement",
        entityId: created.id,
        summary: "Acknowledged that a registration's roster changed after pricing.",
        metadata: { eventId: input.eventId, registrationId: input.registrationId, reasons: registration.review.reasons },
      }, tx);
      return { changed: true as const, acknowledgementId: created.id };
    }, LONG_TRANSACTION);
  } catch (error) {
    if (isUniqueViolation(error)) throw concurrent();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

const versionSelect = {
  id: true,
  versionNumber: true,
  status: true,
  fingerprint: true,
  ruleVersion: true,
  invoiceGrouping: true,
  registeredCount: true,
  checkedInCount: true,
  noShowCount: true,
  addedByStaffCount: true,
  removedByStaffCount: true,
  billableCount: true,
  estimatedCents: true,
  billableCents: true,
  createdAt: true,
  approvedAt: true,
  supersededAt: true,
  preparedBy: { select: { displayName: true } },
  approvedBy: { select: { displayName: true } },
} satisfies Prisma.AttendanceReconciliationVersionSelect;

type VersionRow = Prisma.AttendanceReconciliationVersionGetPayload<{ select: typeof versionSelect }>;

export type VersionSummary = {
  id: string;
  versionNumber: number;
  status: VersionStatus;
  fingerprint: string;
  ruleVersion: string;
  counts: { registered: number; checkedIn: number; noShow: number; addedByStaff: number; removedByStaff: number; billable: number };
  estimatedCents: number;
  billableCents: number;
  preparedAt: string;
  preparedByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  supersededAt: string | null;
};

function toSummary(row: VersionRow): VersionSummary {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    status: row.status,
    fingerprint: row.fingerprint,
    ruleVersion: row.ruleVersion,
    counts: {
      registered: row.registeredCount,
      checkedIn: row.checkedInCount,
      noShow: row.noShowCount,
      addedByStaff: row.addedByStaffCount,
      removedByStaff: row.removedByStaffCount,
      billable: row.billableCount,
    },
    estimatedCents: row.estimatedCents,
    billableCents: row.billableCents,
    preparedAt: row.createdAt.toISOString(),
    preparedByName: row.preparedBy?.displayName ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByName: row.approvedBy?.displayName ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
  };
}

function blockedError(blockers: ResponsibilityBlocker[]) {
  const first = blockers[0];
  return new AttendanceReconciliationError(
    `Finish billing responsibility first: ${blockers.length} ${blockers.length === 1 ? "registration needs" : "registrations need"} attention${first ? ` (${first.confirmationCode}: ${blockerReasonLabel(first.reason).toLowerCase()})` : ""}.`,
    "RESPONSIBILITY_NOT_READY",
    blockers,
  );
}

/**
 * Prepares a DRAFT reconciliation from the facts now. Refused while billing responsibility has
 * unrecorded, out-of-date or unresolved registrations. Idempotent: when the facts and the rules
 * match a version that is still a draft or approved, that version is returned and nothing is
 * written; otherwise a new draft is made and older drafts are superseded. Two staff preparing at
 * once end with one version (a partial unique index on the fingerprint settles it).
 */
export async function prepareReconciliation(input: { eventId: string; actorUserId: string }) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        // One at a time per event: the facts are read and the version written under the same lock that corrections take.
        await requireDeferredEvent(tx, input.eventId);
        await lockEvent(tx, input.eventId);
        const facts = await loadReconciliationFacts(tx, input.eventId);
        if (facts.blockers.length > 0) throw blockedError(facts.blockers);
        if (facts.result.groups.length === 0) {
          throw new AttendanceReconciliationError("There are no submitted or confirmed registrations to reconcile yet.", "NOTHING_TO_RECONCILE");
        }
        const existing = await tx.attendanceReconciliationVersion.findFirst({
          where: { eventId: input.eventId, fingerprint: facts.fingerprint, status: { not: "SUPERSEDED" } },
          select: { id: true, versionNumber: true, status: true },
        });
        if (existing) return { created: false as const, versionId: existing.id, versionNumber: existing.versionNumber, status: existing.status };
        const latest = await tx.attendanceReconciliationVersion.findFirst({
          where: { eventId: input.eventId },
          orderBy: { versionNumber: "desc" },
          select: { versionNumber: true },
        });
        const totals = facts.result.totals;
        const created = await tx.attendanceReconciliationVersion.create({
          data: {
            eventId: input.eventId,
            versionNumber: (latest?.versionNumber ?? 0) + 1,
            status: "DRAFT",
            fingerprint: facts.fingerprint,
            ruleVersion: RECONCILIATION_RULE_VERSION,
            invoiceGrouping: facts.event.invoiceGrouping,
            registeredCount: totals.registered,
            checkedInCount: totals.checkedIn,
            noShowCount: totals.noShow,
            addedByStaffCount: totals.addedByStaff,
            removedByStaffCount: totals.removedByStaff,
            billableCount: totals.billable,
            estimatedCents: totals.estimatedCents,
            billableCents: totals.billableCents,
            snapshot: facts.result as unknown as Prisma.InputJsonValue,
            preparedByUserId: input.actorUserId,
          },
          select: { id: true, versionNumber: true, status: true },
        });
        await tx.attendanceReconciliationVersion.updateMany({
          where: { eventId: input.eventId, status: "DRAFT", id: { not: created.id } },
          data: { status: "SUPERSEDED", supersededAt: new Date(), supersededByVersionId: created.id },
        });
        await writeAuditLog({
          eventId: input.eventId,
          actorUserId: input.actorUserId,
          action: "ATTENDANCE_RECONCILIATION_PREPARED",
          entityType: "AttendanceReconciliationVersion",
          entityId: created.id,
          summary: "Prepared a draft attendance reconciliation.",
          metadata: { eventId: input.eventId, versionNumber: created.versionNumber, registered: totals.registered, checkedIn: totals.checkedIn, billable: totals.billable, billableCents: totals.billableCents },
        }, tx);
        return { created: true as const, versionId: created.id, versionNumber: created.versionNumber, status: created.status };
      }, LONG_TRANSACTION);
    } catch (error) {
      // The lock makes a race unlikely; if the unique indexes still fire, look again.
      if (isUniqueViolation(error) && attempt < 2) continue;
      if (isUniqueViolation(error)) throw concurrent();
      throw error;
    }
  }
  throw concurrent();
}

/**
 * Approves a draft. The draft must still match the facts now (otherwise staff prepare again and
 * review the new numbers), billing responsibility must be complete, and the approver is recorded.
 * The previously approved version is superseded in the same transaction; the approved version
 * itself is immutable from then on (database triggers). Compare-and-set on the draft's status and
 * a one-approved-version-per-event index make two approvals at once safe: exactly one wins.
 */
export async function approveReconciliation(input: { eventId: string; versionId: string; actorUserId: string }) {
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      await requireDeferredEvent(tx, input.eventId);
      // Under the event's lock (corrections and prepares take it too) the facts cannot move between this check and the approval.
      await lockEvent(tx, input.eventId);
      const version = await tx.attendanceReconciliationVersion.findFirst({
        where: { id: input.versionId, eventId: input.eventId },
        select: { id: true, versionNumber: true, status: true, fingerprint: true },
      });
      if (!version) throw new AttendanceReconciliationError("That reconciliation does not belong to this event.", "VERSION_NOT_FOUND");
      if (version.status === "APPROVED") return { changed: false as const, versionId: version.id, versionNumber: version.versionNumber };
      if (version.status === "SUPERSEDED") {
        throw new AttendanceReconciliationError("A newer reconciliation replaced this draft. Review the newer one.", "VERSION_SUPERSEDED");
      }
      const facts = await loadReconciliationFacts(tx, input.eventId);
      if (facts.blockers.length > 0) throw blockedError(facts.blockers);
      if (facts.reviewPending.length > 0) {
        throw new AttendanceReconciliationError(
          `${facts.reviewPending.length} ${facts.reviewPending.length === 1 ? "registration needs" : "registrations need"} a roster review before approval (the roster changed after pricing). Acknowledge ${facts.reviewPending.length === 1 ? "it" : "each"} with a reason, then prepare again.`,
          "REVIEW_REQUIRED",
        );
      }
      if (facts.fingerprint !== version.fingerprint) {
        throw new AttendanceReconciliationError("Attendance or billing facts changed since this draft was prepared. Prepare it again and review the new numbers.", "FACTS_CHANGED");
      }
      const now = new Date();
      // Settle the previous approval first: the database allows one approved version per event.
      await tx.attendanceReconciliationVersion.updateMany({
        where: { eventId: input.eventId, status: "APPROVED", id: { not: version.id } },
        data: { status: "SUPERSEDED", supersededAt: now, supersededByVersionId: version.id },
      });
      const approved = await tx.attendanceReconciliationVersion.updateMany({
        where: { id: version.id, eventId: input.eventId, status: "DRAFT" },
        data: { status: "APPROVED", approvedAt: now, approvedByUserId: input.actorUserId },
      });
      if (approved.count === 0) throw concurrent();
      await tx.attendanceReconciliationVersion.updateMany({
        where: { eventId: input.eventId, status: "DRAFT", id: { not: version.id } },
        data: { status: "SUPERSEDED", supersededAt: now, supersededByVersionId: version.id },
      });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: "ATTENDANCE_RECONCILIATION_APPROVED",
        entityType: "AttendanceReconciliationVersion",
        entityId: version.id,
        summary: "Approved an attendance reconciliation.",
        metadata: { eventId: input.eventId, versionNumber: version.versionNumber, billable: facts.result.totals.billable, billableCents: facts.result.totals.billableCents },
      }, tx);
      return { changed: true as const, versionId: version.id, versionNumber: version.versionNumber };
    }, LONG_TRANSACTION);
  } catch (error) {
    const lost = error instanceof AttendanceReconciliationError ? error.code === "CONCURRENT_CHANGE" : isUniqueViolation(error);
    if (!lost) throw error;
    // Another approval landed first. If it approved this very draft, that is the same outcome.
    const now = await prisma.attendanceReconciliationVersion.findFirst({
      where: { id: input.versionId, eventId: input.eventId },
      select: { id: true, versionNumber: true, status: true },
    });
    if (now?.status === "APPROVED") return { changed: false as const, versionId: now.id, versionNumber: now.versionNumber };
    throw concurrent();
  }
}

// ---------------------------------------------------------------------------------------------
// Screen and export data
// ---------------------------------------------------------------------------------------------

/** The reasons and actors of the corrections a result refers to, read live from the append-only rows (never copied into a snapshot). */
async function correctionDetails(client: Client, eventId: string, result: ReconciliationResult) {
  const ids = result.groups.flatMap((group) => group.registrations.flatMap((registration) => registration.people.flatMap((person) => (person.correction ? [person.correction.id] : []))));
  const details: Record<string, { reason: string; actorName: string | null; createdAt: string }> = {};
  if (ids.length === 0) return details;
  const rows = await client.attendanceCorrection.findMany({
    where: { eventId, id: { in: ids } },
    select: { id: true, reason: true, createdAt: true, actor: { select: { displayName: true } } },
  });
  for (const row of rows) details[row.id] = { reason: row.reason, actorName: row.actor?.displayName ?? null, createdAt: row.createdAt.toISOString() };
  return details;
}

/** The roster-review acknowledgements' reasons, by acknowledgement id, read live. */
async function acknowledgementDetails(client: Client, eventId: string, result: ReconciliationResult) {
  const ids = result.groups.flatMap((group) => group.registrations.flatMap((registration) => (registration.review?.acknowledgementId ? [registration.review.acknowledgementId] : [])));
  const details: Record<string, { reason: string; actorName: string | null; createdAt: string }> = {};
  if (ids.length === 0) return details;
  const rows = await client.attendanceReviewAcknowledgement.findMany({
    where: { eventId, id: { in: ids } },
    select: { id: true, reason: true, createdAt: true, actor: { select: { displayName: true } } },
  });
  for (const row of rows) details[row.id] = { reason: row.reason, actorName: row.actor?.displayName ?? null, createdAt: row.createdAt.toISOString() };
  return details;
}

/**
 * The finance screen's data: the live reconciliation of the facts now (filtered by location for
 * display only), what blocks preparing, the approved version and whether the facts have changed
 * since, the open draft, the version history, and, when `versionId` names a version of this
 * event, that version's stored snapshot instead of the live one.
 */
export async function getAttendanceReconciliationView(eventId: string, options: { locationId?: string | null; versionId?: string | null } = {}) {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, billingMode: true, invoiceGrouping: true } });
  if (!event) throw new AttendanceReconciliationError("That event does not exist.", "EVENT_NOT_FOUND");
  if (event.billingMode !== "DEFERRED_ORGANIZATION_INVOICE") {
    return { isDeferred: false as const, invoiceGrouping: event.invoiceGrouping };
  }
  const facts = await loadReconciliationFacts(prisma, eventId);
  const rows = await prisma.attendanceReconciliationVersion.findMany({
    where: { eventId },
    orderBy: { versionNumber: "desc" },
    select: versionSelect,
  });
  const versions = rows.map(toSummary);
  const approved = versions.find((version) => version.status === "APPROVED") ?? null;
  const draft = versions.find((version) => version.status === "DRAFT") ?? null;
  const freshness = (version: VersionSummary | null) => (version ? versionFreshness(version, facts.fingerprint) : null);

  let shown: { kind: "LIVE" } | { kind: "VERSION"; version: VersionSummary };
  let result: ReconciliationResult = facts.result;
  const requested = options.versionId ? versions.find((version) => version.id === options.versionId) ?? null : null;
  if (requested) {
    const stored = await prisma.attendanceReconciliationVersion.findFirst({ where: { id: requested.id, eventId }, select: { snapshot: true } });
    if (stored) result = stored.snapshot as unknown as ReconciliationResult;
    shown = { kind: "VERSION", version: requested };
  } else {
    shown = { kind: "LIVE" };
  }
  return {
    isDeferred: true as const,
    invoiceGrouping: event.invoiceGrouping,
    shown,
    result: filterResultByLocation(result, options.locationId ?? null),
    correctionDetails: await correctionDetails(prisma, eventId, result),
    acknowledgementDetails: await acknowledgementDetails(prisma, eventId, result),
    reviewPending: facts.reviewPending,
    liveTotals: facts.result.totals,
    liveFingerprint: facts.fingerprint,
    blockers: facts.blockers,
    approved,
    approvedFreshness: freshness(approved),
    draft,
    draftFreshness: freshness(draft),
    versions,
  };
}

export type AttendanceReconciliationView = Awaited<ReturnType<typeof getAttendanceReconciliationView>>;
export type DeferredAttendanceReconciliationView = Extract<AttendanceReconciliationView, { isDeferred: true }>;

/** The CSV export's data: the live reconciliation, or one stored version of this event. */
export async function getAttendanceReconciliationExport(eventId: string, options: { locationId?: string | null; versionId?: string | null } = {}) {
  const view = await getAttendanceReconciliationView(eventId, options);
  if (!view.isDeferred) throw new AttendanceReconciliationError("This event is not billed to organizations after the event.", "NOT_DEFERRED_EVENT");
  const versionLabel = view.shown.kind === "VERSION"
    ? `Version ${view.shown.version.versionNumber} (${view.shown.version.status.toLowerCase()})`
    : "Current facts (not saved)";
  const factsChanged = view.shown.kind === "VERSION"
    ? view.shown.version.status === "SUPERSEDED" ? null : versionFreshness(view.shown.version, view.liveFingerprint) === "FACTS_CHANGED"
    : null;
  return { result: view.result, versionLabel, factsChanged };
}
