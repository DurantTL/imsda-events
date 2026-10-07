import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { getPrisma } from "@/lib/prisma";

type Client = Prisma.TransactionClient | PrismaClient;

/**
 * The church's share of a lodging change (#813). A church-sponsored registration-level code pays its percentage of what
 * the registrant is charged, so when staff change the lodging (or an amendment recomputes the discount) the church's
 * share is RECOMPUTED, never nudged by a running sum of changes:
 *
 *   sponsorLodgingChangeCents = discount(other lines + current lodging charge) - discount(other lines + stored lodging line)
 *
 * `desiredCents` is that figure, computed by the lodging module under the registration's lodging lock with the code's real
 * percent, cap and minimum. Setting it is idempotent and self-correcting: a rate change between edits, a revert, a capped
 * code or an amendment can never leave drift behind, because every recompute starts from the registration as it is now.
 * It lives in `PromoCodeRedemption.sponsorLodgingChangeCents`, not in `discountAmountCents` (an amendment rewrites that
 * from the form) and not in a sponsored `PROMO_CODE` adjustment (every adjustment is added to the registrant's own total).
 * The church-owed readers floor each registration at $0.
 *
 * - Before finalization the new value is stored in the caller's transaction, with an audit row (before, after and the basis
 *   figures) whenever the stored value changes.
 * - On an event billed through invoices (DEFERRED_ORGANIZATION_INVOICE), when the church's invoice is already finalized
 *   (Caleb, #813) nothing is revised and nothing is stored: one open `ChurchSponsorFinanceReview` per registration holds
 *   the difference for the finance office, updated in place and closed again if the share returns to the invoiced amount.
 *   On an attendee-pay event (where sponsored codes live) there is no invoice vehicle, so no flag: an unrelated invoice of
 *   the church can never freeze its share.
 *
 * No money moves, no invoice is created, sent or revised, and audit rows carry ids and amounts only.
 */
export type ChurchShareOutcome =
  | {
      status: "UPDATED";
      /** How much the church's share moved by in this recompute. */
      deltaCents: number;
      churchName: string;
      /** The church's share for this registration now (never the church's event total: that is finance data). */
      registrationOwedCents: number;
      /** What the share should be (and now is): the recompute. */
      desiredCents: number;
    }
  | { status: "UNCHANGED"; churchName: string; registrationOwedCents: number; desiredCents: number }
  | { status: "FLAGGED"; deltaCents: number; churchName: string; desiredCents: number };

export type ChurchShareBasis = { currentLodgingCents: number; storedLodgingCents: number };

export async function setChurchShare(
  tx: Prisma.TransactionClient,
  input: { eventId: string; registrationId: string; desiredCents: number; sourceKey: string; basis: ChurchShareBasis; actorUserId: string | null },
): Promise<ChurchShareOutcome | null> {
  const found = await tx.promoCodeRedemption.findUnique({
    where: { registrationId: input.registrationId },
    select: { id: true, promoCode: { select: { sponsoringOrganizationId: true, sponsoringOrganization: { select: { name: true } } } } },
  });
  const churchId = found?.promoCode.sponsoringOrganizationId;
  if (!found || !churchId) return null;
  const churchName = found.promoCode.sponsoringOrganization?.name ?? "the church";
  // Serializes with every other writer of this row. The caller computed the figure under the registration's lodging lock;
  // the row is read again here, after it is locked, so the comparison is against what is stored now.
  await tx.$queryRaw`SELECT "id" FROM "PromoCodeRedemption" WHERE "id" = ${found.id} FOR UPDATE`;
  const redemption = await tx.promoCodeRedemption.findUniqueOrThrow({
    where: { id: found.id },
    select: { id: true, discountAmountCents: true, sponsorLodgingChangeCents: true },
  });
  const owed = (moved: number) => Math.max(0, redemption.discountAmountCents + moved);
  const desired = Math.trunc(input.desiredCents);
  const stored = redemption.sponsorLodgingChangeCents;

  const event = await tx.event.findUnique({ where: { id: input.eventId }, select: { billingMode: true } });
  const finalized = event?.billingMode === "DEFERRED_ORGANIZATION_INVOICE"
    ? await tx.invoiceVersion.findFirst({
      where: { eventId: input.eventId, status: "FINALIZED", invoice: { partyKind: "ORGANIZATION", partyId: churchId } },
      select: { id: true },
      orderBy: { revision: "desc" },
    })
    : null;
  if (finalized) {
    // What the finance office last reviewed is the baseline once they have cleared a flag; before that, the stored share (the
    // invoiced amount). Only a recompute that differs from it raises a flag, so a cleared flag does not come straight back.
    const reviewed = await tx.churchSponsorFinanceReview.findFirst({
      where: { registrationId: input.registrationId, reviewedShareCents: { not: null } },
      orderBy: { clearedAt: "desc" },
      select: { reviewedShareCents: true },
    });
    const baseline = reviewed?.reviewedShareCents ?? stored;
    const difference = desired - baseline;
    const open = await tx.churchSponsorFinanceReview.findFirst({ where: { registrationId: input.registrationId, clearedAt: null }, select: { id: true } });
    if (difference === 0) {
      // Back at the invoiced amount: nothing is left for the finance office to review.
      if (open) {
        await tx.churchSponsorFinanceReview.update({ where: { id: open.id }, data: { clearedAt: new Date(), clearNote: "The share returned to the invoiced amount." } });
        await writeAuditLog({
          eventId: input.eventId, actorUserId: input.actorUserId ?? undefined, action: "CHURCH_SPONSOR_FLAG_CLEARED",
          entityType: "ChurchSponsorFinanceReview", entityId: open.id,
          summary: "A church sponsorship flag closed itself: the share returned to the invoiced amount.",
          metadata: { registrationId: input.registrationId, churchId, deltaCents: 0 },
        }, tx);
      }
      return { status: "UNCHANGED", churchName, registrationOwedCents: owed(stored), desiredCents: desired };
    }
    const flag = open
      ? await tx.churchSponsorFinanceReview.update({ where: { id: open.id }, data: { deltaCents: difference, desiredShareCents: desired, sourceKey: input.sourceKey, invoiceVersionId: finalized.id }, select: { id: true } })
      : await tx.churchSponsorFinanceReview.create({
        data: { eventId: input.eventId, registrationId: input.registrationId, churchId, invoiceVersionId: finalized.id, sourceKey: input.sourceKey, deltaCents: difference, desiredShareCents: desired },
        select: { id: true },
      });
    await writeAuditLog({
      eventId: input.eventId, actorUserId: input.actorUserId ?? undefined, action: "CHURCH_SPONSOR_SHARE_FLAGGED",
      entityType: "ChurchSponsorFinanceReview", entityId: flag.id,
      summary: "A lodging change moved a church's share after its invoice was finalized; flagged for the finance office. Nothing was changed.",
      metadata: {
        registrationId: input.registrationId, redemptionId: redemption.id, churchId, invoiceVersionId: finalized.id,
        sourceKey: input.sourceKey, deltaCents: difference, ...input.basis,
      },
    }, tx);
    return { status: "FLAGGED", deltaCents: difference, churchName, desiredCents: desired };
  }

  if (desired === stored) {
    // Rewrite the row with the same value (no audit row: nothing changed). An amendment runs at Serializable and may hold a
    // snapshot older than this edit's request version; its own write to this row then fails as a serialization conflict and is
    // retried against the new request, instead of storing a figure recomputed from a request that is no longer current.
    await tx.promoCodeRedemption.update({ where: { id: redemption.id }, data: { sponsorLodgingChangeCents: stored } });
    return { status: "UNCHANGED", churchName, registrationOwedCents: owed(stored), desiredCents: desired };
  }
  await tx.promoCodeRedemption.update({ where: { id: redemption.id }, data: { sponsorLodgingChangeCents: desired } });
  await writeAuditLog({
    eventId: input.eventId, actorUserId: input.actorUserId ?? undefined, action: "CHURCH_SPONSOR_SHARE_CHANGED",
    entityType: "PromoCodeRedemption", entityId: redemption.id,
    summary: "A lodging change moved a church's amount owed.",
    metadata: {
      registrationId: input.registrationId, redemptionId: redemption.id, churchId, sourceKey: input.sourceKey,
      fromCents: owed(stored), toCents: owed(desired), beforeCents: stored, afterCents: desired, deltaCents: desired - stored, ...input.basis,
    },
  }, tx);
  return { status: "UPDATED", deltaCents: desired - stored, churchName, registrationOwedCents: owed(desired), desiredCents: desired };
}

export type ChurchSponsorFinanceFlagRow = {
  id: string;
  churchId: string;
  churchName: string;
  confirmationCode: string;
  deltaCents: number;
  /** What the church's share should be now. */
  shareCents: number;
  /** The share the finance office reviewed when they cleared an earlier flag for this registration, if they did. */
  reviewedShareCents: number | null;
  createdAt: string;
  invoiceVersionId: string | null;
};

/** The open flags of an event, oldest first. Finance only: a confirmation code and amounts, never an attendee name. */
export async function listOpenChurchSponsorFlags(eventId: string, client: Client = getPrisma()): Promise<ChurchSponsorFinanceFlagRow[]> {
  const rows = await client.churchSponsorFinanceReview.findMany({
    where: { eventId, clearedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, churchId: true, registrationId: true, deltaCents: true, desiredShareCents: true, createdAt: true, invoiceVersionId: true,
      church: { select: { name: true } }, registration: { select: { confirmationCode: true } },
    },
  });
  const cleared = rows.length === 0 ? [] : await client.churchSponsorFinanceReview.findMany({
    where: { eventId, registrationId: { in: rows.map((row) => row.registrationId) }, reviewedShareCents: { not: null } },
    orderBy: { clearedAt: "asc" },
    select: { registrationId: true, reviewedShareCents: true },
  });
  const reviewed = new Map(cleared.map((row) => [row.registrationId, row.reviewedShareCents] as const));
  return rows.map((row) => ({
    id: row.id, churchId: row.churchId, churchName: row.church.name, confirmationCode: row.registration.confirmationCode,
    deltaCents: row.deltaCents, shareCents: row.desiredShareCents, reviewedShareCents: reviewed.get(row.registrationId) ?? null,
    createdAt: row.createdAt.toISOString(), invoiceVersionId: row.invoiceVersionId,
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
      select: { id: true, churchId: true, registrationId: true, deltaCents: true, desiredShareCents: true, clearedAt: true },
    });
    if (!flag) throw new ChurchSponsorFlagError("That flag was not found.", "FLAG_NOT_FOUND");
    const cleared = await tx.churchSponsorFinanceReview.updateMany({
      where: { id: flag.id, clearedAt: null },
      data: { clearedAt: new Date(), clearedByUserId: input.actorUserId, clearNote: note, reviewedShareCents: flag.desiredShareCents },
    });
    if (cleared.count === 0) throw new ChurchSponsorFlagError("That flag was already cleared.", "ALREADY_CLEARED");
    await writeAuditLog({
      eventId: input.eventId, actorUserId: input.actorUserId, action: "CHURCH_SPONSOR_FLAG_CLEARED",
      entityType: "ChurchSponsorFinanceReview", entityId: flag.id,
      summary: "The finance office cleared a church sponsorship flag.",
      metadata: { registrationId: flag.registrationId, churchId: flag.churchId, deltaCents: flag.deltaCents, reviewedShareCents: flag.desiredShareCents },
    }, tx);
    return { id: flag.id };
  });
}
