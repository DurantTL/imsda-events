import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { moneyToCents, registrationBalanceCents } from "@/modules/payments/square-domain";
import {
  describePublicRegistrationStatus,
  publicAttendeeName,
  type PublicRegistrationStatusSummary,
} from "@/modules/public-access/domain";

/**
 * Every registration an account may see: those whose contact address is the
 * account's own verified address, and nothing else (ADR 0003).
 *
 * Matching is on the address and never on the name. A shared family address
 * therefore returns several registrations, which is usually correct — one parent
 * registers the household — and where it is not, the household already shares
 * the inbox the private links were sent to. An account changes nothing about who
 * could already see what.
 */

/**
 * A registration's contact address is the one in `contactSnapshot`, falling back
 * to the account holder's `Person` record. That is the precedence
 * `publicContactFromSnapshot` applies when it renders the private management
 * page, and the two must agree: an address that shows as the contact there has
 * to be the address that claims the registration here.
 *
 * It is expressed in SQL rather than filtered in memory so a full table read is
 * not the cost of signing in. `attendee-registration-matching.test.ts` pins it
 * against the TypeScript rule so the two cannot drift apart silently.
 *
 * A DRAFT registration is excluded. It is an abandoned form rather than
 * something anyone submitted, and listing one back to a registrant as though it
 * were theirs would be a puzzle, not a service.
 */
const CONTACT_EMAIL_SQL = Prisma.sql`
  lower(coalesce(
    nullif(trim(registration."contactSnapshot"->>'email'), ''),
    person."normalizedEmail",
    ''
  ))
`;

async function matchingRegistrationIds(verifiedEmail: string) {
  const rows = await getPrisma().$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT registration."id"
    FROM "Registration" registration
    JOIN "Person" person ON person."id" = registration."accountHolderPersonId"
    WHERE registration."status" <> 'DRAFT'
      AND ${CONTACT_EMAIL_SQL} = ${verifiedEmail}
  `);
  return rows.map((row) => row.id);
}

export type AttendeeRegistrationSummary = {
  id: string;
  confirmationCode: string;
  status: PublicRegistrationStatusSummary;
  submittedAt: string | null;
  event: {
    name: string;
    slug: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
    location: string | null;
  };
  attendeeNames: string[];
  totalCents: number;
  paidCents: number;
  balanceCents: number;
};

/**
 * The list behind the account's one page. Read-only: this slice recognises a
 * registrant, it does not yet let one change anything.
 */
export async function listRegistrationsForVerifiedEmail(
  verifiedEmail: string,
): Promise<AttendeeRegistrationSummary[]> {
  const ids = await matchingRegistrationIds(verifiedEmail);
  if (ids.length === 0) return [];

  const registrations = await getPrisma().registration.findMany({
    where: { id: { in: ids } },
    orderBy: [{ event: { startsAt: "desc" } }, { createdAt: "desc" }],
    select: {
      id: true,
      confirmationCode: true,
      status: true,
      submittedAt: true,
      totalAmount: true,
      event: {
        select: {
          name: true,
          slug: true,
          startsAt: true,
          endsAt: true,
          timezone: true,
          location: true,
        },
      },
      attendees: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: {
          profileSnapshot: true,
          person: { select: { firstName: true, lastName: true } },
        },
      },
      payments: {
        where: { status: "SUCCEEDED" },
        select: {
          amount: true,
          refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } },
        },
      },
      waitlistEntry: { select: { position: true, status: true } },
    },
  });

  return registrations.map((registration) => {
    const totalCents = moneyToCents(registration.totalAmount);
    // The same arithmetic the payment path and the private management page use,
    // so a balance shown here can never disagree with the one shown there.
    const balanceCents = registrationBalanceCents(registration);
    return {
      id: registration.id,
      confirmationCode: registration.confirmationCode,
      // The same wording the private management page uses. A registrant who
      // reaches the same registration two ways must not be told two things.
      status: describePublicRegistrationStatus(
        registration.status,
        registration.waitlistEntry?.status === "WAITING"
          ? registration.waitlistEntry.position
          : null,
      ),
      submittedAt: registration.submittedAt?.toISOString() ?? null,
      event: {
        name: registration.event.name,
        slug: registration.event.slug,
        startsAt: registration.event.startsAt.toISOString(),
        endsAt: registration.event.endsAt.toISOString(),
        timezone: registration.event.timezone,
        location: registration.event.location,
      },
      attendeeNames: registration.attendees.map(
        (attendee) => publicAttendeeName(attendee.profileSnapshot, attendee.person),
      ),
      totalCents,
      paidCents: Math.max(0, totalCents - balanceCents),
      balanceCents,
    };
  });
}
