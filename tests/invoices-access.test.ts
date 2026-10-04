import { beforeEach, describe, expect, it, vi } from "vitest";

/** #167: who the Finalize invoices permission can be granted to, and that grants lock the membership row. Synthetic data only. */
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  queryRaw: vi.fn(),
  writeAuditLog: vi.fn(),
}));
const client = {
  eventMembership: { findFirst: mocks.findFirst, update: mocks.update },
  $queryRaw: mocks.queryRaw,
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { InvoiceAccessGrantError, setInvoiceFinalizationAccess } from "@/modules/invoices/finalize-access";

/** The pre-lock read carries only who the person is; role, status and permissions come from the locked row. */
const found = () => ({ id: "m1", userId: "u1", user: { displayName: "Synthetic Staffer", globalRole: null } });
const locked = (role: string, permissions: string[] = [], status = "ACTIVE") => [{ role, status, permissions }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("granting Finalize invoices", () => {
  it("is refused for a role without finance access, with a clear message, and writes nothing", async () => {
    mocks.findFirst.mockResolvedValue(found());
    mocks.queryRaw.mockResolvedValue(locked("READ_ONLY_STAFF"));
    const error = await setInvoiceFinalizationAccess("e1", "m1", "admin", true).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvoiceAccessGrantError);
    expect((error as InvoiceAccessGrantError).code).toBe("ROLE_LACKS_FINANCE");
    expect((error as InvoiceAccessGrantError).message).toContain("finance access");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it.each(["FINANCE_MANAGER", "EVENT_ADMIN"])("is allowed for %s, from the permissions read under the row lock", async (role) => {
    mocks.findFirst.mockResolvedValue(found());
    // The locked read is the truth: another permission was added meanwhile.
    mocks.queryRaw.mockResolvedValue(locked(role, ["MANAGE_FORMS", "VIEW_HEALTH_INFORMATION"]));
    await expect(setInvoiceFinalizationAccess("e1", "m1", "admin", true)).resolves.toEqual({ granted: true, changed: true });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { permissions: ["MANAGE_FORMS", "VIEW_HEALTH_INFORMATION", "FINALIZE_INVOICES"] } });
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "INVOICE_FINALIZATION_ACCESS_GRANTED", eventId: "e1", actorUserId: "admin" });
  });

  it("a revoke keeps the other permissions held now, and is allowed whatever the role", async () => {
    mocks.findFirst.mockResolvedValue(found());
    mocks.queryRaw.mockResolvedValue(locked("READ_ONLY_STAFF", ["FINALIZE_INVOICES", "VIEW_HEALTH_INFORMATION"]));
    await setInvoiceFinalizationAccess("e1", "m1", "admin", false);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { permissions: ["VIEW_HEALTH_INFORMATION"] } });
  });

  it("decides from the locked role and status, not from anything read before the lock", async () => {
    // The role was changed to read-only between the first read and the lock.
    mocks.findFirst.mockResolvedValue({ ...found(), role: "FINANCE_MANAGER", status: "ACTIVE" });
    mocks.queryRaw.mockResolvedValue(locked("READ_ONLY_STAFF"));
    expect(((await setInvoiceFinalizationAccess("e1", "m1", "admin", true).catch((caught: unknown) => caught)) as InvoiceAccessGrantError).code).toBe("ROLE_LACKS_FINANCE");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("is refused for an inactive assignment", async () => {
    mocks.findFirst.mockResolvedValue(found());
    mocks.queryRaw.mockResolvedValue(locked("FINANCE_MANAGER", [], "INACTIVE"));
    const error = await setInvoiceFinalizationAccess("e1", "m1", "admin", true).catch((caught: unknown) => caught);
    expect((error as InvoiceAccessGrantError).code).toBe("MEMBERSHIP_INACTIVE");
  });
});
