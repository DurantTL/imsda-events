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

const membership = (role: string, permissions: string[] = [], status = "ACTIVE") => ({ id: "m1", userId: "u1", role, status, permissions, user: { displayName: "Synthetic Staffer", globalRole: null } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("granting Finalize invoices", () => {
  it("is refused for a role without finance access, with a clear message, and writes nothing", async () => {
    mocks.findFirst.mockResolvedValue(membership("READ_ONLY_STAFF"));
    mocks.queryRaw.mockResolvedValue([{ permissions: [] }]);
    const error = await setInvoiceFinalizationAccess("e1", "m1", "admin", true).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvoiceAccessGrantError);
    expect((error as InvoiceAccessGrantError).code).toBe("ROLE_LACKS_FINANCE");
    expect((error as InvoiceAccessGrantError).message).toContain("finance access");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it.each(["FINANCE_MANAGER", "EVENT_ADMIN"])("is allowed for %s, from the permissions read under the row lock", async (role) => {
    mocks.findFirst.mockResolvedValue(membership(role, ["MANAGE_FORMS"]));
    // The locked read is the truth: another permission was added meanwhile.
    mocks.queryRaw.mockResolvedValue([{ permissions: ["MANAGE_FORMS", "VIEW_HEALTH_INFORMATION"] }]);
    await expect(setInvoiceFinalizationAccess("e1", "m1", "admin", true)).resolves.toEqual({ granted: true, changed: true });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { permissions: ["MANAGE_FORMS", "VIEW_HEALTH_INFORMATION", "FINALIZE_INVOICES"] } });
    expect(mocks.writeAuditLog.mock.calls[0]![0]).toMatchObject({ action: "INVOICE_FINALIZATION_ACCESS_GRANTED", eventId: "e1", actorUserId: "admin" });
  });

  it("a revoke keeps the other permissions held now, and is allowed whatever the role", async () => {
    mocks.findFirst.mockResolvedValue(membership("READ_ONLY_STAFF", ["FINALIZE_INVOICES"]));
    mocks.queryRaw.mockResolvedValue([{ permissions: ["FINALIZE_INVOICES", "VIEW_HEALTH_INFORMATION"] }]);
    await setInvoiceFinalizationAccess("e1", "m1", "admin", false);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { permissions: ["VIEW_HEALTH_INFORMATION"] } });
  });

  it("is refused for an inactive assignment", async () => {
    mocks.findFirst.mockResolvedValue(membership("FINANCE_MANAGER", [], "INACTIVE"));
    mocks.queryRaw.mockResolvedValue([{ permissions: [] }]);
    const error = await setInvoiceFinalizationAccess("e1", "m1", "admin", true).catch((caught: unknown) => caught);
    expect((error as InvoiceAccessGrantError).code).toBe("MEMBERSHIP_INACTIVE");
  });
});
