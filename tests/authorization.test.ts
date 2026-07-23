import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  requireAuthenticatedUser,
  requireEventMembership,
  requirePermission,
  type MembershipLookup,
  type MembershipRecord,
  type Session,
} from "@/modules/access/authorization";
import { eventPermissions, eventRoles, rolePermissions } from "@/modules/access/permissions";

const user = {
  id: "usr_test",
  email: "staff@example.test",
  displayName: "Example Staff",
  globalRole: null,
};

const session: Session = { user };

function lookupFor(record: MembershipRecord | null): MembershipLookup {
  return async (userId, eventId) =>
    record && record.userId === userId && record.eventId === eventId ? record : null;
}

describe("event-scoped authorization", () => {
  it("requires an authenticated user", () => {
    expect(() => requireAuthenticatedUser({ user: null })).toThrowError(
      expect.objectContaining({ status: 401, code: "AUTHENTICATION_REQUIRED" }),
    );
  });

  it("denies a user who is not assigned to the event", async () => {
    await expect(
      requireEventMembership(session, "evt_unassigned", lookupFor(null)),
    ).rejects.toMatchObject({
      status: 403,
      code: "EVENT_ACCESS_DENIED",
    } satisfies Partial<AccessDeniedError>);
  });

  it("uses event roles to grant only the matching capabilities", async () => {
    const membership: MembershipRecord = {
      eventId: "evt_wr26",
      userId: user.id,
      role: "CHECK_IN_STAFF",
      status: "ACTIVE",
      permissions: [],
    };

    await expect(
      requirePermission(session, membership.eventId, "MANAGE_CHECK_IN", lookupFor(membership)),
    ).resolves.toMatchObject({ membership });

    await expect(
      requirePermission(session, membership.eventId, "MANAGE_FINANCE", lookupFor(membership)),
    ).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
  });

  it("supports explicit event-level permission grants", async () => {
    const membership: MembershipRecord = {
      eventId: "evt_wr26",
      userId: user.id,
      role: "READ_ONLY_STAFF",
      status: "ACTIVE",
      permissions: ["MANAGE_COMMUNICATIONS"],
    };

    await expect(
      requirePermission(
        session,
        membership.eventId,
        "MANAGE_COMMUNICATIONS",
        lookupFor(membership),
      ),
    ).resolves.toMatchObject({ membership });
  });

  it("allows a system administrator to cross event boundaries", async () => {
    const systemSession: Session = {
      user: { ...user, globalRole: "SYSTEM_ADMIN" },
    };

    await expect(
      requirePermission(systemSession, "evt_any", "MANAGE_STAFF", lookupFor(null)),
    ).resolves.toMatchObject({ membership: null });
  });

  it.each(eventRoles)("enforces the complete %s permission matrix", async (role) => {
    const membership: MembershipRecord = {
      eventId: "evt_wr26",
      userId: user.id,
      role,
      status: "ACTIVE",
      permissions: [],
    };

    for (const permission of eventPermissions) {
      const assertion = requirePermission(session, membership.eventId, permission, lookupFor(membership));
      if (rolePermissions[role].includes(permission)) {
        await expect(assertion).resolves.toMatchObject({ membership });
      } else {
        await expect(assertion).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
      }
    }
  });

  it("denies every permission when an event assignment is inactive", async () => {
    const membership: MembershipRecord = {
      eventId: "evt_wr26",
      userId: user.id,
      role: "EVENT_ADMIN",
      status: "INACTIVE",
      permissions: [],
    };
    await expect(requirePermission(session, membership.eventId, "VIEW_EVENT", lookupFor(membership))).rejects.toMatchObject({ status: 403, code: "EVENT_ACCESS_DENIED" });
  });
});
