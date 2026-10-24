import { beforeEach, describe, expect, it, vi } from "vitest";

/** #871: staff and signed-in attendee registration contact edits use the shared phone validator against the stored phone. Synthetic data only. */
const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  refresh: vi.fn(),
  consumeStepUp: vi.fn(),
  enqueue: vi.fn(),
  processQueued: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/background-checks/refresh-after-write", () => ({ refreshBackgroundCheckMatchesForRegistrations: mocks.refresh }));
vi.mock("@/modules/attendee-accounts/step-up-service", () => ({ consumeAttendeeEditStepUp: mocks.consumeStepUp }));
vi.mock("@/modules/communications/transactional-messages", () => ({ enqueueRegistrationContactUpdatedMessage: mocks.enqueue }));
vi.mock("@/modules/communications/messaging-repository", () => ({ processQueuedMessageIdsAfterCommit: mocks.processQueued }));
vi.mock("@/modules/notifications/settings", () => ({ isNotificationEnabled: vi.fn().mockResolvedValue(false) }));

import { updateAttendeeRegistrationContact } from "@/modules/attendee-accounts/registrations-repository";
import { updateRegistration } from "@/modules/registrations/repository";

const legacy = "555-0100";

describe("staff edit of a registration's contact phone (updateRegistration)", () => {
  const tx = {
    person: { update: vi.fn() },
    registration: { update: vi.fn() },
    registrationAttendee: { update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const findFirst = vi.fn();

  function existing(snapshot: Record<string, unknown>, personPhone: string | null = null) {
    findFirst.mockResolvedValue({
      id: "reg-1",
      confirmationCode: "REG-SYNTH",
      accountHolderPersonId: "person-1",
      accountHolderPerson: { firstName: "Alicia", lastName: "Smith", normalizedEmail: "alicia@example.test", phone: personPhone },
      contactSnapshot: snapshot,
      publicFormSubmission: null,
      attendees: [],
    });
  }

  /** The read-back after the write is not under test; only what was written is. */
  async function edit(phone: string | undefined) {
    return updateRegistration("event-1", "reg-1", phone === undefined ? { firstName: "Alicia" } : { phone }, "user-1").catch((error: unknown) => error);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPrisma.mockReturnValue({
      registration: { findFirst },
      $transaction: (work: (client: typeof tx) => unknown) => work(tx),
    });
  });

  it("stores a changed phone normalised", async () => {
    existing({ phone: legacy });
    await edit("515.555.0134");
    expect(tx.registration.update.mock.calls[0]![0].data.contactSnapshot.phone).toBe("(515) 555-0134");
    expect(tx.person.update.mock.calls[0]![0].data.phone).toBe("(515) 555-0134");
  });

  it("refuses a changed bad phone before writing, without echoing it", async () => {
    existing({ phone: "(515) 555-0134" });
    const error = await edit("idk 911") as { issues: Array<{ path: string[] }> };
    expect(error.issues[0]!.path).toEqual(["phone"]);
    expect(JSON.stringify(error.issues)).not.toContain("idk 911");
    expect(tx.person.update).not.toHaveBeenCalled();
    expect(tx.registration.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("lets an old unusable phone stay when the edit leaves it, or only re-formats it", async () => {
    existing({ phone: legacy });
    await edit(legacy);
    await edit("555 0100");
    expect(tx.registration.update.mock.calls.map((call) => call[0].data.contactSnapshot.phone)).toEqual([legacy, legacy]);
  });

  it("leaves the stored phone alone when the edit does not send one", async () => {
    existing({ phone: legacy });
    await edit(undefined);
    expect(tx.registration.update.mock.calls[0]![0].data.contactSnapshot.phone).toBe(legacy);
  });

  it("judges against the contact person's phone when the snapshot has none", async () => {
    existing({}, legacy);
    await edit(legacy);
    expect(tx.registration.update.mock.calls[0]![0].data.contactSnapshot.phone).toBe(legacy);
    tx.registration.update.mockClear();
    const error = await edit("555-0199") as { issues?: unknown };
    expect(error.issues).toBeDefined();
    expect(tx.registration.update).not.toHaveBeenCalled();
  });
});

describe("signed-in attendee edit of a registration's contact phone (updateAttendeeRegistrationContact)", () => {
  const tx = {
    $queryRaw: vi.fn(),
    registration: { update: vi.fn() },
    auditLog: { create: vi.fn() },
  };

  function owned(contactSnapshot: Record<string, unknown>, personPhone: string | null = null) {
    tx.$queryRaw.mockResolvedValue([{ id: "reg-1", eventId: "event-1", confirmationCode: "REG-SYNTH", contactSnapshot, personPhone }]);
  }
  const save = (phone: string) => updateAttendeeRegistrationContact({
    accountId: "acct-1",
    verifiedEmail: "alicia@example.test",
    sessionId: "session-1",
    registrationId: "reg-1",
    code: "123456",
    contact: { firstName: "Alicia", lastName: "Smith", email: "alicia@example.test", phone },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPrisma.mockReturnValue({ $transaction: (work: (client: typeof tx) => unknown) => work(tx) });
    mocks.consumeStepUp.mockResolvedValue(true);
    mocks.enqueue.mockResolvedValue({ pendingMessageIds: [] });
  });

  it("stores a changed phone normalised and returns it that way", async () => {
    owned({ phone: legacy });
    const result = await save("515-555-0134");
    expect(result).toMatchObject({ codeAccepted: true, contact: { phone: "(515) 555-0134" } });
    expect(tx.registration.update.mock.calls[0]![0].data.contactSnapshot.phone).toBe("(515) 555-0134");
  });

  it("refuses a changed bad phone before the edit code is spent, without echoing it", async () => {
    owned({ phone: "(515) 555-0134" });
    const error = await save("idk 911").catch((caught: unknown) => caught) as { issues: Array<{ path: string[] }> };
    expect(error.issues[0]!.path).toEqual(["contact", "phone"]);
    expect(JSON.stringify(error.issues)).not.toContain("idk 911");
    expect(mocks.consumeStepUp).not.toHaveBeenCalled();
    expect(tx.registration.update).not.toHaveBeenCalled();
  });

  it("lets an old unusable phone stay when untouched or only re-formatted", async () => {
    owned({ phone: legacy });
    await save(legacy);
    await save("555 0100");
    expect(tx.registration.update.mock.calls.map((call) => call[0].data.contactSnapshot.phone)).toEqual([legacy, legacy]);
  });

  it("falls back to the contact person's phone when the snapshot has none", async () => {
    owned({}, legacy);
    await expect(save(legacy)).resolves.toMatchObject({ codeAccepted: true });
    await expect(save("555-0199")).rejects.toThrow();
  });
});
