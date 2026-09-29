import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  isAccountEmailConfigured: vi.fn(),
  getAccountEmailSender: vi.fn(),
  processAccountEmailQueue: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/logger", () => ({ logError: dependencies.logError, logInfo: dependencies.logInfo }));
vi.mock("@/modules/communications/account-email", () => ({
  isAccountEmailConfigured: dependencies.isAccountEmailConfigured,
  getAccountEmailSender: dependencies.getAccountEmailSender,
}));
vi.mock("@/modules/communications/email-delivery", () => ({ processAccountEmailQueue: dependencies.processAccountEmailQueue }));

import { sendDueLocationWaitlistDigests } from "@/modules/event-locations/waitlist-digest";

/**
 * The daily digest to Area Coordinators and event staff (#599): who gets it,
 * what it covers, that a day with no changes sends nothing, that it is
 * idempotent per recipient per day, that a revoked coordinator gets none, and
 * that a delivery failure never undoes the queued digest. Synthetic data only.
 */

const MORNING = new Date("2026-10-06T13:00:00Z"); // 8:00 AM Central
const EARLY = new Date("2026-10-06T11:00:00Z"); // 6:00 AM Central

type Change = {
  id: string; eventId: string; locationId: string; kind: "JOINED" | "PROMOTED" | "REMOVED"; clubName: string;
  locationName: string; attendeeCount: number; place: number | null; occurredAt: Date;
};
const change = (overrides: Partial<Change> = {}): Change => ({
  id: "change-1", eventId: "event-1", locationId: "loc-a", kind: "JOINED", clubName: "River City Pathfinders",
  locationName: "Camp Heritage 1", attendeeCount: 12, place: 1, occurredAt: new Date("2026-10-05T20:00:00Z"), ...overrides,
});

const activeGrant = { revokedAt: null, expiresAt: null };
const coordinator = (overrides: Record<string, unknown> = {}) => ({
  id: "account-1", email: "Pat.Coordinator@example.test", displayName: "Pat Coordinator", disabledAt: null, areaCoordinatorGrant: activeGrant, ...overrides,
});
const admin = (id: string, email: string, name: string) => ({ eventId: "event-1", user: { id, email, displayName: name } });

function fixture(options: {
  changes?: Change[];
  locations?: Array<{ id: string; coordinator: ReturnType<typeof coordinator> | null }>;
  memberships?: Array<ReturnType<typeof admin>>;
  existingKeys?: string[];
} = {}) {
  const changes = options.changes ?? [change()];
  const created: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    locationWaitlistChange: {
      findMany: vi.fn().mockResolvedValue(changes),
      updateMany: vi.fn().mockResolvedValue({ count: changes.length }),
    },
    eventLocation: { findMany: vi.fn().mockResolvedValue(options.locations ?? [{ id: "loc-a", coordinator: coordinator() }]) },
    eventMembership: { findMany: vi.fn().mockResolvedValue(options.memberships ?? [admin("user-1", "staff.admin@example.test", "Sam Admin")]) },
    event: { findMany: vi.fn().mockResolvedValue([{ id: "event-1", name: "Honors Weekend 2027" }]) },
    messageOutbox: {
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) => (options.existingKeys?.includes(where.idempotencyKey) ? { id: "existing" } : null)),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => { created.push(args); return { id: `message-${created.length}` }; }),
    },
  };
  const prisma = {
    locationWaitlistChange: { count: vi.fn().mockResolvedValue(changes.length) },
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return { tx, prisma, created };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.isAccountEmailConfigured.mockReturnValue(true);
  dependencies.getAccountEmailSender.mockReturnValue({ name: "IMSDA Events", address: "events@example.test", replyTo: null });
  dependencies.processAccountEmailQueue.mockResolvedValue({ recoveredIds: [], sentIds: ["message-1", "message-2"], failedIds: [], rescheduledIds: [] });
});

describe("the daily location waitlist digest", () => {
  it("does nothing before the morning send time, and looks at nothing", async () => {
    const { prisma } = fixture();
    const result = await sendDueLocationWaitlistDigests(EARLY);
    expect(result).toMatchObject({ status: "NOT_DUE", messageIds: [] });
    expect(prisma.locationWaitlistChange.count).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("sends no email on a day with no changes", async () => {
    const { prisma } = fixture({ changes: [] });
    const result = await sendDueLocationWaitlistDigests(MORNING);
    expect(result).toMatchObject({ status: "NO_CHANGES", messageIds: [], changesCovered: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(dependencies.processAccountEmailQueue).not.toHaveBeenCalled();
  });

  it("only counts changes from before the morning send time", async () => {
    const { prisma } = fixture();
    await sendDueLocationWaitlistDigests(MORNING);
    // 7:00 AM Central on the 6th is 12:00 UTC.
    expect(prisma.locationWaitlistChange.count).toHaveBeenCalledWith({ where: { digestedAt: null, occurredAt: { lt: new Date("2026-10-06T12:00:00.000Z") } } });
  });

  it("queues one digest for the active coordinator and one for the event administrator, and stamps the changes", async () => {
    const { tx, created } = fixture();
    const result = await sendDueLocationWaitlistDigests(MORNING);
    expect(result).toMatchObject({ status: "QUEUED", changesCovered: 1, recipients: 2 });
    expect(created).toHaveLength(2);
    const byEmail = new Map(created.map(({ data }) => [data.recipientEmail as string, data]));
    expect([...byEmail.keys()].sort()).toEqual(["pat.coordinator@example.test", "staff.admin@example.test"]);
    const coordinatorMail = byEmail.get("pat.coordinator@example.test")!;
    expect(coordinatorMail).toMatchObject({
      eventId: null, templateKey: "LOCATION_WAITLIST_DIGEST", recipientKind: "INTERNAL", status: "PENDING",
      accountAttendeeId: "account-1", accountUserId: null, idempotencyKey: "location-waitlist-digest:2026-10-06:pat.coordinator@example.test",
      senderEmailSnapshot: "events@example.test",
    });
    expect(String(coordinatorMail.bodyTextSnapshot)).toContain("Joined the waitlist: River City Pathfinders (12 people, place #1 in line)");
    expect(byEmail.get("staff.admin@example.test")).toMatchObject({ accountUserId: "user-1", accountAttendeeId: null });
    expect(tx.locationWaitlistChange.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["change-1"] }, digestedAt: null }, data: { digestedAt: MORNING } });
  });

  it("gives a revoked coordinator nothing, and an expired one nothing", async () => {
    for (const grant of [{ revokedAt: new Date("2026-10-01T00:00:00Z"), expiresAt: null }, { revokedAt: null, expiresAt: new Date("2026-10-05T00:00:00Z") }]) {
      const { created } = fixture({ locations: [{ id: "loc-a", coordinator: coordinator({ areaCoordinatorGrant: grant }) }] });
      await sendDueLocationWaitlistDigests(MORNING);
      expect(created.map(({ data }) => data.recipientEmail)).toEqual(["staff.admin@example.test"]);
    }
  });

  it("gives a disabled coordinator account, and a location with no coordinator, nothing", async () => {
    const disabled = fixture({ locations: [{ id: "loc-a", coordinator: coordinator({ disabledAt: new Date("2026-10-01T00:00:00Z") }) }] });
    await sendDueLocationWaitlistDigests(MORNING);
    expect(disabled.created.map(({ data }) => data.recipientEmail)).toEqual(["staff.admin@example.test"]);
    const none = fixture({ locations: [{ id: "loc-a", coordinator: null }] });
    await sendDueLocationWaitlistDigests(MORNING);
    expect(none.created.map(({ data }) => data.recipientEmail)).toEqual(["staff.admin@example.test"]);
  });

  it("asks only for active event administrators on activated, enabled staff accounts", async () => {
    const { tx } = fixture();
    await sendDueLocationWaitlistDigests(MORNING);
    expect(tx.eventMembership.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        eventId: { in: ["event-1"] }, role: "EVENT_ADMIN", status: "ACTIVE",
        user: { accountStatus: "ACTIVE", NOT: { credential: { is: { disabledAt: { not: null } } } } },
      }),
    }));
  });

  it("covers a coordinator's own locations only, and an administrator's whole event, one email each", async () => {
    const { created } = fixture({
      changes: [
        change({ id: "c1", locationId: "loc-a", locationName: "Camp Heritage 1", clubName: "River City Pathfinders" }),
        change({ id: "c2", locationId: "loc-b", locationName: "Des Moines", clubName: "Lakeside Guides", kind: "PROMOTED", place: 1 }),
        change({ id: "c3", locationId: "loc-a", locationName: "Camp Heritage 1", clubName: "Oak Hill Explorers", kind: "REMOVED", place: 2 }),
      ],
      locations: [{ id: "loc-a", coordinator: coordinator() }, { id: "loc-b", coordinator: null }],
    });
    await sendDueLocationWaitlistDigests(MORNING);
    expect(created).toHaveLength(2);
    const byEmail = new Map(created.map(({ data }) => [data.recipientEmail as string, String(data.bodyTextSnapshot)]));
    const coordinatorBody = byEmail.get("pat.coordinator@example.test")!;
    expect(coordinatorBody).toContain("River City Pathfinders");
    expect(coordinatorBody).toContain("Oak Hill Explorers");
    expect(coordinatorBody).not.toContain("Lakeside Guides");
    expect(coordinatorBody).not.toContain("Des Moines");
    const adminBody = byEmail.get("staff.admin@example.test")!;
    for (const club of ["River City Pathfinders", "Lakeside Guides", "Oak Hill Explorers"]) expect(adminBody).toContain(club);
  });

  it("sends a person who is both coordinator and administrator one email, naming each change once", async () => {
    const { created } = fixture({ memberships: [admin("user-9", "pat.coordinator@example.test", "Pat Coordinator")] });
    await sendDueLocationWaitlistDigests(MORNING);
    expect(created).toHaveLength(1);
    const body = String(created[0]!.data.bodyTextSnapshot);
    expect(body.match(/River City Pathfinders/g)).toHaveLength(1);
    expect(body).toContain("as an Area Coordinator and an event administrator");
    // Two roles, so no single account owns the message.
    expect(created[0]!.data).toMatchObject({ accountUserId: null, accountAttendeeId: null });
  });

  it("is idempotent per recipient per day: a recipient who already has today's digest gets no second one", async () => {
    const { created, tx } = fixture({ existingKeys: [
      "location-waitlist-digest:2026-10-06:pat.coordinator@example.test",
      "location-waitlist-digest:2026-10-06:staff.admin@example.test",
    ] });
    const result = await sendDueLocationWaitlistDigests(MORNING);
    expect(created).toHaveLength(0);
    expect(result).toMatchObject({ status: "NO_CHANGES", messageIds: [], changesCovered: 0 });
    // Nothing was covered, so the changes wait for tomorrow's digest rather than being lost.
    expect(tx.locationWaitlistChange.updateMany).not.toHaveBeenCalled();
    expect(dependencies.processAccountEmailQueue).not.toHaveBeenCalled();
  });

  it("stamps changes nobody is responsible for, so they do not pile up", async () => {
    const { created, tx } = fixture({ locations: [{ id: "loc-a", coordinator: null }], memberships: [] });
    const result = await sendDueLocationWaitlistDigests(MORNING);
    expect(created).toHaveLength(0);
    expect(tx.locationWaitlistChange.updateMany).toHaveBeenCalledOnce();
    expect(result.changesCovered).toBe(1);
  });

  it("queues nothing, and keeps the changes, while account email is not configured", async () => {
    dependencies.isAccountEmailConfigured.mockReturnValue(false);
    const { prisma, tx } = fixture();
    const result = await sendDueLocationWaitlistDigests(MORNING);
    expect(result.status).toBe("EMAIL_NOT_CONFIGURED");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.locationWaitlistChange.updateMany).not.toHaveBeenCalled();
  });

  it("delivers the queued digests after the transaction and reports how many were sent", async () => {
    fixture();
    const result = await sendDueLocationWaitlistDigests(MORNING);
    expect(dependencies.processAccountEmailQueue).toHaveBeenCalledWith({ messageIds: ["message-1", "message-2"] });
    expect(result).toMatchObject({ status: "QUEUED", delivered: 2, messageIds: ["message-1", "message-2"] });
  });

  it("keeps the digest queued when delivery fails: the failure is logged, never thrown, and the changes stay stamped", async () => {
    dependencies.processAccountEmailQueue.mockRejectedValue(new Error("synthetic provider outage"));
    const { tx } = fixture();
    const result = await sendDueLocationWaitlistDigests(MORNING);
    expect(result).toMatchObject({ status: "QUEUED", delivered: 0, messageIds: ["message-1", "message-2"] });
    expect(dependencies.logError).toHaveBeenCalledWith(expect.stringContaining("queued but not delivered"), expect.any(Error), expect.anything());
    expect(tx.locationWaitlistChange.updateMany).toHaveBeenCalledOnce();
  });

  it("delivers through an injected sender so a caller can control delivery", async () => {
    fixture();
    const deliver = vi.fn().mockResolvedValue({ sentIds: ["message-1"] });
    const result = await sendDueLocationWaitlistDigests(MORNING, { deliver });
    expect(deliver).toHaveBeenCalledWith(["message-1", "message-2"]);
    expect(dependencies.processAccountEmailQueue).not.toHaveBeenCalled();
    expect(result.delivered).toBe(1);
  });
});
