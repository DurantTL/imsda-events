import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { resolvePhoneChange } from "@/lib/field-validation";
import { getPrisma } from "@/lib/prisma";
import { AccessDeniedError } from "@/modules/access/authorization";
import { writeAuditLog } from "@/modules/audit/audit-service";
import type { PastorContactInput } from "@/modules/organizations/contacts-schemas";

/**
 * Non-billing organization contacts (#977): today a church's pastor. Office-only, the same
 * authority as the billing contact (system administrator), checked here as well as in the route.
 * Entirely separate from `OrganizationBillingContact` (the treasurer, the invoice recipient):
 * nothing here is read by invoice resolution and nothing is ever sent to a pastor. Rows are
 * ended, never deleted. Audit rows hold ids only, never a name, email or phone.
 */
export type OrganizationContactErrorCode = "ORGANIZATION_NOT_ELIGIBLE" | "CONTACT_NOT_FOUND" | "CONCURRENT_CHANGE" | "INVALID_CONTACT";

export class OrganizationContactError extends Error {
  constructor(message: string, public readonly code: OrganizationContactErrorCode) {
    super(message);
    this.name = "OrganizationContactError";
  }
}

type Client = Prisma.TransactionClient | PrismaClient;
export type ContactActor = { id: string; globalRole?: string | null };

function requireOfficeActor(actor: ContactActor) {
  if (actor.globalRole !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError("Only a system administrator can manage an organization's pastor contact.", 403, "PERMISSION_DENIED");
  }
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const concurrentChange = () => new OrganizationContactError("Someone else just changed this contact. Reload and try again.", "CONCURRENT_CHANGE");

async function requireChurch(tx: Client, organizationId: string) {
  const organization = await tx.organization.findFirst({ where: { id: organizationId, type: "CHURCH" }, select: { id: true } });
  if (!organization) throw new OrganizationContactError("A pastor contact is kept for a church only.", "ORGANIZATION_NOT_ELIGIBLE");
}

/** Adds the pastor, ending the church's previous one in the same transaction. One active row; a race returns CONCURRENT_CHANGE. */
export async function setPastorContact(input: { organizationId: string; contact: PastorContactInput; actor: ContactActor }) {
  requireOfficeActor(input.actor);
  try {
    return await getPrisma().$transaction(async (tx) => {
      await requireChurch(tx, input.organizationId);
      // A retry of the same save changes nothing: the active pastor already has these details.
      const current = await tx.organizationContact.findFirst({
        where: { organizationId: input.organizationId, kind: "PASTOR", effectiveTo: null },
        select: { id: true, name: true, email: true, phone: true },
      });
      // The phone must pass the shared check unless it is the active contact's own saved phone (#1193); the decision is made here
      // from the stored value. The message never carries the phone.
      const phone = resolvePhoneChange(input.contact.phone ?? "", current?.phone);
      if (!phone.ok) throw new OrganizationContactError(phone.message, "INVALID_CONTACT");
      const contact = { ...input.contact, phone: phone.value || null };
      // An unchanged phone comes back exactly as stored, so re-sending an old-format phone is a retry, not a replacement that
      // ends the contact and writes a duplicate history row (#1193).
      if (current && current.name === contact.name && current.email === contact.email && current.phone === contact.phone) {
        return { id: current.id, replaced: false };
      }
      const now = new Date();
      const ended = await tx.organizationContact.updateMany({
        where: { organizationId: input.organizationId, kind: "PASTOR", effectiveTo: null },
        data: { effectiveTo: now, endedByUserId: input.actor.id, endReason: "Replaced by a new pastor contact" },
      });
      const created = await tx.organizationContact.create({
        data: {
          organizationId: input.organizationId,
          kind: "PASTOR",
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          effectiveFrom: now,
          createdByUserId: input.actor.id,
        },
        select: { id: true },
      });
      await writeAuditLog({
        actorUserId: input.actor.id,
        action: ended.count > 0 ? "PASTOR_CONTACT_REPLACED" : "PASTOR_CONTACT_ADDED",
        entityType: "Organization",
        entityId: input.organizationId,
        summary: ended.count > 0 ? "Replaced a church's pastor contact." : "Added a church's pastor contact.",
        metadata: { organizationId: input.organizationId, contactId: created.id, replacedPrevious: ended.count > 0 },
      }, tx);
      return { id: created.id, replaced: ended.count > 0 };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw concurrentChange();
    throw error;
  }
}

/** Ends the active pastor contact without a replacement; the row stays in the history. */
export async function endPastorContact(input: { organizationId: string; contactId: string; reason?: string | null; actor: ContactActor }) {
  requireOfficeActor(input.actor);
  return getPrisma().$transaction(async (tx) => {
    const result = await tx.organizationContact.updateMany({
      where: { id: input.contactId, organizationId: input.organizationId, kind: "PASTOR", effectiveTo: null },
      data: { effectiveTo: new Date(), endedByUserId: input.actor.id, endReason: input.reason?.trim() || "Ended by an administrator" },
    });
    if (result.count === 0) throw new OrganizationContactError("That pastor contact is no longer active.", "CONTACT_NOT_FOUND");
    await writeAuditLog({
      actorUserId: input.actor.id,
      action: "PASTOR_CONTACT_ENDED",
      entityType: "Organization",
      entityId: input.organizationId,
      summary: "Ended a church's pastor contact.",
      metadata: { organizationId: input.organizationId, contactId: input.contactId },
    }, tx);
    return { changed: true as const };
  });
}

export type PastorContactEntry = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  endReason: string | null;
  createdByName: string | null;
  endedByName: string | null;
};

/** The office view of one church: its pastor contact and history. The treasurer is on the billing screen, not here. */
export async function getChurchPastorContactView(organizationId: string, actor: ContactActor) {
  requireOfficeActor(actor);
  const prisma = getPrisma();
  const organization = await prisma.organization.findFirst({ where: { id: organizationId, type: "CHURCH" }, select: { id: true, name: true } });
  if (!organization) return null;
  const rows = await prisma.organizationContact.findMany({
    where: { organizationId, kind: "PASTOR" },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    select: {
      id: true, name: true, email: true, phone: true, effectiveFrom: true, effectiveTo: true, endReason: true,
      createdBy: { select: { displayName: true } },
      endedBy: { select: { displayName: true } },
    },
  });
  const history: PastorContactEntry[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    endReason: row.endReason,
    createdByName: row.createdBy?.displayName ?? null,
    endedByName: row.endedBy?.displayName ?? null,
  }));
  return { organization, active: history.find((entry) => entry.effectiveTo === null) ?? null, history };
}

export type DirectoryContacts = {
  pastor: { name: string; email: string | null; phone: string | null } | null;
  billing: { name: string; roleLabel: string; email: string } | null;
};

/** Active pastor and billing contact (treasurer) for a page of directory rows, kept apart. Office screens only. */
export async function listDirectoryContacts(organizationIds: readonly string[], actor: ContactActor) {
  requireOfficeActor(actor);
  const result = new Map<string, DirectoryContacts>();
  if (organizationIds.length === 0) return result;
  const prisma = getPrisma();
  const [pastors, billing] = await Promise.all([
    prisma.organizationContact.findMany({
      where: { organizationId: { in: [...organizationIds] }, kind: "PASTOR", effectiveTo: null },
      select: { organizationId: true, name: true, email: true, phone: true },
    }),
    prisma.organizationBillingContact.findMany({
      where: { organizationId: { in: [...organizationIds] }, effectiveTo: null },
      select: { organizationId: true, name: true, roleLabel: true, email: true },
    }),
  ]);
  for (const id of organizationIds) result.set(id, { pastor: null, billing: null });
  for (const row of pastors) {
    const entry = result.get(row.organizationId);
    if (entry) entry.pastor = { name: row.name, email: row.email, phone: row.phone };
  }
  for (const row of billing) {
    const entry = result.get(row.organizationId);
    if (entry) entry.billing = { name: row.name, roleLabel: row.roleLabel, email: row.email };
  }
  return result;
}
