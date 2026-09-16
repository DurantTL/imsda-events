import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import {
  PersonLinkError,
  linkAttendeeAccountToPerson,
  linkUserToPerson,
  getPersonForAttendeeAccount,
  getPersonForUser,
  listAccountLinksForPerson,
} from "@/modules/people/account-links-repository";

function duplicateKeyError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

function fixture() {
  const account = { id: "acc_alicia" };
  const person = { id: "per_alicia" };
  const user = { id: "usr_dana" };

  const attendeeAccountPersonLink = {
    create: vi.fn(),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const userPersonLink = {
    create: vi.fn(),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const prisma = {
    attendeeAccount: { findUnique: vi.fn().mockResolvedValue(account) },
    user: { findUnique: vi.fn().mockResolvedValue(user) },
    person: { findUnique: vi.fn().mockResolvedValue(person) },
    attendeeAccountPersonLink,
    userPersonLink,
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return { prisma, account, person, user, attendeeAccountPersonLink, userPersonLink };
}

beforeEach(() => vi.clearAllMocks());

describe("linkAttendeeAccountToPerson", () => {
  it("creates a self-service link actored by the account itself", async () => {
    const { attendeeAccountPersonLink } = fixture();
    const created = {
      id: "link_1",
      accountId: "acc_alicia",
      personId: "per_alicia",
      provenance: "SELF_SERVICE_VERIFICATION",
      actorAttendeeAccountId: "acc_alicia",
      actorUserId: null,
      evidenceReference: "verification-token:tok_1",
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
    };
    attendeeAccountPersonLink.create.mockResolvedValue(created);

    const result = await linkAttendeeAccountToPerson("acc_alicia", {
      personId: "per_alicia",
      provenance: "SELF_SERVICE_VERIFICATION",
      actorAttendeeAccountId: "acc_alicia",
      evidenceReference: "verification-token:tok_1",
    });

    expect(result).toMatchObject({ id: "link_1", provenance: "SELF_SERVICE_VERIFICATION" });
    expect(attendeeAccountPersonLink.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accountId: "acc_alicia", personId: "per_alicia" }),
      }),
    );
  });

  it("rejects a self-service link whose actor account is not the account being linked", async () => {
    fixture();
    await expect(
      linkAttendeeAccountToPerson("acc_alicia", {
        personId: "per_alicia",
        provenance: "SELF_SERVICE_VERIFICATION",
        actorAttendeeAccountId: "acc_someone_else",
        evidenceReference: "verification-token:tok_1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ACTOR" });
  });

  it("raises a domain error, not a raw constraint violation, when the account is already linked", async () => {
    const { attendeeAccountPersonLink } = fixture();
    attendeeAccountPersonLink.create.mockRejectedValue(duplicateKeyError());

    await expect(
      linkAttendeeAccountToPerson("acc_alicia", {
        personId: "per_alicia",
        provenance: "STAFF_ACTION",
        actorUserId: "usr_dana",
        evidenceReference: "staff-note:note_1",
      }),
    ).rejects.toMatchObject({ code: "ALREADY_LINKED" });
    expect(PersonLinkError).toBeDefined();
  });

  it("rejects linking to an account or person that does not exist", async () => {
    const { prisma } = fixture();
    prisma.attendeeAccount.findUnique.mockResolvedValue(null);
    await expect(
      linkAttendeeAccountToPerson("acc_missing", {
        personId: "per_alicia",
        provenance: "STAFF_ACTION",
        actorUserId: "usr_dana",
        evidenceReference: "staff-note:note_1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("linkUserToPerson", () => {
  it("creates a staff-action link", async () => {
    const { userPersonLink } = fixture();
    const created = {
      id: "link_2",
      userId: "usr_dana",
      personId: "per_dana",
      provenance: "STAFF_ACTION",
      actorUserId: "usr_admin",
      evidenceReference: "staff-note:note_2",
      createdAt: new Date("2026-01-06T00:00:00.000Z"),
    };
    userPersonLink.create.mockResolvedValue(created);

    const result = await linkUserToPerson("usr_dana", {
      personId: "per_dana",
      provenance: "STAFF_ACTION",
      actorUserId: "usr_admin",
      evidenceReference: "staff-note:note_2",
    });

    expect(result).toMatchObject({ id: "link_2", actorUserId: "usr_admin" });
  });

  it("one user links to exactly one person: a second attempt is a domain error", async () => {
    const { userPersonLink } = fixture();
    userPersonLink.create.mockRejectedValue(duplicateKeyError());

    await expect(
      linkUserToPerson("usr_dana", {
        personId: "per_dana_2",
        provenance: "STAFF_ACTION",
        actorUserId: "usr_admin",
        evidenceReference: "staff-note:note_3",
      }),
    ).rejects.toMatchObject({ code: "ALREADY_LINKED" });
  });
});

describe("read paths", () => {
  it("returns null, not throwing, when an account has no link", async () => {
    fixture();
    await expect(getPersonForAttendeeAccount("acc_unlinked")).resolves.toBeNull();
    await expect(getPersonForUser("usr_unlinked")).resolves.toBeNull();
  });

  it("lists every link recorded against a person, across both account types", async () => {
    const { attendeeAccountPersonLink, userPersonLink } = fixture();
    attendeeAccountPersonLink.findMany.mockResolvedValue([
      {
        id: "link_1",
        accountId: "acc_alicia",
        personId: "per_alicia",
        provenance: "SELF_SERVICE_VERIFICATION",
        actorAttendeeAccountId: "acc_alicia",
        actorUserId: null,
        evidenceReference: "verification-token:tok_1",
        createdAt: new Date("2026-01-05T00:00:00.000Z"),
      },
    ]);
    userPersonLink.findMany.mockResolvedValue([
      {
        id: "link_2",
        userId: "usr_dana",
        personId: "per_alicia",
        provenance: "STAFF_ACTION",
        actorUserId: "usr_admin",
        evidenceReference: "staff-note:note_2",
        createdAt: new Date("2026-01-06T00:00:00.000Z"),
      },
    ]);

    const result = await listAccountLinksForPerson("per_alicia");
    expect(result.attendeeAccountLinks).toHaveLength(1);
    expect(result.userLinks).toHaveLength(1);
  });
});
