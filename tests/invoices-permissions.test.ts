import { describe, expect, it } from "vitest";
import { effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { eventPermissions, eventRoles, rolePermissions } from "@/modules/access/permissions";

/** #167 (Caleb, Oct 4, 2026): Finalize invoices is its own permission, held by no role. */
describe("the Finalize invoices permission", () => {
  it("exists and is carried by no role, Event Admin and Finance Manager included", () => {
    expect(eventPermissions).toContain("FINALIZE_INVOICES");
    for (const role of eventRoles) expect(rolePermissions[role], role).not.toContain("FINALIZE_INVOICES");
    expect(rolePermissions.FINANCE_MANAGER).toContain("MANAGE_FINANCE");
  });

  it("system administrators have it automatically; a named membership holds it only when granted", () => {
    const admin = { id: "u1", email: "a@example.test", displayName: "Admin", globalRole: "SYSTEM_ADMIN" as const };
    const staff = { id: "u2", email: "s@example.test", displayName: "Staff", globalRole: null };
    expect(effectivePermissions(admin, null)).toContain("FINALIZE_INVOICES");
    expect(effectivePermissions(staff, { eventId: "e", userId: "u2", role: "EVENT_ADMIN", status: "ACTIVE", permissions: [] })).not.toContain("FINALIZE_INVOICES");
    expect(effectivePermissions(staff, { eventId: "e", userId: "u2", role: "FINANCE_MANAGER", status: "ACTIVE", permissions: [] })).not.toContain("FINALIZE_INVOICES");
    expect(effectivePermissions(staff, { eventId: "e", userId: "u2", role: "FINANCE_MANAGER", status: "ACTIVE", permissions: ["FINALIZE_INVOICES"] })).toContain("FINALIZE_INVOICES");
  });

  it("requirePermission refuses MANAGE_FINANCE holders and accepts a granted membership", async () => {
    const staff = { id: "u2", email: "s@example.test", displayName: "Staff", globalRole: null };
    const lookup = (permissions: Array<"FINALIZE_INVOICES">) => async () => ({ eventId: "e", userId: "u2", role: "FINANCE_MANAGER" as const, status: "ACTIVE" as const, permissions });
    await expect(requirePermission({ user: staff }, "e", "FINALIZE_INVOICES", lookup([]))).rejects.toMatchObject({ status: 403 });
    await expect(requirePermission({ user: staff }, "e", "FINALIZE_INVOICES", lookup(["FINALIZE_INVOICES"]))).resolves.toBeTruthy();
  });
});
