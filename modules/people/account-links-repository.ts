import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  attendeeAccountPersonLinkInputSchema,
  userPersonLinkInputSchema,
  type AttendeeAccountPersonLinkRecord,
  type UserPersonLinkRecord,
} from "@/modules/people/account-links-domain";

/**
 * These links carry provenance for audit and support, and nothing else.
 * Deliberately, no function here returns or checks a permission, an event
 * id, or a role — `modules/access/authorization.ts` never imports from this
 * file, and this file never imports from it either. See
 * `tests/account-links-invariant.test.ts` for the regression test.
 */
export class PersonLinkError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "ALREADY_LINKED" | "INVALID_ACTOR",
    message: string,
  ) {
    super(message);
    this.name = "PersonLinkError";
  }
}

function conflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new PersonLinkError("ALREADY_LINKED", "This account is already linked to a person.");
  }
  throw error;
}

function serializeAttendeeAccountLink(row: {
  id: string;
  accountId: string;
  personId: string;
  provenance: string;
  actorAttendeeAccountId: string | null;
  actorUserId: string | null;
  evidenceReference: string;
  createdAt: Date;
}): AttendeeAccountPersonLinkRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    personId: row.personId,
    provenance: row.provenance as AttendeeAccountPersonLinkRecord["provenance"],
    actorAttendeeAccountId: row.actorAttendeeAccountId,
    actorUserId: row.actorUserId,
    evidenceReference: row.evidenceReference,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeUserLink(row: {
  id: string;
  userId: string;
  personId: string;
  provenance: string;
  actorUserId: string;
  evidenceReference: string;
  createdAt: Date;
}): UserPersonLinkRecord {
  return {
    id: row.id,
    userId: row.userId,
    personId: row.personId,
    provenance: row.provenance as UserPersonLinkRecord["provenance"],
    actorUserId: row.actorUserId,
    evidenceReference: row.evidenceReference,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Links an attendee account to a person. An account links to exactly one
 * person — enforced by the unique index on `accountId`, surfaced here as a
 * domain error rather than a raw constraint violation.
 */
export async function linkAttendeeAccountToPerson(accountId: string, rawInput: unknown) {
  const input = attendeeAccountPersonLinkInputSchema.parse(rawInput);
  const prisma = getPrisma();

  const [account, person] = await Promise.all([
    prisma.attendeeAccount.findUnique({ where: { id: accountId }, select: { id: true } }),
    prisma.person.findUnique({ where: { id: input.personId }, select: { id: true } }),
  ]);
  if (!account) throw new PersonLinkError("NOT_FOUND", "That attendee account was not found.");
  if (!person) throw new PersonLinkError("NOT_FOUND", "That person was not found.");

  if (input.provenance === "SELF_SERVICE_VERIFICATION" && input.actorAttendeeAccountId !== accountId) {
    throw new PersonLinkError(
      "INVALID_ACTOR",
      "A self-service link's actor must be the account being linked.",
    );
  }

  try {
    const created = await prisma.attendeeAccountPersonLink.create({
      data: {
        accountId,
        personId: input.personId,
        provenance: input.provenance,
        actorAttendeeAccountId: input.actorAttendeeAccountId ?? null,
        actorUserId: input.actorUserId ?? null,
        evidenceReference: input.evidenceReference,
      },
    });
    return serializeAttendeeAccountLink(created);
  } catch (error) {
    return conflict(error);
  }
}

/** Links a staff user to a person. A user links to exactly one person. */
export async function linkUserToPerson(userId: string, rawInput: unknown) {
  const input = userPersonLinkInputSchema.parse(rawInput);
  const prisma = getPrisma();

  const [user, person] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    prisma.person.findUnique({ where: { id: input.personId }, select: { id: true } }),
  ]);
  if (!user) throw new PersonLinkError("NOT_FOUND", "That staff account was not found.");
  if (!person) throw new PersonLinkError("NOT_FOUND", "That person was not found.");

  if (input.provenance === "SELF_SERVICE_VERIFICATION" && input.actorUserId !== userId) {
    throw new PersonLinkError(
      "INVALID_ACTOR",
      "A self-service link's actor must be the account being linked.",
    );
  }

  try {
    const created = await prisma.userPersonLink.create({
      data: {
        userId,
        personId: input.personId,
        provenance: input.provenance,
        actorUserId: input.actorUserId,
        evidenceReference: input.evidenceReference,
      },
    });
    return serializeUserLink(created);
  } catch (error) {
    return conflict(error);
  }
}

/** The person an attendee account is linked to, if any. Identity only —
 * callers needing event access must still go through
 * `modules/access/authorization.ts`, which does not consult this table. */
export async function getPersonForAttendeeAccount(accountId: string) {
  const link = await getPrisma().attendeeAccountPersonLink.findUnique({ where: { accountId } });
  return link ? serializeAttendeeAccountLink(link) : null;
}

/** The person a staff user is linked to, if any. Identity only — see the
 * note on `getPersonForAttendeeAccount`. */
export async function getPersonForUser(userId: string) {
  const link = await getPrisma().userPersonLink.findUnique({ where: { userId } });
  return link ? serializeUserLink(link) : null;
}

/** Every account link recorded against a person, across both account
 * types. A person may have several. */
export async function listAccountLinksForPerson(personId: string) {
  const prisma = getPrisma();
  const [attendeeAccountLinks, userLinks] = await Promise.all([
    prisma.attendeeAccountPersonLink.findMany({ where: { personId }, orderBy: { createdAt: "asc" } }),
    prisma.userPersonLink.findMany({ where: { personId }, orderBy: { createdAt: "asc" } }),
  ]);
  return {
    attendeeAccountLinks: attendeeAccountLinks.map(serializeAttendeeAccountLink),
    userLinks: userLinks.map(serializeUserLink),
  };
}
