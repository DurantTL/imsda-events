import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { getHonorWatchPanel, replaceHonorWatches } from "@/modules/honors/watch-repository";

/** Saving honor watches (#1099) against a small in-memory stand-in for the Prisma calls it makes. Synthetic data only. */

type Watch = { id: string; eventId: string; position: number; name: string; recipients: string[]; honorIds: string[]; offeringIds: string[]; summaryAt: Date | null; createdAt: Date };

const lastSummary = new Date("2026-11-03T12:00:00Z");
const now = new Date("2026-11-04T15:00:00Z");

function world() {
  let counter = 0;
  const watches: Watch[] = [
    { id: "w-mine", eventId: "event-1", position: 0, name: "Mine", recipients: ["a@example.test"], honorIds: ["h1"], offeringIds: ["c1"], summaryAt: lastSummary, createdAt: new Date("2026-11-01T00:00:00Z") },
    { id: "w-theirs", eventId: "event-2", position: 0, name: "Theirs", recipients: ["z@example.test"], honorIds: ["h1"], offeringIds: [], summaryAt: lastSummary, createdAt: new Date("2026-11-01T00:00:00Z") },
  ];
  const offerings: Array<{ id: string; eventId: string; isActive: boolean; span: string; session: { name: string; sortOrder: number }; honors: Array<{ honor: { id: string; code: string; name: string; isActive: boolean } }> }> = [
    { id: "c1", eventId: "event-1", isActive: true, span: "SINGLE_SESSION", session: { name: "Sabbath", sortOrder: 0 }, honors: [{ honor: { id: "h1", code: "H1", name: "Birds", isActive: true } }] },
    { id: "c2", eventId: "event-1", isActive: true, span: "ALL_SESSIONS", session: { name: "x", sortOrder: 0 }, honors: [{ honor: { id: "h2", code: "H2", name: "Knots", isActive: true } }] },
    { id: "c-other", eventId: "event-2", isActive: true, span: "ALL_SESSIONS", session: { name: "x", sortOrder: 0 }, honors: [{ honor: { id: "h2", code: "H2", name: "Knots", isActive: true } }] },
  ];
  const honors = ["h1", "h2"];
  const inList = (list: string[] | undefined, id: string) => !list || list.includes(id);
  const db = {
    event: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (["event-1", "event-2"].includes(where.id) ? { id: where.id } : null)) },
    honor: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => honors.filter((id) => where.id.in.includes(id)).map((id) => ({ id }))) },
    honorOffering: {
      findMany: vi.fn(async ({ where }: { where: { eventId: string; id?: { in: string[] } } }) => offerings.filter((row) => row.eventId === where.eventId && inList(where.id?.in, row.id))),
    },
    honorWatch: {
      findMany: vi.fn(async ({ where }: { where: { eventId: string } }) => watches.filter((row) => row.eventId === where.eventId).sort((a, b) => a.position - b.position)),
      deleteMany: vi.fn(async ({ where }: { where: { eventId: string; id: { notIn: string[] } } }) => {
        const gone = watches.filter((row) => row.eventId === where.eventId && !where.id.notIn.includes(row.id));
        for (const row of gone) watches.splice(watches.indexOf(row), 1);
        return { count: gone.length };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; eventId: string }; data: Partial<Watch> }) => {
        const row = watches.find((candidate) => candidate.id === where.id && candidate.eventId === where.eventId);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      create: vi.fn(async ({ data }: { data: Omit<Watch, "id" | "summaryAt"> & { createdAt: Date } }) => {
        counter += 1;
        const row: Watch = { ...data, id: `w-new-${counter}`, summaryAt: null };
        watches.push(row);
        return { id: row.id };
      }),
    },
    $transaction: vi.fn(async (work: (client: typeof db) => Promise<unknown>) => work(db)),
  };
  mocks.getPrisma.mockReturnValue(db);
  return { watches, db };
}

const mine = { id: "w-mine", name: "Mine", recipients: ["a@example.test"], honorIds: ["h1"], offeringIds: ["c1"] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saving honor watches (#1099)", () => {
  it("refuses another event's class, and stores nothing", async () => {
    const w = world();
    await expect(replaceHonorWatches("event-1", "admin-1", { watches: [{ ...mine, offeringIds: ["c-other"] }] }, now)).rejects.toMatchObject({ code: "INVALID_WATCHES", message: expect.stringContaining("from this event") });
    expect(w.db.$transaction).not.toHaveBeenCalled();
    expect(w.watches.find((row) => row.id === "w-mine")!.offeringIds).toEqual(["c1"]);
  });

  it("refuses another event's watch id, leaves that watch alone, and writes no audit entry", async () => {
    const w = world();
    await expect(replaceHonorWatches("event-1", "admin-1", { watches: [{ ...mine, id: "w-theirs" }] }, now)).rejects.toMatchObject({ code: "INVALID_WATCHES" });
    const theirs = w.watches.find((row) => row.id === "w-theirs")!;
    expect(theirs).toMatchObject({ name: "Theirs", eventId: "event-2" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a watch id that no longer exists as a conflict", async () => {
    world();
    await expect(replaceHonorWatches("event-1", "admin-1", { watches: [{ ...mine, id: "w-gone" }] }, now)).rejects.toMatchObject({ code: "INVALID_WATCHES", message: expect.stringContaining("changed or removed") });
  });

  it("keeps the summary point when a save changes what a watch looks at, so changes still owed are not dropped", async () => {
    const w = world();
    await replaceHonorWatches("event-1", "admin-1", { watches: [{ ...mine, honorIds: ["h2"], offeringIds: ["c2"], name: "Renamed" }] }, now);
    const row = w.watches.find((candidate) => candidate.id === "w-mine")!;
    expect(row).toMatchObject({ name: "Renamed", honorIds: ["h2"], offeringIds: ["c2"] });
    expect(row.summaryAt).toEqual(lastSummary);
  });

  it("creates a new watch from the save time with no summary point, and removes ones left out of the list", async () => {
    const w = world();
    await replaceHonorWatches("event-1", "admin-1", { watches: [{ name: "Fresh", recipients: ["b@example.test"], honorIds: ["h2"], offeringIds: [] }] }, now);
    expect(w.watches.filter((row) => row.eventId === "event-1")).toHaveLength(1);
    expect(w.watches.find((row) => row.name === "Fresh")).toMatchObject({ summaryAt: null, createdAt: now });
    expect(w.watches.some((row) => row.id === "w-theirs")).toBe(true);
  });

  it("lets an old saved recipient through on a re-save, but not the same text on a new watch or a new bad one (#1193)", async () => {
    const w = world();
    w.watches.find((row) => row.id === "w-mine")!.recipients = ["old@odd-domain"];
    await replaceHonorWatches("event-1", "admin-1", { watches: [{ ...mine, recipients: ["old@odd-domain", "b@example.test"] }] }, now);
    for (const watch of [{ name: "Fresh", recipients: ["old@odd-domain"], honorIds: ["h2"], offeringIds: [] }, { ...mine, recipients: ["not an email"] }]) {
      const error = await replaceHonorWatches("event-1", "admin-1", { watches: [watch] }, now).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "INVALID_WATCHES", message: expect.stringContaining("Address 1: Enter a valid email address") });
      expect((error as Error).message).not.toMatch(/odd-domain|not an email/);
    }
  });

  it("audits ids and counts only: never an address or a name", async () => {
    world();
    await replaceHonorWatches("event-1", "admin-1", { watches: [mine] }, now);
    const entry = mocks.writeAuditLog.mock.calls[0]![0] as { action: string; metadata: Record<string, unknown> };
    expect(entry.action).toBe("HONOR_WATCHES_CHANGED");
    expect(entry.metadata).toMatchObject({ watchCount: 1, recipientCount: 1, honorCount: 1, classCount: 1 });
    expect(JSON.stringify(entry)).not.toMatch(/example\.test|Mine/);
  });

  it("does not let a deleted class block saving: the panel drops it, with a notice, and its own list saves", async () => {
    const w = world();
    const stale = w.watches.find((row) => row.id === "w-mine")!;
    stale.offeringIds = ["c1", "c-deleted"];
    const panel = await getHonorWatchPanel("event-1");
    expect(panel.watches[0]!.offeringIds).toEqual(["c1"]);
    expect(panel.watches[0]!.warnings.join(" ")).toContain("deleted");
    const saved = await replaceHonorWatches("event-1", "admin-1", { watches: panel.watches.map((entry) => ({ id: entry.id, name: entry.name, recipients: entry.recipients, honorIds: entry.honorIds, offeringIds: entry.offeringIds })) }, now);
    expect(w.watches.find((row) => row.id === "w-mine")!.offeringIds).toEqual(["c1"]);
    expect(saved.watches[0]!.warnings).toEqual([]);
  });

  it("still refuses a deleted class named in a request, since only the panel's own cleaned list is saved", async () => {
    world();
    await expect(replaceHonorWatches("event-1", "admin-1", { watches: [{ ...mine, offeringIds: ["c-deleted"] }] }, now)).rejects.toMatchObject({ code: "INVALID_WATCHES" });
  });
});
