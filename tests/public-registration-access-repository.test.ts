import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  enqueueRegistrationAccessRecoveryMessage: vi.fn(),
  enqueueRegistrationContactUpdatedMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueRegistrationAccessRecoveryMessage:
    dependencies.enqueueRegistrationAccessRecoveryMessage,
  enqueueRegistrationContactUpdatedMessage:
    dependencies.enqueueRegistrationContactUpdatedMessage,
}));

import {
  authorizeRegistrationAccessToken,
  confirmPublicRegistrationShirtSizes,
  issueRegistrationAccessToken,
  issueStableRegistrationAccessToken,
  requestRegistrationAccessRecovery,
  resolveRegistrationAccessToken,
  revokeRegistrationAccessToken,
  updatePublicRegistrationContact,
} from "@/modules/public-access/repository";

function accessRecord(overrides: {
  expiresAt?: Date;
  revokedAt?: Date | null;
  status?: "SUBMITTED" | "CONFIRMED" | "WAITLISTED" | "CANCELLED";
} = {}) {
  const status = overrides.status ?? "SUBMITTED";
  return {
    id: "access-1",
    registrationId: "registration-1",
    tokenHash: "stored-hash",
    purpose: "MANAGE_REGISTRATION",
    expiresAt: overrides.expiresAt ?? new Date("2026-11-10T18:00:00.000Z"),
    revokedAt: overrides.revokedAt ?? null,
    createdAt: new Date("2026-07-23T12:00:00.000Z"),
    registration: {
      id: "registration-1",
      eventId: "event-1",
      confirmationCode: "REG-PRIVATE",
      status,
      totalAmount: { toString: () => "250.00" },
      contactSnapshot: {},
      submittedAt: new Date("2026-07-23T12:00:00.000Z"),
      updatedAt: new Date("2026-07-25T12:00:00.000Z"),
      event: {
        name: "Women’s Retreat",
        slug: "womens-retreat-2026",
        startsAt: new Date("2026-10-09T21:00:00.000Z"),
        endsAt: new Date("2026-10-11T17:00:00.000Z"),
        timezone: "America/Chicago",
        location: "Camp Heritage",
        publicInfoUrl: "https://imsda.org/event/womens-retreat-3/",
        supportContact: "registration@imsda.org",
        collectsShirtSizes: true,
        attendeeEditPolicy: "TIERED",
      },
      accountHolderPerson: {
        firstName: "Caleb",
        lastName: "Durant",
        normalizedEmail: "caleb@example.test",
        phone: "555-0101",
      },
      attendees: [{
        id: "attendee-1",
        formResponses: {
          shirt_size: "Adult L",
          session_preferences: ["Prayer", "Service"],
          medical_note: "PRIVATE-MEDICAL",
        } as Record<string, unknown>,
        profileSnapshot: {
          firstName: "Retreat",
          lastName: "Guest",
          email: "private@example.test",
        },
        person: {
          firstName: "Canonical",
          lastName: "Person",
        },
      }],
      payments: [{
        amount: { toString: () => "100.00" },
        refunds: [{ amount: { toString: () => "25.00" } }],
      }],
      waitlistEntry: status === "WAITLISTED"
        ? { position: 3, status: "WAITING" }
        : null,
      publicFormSubmission: {
        createdAt: new Date("2026-07-23T12:00:00.000Z"),
        responses: {},
        pricingSnapshot: {},
        attendeeResponses: [{ registration_fee: "Standard" }],
        formVersion: {
          versionNumber: 2,
          definition: {
            title: "Attendee registration",
            description: "",
            confirmationMessage: "Received.",
            sections: [{
              id: "sessions",
              title: "Sessions",
              description: "",
              fields: [{
                id: "session_preferences",
                key: "session_preferences",
                label: "Seminar preferences",
                helpText: "",
                type: "RANKED_CHOICE",
                scope: "ATTENDEE",
                required: true,
                options: ["Prayer", "Service"],
                minSelections: 1,
                maxSelections: 2,
                availabilityMode: "RANKED_INTEREST",
                choiceLimits: {},
              }, {
                id: "medical_note",
                key: "medical_note",
                label: "Medical note",
                helpText: "",
                type: "TEXT",
                scope: "ATTENDEE",
                required: false,
                options: [],
              }],
            }],
          },
          form: {
            name: "Attendee registration",
            slug: "attendee",
          },
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.enqueueRegistrationContactUpdatedMessage.mockResolvedValue({
    messageIds: ["contact-message"],
    pendingMessageIds: ["contact-message"],
    deliveryMode: "LOCAL_CAPTURE",
    skippedReason: null,
  });
  dependencies.enqueueRegistrationAccessRecoveryMessage.mockResolvedValue({
    messageIds: ["recovery-message"],
    pendingMessageIds: ["recovery-message"],
    deliveryMode: "EXTERNAL_EMAIL",
    skippedReason: null,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("private registration access repository", () => {
  it("persists only the token hash and returns the raw token once", async () => {
    const registrationAccessToken = {
      create: vi.fn().mockResolvedValue({ id: "access-new" }),
    };
    const auditLog = {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    };
    const client = {
      registration: {
        findUnique: vi.fn().mockResolvedValue({
          eventId: "event-1",
          confirmationCode: "REG-PRIVATE",
          event: { endsAt: new Date("2026-10-11T17:00:00.000Z") },
        }),
      },
      registrationAccessToken,
      auditLog,
    };

    const issued = await issueRegistrationAccessToken(client as never, {
      registrationId: "registration-1",
      now: new Date("2026-07-23T12:00:00.000Z"),
    });

    expect(issued.token).toHaveLength(43);
    expect(issued.managePath).toBe(`/manage/${issued.token}`);
    expect(issued.expiresAt.toISOString()).toBe("2026-11-10T17:00:00.000Z");
    expect(registrationAccessToken.create).toHaveBeenCalledWith({
      data: {
        registrationId: "registration-1",
        tokenHash: hashOpaqueToken(issued.token),
        purpose: "MANAGE_REGISTRATION",
        expiresAt: issued.expiresAt,
      },
      select: { id: true },
    });

    const persistedCalls = JSON.stringify({
      token: registrationAccessToken.create.mock.calls,
      audit: auditLog.create.mock.calls,
    });
    expect(persistedCalls).not.toContain(issued.token);
    expect(auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "REGISTRATION_ACCESS_ISSUED",
        metadata: {
          accessTokenId: "access-new",
          purpose: "MANAGE_REGISTRATION",
          expiresAt: issued.expiresAt.toISOString(),
        },
      }),
    });
  });

  it("reuses one hash-only token for retries of the same immutable email", async () => {
    vi.stubEnv(
      "MANAGE_LINK_DERIVATION_SECRET",
      "test-only-manage-link-secret-with-more-than-32-characters",
    );
    const rows = new Map<string, {
      id: string;
      registrationId: string;
      purpose: "MANAGE_REGISTRATION";
      expiresAt: Date;
      revokedAt: null;
    }>();
    const registrationAccessToken = {
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => (
        rows.get(where.tokenHash) ?? null
      )),
      create: vi.fn(async ({ data }: {
        data: {
          registrationId: string;
          tokenHash: string;
          purpose: "MANAGE_REGISTRATION";
          expiresAt: Date;
        };
      }) => {
        const row = {
          id: "access-stable",
          registrationId: data.registrationId,
          purpose: data.purpose,
          expiresAt: data.expiresAt,
          revokedAt: null,
        };
        rows.set(data.tokenHash, row);
        return { id: row.id };
      }),
    };
    const client = {
      registration: {
        findUnique: vi.fn().mockResolvedValue({
          eventId: "event-1",
          confirmationCode: "REG-PRIVATE",
          event: { endsAt: new Date("2026-10-11T17:00:00.000Z") },
        }),
      },
      registrationAccessToken,
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
    };
    const input = {
      registrationId: "registration-1",
      deliveryKey: "message:outbox-1",
      now: new Date("2026-07-23T12:00:00.000Z"),
    };

    const first = await issueStableRegistrationAccessToken(
      client as never,
      input,
    );
    const retry = await issueStableRegistrationAccessToken(
      client as never,
      input,
    );
    const anotherMessage = await issueStableRegistrationAccessToken(
      client as never,
      { ...input, deliveryKey: "message:outbox-2" },
    );

    expect(retry).toEqual(first);
    expect(anotherMessage.token).not.toBe(first.token);
    expect(registrationAccessToken.create).toHaveBeenCalledTimes(2);
    expect(client.auditLog.create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(registrationAccessToken.create.mock.calls))
      .not.toContain(first.token);
  });

  it("resolves an active link with only policy-approved answers and no protected details", async () => {
    const token = createOpaqueToken();
    const findUnique = vi.fn().mockResolvedValue(accessRecord());
    const client = {
      registrationAccessToken: { findUnique },
    };

    const view = await resolveRegistrationAccessToken(token, {
      client: client as never,
      now: new Date("2026-08-01T12:00:00.000Z"),
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashOpaqueToken(token) },
      include: expect.any(Object),
    });
    expect(view).toMatchObject({
      event: {
        name: "Women’s Retreat",
        shirtSizesAvailable: true,
      },
      registration: {
        confirmationCode: "REG-PRIVATE",
        statusLabel: "Submitted",
      },
      contact: {
        firstName: "Caleb",
        email: "caleb@example.test",
      },
      attendees: [{
        id: "attendee-1",
        name: "Retreat Guest",
        shirtSize: "Adult L",
        shirtSizeConfirmedAt: null,
      }],
      payment: {
        totalCents: 25_000,
        paidCents: 7_500,
        refundedCents: 2_500,
        amountDueCents: 17_500,
      },
      form: {
        name: "Attendee registration",
        versionNumber: 2,
      },
      answerEditing: {
        enabled: true,
        expectedUpdatedAt: "2026-07-25T12:00:00.000Z",
        fields: [{ key: "session_preferences" }],
        attendees: [{
          attendeeId: "attendee-1",
          responses: {
            session_preferences: ["Prayer", "Service"],
          },
        }],
      },
    });
    expect(JSON.stringify(view)).not.toContain("private@example.test");
    expect(JSON.stringify(view)).not.toContain("externalReference");
    expect(JSON.stringify(view)).not.toContain("PRIVATE-MEDICAL");

    await expect(authorizeRegistrationAccessToken(token, {
      client: client as never,
      now: new Date("2026-08-01T12:00:00.000Z"),
    })).resolves.toEqual({
      accessTokenId: "access-1",
      registrationId: "registration-1",
      eventId: "event-1",
      registrationStatus: "SUBMITTED",
    });
  });

  it("rejects malformed, expired, and revoked links with the same null result", async () => {
    const token = createOpaqueToken();
    const findUnique = vi.fn();
    const client = {
      registrationAccessToken: { findUnique },
    };

    expect(await resolveRegistrationAccessToken("not-a-token", {
      client: client as never,
    })).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();

    findUnique.mockResolvedValueOnce(accessRecord({
      expiresAt: new Date("2026-07-24T12:00:00.000Z"),
    }));
    expect(await resolveRegistrationAccessToken(token, {
      client: client as never,
      now: new Date("2026-07-24T12:00:00.000Z"),
    })).toBeNull();

    findUnique.mockResolvedValueOnce(accessRecord({
      revokedAt: new Date("2026-07-23T14:00:00.000Z"),
    }));
    expect(await resolveRegistrationAccessToken(token, {
      client: client as never,
      now: new Date("2026-07-23T13:00:00.000Z"),
    })).toBeNull();
  });

  it("queues recovery only for an active registration with the matching contact email", async () => {
    const auditLog = { create: vi.fn().mockResolvedValue({ id: "audit-recovery" }) };
    const tx = {
      registration: {
        findMany: vi.fn().mockResolvedValue([
          accessRecord().registration,
          {
            ...accessRecord().registration,
            id: "cancelled",
            contactSnapshot: { email: "someone-else@example.test" },
          },
        ]),
      },
      auditLog,
    };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (
        operation: (client: typeof tx) => unknown,
      ) => operation(tx)),
    });

    const result = await requestRegistrationAccessRecovery({
      confirmationCode: " reg-private ",
      email: " Caleb@Example.Test ",
    });

    expect(result.pendingMessageIds).toEqual(["recovery-message"]);
    expect(dependencies.enqueueRegistrationAccessRecoveryMessage)
      .toHaveBeenCalledWith(tx, expect.objectContaining({
        eventId: "event-1",
        registrationId: "registration-1",
        recipientEmail: "caleb@example.test",
      }));
    const persistedAudit = JSON.stringify(auditLog.create.mock.calls);
    expect(persistedAudit).not.toContain("REG-PRIVATE");
    expect(persistedAudit).not.toContain("caleb@example.test");
    expect(auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "REGISTRATION_ACCESS_RECOVERY_REQUESTED",
        entityId: "registration-1",
        metadata: expect.objectContaining({
          matched: true,
          rawIdentifiersStored: false,
        }),
      }),
    });
  });

  it("audits a recovery mismatch without queuing mail or storing submitted identifiers", async () => {
    const auditLog = { create: vi.fn().mockResolvedValue({ id: "audit-miss" }) };
    const tx = {
      registration: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog,
    };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (
        operation: (client: typeof tx) => unknown,
      ) => operation(tx)),
    });

    await expect(requestRegistrationAccessRecovery({
      confirmationCode: "REG-SECRET",
      email: "private@example.test",
    })).resolves.toEqual({ pendingMessageIds: [] });

    expect(dependencies.enqueueRegistrationAccessRecoveryMessage).not.toHaveBeenCalled();
    const persistedAudit = JSON.stringify(auditLog.create.mock.calls);
    expect(persistedAudit).not.toContain("REG-SECRET");
    expect(persistedAudit).not.toContain("private@example.test");
  });

  it("updates only the registration-scoped contact snapshot and writes a non-secret audit record", async () => {
    const token = createOpaqueToken();
    const record = accessRecord();
    const tx = {
      registrationAccessToken: {
        findUnique: vi.fn().mockResolvedValue(record),
      },
      registration: {
        update: vi.fn().mockResolvedValue({ id: "registration-1" }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
    };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (
        operation: (client: typeof tx) => unknown,
      ) => operation(tx)),
    });

    const updated = await updatePublicRegistrationContact(token, {
      firstName: "Updated",
      lastName: "Contact",
      email: "updated@example.test",
      phone: "",
    }, new Date("2026-08-01T12:00:00.000Z"));

    expect(tx.registration.update).toHaveBeenCalledWith({
      where: { id: "registration-1" },
      data: {
        contactSnapshot: {
          firstName: "Updated",
          lastName: "Contact",
          email: "updated@example.test",
          phone: "",
        },
      },
    });
    expect(updated?.contact).toEqual({
      firstName: "Updated",
      lastName: "Contact",
      email: "updated@example.test",
      phone: "",
    });
    expect(dependencies.enqueueRegistrationContactUpdatedMessage)
      .toHaveBeenCalledWith(tx, expect.objectContaining({
        eventId: "event-1",
        registrationId: "registration-1",
        recipientEmail: "updated@example.test",
        recipientName: "Updated Contact",
      }));
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(token);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PUBLIC_REGISTRATION_CONTACT_UPDATED",
        metadata: {
          source: "PRIVATE_MANAGE_LINK",
          changedFields: ["firstName", "lastName", "email", "phone"],
        },
      }),
    });
  });

  it("reconfirms every attendee shirt size without changing the immutable submission", async () => {
    const token = createOpaqueToken();
    const record = accessRecord();
    const originalAttendeeResponses = structuredClone(
      record.registration.publicFormSubmission.attendeeResponses,
    );
    const registrationAttendee = {
      update: vi.fn(async ({ where, data }: {
        where: { id: string };
        data: { formResponses: Record<string, unknown> };
      }) => {
        const attendee = record.registration.attendees.find(
          (candidate) => candidate.id === where.id,
        )!;
        attendee.formResponses = data.formResponses;
        return { id: where.id };
      }),
    };
    const tx = {
      registrationAccessToken: {
        findUnique: vi.fn().mockResolvedValue(record),
      },
      registrationAttendee,
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: "audit-shirt" }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (
        operation: (client: typeof tx) => unknown,
      ) => operation(tx)),
    };
    dependencies.getPrisma.mockReturnValue(prisma);

    const updated = await confirmPublicRegistrationShirtSizes(
      token,
      {
        attendees: [{
          attendeeId: "attendee-1",
          shirtSize: "Adult XL",
        }],
      },
      new Date("2026-08-02T15:30:00.000Z"),
    );

    expect(registrationAttendee.update).toHaveBeenCalledWith({
      where: { id: "attendee-1" },
      data: {
        formResponses: expect.objectContaining({
          shirt_size: "Adult XL",
          shirt_size_confirmed_at: "2026-08-02T15:30:00.000Z",
        }),
      },
    });
    expect(updated?.attendees).toEqual([expect.objectContaining({
      id: "attendee-1",
      shirtSize: "Adult XL",
      shirtSizeConfirmedAt: "2026-08-02T15:30:00.000Z",
    })]);
    expect(record.registration.publicFormSubmission.attendeeResponses)
      .toEqual(originalAttendeeResponses);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PUBLIC_ATTENDEE_SHIRT_SIZES_CONFIRMED",
        metadata: expect.objectContaining({
          originalSubmissionPreserved: true,
        }),
      }),
    });
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(token);
  });

  it("revokes a link by hash and never stores the raw token", async () => {
    const token = createOpaqueToken();
    const tx = {
      registrationAccessToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: "access-1",
          revokedAt: null,
          registration: {
            id: "registration-1",
            eventId: "event-1",
            confirmationCode: "REG-PRIVATE",
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
    };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (
        operation: (client: typeof tx) => unknown,
      ) => operation(tx)),
    });

    await expect(revokeRegistrationAccessToken(
      token,
      new Date("2026-08-01T12:00:00.000Z"),
    )).resolves.toBe(true);
    expect(tx.registrationAccessToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashOpaqueToken(token) },
      select: expect.any(Object),
    });
    expect(JSON.stringify(tx.registrationAccessToken.updateMany.mock.calls))
      .not.toContain(token);
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(token);
  });
});
