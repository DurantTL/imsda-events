import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #131: a declared responsible adult gets no access to the minor's medical or other records, or to other
 * registrations' data, through this slice. Authority is a link that lodging and check-in read; no access
 * decision in the application reads it. Synthetic data only.
 */
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  eventMembershipFindMany: vi.fn(),
  guardianTouched: vi.fn(),
}));

vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => new Proxy({ eventMembership: { findMany: mocks.eventMembershipFindMany } }, {
    get(target, property: string) {
      if (property === "guardianAuthority" || property === "guardianAuthorityConflict") {
        mocks.guardianTouched(property);
        throw new Error(`An access decision must not read ${property}.`);
      }
      return (target as Record<string, unknown>)[property];
    },
  }),
}));
vi.mock("@/modules/health-records/flag", () => ({ requireHealthRecordsEnabled: () => undefined }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: vi.fn() }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ passkeysConfigured: () => false }));
vi.mock("@/modules/club-rosters/access", () => ({ ROSTER_UNLOCK_HOURS: 12, requireRosterAccess: vi.fn() }));
vi.mock("@/modules/organizations/area-coordinators", () => ({ currentAreaCoordinator: vi.fn() }));

import { AccessDeniedError, effectivePermissions, requirePermission } from "@/modules/access/authorization";
import { requireStaffHealthViewer } from "@/modules/health-records/access";
import { HealthRecordError } from "@/modules/health-records/errors";
import { eventPermissions, rolePermissions } from "@/modules/access/permissions";

/** An ordinary signed-in person who is the declared responsible adult for a minor: no staff role anywhere. */
const guardian = { id: "user-guardian", globalRole: null, email: "dad@example.test", displayName: "Dan Sample" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: guardian });
  mocks.eventMembershipFindMany.mockResolvedValue([]);
});

describe("a responsible adult gets no access from the declaration", () => {
  it("is not a health-record viewer, whatever is declared", async () => {
    await expect(requireStaffHealthViewer()).rejects.toBeInstanceOf(HealthRecordError);
    await expect(requireStaffHealthViewer()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.guardianTouched).not.toHaveBeenCalled();
  });

  it("holds no event permission: not the people list, reports, sensitive data, health information or registration management", async () => {
    for (const permission of ["VIEW_EVENT", "VIEW_SENSITIVE_DATA", "VIEW_REPORTS", "VIEW_HEALTH_INFORMATION", "MANAGE_REGISTRATION"] as const) {
      await expect(
        requirePermission({ user: guardian } as never, "event-1", permission, async () => null),
        permission,
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    expect(mocks.guardianTouched).not.toHaveBeenCalled();
  });

  it("no role or permission mentions guardian authority, so none can be granted by a declaration", () => {
    expect(eventPermissions.some((permission) => /guardian|responsible/i.test(permission))).toBe(false);
    expect(Object.keys(rolePermissions).some((role) => /guardian|responsible/i.test(role))).toBe(false);
    // The only way to a health permission is the explicit grant to a membership, which no role carries.
    for (const [role, permissions] of Object.entries(rolePermissions)) {
      expect(permissions, role).not.toContain("VIEW_HEALTH_INFORMATION");
    }
    expect(effectivePermissions(guardian as never, null)).toEqual([]);
  });

  it("no access decision, health, notes, check-in or other registration code reads the declaration", () => {
    const modulesThatDecideAccess = [
      "modules/access",
      "modules/health-records",
      "modules/notes",
      "modules/checkin",
      "modules/registrations",
      "modules/attendee-accounts",
      "modules/club-rosters",
      "modules/organizations",
      "modules/payments",
      "modules/reporting",
    ];
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && /guardian-authority|guardianAuthority/.test(readFileSync(path, "utf8"))) offenders.push(path.replaceAll("\\", "/"));
      }
    };
    modulesThatDecideAccess.forEach(walk);
    expect(offenders).toEqual([]);
  });

  it("the one place the declaration is read for another purpose lists names and codes only", async () => {
    const { RESPONSIBLE_ADULT_CSV_HEADERS } = await import("@/modules/guardian-authority/export");
    expect(RESPONSIBLE_ADULT_CSV_HEADERS.join(" ")).not.toMatch(/health|medical|allerg|insurance|dietary|incident|email|phone|address|birth|payment|balance/i);
  });
});
