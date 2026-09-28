import { describe, expect, it } from "vitest";
import {
  otherWorkspaceContextsForAttendee,
  otherWorkspaceContextsForStaff,
} from "@/modules/access/workspace-contexts";

describe("otherWorkspaceContextsForStaff", () => {
  it("offers nothing for staff with neither an admin role nor a matching attendee account", () => {
    expect(otherWorkspaceContextsForStaff({
      isSystemAdmin: false,
      attendeeAccountAvailable: false,
    })).toEqual([]);
  });

  it("offers only system management for an admin with no matching attendee account", () => {
    const contexts = otherWorkspaceContextsForStaff({
      isSystemAdmin: true,
      attendeeAccountAvailable: false,
    });
    expect(contexts).toEqual([{ kind: "system_admin", href: "/admin", label: "System management" }]);
  });

  it("offers only the attendee account for ordinary staff who also hold one", () => {
    const contexts = otherWorkspaceContextsForStaff({
      isSystemAdmin: false,
      attendeeAccountAvailable: true,
    });
    expect(contexts).toEqual([{ kind: "attendee", href: "/account", label: "My registrations" }]);
  });

  it("offers both contexts, in a stable order, for a system administrator who also holds a matching attendee account (multi-context)", () => {
    const contexts = otherWorkspaceContextsForStaff({
      isSystemAdmin: true,
      attendeeAccountAvailable: true,
    });
    expect(contexts.map((context) => context.kind)).toEqual(["system_admin", "attendee"]);
    expect(contexts).toEqual([
      { kind: "system_admin", href: "/admin", label: "System management" },
      { kind: "attendee", href: "/account", label: "My registrations" },
    ]);
  });
});

describe("otherWorkspaceContextsForAttendee", () => {
  it("offers nothing for an attendee with no staff session on this browser", () => {
    expect(otherWorkspaceContextsForAttendee({ hasStaffSession: false })).toEqual([]);
  });

  it("offers the staff workspace only when this browser also carries a live staff session", () => {
    expect(otherWorkspaceContextsForAttendee({ hasStaffSession: true })).toEqual([
      { kind: "staff_workspace", href: "/overview", label: "Staff workspace" },
    ]);
  });
});
