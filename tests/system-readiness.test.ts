import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { POST, GET } from "@/app/api/admin/system-readiness/route";
import {
  automaticBackupKeys,
  evaluateAutomaticChecks,
  evaluateBackupItems,
  type ReadinessFacts,
} from "@/modules/system-admin/readiness-checks";
import { manualReadinessItems } from "@/modules/system-admin/readiness-items";
import {
  ReadinessError,
  tickReadinessItem,
  untickReadinessItem,
} from "@/modules/system-admin/readiness-repository";

const now = new Date("2026-10-16T12:00:00.000Z");

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    admins: [
      { displayName: "Synthetic Admin One", hasMfaOrPasskey: true },
      { displayName: "Synthetic Admin Two", hasMfaOrPasskey: false },
    ],
    pendingMigrations: [],
    sweep: { status: "ok", lastSucceededAt: now.toISOString(), lastFailedAt: null, ageMs: 1000 },
    encryptionKeyConfigured: true,
    email: { deliveryConfigured: true, senderConfigured: true, senderDeliverable: true },
    square: { environment: "sandbox", productionUnlocked: false },
    backup: null,
    ...overrides,
  };
}

function row(rows: ReturnType<typeof evaluateAutomaticChecks>, key: string) {
  const found = rows.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`missing row ${key}`);
  return found;
}

describe("manual readiness items", () => {
  it("have unique, stable-looking keys and never say background check", () => {
    const keys = manualReadinessItems.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const item of manualReadinessItems) {
      expect(item.key).toMatch(/^[a-z0-9-]+$/);
      expect(`${item.title} ${item.detail}`.toLowerCase()).not.toContain("background check");
    }
    expect(manualReadinessItems.some((item) => item.title.includes("Sterling Volunteers check"))).toBe(true);
  });
});

describe("automatic readiness checks", () => {
  it("names the administrators without MFA or a passkey", () => {
    const mfa = row(evaluateAutomaticChecks(facts(), now), "admins-mfa");
    expect(mfa.status).toBe("attention");
    expect(mfa.people).toEqual(["Synthetic Admin Two"]);
    expect(mfa.summary).toContain("1 of 2");
  });

  it("passes when every administrator is covered, and flags none at all", () => {
    expect(row(evaluateAutomaticChecks(facts({ admins: [{ displayName: "A", hasMfaOrPasskey: true }] }), now), "admins-mfa").status).toBe("ok");
    expect(row(evaluateAutomaticChecks(facts({ admins: [] }), now), "admins-mfa").status).toBe("attention");
    expect(row(evaluateAutomaticChecks(facts({ admins: null }), now), "admins-mfa").status).toBe("unknown");
  });

  it("reports pending migrations by count only", () => {
    const rows = evaluateAutomaticChecks(facts({ pendingMigrations: ["20261016100000_x", "20261016110000_y"] }), now);
    expect(row(rows, "migrations").status).toBe("attention");
    expect(row(rows, "migrations").summary).toBe("2 migrations are not applied yet.");
    expect(row(evaluateAutomaticChecks(facts({ pendingMigrations: null }), now), "migrations").status).toBe("unknown");
  });

  it("maps the sweeper heartbeat", () => {
    const base = { lastSucceededAt: null, lastFailedAt: null, ageMs: null };
    expect(row(evaluateAutomaticChecks(facts({ sweep: { ...base, status: "stale" } }), now), "outbox-sweeper").status).toBe("attention");
    expect(row(evaluateAutomaticChecks(facts({ sweep: { ...base, status: "never" } }), now), "outbox-sweeper").status).toBe("attention");
    expect(row(evaluateAutomaticChecks(facts({ sweep: null }), now), "outbox-sweeper").status).toBe("unknown");
    expect(row(evaluateAutomaticChecks(facts(), now), "outbox-sweeper").status).toBe("ok");
  });

  it("shows encryption key, email and Square as yes/no and state only", () => {
    const rows = evaluateAutomaticChecks(
      facts({
        encryptionKeyConfigured: false,
        email: { deliveryConfigured: false, senderConfigured: true, senderDeliverable: false },
        square: { environment: "production", productionUnlocked: false },
      }),
      now,
    );
    expect(row(rows, "encryption-key").status).toBe("attention");
    expect(row(rows, "email-provider").status).toBe("attention");
    expect(row(rows, "email-sender").status).toBe("attention");
    expect(row(rows, "square-environment").status).toBe("info");
    expect(row(rows, "square-environment").summary).toContain("not unlocked");
  });

  it("keeps backups manual until the seam returns evidence", () => {
    expect(evaluateBackupItems(null, now)).toEqual([]);
    expect(automaticBackupKeys(null).size).toBe(0);
    const evidence = { lastBackupAt: new Date("2026-10-16T02:00:00.000Z"), lastRestoreTestAt: null };
    const rows = evaluateBackupItems(evidence, now);
    expect(rows.map((candidate) => candidate.status)).toEqual(["ok", "attention"]);
    expect([...automaticBackupKeys(evidence)].sort()).toEqual(["backup-offsite", "restore-rehearsal"]);
  });
});

function fakeDatabase(existing: Record<string, unknown> | null) {
  const tx = {
    systemReadinessTick: {
      findUnique: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  mocks.getPrisma.mockReturnValue({ ...tx, $transaction: (callback: (client: typeof tx) => unknown) => callback(tx) });
  return tx;
}

describe("ticking and unticking", () => {
  const actor = { id: "user-1", displayName: "Synthetic Admin One" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records who ticked and audits it", async () => {
    const tx = fakeDatabase(null);
    await tickReadinessItem("director-invites-sent", actor, "  sent to all synthetic clubs ");
    expect(tx.systemReadinessTick.create).toHaveBeenCalledWith({
      data: { itemKey: "director-invites-sent", tickedByUserId: "user-1", tickedByName: "Synthetic Admin One", note: "sent to all synthetic clubs" },
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SYSTEM_READINESS_TICKED", entityId: "director-invites-sent", actorUserId: "user-1" }),
      tx,
    );
  });

  it("refuses an unknown item and a second tick", async () => {
    fakeDatabase(null);
    await expect(tickReadinessItem("nope", actor)).rejects.toMatchObject({ code: "UNKNOWN_ITEM" });
    fakeDatabase({ itemKey: "wr26-signed-off" });
    await expect(tickReadinessItem("wr26-signed-off", actor)).rejects.toMatchObject({ code: "ALREADY_TICKED" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("requires a reason to untick and keeps it in the audit entry", async () => {
    const tx = fakeDatabase({ itemKey: "wr26-signed-off", tickedByName: "Synthetic Admin Two", tickedAt: new Date("2026-10-10T00:00:00.000Z") });
    await expect(untickReadinessItem("wr26-signed-off", actor, "   ")).rejects.toBeInstanceOf(ReadinessError);
    expect(tx.systemReadinessTick.delete).not.toHaveBeenCalled();
    await untickReadinessItem("wr26-signed-off", actor, "Ticked in error");
    expect(tx.systemReadinessTick.delete).toHaveBeenCalledWith({ where: { itemKey: "wr26-signed-off" } });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SYSTEM_READINESS_UNTICKED",
        metadata: expect.objectContaining({ reason: "Ticked in error", previouslyTickedBy: "Synthetic Admin Two" }),
      }),
      tx,
    );
  });

  it("refuses to untick an item that is not ticked", async () => {
    fakeDatabase(null);
    await expect(untickReadinessItem("wr26-signed-off", actor, "why")).rejects.toMatchObject({ code: "NOT_TICKED" });
  });
});

describe("system readiness route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rejectCrossOriginRequest.mockReturnValue(null);
  });

  function post(body: unknown) {
    return POST(new Request("http://localhost/api/admin/system-readiness", { method: "POST", body: JSON.stringify(body) }));
  }

  it("refuses anyone who is not a signed-in system administrator, before touching the database", async () => {
    for (const session of [{ user: null }, { user: { id: "u", displayName: "Event Admin", globalRole: null } }]) {
      mocks.getCurrentSession.mockResolvedValue(session);
      expect((await post({ action: "tick", key: "wr26-signed-off" })).status).toBe(403);
      expect((await GET(new Request("http://localhost/api/admin/system-readiness"))).status).toBe(403);
    }
    expect(mocks.getPrisma).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-origin posts", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "u", displayName: "A", globalRole: "SYSTEM_ADMIN" } });
    expect((await post({ action: "tick", key: "wr26-signed-off" })).status).toBe(403);
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it("rejects a malformed body from an administrator", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "u", displayName: "A", globalRole: "SYSTEM_ADMIN" } });
    expect((await post({ action: "delete-everything", key: "x" })).status).toBe(400);
  });
});
