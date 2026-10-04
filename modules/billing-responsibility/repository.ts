import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  BILLING_RESPONSIBILITY_STATUSES,
  RESPONSIBLE_ORGANIZATION_TYPES,
  groupBillingLines,
  planResolution,
  resolveByRule,
  staffSourceFor,
  summarizeBillingGroups,
  isStaffDecision,
  type BillingContactView,
  type BillingLine,
  type BillingResponsibilitySource,
  type InvoiceGroupingMode,
  type ResponsibleParty,
  type Resolution,
} from "@/modules/billing-responsibility/domain";
import type { BillingContactInput } from "@/modules/billing-responsibility/schemas";
import { resolveResponsibleOrganization } from "@/modules/forms/definition";
import { moneyToCents } from "@/modules/payments/square-domain";
import { storedRegistrationResponses } from "@/modules/registrations/amendments-repository";

/**
 * Billing responsibility and organization billing contacts (#165, slice 1). Every function takes
 * the event the caller was authorized for (MANAGE_FINANCE is checked by the route or page, the
 * same as church-owed) and refuses a registration, contact, or organization that does not belong
 * to that event. Audit entries carry ids and counts only: contact names, emails and phone
 * numbers never go into an audit row.
 */

export type BillingResponsibilityErrorCode =
  | "EVENT_NOT_FOUND"
  | "NOT_DEFERRED_EVENT"
  | "REGISTRATION_NOT_FOUND"
  | "ORGANIZATION_NOT_ELIGIBLE"
  | "ORGANIZATION_NOT_RELEVANT"
  | "REASON_REQUIRED"
  | "NOT_AN_OVERRIDE"
  | "CONTACT_NOT_FOUND"
  | "CONCURRENT_CHANGE";

export class BillingResponsibilityError extends Error {
  constructor(message: string, public readonly code: BillingResponsibilityErrorCode) {
    super(message);
    this.name = "BillingResponsibilityError";
  }
}

type Client = Prisma.TransactionClient | PrismaClient;

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const personName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim() || "Billing contact";

const registrationSelect = {
  id: true,
  confirmationCode: true,
  status: true,
  totalAmount: true,
  location: { select: { name: true } },
  accountHolderPerson: { select: { firstName: true, lastName: true } },
  clubRegistration: {
    select: {
      organization: {
        select: { id: true, name: true, parentOrganizationId: true, parentOrganization: { select: { id: true, name: true } } },
      },
    },
  },
  groupRegistration: {
    select: { billingPerson: { select: { id: true, firstName: true, lastName: true, normalizedEmail: true } } },
  },
  billingResponsibility: {
    select: {
      kind: true,
      organizationId: true,
      personId: true,
      source: true,
      reason: true,
      organization: { select: { id: true, name: true } },
      person: { select: { id: true, firstName: true, lastName: true, normalizedEmail: true } },
    },
  },
  publicFormSubmission: { select: { responses: true } },
  operations: { where: { type: "AMENDMENT" }, orderBy: { createdAt: "desc" }, take: 1, select: { afterSnapshot: true } },
  _count: { select: { attendees: true } },
} satisfies Prisma.RegistrationSelect;

type RegistrationRow = Prisma.RegistrationGetPayload<{ select: typeof registrationSelect }>;

function ruleFor(row: RegistrationRow): Resolution {
  return resolveByRule({
    club: row.clubRegistration
      ? { organizationId: row.clubRegistration.organization.id, parentOrganizationId: row.clubRegistration.organization.parentOrganizationId }
      : null,
    groupBillingPersonId: row.groupRegistration?.billingPerson.id ?? null,
  });
}

async function requireDeferredEvent(client: Client, eventId: string) {
  const event = await client.event.findUnique({ where: { id: eventId }, select: { id: true, billingMode: true, invoiceGrouping: true } });
  if (!event) throw new BillingResponsibilityError("That event does not exist.", "EVENT_NOT_FOUND");
  if (event.billingMode !== "DEFERRED_ORGANIZATION_INVOICE") {
    throw new BillingResponsibilityError("This event is not billed to organizations after the event.", "NOT_DEFERRED_EVENT");
  }
  return event;
}

function loadRegistrations(client: Client, eventId: string, locationId?: string | null) {
  return client.registration.findMany({
    where: {
      eventId,
      status: { in: [...BILLING_RESPONSIBILITY_STATUSES] },
      ...(locationId ? { locationId } : {}),
    },
    select: registrationSelect,
    orderBy: [{ confirmationCode: "asc" }],
  });
}

function toLine(row: RegistrationRow): BillingLine {
  const rule = ruleFor(row);
  const stored = row.billingResponsibility;
  const club = row.clubRegistration?.organization ?? null;
  let party: ResponsibleParty = { kind: "UNRESOLVED" };
  let source: BillingResponsibilitySource = rule.source;
  if (stored) {
    source = stored.source;
    if (stored.kind === "ORGANIZATION" && stored.organization) party = { kind: "ORGANIZATION", id: stored.organization.id, name: stored.organization.name };
    else if (stored.kind === "PERSON" && stored.person) party = { kind: "PERSON", id: stored.person.id, name: personName(stored.person), email: stored.person.normalizedEmail };
  } else if (rule.kind === "ORGANIZATION" && club?.parentOrganization) {
    party = { kind: "ORGANIZATION", id: club.parentOrganization.id, name: club.parentOrganization.name };
  } else if (rule.kind === "PERSON" && row.groupRegistration) {
    const person = row.groupRegistration.billingPerson;
    party = { kind: "PERSON", id: person.id, name: personName(person), email: person.normalizedEmail };
  }
  const isUnlinkedRegistration = !club && !row.groupRegistration;
  const hint = isUnlinkedRegistration && party.kind === "UNRESOLVED"
    ? resolveResponsibleOrganization(storedRegistrationResponses(row))
    : null;
  return {
    registrationId: row.id,
    confirmationCode: row.confirmationCode,
    status: row.status,
    attendeeCount: row._count.attendees,
    totalAmountCents: moneyToCents(row.totalAmount),
    locationName: row.location?.name ?? null,
    clubId: club?.id ?? null,
    clubName: club?.name ?? null,
    registrantName: personName(row.accountHolderPerson),
    party,
    source,
    reason: stored?.reason ?? null,
    recorded: Boolean(stored),
    hint,
  };
}

const contactSelect = {
  id: true,
  organizationId: true,
  name: true,
  email: true,
  phone: true,
  roleLabel: true,
  effectiveFrom: true,
  verifiedAt: true,
} satisfies Prisma.OrganizationBillingContactSelect;

function toContactView(row: Prisma.OrganizationBillingContactGetPayload<{ select: typeof contactSelect }>): BillingContactView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    roleLabel: row.roleLabel,
    effectiveFrom: row.effectiveFrom.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
}

export type ContactHistoryEntry = BillingContactView & {
  effectiveTo: string | null;
  endReason: string | null;
  createdByName: string | null;
  verifiedByName: string | null;
  endedByName: string | null;
};

/** Every billing contact the organizations ever had, newest first. Only called for organizations on this event's screen. */
async function listContactHistory(client: Client, organizationIds: readonly string[]) {
  if (organizationIds.length === 0) return {} as Record<string, ContactHistoryEntry[]>;
  const rows = await client.organizationBillingContact.findMany({
    where: { organizationId: { in: [...organizationIds] } },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    select: {
      ...contactSelect,
      effectiveTo: true,
      endReason: true,
      createdBy: { select: { displayName: true } },
      verifiedBy: { select: { displayName: true } },
      endedBy: { select: { displayName: true } },
    },
  });
  const history: Record<string, ContactHistoryEntry[]> = {};
  for (const row of rows) {
    (history[row.organizationId] ??= []).push({
      ...toContactView(row),
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
      endReason: row.endReason,
      createdByName: row.createdBy?.displayName ?? null,
      verifiedByName: row.verifiedBy?.displayName ?? null,
      endedByName: row.endedBy?.displayName ?? null,
    });
  }
  return history;
}

/**
 * The finance screen's data: invoice groups under the event's grouping setting, each with its
 * responsible party, active billing contact and readiness, plus the unresolved registrations.
 * Registrations the resolver has not recorded yet are shown as the rule's proposal and flagged.
 */
export async function getBillingResponsibilityView(eventId: string, options: { locationId?: string | null } = {}) {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, billingMode: true, invoiceGrouping: true } });
  if (!event) throw new BillingResponsibilityError("That event does not exist.", "EVENT_NOT_FOUND");
  const isDeferred = event.billingMode === "DEFERRED_ORGANIZATION_INVOICE";
  const rows = isDeferred ? await loadRegistrations(prisma, eventId, options.locationId) : [];
  const lines = rows.map(toLine);
  const organizationIds = [...new Set(lines.flatMap((line) => (line.party.kind === "ORGANIZATION" ? [line.party.id] : [])))];
  const history = await listContactHistory(prisma, organizationIds);
  const decidedIds = lines.filter((line) => isStaffDecision(line.source)).map((line) => line.registrationId);
  const lineHistory = await listResponsibilityHistory(prisma, eventId, decidedIds);
  const contacts = new Map<string, BillingContactView>();
  for (const [organizationId, entries] of Object.entries(history)) {
    const active = entries.find((entry) => entry.effectiveTo === null);
    if (active) contacts.set(organizationId, active);
  }
  const grouping: InvoiceGroupingMode = event.invoiceGrouping;
  const groups = groupBillingLines(lines, grouping, contacts);
  return {
    isDeferred,
    invoiceGrouping: grouping,
    groups,
    summary: summarizeBillingGroups(groups),
    unrecordedCount: lines.filter((line) => !line.recorded).length,
    history,
    lineHistory,
  };
}

export type BillingResponsibilityView = Awaited<ReturnType<typeof getBillingResponsibilityView>>;

/** The CSV export's data, with no history. */
export async function getBillingResponsibilityExport(eventId: string, options: { locationId?: string | null } = {}) {
  const { groups, invoiceGrouping } = await getBillingResponsibilityView(eventId, options);
  return { groups, invoiceGrouping };
}

// ---------------------------------------------------------------------------------------------
// Resolver and backfill
// ---------------------------------------------------------------------------------------------

export type ResolutionReport = {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  keptStaffDecisions: number;
  /** Registrations that cannot be mapped confidently: they stay unresolved until staff link them. */
  unresolved: Array<{ registrationId: string; confirmationCode: string; reason: BillingResponsibilitySource; hint: string | null }>;
};

/**
 * Records the rule-derived responsible party for every submitted, confirmed, waitlisted or
 * cancelled registration of a deferred-invoice event. Idempotent: running it again changes
 * nothing, a staff decision is never replaced, and an ambiguous registration is recorded as
 * UNRESOLVED (never linked). `apply: false` is the dry run and writes nothing.
 */
export async function resolveEventBillingResponsibility(
  eventId: string,
  options: { apply: boolean; actorUserId?: string | null },
): Promise<ResolutionReport> {
  const prisma = getPrisma();
  await requireDeferredEvent(prisma, eventId);
  const rows = await loadRegistrations(prisma, eventId);
  const report: ResolutionReport = { dryRun: !options.apply, total: rows.length, created: 0, updated: 0, unchanged: 0, keptStaffDecisions: 0, unresolved: [] };
  for (const row of rows) {
    const rule = ruleFor(row);
    const existing = row.billingResponsibility;
    const outcome = planResolution(existing, rule);
    const effectiveKind = outcome.action === "KEEP_STAFF_DECISION" ? existing?.kind : rule.kind;
    if (effectiveKind === "UNRESOLVED") {
      report.unresolved.push({
        registrationId: row.id,
        confirmationCode: row.confirmationCode,
        reason: outcome.action === "KEEP_STAFF_DECISION" ? (existing as { source: BillingResponsibilitySource }).source : rule.source,
        hint: !row.clubRegistration && !row.groupRegistration ? resolveResponsibleOrganization(storedRegistrationResponses(row)) : null,
      });
    }
    if (outcome.action === "KEEP_STAFF_DECISION") { report.keptStaffDecisions += 1; continue; }
    if (outcome.action === "UNCHANGED") { report.unchanged += 1; continue; }
    if (!options.apply) {
      if (outcome.action === "CREATE") report.created += 1; else report.updated += 1;
      continue;
    }
    const applied = await applyRuleResolution(prisma, eventId, row.id, existing, outcome.next, options.actorUserId ?? null);
    if (applied === "CREATED") report.created += 1;
    else if (applied === "UPDATED") report.updated += 1;
    else report.unchanged += 1;
  }
  if (options.apply && (report.created > 0 || report.updated > 0)) {
    await writeAuditLog({
      eventId,
      ...(options.actorUserId ? { actorUserId: options.actorUserId } : {}),
      action: "BILLING_RESPONSIBILITY_RESOLVED",
      entityType: "Event",
      entityId: eventId,
      summary: "Recorded who is responsible for each registration's invoice.",
      metadata: { eventId, created: report.created, updated: report.updated, unresolved: report.unresolved.length },
    });
  }
  return report;
}

type StoredForCompare = Pick<NonNullable<RegistrationRow["billingResponsibility"]>, "kind" | "organizationId" | "personId" | "source">;

async function applyRuleResolution(
  prisma: PrismaClient,
  eventId: string,
  registrationId: string,
  existing: StoredForCompare | null,
  next: Resolution,
  actorUserId: string | null,
): Promise<"CREATED" | "UPDATED" | "SKIPPED"> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (!existing) {
        await tx.registrationBillingResponsibility.create({
          data: { eventId, registrationId, kind: next.kind, organizationId: next.organizationId, personId: next.personId, source: next.source, setByUserId: actorUserId },
        });
      } else {
        // Compare-and-set: a staff decision (or another resolver run) that landed meanwhile is not overwritten.
        const result = await tx.registrationBillingResponsibility.updateMany({
          where: { registrationId, kind: existing.kind, organizationId: existing.organizationId, personId: existing.personId, source: existing.source },
          data: { kind: next.kind, organizationId: next.organizationId, personId: next.personId, source: next.source, reason: null, setByUserId: actorUserId },
        });
        if (result.count === 0) return "SKIPPED" as const;
      }
      await tx.registrationBillingResponsibilityChange.create({
        data: {
          eventId,
          registrationId,
          changeType: existing ? "RE_RESOLVED" : "RESOLVED",
          fromKind: existing?.kind ?? null,
          fromOrganizationId: existing?.organizationId ?? null,
          fromPersonId: existing?.personId ?? null,
          fromSource: existing?.source ?? null,
          toKind: next.kind,
          toOrganizationId: next.organizationId,
          toPersonId: next.personId,
          toSource: next.source,
          actorUserId,
        },
      });
      return existing ? "UPDATED" as const : "CREATED" as const;
    });
  } catch (error) {
    // A parallel run created the row first: same outcome, nothing to do here.
    if (isUniqueViolation(error)) return "SKIPPED";
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Staff decisions on one registration
// ---------------------------------------------------------------------------------------------

async function loadRegistrationInEvent(tx: Client, eventId: string, registrationId: string) {
  const row = await tx.registration.findFirst({
    where: { id: registrationId, eventId, status: { in: [...BILLING_RESPONSIBILITY_STATUSES] } },
    select: registrationSelect,
  });
  if (!row) throw new BillingResponsibilityError("That registration is not on this event.", "REGISTRATION_NOT_FOUND");
  return row;
}

/**
 * Staff name the organization responsible for one registration. When the rules found no party
 * this is a link; when they did, it is an override and needs a reason. Either way it is audited,
 * recorded in the history, and outranks the rules from then on.
 */
export async function linkRegistrationToOrganization(input: {
  eventId: string;
  registrationId: string;
  organizationId: string;
  reason?: string | null;
  actorUserId: string;
}) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    await requireDeferredEvent(tx, input.eventId);
    const row = await loadRegistrationInEvent(tx, input.eventId, input.registrationId);
    const organization = await tx.organization.findFirst({
      where: { id: input.organizationId, isActive: true, type: { in: [...RESPONSIBLE_ORGANIZATION_TYPES] } },
      select: { id: true },
    });
    if (!organization) {
      throw new BillingResponsibilityError("Choose an active church, school, club or ministry from the list.", "ORGANIZATION_NOT_ELIGIBLE");
    }
    const rule = ruleFor(row);
    const source = staffSourceFor(rule);
    const reason = input.reason?.trim() || null;
    if (source === "STAFF_OVERRIDE" && !reason) {
      throw new BillingResponsibilityError("Say why you are replacing the responsible party the system found.", "REASON_REQUIRED");
    }
    const existing = row.billingResponsibility;
    // The effective "before" is the recorded row, or else the rule's proposal that was on screen.
    const before: Resolution = existing ?? rule;
    if (existing && existing.source === source && existing.kind === "ORGANIZATION" && existing.organizationId === organization.id) {
      return { changed: false as const, source };
    }
    const data = { kind: "ORGANIZATION" as const, organizationId: organization.id, personId: null, source, reason, setByUserId: input.actorUserId };
    await tx.registrationBillingResponsibility.upsert({
      where: { registrationId: row.id },
      create: { eventId: input.eventId, registrationId: row.id, ...data },
      update: data,
    });
    await tx.registrationBillingResponsibilityChange.create({
      data: {
        eventId: input.eventId,
        registrationId: row.id,
        changeType: source,
        fromKind: before.kind,
        fromOrganizationId: before.organizationId,
        fromPersonId: before.personId,
        fromSource: before.source,
        toKind: "ORGANIZATION",
        toOrganizationId: organization.id,
        toPersonId: null,
        toSource: source,
        reason,
        actorUserId: input.actorUserId,
      },
    });
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: source === "STAFF_OVERRIDE" ? "BILLING_RESPONSIBILITY_OVERRIDDEN" : "BILLING_RESPONSIBILITY_LINKED",
      entityType: "Registration",
      entityId: row.id,
      summary: source === "STAFF_OVERRIDE" ? "Replaced the responsible party for a registration." : "Linked a registration to its responsible organization.",
      metadata: {
        eventId: input.eventId,
        registrationId: row.id,
        before: { kind: before.kind, organizationId: before.organizationId, personId: before.personId, source: before.source },
        after: { kind: "ORGANIZATION", organizationId: organization.id, source },
        hasReason: Boolean(reason),
      },
    }, tx);
    return { changed: true as const, source };
  });
}

/** Drops a staff decision so the rules decide again (the registration may go back to unresolved). */
export async function clearResponsibilityOverride(input: { eventId: string; registrationId: string; reason?: string | null; actorUserId: string }) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    await requireDeferredEvent(tx, input.eventId);
    const row = await loadRegistrationInEvent(tx, input.eventId, input.registrationId);
    const existing = row.billingResponsibility;
    if (!existing || !isStaffDecision(existing.source)) {
      throw new BillingResponsibilityError("Only a staff link or override can be cleared.", "NOT_AN_OVERRIDE");
    }
    const rule = ruleFor(row);
    const reason = input.reason?.trim() || null;
    await tx.registrationBillingResponsibility.update({
      where: { registrationId: row.id },
      data: { kind: rule.kind, organizationId: rule.organizationId, personId: rule.personId, source: rule.source, reason: null, setByUserId: input.actorUserId },
    });
    await tx.registrationBillingResponsibilityChange.create({
      data: {
        eventId: input.eventId,
        registrationId: row.id,
        changeType: "OVERRIDE_CLEARED",
        fromKind: existing.kind,
        fromOrganizationId: existing.organizationId,
        fromPersonId: existing.personId,
        fromSource: existing.source,
        toKind: rule.kind,
        toOrganizationId: rule.organizationId,
        toPersonId: rule.personId,
        toSource: rule.source,
        reason,
        actorUserId: input.actorUserId,
      },
    });
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "BILLING_RESPONSIBILITY_OVERRIDE_CLEARED",
      entityType: "Registration",
      entityId: row.id,
      summary: "Cleared a staff decision on a registration's responsible party.",
      metadata: {
        eventId: input.eventId,
        registrationId: row.id,
        before: { kind: existing.kind, organizationId: existing.organizationId, personId: existing.personId, source: existing.source },
        after: { kind: rule.kind, organizationId: rule.organizationId, personId: rule.personId, source: rule.source },
      },
    }, tx);
    return { source: rule.source };
  });
}

export type RegistrationResponsibilityHistoryEntry = {
  id: string;
  changeType: string;
  fromSource: string | null;
  toSource: string;
  fromOrganizationName: string | null;
  toOrganizationName: string | null;
  reason: string | null;
  actorName: string | null;
  createdAt: string;
};

/** Append-only history for these registrations of this event, newest first, keyed by registration. */
export async function listResponsibilityHistory(client: Client, eventId: string, registrationIds: readonly string[]) {
  const result: Record<string, RegistrationResponsibilityHistoryEntry[]> = {};
  if (registrationIds.length === 0) return result;
  const changes = await client.registrationBillingResponsibilityChange.findMany({
    where: { eventId, registrationId: { in: [...registrationIds] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true, registrationId: true, changeType: true, fromSource: true, toSource: true, fromOrganizationId: true, toOrganizationId: true, reason: true, createdAt: true,
      actor: { select: { displayName: true } },
    },
  });
  const ids = [...new Set(changes.flatMap((change) => [change.fromOrganizationId, change.toOrganizationId].filter((value): value is string => Boolean(value))))];
  const names = new Map((ids.length ? await client.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((org) => [org.id, org.name]));
  for (const change of changes) {
    (result[change.registrationId] ??= []).push({
      id: change.id,
      changeType: change.changeType,
      fromSource: change.fromSource,
      toSource: change.toSource,
      fromOrganizationName: change.fromOrganizationId ? names.get(change.fromOrganizationId) ?? null : null,
      toOrganizationName: change.toOrganizationId ? names.get(change.toOrganizationId) ?? null : null,
      reason: change.reason,
      actorName: change.actor?.displayName ?? null,
      createdAt: change.createdAt.toISOString(),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Grouping setting
// ---------------------------------------------------------------------------------------------

export async function setInvoiceGrouping(input: { eventId: string; invoiceGrouping: InvoiceGroupingMode; actorUserId: string }) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const event = await requireDeferredEvent(tx, input.eventId);
    const before = event.invoiceGrouping;
    if (before === input.invoiceGrouping) return { changed: false as const };
    await tx.event.update({ where: { id: input.eventId }, data: { invoiceGrouping: input.invoiceGrouping } });
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "INVOICE_GROUPING_CHANGED",
      entityType: "Event",
      entityId: input.eventId,
      summary: input.invoiceGrouping === "PER_CLUB" ? "Switched to one invoice per club." : "Switched to one invoice per church.",
      metadata: { eventId: input.eventId, before, after: input.invoiceGrouping },
    }, tx);
    return { changed: true as const };
  });
}

// ---------------------------------------------------------------------------------------------
// Organization billing contacts
// ---------------------------------------------------------------------------------------------

/**
 * Staff may only touch the billing contact of an organization that matters to this event: one a
 * registration here is billed to (recorded), or the sponsoring church of a club registered here.
 * That keeps the screen from becoming a way to browse or edit unrelated organizations.
 */
async function requireOrganizationOnEvent(tx: Client, eventId: string, organizationId: string) {
  const [recorded, viaClub] = await Promise.all([
    tx.registrationBillingResponsibility.count({ where: { eventId, organizationId } }),
    tx.clubEventRegistration.count({
      where: { eventId, organization: { parentOrganizationId: organizationId }, registration: { status: { in: [...BILLING_RESPONSIBILITY_STATUSES] } } },
    }),
  ]);
  if (recorded + viaClub === 0) {
    throw new BillingResponsibilityError("That organization is not billed for this event.", "ORGANIZATION_NOT_RELEVANT");
  }
}

/**
 * Adds a billing contact, ending the organization's previous one in the same transaction, so
 * history is kept and exactly one is active. A new contact starts unverified. A database index
 * settles two staff members racing: one of them gets CONCURRENT_CHANGE.
 */
export async function setOrganizationBillingContact(input: {
  eventId: string;
  organizationId: string;
  contact: BillingContactInput;
  actorUserId: string;
}) {
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(async (tx) => {
      await requireDeferredEvent(tx, input.eventId);
      await requireOrganizationOnEvent(tx, input.eventId, input.organizationId);
      const now = new Date();
      const ended = await tx.organizationBillingContact.updateMany({
        where: { organizationId: input.organizationId, effectiveTo: null },
        data: { effectiveTo: now, endedByUserId: input.actorUserId, endReason: "Replaced by a new billing contact" },
      });
      const created = await tx.organizationBillingContact.create({
        data: {
          organizationId: input.organizationId,
          name: input.contact.name,
          email: input.contact.email,
          phone: input.contact.phone,
          roleLabel: input.contact.roleLabel,
          source: "STAFF_ENTERED",
          effectiveFrom: now,
          createdByUserId: input.actorUserId,
        },
        select: { id: true },
      });
      await writeAuditLog({
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: ended.count > 0 ? "BILLING_CONTACT_REPLACED" : "BILLING_CONTACT_ADDED",
        entityType: "Organization",
        entityId: input.organizationId,
        summary: ended.count > 0 ? "Replaced an organization's billing contact." : "Added an organization's billing contact.",
        metadata: { eventId: input.eventId, organizationId: input.organizationId, contactId: created.id, replacedPrevious: ended.count > 0 },
      }, tx);
      return { id: created.id, replaced: ended.count > 0 };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new BillingResponsibilityError("Someone else just changed this billing contact. Reload and try again.", "CONCURRENT_CHANGE");
    }
    throw error;
  }
}

async function requireActiveContact(tx: Client, eventId: string, organizationId: string, contactId: string) {
  await requireOrganizationOnEvent(tx, eventId, organizationId);
  const contact = await tx.organizationBillingContact.findFirst({
    where: { id: contactId, organizationId, effectiveTo: null },
    select: { id: true, verifiedAt: true },
  });
  if (!contact) throw new BillingResponsibilityError("That billing contact is no longer active.", "CONTACT_NOT_FOUND");
  return contact;
}

/** Staff confirm the active contact is right (for example after calling the church). */
export async function verifyOrganizationBillingContact(input: { eventId: string; organizationId: string; contactId: string; actorUserId: string }) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    await requireDeferredEvent(tx, input.eventId);
    const contact = await requireActiveContact(tx, input.eventId, input.organizationId, input.contactId);
    if (contact.verifiedAt) return { changed: false as const };
    const result = await tx.organizationBillingContact.updateMany({
      where: { id: contact.id, effectiveTo: null, verifiedAt: null },
      data: { verifiedAt: new Date(), verifiedByUserId: input.actorUserId },
    });
    if (result.count === 0) return { changed: false as const };
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "BILLING_CONTACT_VERIFIED",
      entityType: "Organization",
      entityId: input.organizationId,
      summary: "Verified an organization's billing contact.",
      metadata: { eventId: input.eventId, organizationId: input.organizationId, contactId: contact.id },
    }, tx);
    return { changed: true as const };
  });
}

/** Ends the active contact without a replacement; the row stays in the history. */
export async function endOrganizationBillingContact(input: { eventId: string; organizationId: string; contactId: string; reason?: string | null; actorUserId: string }) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    await requireDeferredEvent(tx, input.eventId);
    const contact = await requireActiveContact(tx, input.eventId, input.organizationId, input.contactId);
    const result = await tx.organizationBillingContact.updateMany({
      where: { id: contact.id, effectiveTo: null },
      data: { effectiveTo: new Date(), endedByUserId: input.actorUserId, endReason: input.reason?.trim() || "Ended by staff" },
    });
    if (result.count === 0) throw new BillingResponsibilityError("That billing contact is no longer active.", "CONTACT_NOT_FOUND");
    await writeAuditLog({
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "BILLING_CONTACT_ENDED",
      entityType: "Organization",
      entityId: input.organizationId,
      summary: "Ended an organization's billing contact.",
      metadata: { eventId: input.eventId, organizationId: input.organizationId, contactId: contact.id },
    }, tx);
    return { changed: true as const };
  });
}

// ---------------------------------------------------------------------------------------------
// Organization picker
// ---------------------------------------------------------------------------------------------

export type OrganizationOption = { id: string; name: string; type: string; city: string | null };

/**
 * Staff search for an organization to link: active churches, schools, clubs and ministries,
 * matched on the name only, and returning only the name, type and city (to tell two
 * same-named churches apart). Never an address, code, contact or roster.
 */
export async function searchResponsibleOrganizations(query: string): Promise<OrganizationOption[]> {
  const terms = query.normalize("NFKC").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (terms.join(" ").length < 2) return [];
  return getPrisma().organization.findMany({
    where: {
      isActive: true,
      type: { in: [...RESPONSIBLE_ORGANIZATION_TYPES] },
      AND: terms.map((term) => ({ name: { contains: term.slice(0, 80), mode: "insensitive" as const } })),
    },
    orderBy: [{ name: "asc" }],
    take: 10,
    select: { id: true, name: true, type: true, city: true },
  });
}
