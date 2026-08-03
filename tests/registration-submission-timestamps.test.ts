import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@prisma/client", () => ({
  Prisma: {
    TransactionIsolationLevel: { Serializable: "Serializable" },
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {},
  },
}));

import {
  createRegistration,
  updateRegistration,
} from "@/modules/registrations/repository";

const submittedAt = new Date("2026-07-01T12:00:00.000Z");

function registrationRecord(status: "DRAFT" | "SUBMITTED", submitted: Date | null) {
  return {
    id: "registration-1",
    eventId: "event-1",
    accountHolderPersonId: "person-1",
    confirmationCode: "REG-ONE",
    status,
    totalAmount: 100,
    contactSnapshot: {
      firstName: "Synthetic",
      lastName: "Registrant",
      email: "synthetic@example.test",
      phone: "",
    },
    submittedAt: submitted,
    cancelledAt: null,
    createdAt: new Date("2026-06-30T12:00:00.000Z"),
    updatedAt: new Date("2026-07-02T12:00:00.000Z"),
    accountHolderPerson: {
      id: "person-1",
      firstName: "Synthetic",
      lastName: "Registrant",
      normalizedEmail: "synthetic@example.test",
      phone: null,
    },
    attendees: [{
      id: "attendee-1",
      personId: "person-1",
      attendeeType: "ATTENDEE",
      position: 0,
      profileSnapshot: {
        firstName: "Synthetic",
        lastName: "Registrant",
        email: "synthetic@example.test",
        phone: "",
      },
      formResponses: {},
      createdAt: new Date("2026-06-30T12:00:00.000Z"),
      person: {
        firstName: "Synthetic",
        lastName: "Registrant",
        normalizedEmail: "synthetic@example.test",
        phone: null,
      },
      checkIns: [],
    }],
    payments: [],
    messages: [],
    operations: [],
    publicFormSubmission: null,
  };
}

function fixture(status: "DRAFT" | "SUBMITTED", submitted: Date | null) {
  let registration = registrationRecord(status, submitted);
  const tx = {
    person: {
      upsert: vi.fn().mockResolvedValue(registration.accountHolderPerson),
      create: vi.fn().mockResolvedValue(registration.accountHolderPerson),
      update: vi.fn().mockResolvedValue(registration.accountHolderPerson),
    },
    registration: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        registration = registrationRecord(
          data.status as "DRAFT" | "SUBMITTED",
          data.submittedAt as Date | null,
        );
        return registration;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        registration = { ...registration, ...data };
        return registration;
      }),
    },
    registrationAttendee: {
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    registration: {
      findFirst: vi.fn(async () => registration),
      findMany: vi.fn(async () => [registration]),
    },
    $transaction: vi.fn(async (
      operation: (client: typeof tx) => unknown,
    ) => operation(tx)),
  };
  return { prisma };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registration submission timestamps", () => {
  it("keeps a staff-created draft unknown through later edits", async () => {
    const { prisma } = fixture("DRAFT", null);
    dependencies.getPrisma.mockReturnValue(prisma);

    const created = await createRegistration("event-1", {
      firstName: "Synthetic",
      lastName: "Registrant",
      email: "synthetic@example.test",
      phone: "",
      attendeeType: "ATTENDEE",
      status: "DRAFT",
      totalAmountCents: 10_000,
    }, "user-1");
    const edited = await updateRegistration(
      "event-1",
      "registration-1",
      { totalAmountCents: 12_500 },
      "user-1",
    );

    expect(created?.submittedAt).toBeNull();
    expect(edited?.submittedAt).toBeNull();
  });

  it("preserves the original submitted time through repeated staff edits", async () => {
    const { prisma } = fixture("SUBMITTED", submittedAt);
    dependencies.getPrisma.mockReturnValue(prisma);

    const firstEdit = await updateRegistration(
      "event-1",
      "registration-1",
      { totalAmountCents: 12_500 },
      "user-1",
    );
    const secondEdit = await updateRegistration(
      "event-1",
      "registration-1",
      { phone: "555-0100" },
      "user-1",
    );

    expect(firstEdit?.submittedAt).toBe(submittedAt.toISOString());
    expect(secondEdit?.submittedAt).toBe(submittedAt.toISOString());
  });

  it("backfills only statuses that prove a successful submission", () => {
    const migration = readFileSync(
      new URL(
        "../prisma/migrations/20260803160000_registration_submitted_at_backfill/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain('WHERE "submittedAt" IS NULL');
    expect(migration).toContain(
      '"status" IN (\'SUBMITTED\', \'CONFIRMED\', \'WAITLISTED\')',
    );
    expect(migration).not.toContain("'DRAFT'");
    expect(migration).not.toContain("'CANCELLED'");
  });
});
