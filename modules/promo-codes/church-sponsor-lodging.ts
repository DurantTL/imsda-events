import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { getPrisma } from "@/lib/prisma";

type Client = Prisma.TransactionClient | PrismaClient;

/**
 * A staff lodging edit (or an approved registrant change request, which staff apply with the same edit) that changes the
 * lodging charge of a registration holding a church-sponsored registration-level code moves the church's share (#813).
 *
 * - Before the church's invoice is finalized the church's amount owed moves in the SAME transaction as the edit, by
 *   `PromoCodeRedemption.sponsorLodgingChangeCents`. That is a separate column on purpose: an amendment of the
 *   registrant's answers rewrites `discountAmountCents` from the form (it would erase a lodging change recorded there),
 *   and a sponsored `PROMO_CODE` adjustment is added to the registrant's own total (every adjustment is), which would
 *   change what the registrant owes by the church's share. The registrant's share is recorded by staff in Payments as
 *   before; the church-owed views read `discountAmountCents + sponsorLodgingChangeCents`.
 * - When the church's invoice is already finalized (Caleb, #813) nothing is revised and nothing moves: a
 *   `ChurchSponsorFinanceReview` row records the change for the finance office, who see it where they see what churches owe,
 *   on Payments and on the invoice, and clear it once handled.
 *
 * The caller holds the registration's lodging advisory lock, so two edits to one registration cannot interleave; the
 * redemption row is also locked here so an amendment cannot interleave either. Each edit's change is its own
 * (previous request against the new one), so a retry or a second edit never counts a change twice.
 *
 * No money moves, no invoice is created, sent or revised, and the audit rows carry ids and amounts only.
 */
export type ChurchShareOutcome =
  | {
      status: "UPDATED";
      /** The change actually applied to the church's share (can be smaller than asked when it would go below zero). */
      deltaCents: number;
      churchName: string;
      /** What the church now owes for this registration. */
      registrationOwedCents: number;
    }
  | { status: "FLAGGED"; deltaCents: number; churchName: string };

export async function settleChurchShareForLodgingChange(
  tx: Prisma.TransactionClient,
  input: { eventId: string; registrationId: string; lodgingRequestVersionId: string; deltaCents: number; actorUserId: string | null },
): Promise<ChurchShareOutcome | null> {
  if (!Number.isInteger(input.deltaCents) || input.deltaCents === 0) return null;
  const found = await tx.promoCodeRedemption.findUnique({
    where: { registrationId: input.registrationId },
    select: { id: true, promoCode: { select: { sponsoringOrganizationId: true, sponsoringOrganization: { select: { name: true } } } } },
  });
  const churchId = found?.promoCode.sponsoringOrganizationId;
  if (!found || !churchId) return null;
  const churchName = found.promoCode.sponsoringOrganization?.name ?? "the church";
  // Serializes with an amendment (which rewrites the discount) and with any other writer of this row.
  await tx.$queryRaw`SELECT "id" FROM "PromoCodeRedemption" WHERE "id" = ${found.id} FOR UPDATE`;
  const redemption = await tx.promoCodeRedemption.findUniqueOrThrow({
    where: { id: found.id },
    select: { id: true, discountAmountCents: true, sponsorLodgingChangeCents: true },
  });

  const finalized = await tx.invoiceVersion.findFirst({
    where: { eventId: input.eventId, status: "FINALIZED", invoice: { partyKind: "ORGANIZATION", partyId: churchId } },
    select: { id: true },
    orderBy: { revision: "desc" },
  });
  if (finalized) {
    const flag = await tx.churchSponsorFinanceReview.upsert({
      where: { registrationId_lodgingRequestVersionId: { registrationId: input.registrationId, lodgingRequestVersionId: input.lodgingRequestVersionId } },
      create: {
        eventId: input.eventId, registrationId: input.registrationId, churchId, invoiceVersionId: finalized.id,
        lodgingRequestVersionId: input.lodgingRequestVersionId, deltaCents: input.deltaCents,
      },
      update: {},
      select: { id: true },
    });
    await writeAuditLog({
      eventId: input.eventId, actorUserId: input.actorUserId ?? undefined, action: "CHURCH_SPONSOR_SHARE_FLAGGED",
      entityType: "ChurchSponsorFinanceReview", entityId: flag.id,
      summary: "A lodging change moved a church's share after its invoice was finalized; flagged for the finance office. Nothing was changed.",
      metadata: {
        registrationId: input.registrationId, redemptionId: redemption.id, churchId, invoiceVersionId: finalized.id,
        lodgingRequestVersionId: input.lodgingRequestVersionId, deltaCents: input.deltaCents,
      },
    }, tx);
    return { status: "FLAGGED", deltaCents: input.deltaCents, churchName };
  }

  const before = redemption.discountAmountCents + redemption.sponsorLodgingChangeCents;
  // The church never owes less than nothing for a registration.
  const applied = Math.max(input.deltaCents, -Math.max(0, before)) || 0;
  const updated = applied === 0
    ? redemption
    : await tx.promoCodeRedemption.update({
      where: { id: redemption.id },
      data: { sponsorLodgingChangeCents: { increment: applied } },
      select: { id: true, discountAmountCents: true, sponsorLodgingChangeCents: true },
    });
  const after = updated.discountAmountCents + updated.sponsorLodgingChangeCents;
  if (applied !== 0) {
    await writeAuditLog({
      eventId: input.eventId, actorUserId: input.actorUserId ?? undefined, action: "CHURCH_SPONSOR_SHARE_CHANGED",
      entityType: "PromoCodeRedemption", entityId: redemption.id,
      summary: "A lodging change moved a church's amount owed.",
      metadata: {
        registrationId: input.registrationId, redemptionId: redemption.id, churchId,
        lodgingRequestVersionId: input.lodgingRequestVersionId,
        fromCents: before, toCents: after, deltaCents: applied, requestedDeltaCents: input.deltaCents,
      },
    }, tx);
  }
  return { status: "UPDATED", deltaCents: applied, churchName, registrationOwedCents: Math.max(0, after) };
}

export type ChurchSponsorFinanceReviewRow = {
  id: string;
  churchId: string;
  churchName: string;
  confirmationCode: string;
  deltaCents: number;
  createdAt: string;
  invoiceVersionId: string | null;
};

/** The open flags of an event, oldest first. Finance only: a confirmation code and amounts, never an attendee name. */
export async function listOpenChurchSponsorFlags(eventId: string, client: Client = getPrisma()): Promise<ChurchSponsorFinanceReviewRow[]> {
  const rows = await client.churchSponsorFinanceReview.findMany({
    where: { eventId, clearedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, churchId: true, deltaCents: true, createdAt: true, invoiceVersionId: true,
      church: { select: { name: true } }, registration: { select: { confirmationCode: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id, churchId: row.churchId, churchName: row.church.name, confirmationCode: row.registration.confirmationCode,
    deltaCents: row.deltaCents, createdAt: row.createdAt.toISOString(), invoiceVersionId: row.invoiceVersionId,
  }));
}

export async function countOpenChurchSponsorFlags(eventId: string, client: Client = getPrisma(), churchId?: string) {
  return client.churchSponsorFinanceReview.count({ where: { eventId, clearedAt: null, ...(churchId ? { churchId } : {}) } });
}

export class ChurchSponsorFlagError extends Error {
  constructor(message: string, readonly code: "FLAG_NOT_FOUND" | "ALREADY_CLEARED") {
    super(message);
    this.name = "ChurchSponsorFlagError";
  }
}

/**
 * The finance office has dealt with a flag (revised the invoice through the invoice-revision path, or decided no change is
 * needed). Clearing changes no amount and no invoice: it only takes the flag off the lists. Idempotent per flag: a second
 * clear is refused rather than overwriting who cleared it.
 */
export async function clearChurchSponsorFlag(
  input: { eventId: string; flagId: string; actorUserId: string; note?: string | null },
  client: PrismaClient = getPrisma(),
) {
  const note = input.note?.trim().slice(0, 300) || null;
  return client.$transaction(async (tx) => {
    const flag = await tx.churchSponsorFinanceReview.findFirst({
      where: { id: input.flagId, eventId: input.eventId },
      select: { id: true, churchId: true, registrationId: true, deltaCents: true, clearedAt: true },
    });
    if (!flag) throw new ChurchSponsorFlagError("That flag was not found.", "FLAG_NOT_FOUND");
    const cleared = await tx.churchSponsorFinanceReview.updateMany({
      where: { id: flag.id, clearedAt: null },
      data: { clearedAt: new Date(), clearedByUserId: input.actorUserId, clearNote: note },
    });
    if (cleared.count === 0) throw new ChurchSponsorFlagError("That flag was already cleared.", "ALREADY_CLEARED");
    await writeAuditLog({
      eventId: input.eventId, actorUserId: input.actorUserId, action: "CHURCH_SPONSOR_FLAG_CLEARED",
      entityType: "ChurchSponsorFinanceReview", entityId: flag.id,
      summary: "The finance office cleared a church sponsorship flag.",
      metadata: { registrationId: flag.registrationId, churchId: flag.churchId, deltaCents: flag.deltaCents },
    }, tx);
    return { id: flag.id };
  });
}
