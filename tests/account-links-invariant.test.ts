import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  requireEventMembership,
  requirePermission,
  type MembershipLookup,
  type MembershipRecord,
  type Session,
} from "@/modules/access/authorization";

vi.mock("server-only", () => ({}));

import { getPersonForUser, getPersonForAttendeeAccount } from "@/modules/people/account-links-repository";

/**
 * Proves the central invariant of #125: an account-to-person link grants
 * nothing by itself. No staff permission, no event access, and no
 * cross-event visibility follows from `UserPersonLink` or
 * `AttendeeAccountPersonLink` existing.
 */
describe("account-to-person links grant no access", () => {
  it("keeps the authorization module free of any reference to the link tables or repository", () => {
    // A static guard, not just a behavioral one: if a future change wires
    // permission checks up to a person link, this fails immediately rather
    // than waiting on the specific access scenario below to catch it.
    const authorizationSource = readFileSync(
      join(process.cwd(), "modules/access/authorization.ts"),
      "utf8",
    );
    expect(authorizationSource).not.toMatch(/PersonLink/);
    expect(authorizationSource).not.toMatch(/account-links/);
  });

  it("denies event access to a staff user whose linked person has other-event footprint, absent an event membership", async () => {
    // Alicia (person) has attended Event B as an attendee, and staff user
    // Dana has explicitly linked her own staff account to Alicia's person
    // record (say, because Dana is also a WR26 alumna and self-verified the
    // match). Dana still has no EventMembership on Event A: the link must
    // not let her in.
    const dana: Session = {
      user: { id: "usr_dana", email: "dana@example.test", displayName: "Dana Staff", globalRole: null },
    };

    const lookup: MembershipLookup = async () => null; // no membership anywhere, on purpose

    await expect(requireEventMembership(dana, "evt_a", lookup)).rejects.toMatchObject({
      status: 403,
      code: "EVENT_ACCESS_DENIED",
    });
    await expect(requirePermission(dana, "evt_a", "VIEW_EVENT", lookup)).rejects.toMatchObject({
      status: 403,
      code: "EVENT_ACCESS_DENIED",
    });
  });

  it("does not upgrade permissions on an event the user does belong to, just because their linked person has broader footprint elsewhere", async () => {
    const dana: Session = {
      user: { id: "usr_dana", email: "dana@example.test", displayName: "Dana Staff", globalRole: null },
    };
    const readOnlyMembership: MembershipRecord = {
      eventId: "evt_a",
      userId: "usr_dana",
      role: "READ_ONLY_STAFF",
      status: "ACTIVE",
      permissions: [],
    };
    const lookup: MembershipLookup = async (userId, eventId) =>
      userId === "usr_dana" && eventId === "evt_a" ? readOnlyMembership : null;

    // She can view the event she's actually a member of...
    await expect(requirePermission(dana, "evt_a", "VIEW_EVENT", lookup)).resolves.toMatchObject({
      membership: readOnlyMembership,
    });
    // ...but the link does not grant her MANAGE_FINANCE, MANAGE_STAFF, or
    // any other permission beyond her role, no matter what her linked
    // person's history elsewhere looks like.
    await expect(requirePermission(dana, "evt_a", "MANAGE_FINANCE", lookup)).rejects.toMatchObject({
      status: 403,
      code: "PERMISSION_DENIED",
    });
    // And she still has no access to a second event at all.
    await expect(requirePermission(dana, "evt_b", "VIEW_EVENT", lookup)).rejects.toMatchObject({
      status: 403,
      code: "EVENT_ACCESS_DENIED",
    });
  });

  it("the account-links repository never imports the authorization module or touches EventMembership", async () => {
    // A structural check: if a future change wired this repository up to
    // permission checks or membership data, this fails immediately. Doc
    // comments on the repository already say this in words; this asserts
    // it in code — no import of `modules/access/*`, and no Prisma call
    // against `eventMembership`.
    const readFunctions = { getPersonForUser, getPersonForAttendeeAccount };
    for (const fn of Object.values(readFunctions)) {
      expect(typeof fn).toBe("function");
    }
    const repositorySource = readFileSync(
      join(process.cwd(), "modules/people/account-links-repository.ts"),
      "utf8",
    );
    expect(repositorySource).not.toMatch(/from ["']@\/modules\/access/);
    expect(repositorySource).not.toMatch(/\.eventMembership\./);
  });
});
