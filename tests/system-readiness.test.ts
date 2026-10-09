import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  logError: vi.fn(),
  getServerEnv: vi.fn(),
  getSweepHeartbeat: vi.fn(),
  getPlatformSettings: vi.fn(),
  readdir: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { mocks.redirect(to); throw new Error(`REDIRECT:${to}`); },
}));
vi.mock("@/modules/access/login-redirect", () => ({ staffLoginRedirectPath: async () => "/login" }));
vi.mock("@/components/system-readiness-workspace", () => ({ SystemReadinessWorkspace: () => null }));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/lib/logger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/logger")>()), logError: mocks.logError }));
vi.mock("@/lib/env", () => ({ getServerEnv: mocks.getServerEnv }));
vi.mock("@/integrations/email/provider", () => ({ getEmailAvailability: () => ({ deliveryConfigured: true }) }));
vi.mock("@/modules/operations/sweep-heartbeat-repository", () => ({ getSweepHeartbeat: mocks.getSweepHeartbeat }));
vi.mock("@/modules/system-admin/platform-settings", () => ({ getPlatformSettings: mocks.getPlatformSettings }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs/promises")>()), readdir: mocks.readdir }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import SystemReadinessPage from "@/app/(workspace)/admin/readiness/page";
import { POST, GET } from "@/app/api/admin/system-readiness/route";
import {
  automaticBackupKeys,
  evaluateAutomaticChecks,
  evaluateBackupItems,
  pendingMigrationNames,
  type ReadinessFacts,
} from "@/modules/system-admin/readiness-checks";
import { manualReadinessItems } from "@/modules/system-admin/readiness-items";
import {
  getSystemReadiness,
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
    email: { deliveryConfigured: true, senderConfigured: true, senderReadable: true, senderDeliverable: true },
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
        email: { deliveryConfigured: false, senderConfigured: true, senderReadable: true, senderDeliverable: false },
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
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    expect(tx.systemReadinessTick.deleteMany).not.toHaveBeenCalled();
    await untickReadinessItem("wr26-signed-off", actor, "Ticked in error");
    expect(tx.systemReadinessTick.deleteMany).toHaveBeenCalledWith({ where: { itemKey: "wr26-signed-off" } });
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

describe("tick races", () => {
  const actor = { id: "user-1", displayName: "Synthetic Admin One" };
  beforeEach(() => vi.clearAllMocks());

  function knownError(code: string) {
    return new Prisma.PrismaClientKnownRequestError("synthetic", { code, clientVersion: "test" });
  }

  it("maps a concurrent tick (P2002) to ALREADY_TICKED", async () => {
    const tx = fakeDatabase(null);
    tx.systemReadinessTick.create.mockRejectedValue(knownError("P2002"));
    await expect(tickReadinessItem("wr26-signed-off", actor)).rejects.toMatchObject({ code: "ALREADY_TICKED" });
  });

  it("maps a concurrent untick (P2025 or nothing deleted) to NOT_TICKED", async () => {
    const existing = { itemKey: "wr26-signed-off", tickedByName: "X", tickedAt: new Date() };
    const tx = fakeDatabase(existing);
    tx.systemReadinessTick.deleteMany.mockRejectedValue(knownError("P2025"));
    await expect(untickReadinessItem("wr26-signed-off", actor, "why")).rejects.toMatchObject({ code: "NOT_TICKED" });
    tx.systemReadinessTick.deleteMany.mockResolvedValue({ count: 0 });
    await expect(untickReadinessItem("wr26-signed-off", actor, "why")).rejects.toMatchObject({ code: "NOT_TICKED" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("returns 409 through the route for a tick race", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(null);
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "u", displayName: "A", globalRole: "SYSTEM_ADMIN" } });
    const tx = fakeDatabase(null);
    tx.systemReadinessTick.create.mockRejectedValue(knownError("P2002"));
    const response = await POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "tick", key: "wr26-signed-off" }) }));
    expect(response.status).toBe(409);
  });
});

describe("pending migrations", () => {
  const at = new Date("2026-10-01T00:00:00.000Z");
  it("treats failed and rolled-back rows as pending and a re-applied one as applied", () => {
    const rows = [
      { migration_name: "a_done", finished_at: at, rolled_back_at: null },
      { migration_name: "b_failed", finished_at: null, rolled_back_at: null },
      { migration_name: "c_rolled_back", finished_at: at, rolled_back_at: at },
      { migration_name: "d_reapplied", finished_at: at, rolled_back_at: at },
      { migration_name: "d_reapplied", finished_at: at, rolled_back_at: null },
    ];
    expect(pendingMigrationNames(["a_done", "b_failed", "c_rolled_back", "d_reapplied", "e_missing"], rows))
      .toEqual(["b_failed", "c_rolled_back", "e_missing"]);
  });
});

describe("getSystemReadiness", () => {
  const SECRET_KEY = "synthetic-encryption-key-value-0123456789";
  const SENDER = "synthetic.sender@events.synthetic-domain.test";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerEnv.mockReturnValue({
      SECRET_ENCRYPTION_KEY: SECRET_KEY,
      ACCOUNT_EMAIL_SENDER_ADDRESS: SENDER,
      SQUARE_ENABLE_PRODUCTION: false,
    });
    mocks.getSweepHeartbeat.mockResolvedValue({ status: "ok", lastSucceededAt: null, lastFailedAt: null, ageMs: 0 });
    mocks.getPlatformSettings.mockResolvedValue({ defaultSenderEmail: SENDER });
    mocks.readdir.mockResolvedValue([{ name: "m1", isDirectory: () => true }]);
  });

  function database(ticksError?: Error) {
    mocks.getPrisma.mockReturnValue({
      user: { findMany: vi.fn().mockResolvedValue([{ displayName: "Synthetic Admin", mfaEnrollment: { status: "ACTIVE" }, passkeys: [] }]) },
      $queryRaw: vi.fn().mockResolvedValue([{ migration_name: "m1", finished_at: new Date(), rolled_back_at: null }]),
      systemReadinessTick: {
        findMany: ticksError ? vi.fn().mockRejectedValue(ticksError) : vi.fn().mockResolvedValue([]),
      },
    });
  }

  it("never serialises the key or a sender address", async () => {
    database();
    const text = JSON.stringify(await getSystemReadiness(now));
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(SENDER);
    expect(text).not.toContain("synthetic.sender");
  });

  it("keeps automatic checks when the tick table is missing", async () => {
    database(new Error("relation does not exist"));
    const readiness = await getSystemReadiness(now);
    expect(readiness.ticksAvailable).toBe(false);
    expect(readiness.summary.manualDone).toBe(0);
    expect(readiness.groups.flatMap((group) => group.items).every((item) => item.tick === null)).toBe(true);
    expect(readiness.automatic.find((candidate) => candidate.key === "migrations")?.status).toBe("ok");
    expect(mocks.logError).toHaveBeenCalled();
  });

  it("shows the sender as unknown when settings cannot be read and no account sender is set", async () => {
    mocks.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: SECRET_KEY, SQUARE_ENABLE_PRODUCTION: false });
    mocks.getPlatformSettings.mockRejectedValue(new Error("down"));
    database();
    const readiness = await getSystemReadiness(now);
    expect(readiness.automatic.find((candidate) => candidate.key === "email-sender")?.status).toBe("unknown");
    expect(mocks.logError).toHaveBeenCalled();
  });
});

describe("Square unlock display", () => {
  it("shows the unlock state on sandbox too", () => {
    const rows = evaluateAutomaticChecks(facts(), now);
    expect(row(rows, "square-environment").summary).toBe("Sandbox. Production unlock: off.");
  });
});

describe("route success and validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rejectCrossOriginRequest.mockReturnValue(null);
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "u", displayName: "Synthetic Admin", globalRole: "SYSTEM_ADMIN" } });
  });

  it("ticks for an administrator and returns the readiness", async () => {
    const tx = fakeDatabase(null);
    mocks.getServerEnv.mockReturnValue({ SQUARE_ENABLE_PRODUCTION: false });
    mocks.getSweepHeartbeat.mockResolvedValue(null);
    mocks.getPlatformSettings.mockResolvedValue({ defaultSenderEmail: null });
    mocks.readdir.mockResolvedValue([]);
    const client = mocks.getPrisma();
    client.user = { findMany: vi.fn().mockResolvedValue([]) };
    client.$queryRaw = vi.fn().mockResolvedValue([]);
    const response = await POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "tick", key: "wr26-signed-off" }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).readiness.groups).toBeDefined();
    expect(tx.systemReadinessTick.create).toHaveBeenCalled();
  });

  it("returns 400 for an untick without a reason", async () => {
    fakeDatabase({ itemKey: "wr26-signed-off", tickedByName: "X", tickedAt: new Date() });
    const response = await POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "untick", key: "wr26-signed-off" }) }));
    expect(response.status).toBe(400);
  });
});

describe("readiness page access", () => {
  beforeEach(() => vi.clearAllMocks());
  it("redirects a non-admin to no-access and a signed-out user to login", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "u", globalRole: null } });
    await expect(SystemReadinessPage()).rejects.toThrow("REDIRECT:/no-access");
    mocks.getCurrentSession.mockResolvedValue({ user: null });
    await expect(SystemReadinessPage()).rejects.toThrow("REDIRECT:/login");
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });
});
