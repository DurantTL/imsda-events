import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GUARDIAN_SLOTS,
  guardianAuditActor,
  guardianEmailProblem,
  guardianInputSchema,
  guardianPhoneProblem,
  guardianSlotValues,
  guardianSlotsFrom,
  guardianViewerCanEdit,
  guardianViewerCanRead,
  guardiansInputSchema,
  staffHoldsSensitiveData,
  validateGuardianForm,
  type GuardianViewer,
} from "@/modules/club-rosters/guardians-domain";
import { rosterMemberInputSchema, rosterMemberUpdateSchema } from "@/modules/club-rosters/schemas";
import { clubCapabilities } from "@/modules/organizations/director-grants-domain";

describe("guardian contacts: schema and migration (#510)", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync("prisma/migrations/20261003120000_club_roster_guardians/migration.sql", "utf8");

  it("is a child table with one row per member and slot, deleted with the member", () => {
    const model = schema.slice(schema.indexOf("model ClubRosterGuardian {"));
    expect(model).toContain("rosterMemberId String");
    expect(model).toContain("position       Int");
    expect(model).toContain("onDelete: Cascade");
    expect(model).toContain("@@unique([rosterMemberId, position])");
    expect(schema).toContain("guardians           ClubRosterGuardian[]");
    expect(migration).toContain('CREATE UNIQUE INDEX "ClubRosterGuardian_rosterMemberId_position_key" ON "ClubRosterGuardian"("rosterMemberId", "position")');
    expect(migration).toContain('CHECK ("position" IN (1, 2))');
    expect(migration).toContain('REFERENCES "ClubRosterMember"("id") ON DELETE CASCADE');
  });

  it("holds plain text columns, every one optional, and nothing sealed", () => {
    for (const column of ["name", "relationship", "email", "phone"]) {
      expect(migration).toContain(`"${column}" TEXT NOT NULL DEFAULT ''`);
    }
    expect(migration).not.toMatch(/sealed|encrypted/i);
  });

  it("is additive: it touches no existing table and drops nothing", () => {
    expect(migration).not.toMatch(/DROP\s/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(migration).not.toMatch(/ALTER TABLE "(?!ClubRosterGuardian")/);
    expect(migration.match(/CREATE TABLE/g)).toHaveLength(1);
  });
});

describe("guardian validation (#510)", () => {
  it("accepts every field blank and trims what it keeps", () => {
    expect(guardianInputSchema.parse({})).toEqual({ name: "", relationship: "", email: "", phone: "" });
    expect(guardianInputSchema.parse({ name: "  Synthetic Guardian  ", relationship: " Aunt ", email: " g@example.test ", phone: " (515) 555-0101 " }))
      .toEqual({ name: "Synthetic Guardian", relationship: "Aunt", email: "g@example.test", phone: "(515) 555-0101" });
  });

  it("checks email and phone lightly, and only when something was typed", () => {
    expect(guardianEmailProblem("")).toBeNull();
    expect(guardianEmailProblem("name@example.test")).toBeNull();
    for (const bad of ["name", "name@", "@example.test", "a b@example.test", "name@example"]) expect(guardianEmailProblem(bad)).not.toBeNull();
    expect(guardianPhoneProblem("")).toBeNull();
    for (const good of ["515-555-0101", "(515) 555-0101", "+1 515 555 0101", "515.555.0101", "515 555 0101 x12", "515-555-0101 ext. 4"]) {
      expect(guardianPhoneProblem(good)).toBeNull();
    }
    for (const bad of ["12345", "call me", "515-555-0101 now", "1".repeat(20)]) expect(guardianPhoneProblem(bad)).not.toBeNull();
    expect(() => guardianInputSchema.parse({ email: "nope" })).toThrow();
    expect(() => guardianInputSchema.parse({ phone: "nope" })).toThrow();
  });

  it("rejects unknown keys and more than two guardians", () => {
    expect(() => guardianInputSchema.parse({ name: "A", ssn: "x" })).toThrow();
    expect(() => guardiansInputSchema.parse([{}, {}, {}])).toThrow();
    expect(guardiansInputSchema.parse([{}, {}])).toHaveLength(GUARDIAN_SLOTS);
  });

  it("turns a request into numbered slots and drops blank ones", () => {
    const blank = { name: "", relationship: "", email: "", phone: "" };
    const kept = { name: "A", relationship: "", email: "", phone: "" };
    expect(guardianSlotsFrom([blank, kept])).toEqual([{ position: 2, ...kept }]);
    expect(guardianSlotsFrom([kept, blank])).toEqual([{ position: 1, ...kept }]);
    expect(guardianSlotsFrom([])).toEqual([]);
  });

  it("fills the dialog's two slots from what is stored", () => {
    const values = guardianSlotValues([{ position: 2, name: "B", relationship: "Dad", email: "", phone: "" }]);
    expect(values).toHaveLength(2);
    expect(values[0]).toEqual({ name: "", relationship: "", email: "", phone: "" });
    expect(values[1]).toMatchObject({ name: "B", relationship: "Dad" });
  });

  it("reports dialog errors per slot and field", () => {
    expect(validateGuardianForm([{ email: "bad", phone: "" }, { email: "", phone: "bad" }])).toEqual({
      g1Email: "Enter an email like name@example.com.",
      g2Phone: "Enter a phone number like (515) 555-0134.",
    });
    expect(validateGuardianForm([{ email: "", phone: "" }, { email: "", phone: "" }])).toEqual({});
  });
});

describe("guardians in the roster add and edit requests (#510)", () => {
  const member = { firstName: "Test", lastName: "Youth", birthDate: "2014-12-06", attendeeType: "YOUTH", gender: "FEMALE" };

  it("is optional on both, so older clients keep working, and validated when sent", () => {
    expect(rosterMemberInputSchema.parse(member)).not.toHaveProperty("guardians");
    expect(rosterMemberUpdateSchema.parse({ role: "TLT" })).not.toHaveProperty("guardians");
    expect(rosterMemberInputSchema.parse({ ...member, guardians: [{ name: " G " }] }).guardians).toEqual([{ name: "G", relationship: "", email: "", phone: "" }]);
    expect(rosterMemberUpdateSchema.parse({ guardians: [] }).guardians).toEqual([]);
    expect(() => rosterMemberInputSchema.parse({ ...member, guardians: [{ email: "bad" }] })).toThrow();
    expect(() => rosterMemberUpdateSchema.parse({ guardians: [{}, {}, {}] })).toThrow();
  });
});

describe("who may see or edit guardian contacts (#510)", () => {
  const leaderOf = (organizationId: string): GuardianViewer => ({ kind: "CLUB_LEADER", organizationId, actor: { kind: "ATTENDEE", accountId: "director-1" } });
  const coordinator: GuardianViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "coordinator-1" } };
  const staff: GuardianViewer = { kind: "STAFF", userId: "staff-1" };

  it("lets a club's leader read and edit that club only", () => {
    expect(guardianViewerCanRead(leaderOf("club-1"), "club-1")).toBe(true);
    expect(guardianViewerCanEdit(leaderOf("club-1"), "club-1")).toBe(true);
    expect(guardianViewerCanRead(leaderOf("club-1"), "club-2")).toBe(false);
    expect(guardianViewerCanEdit(leaderOf("club-1"), "club-2")).toBe(false);
  });

  it("lets every Area Coordinator and sensitive-data staff read any club, and edit none", () => {
    for (const viewer of [coordinator, staff]) {
      expect(guardianViewerCanRead(viewer, "club-1")).toBe(true);
      expect(guardianViewerCanRead(viewer, "club-99")).toBe(true);
      expect(guardianViewerCanEdit(viewer, "club-1")).toBe(false);
    }
  });

  it("gives the guardians capability to a director and deputy, and to no other club role", () => {
    expect(clubCapabilities("DIRECTOR").guardians).toBe(true);
    expect(clubCapabilities("DEPUTY").guardians).toBe(true);
    expect(clubCapabilities("REGISTRAR").guardians).toBe(false);
    expect(clubCapabilities("REPORTER").guardians).toBe(false);
  });

  const membership = (overrides: Partial<{ eventId: string; status: string; permissions: string[]; roleHasSensitiveData: boolean }> = {}) => ({
    eventId: "event-1", status: "ACTIVE", permissions: [] as string[], roleHasSensitiveData: false, ...overrides,
  });

  it("allows a system administrator and staff whose role or grant carries the sensitive-data permission", () => {
    expect(staffHoldsSensitiveData({ globalRole: "SYSTEM_ADMIN" }, [])).toBe(true);
    expect(staffHoldsSensitiveData({ globalRole: "STAFF" }, [membership({ roleHasSensitiveData: true })])).toBe(true);
    expect(staffHoldsSensitiveData({ globalRole: "STAFF" }, [membership({ permissions: ["VIEW_SENSITIVE_DATA"] })])).toBe(true);
  });

  it("refuses staff without the permission, with an inactive membership, or on another event", () => {
    expect(staffHoldsSensitiveData({ globalRole: "STAFF" }, [])).toBe(false);
    expect(staffHoldsSensitiveData({ globalRole: null }, [membership()])).toBe(false);
    expect(staffHoldsSensitiveData({ globalRole: "STAFF" }, [membership({ permissions: ["VIEW_REPORTS"] })])).toBe(false);
    expect(staffHoldsSensitiveData({ globalRole: "STAFF" }, [membership({ roleHasSensitiveData: true, status: "SUSPENDED" })])).toBe(false);
    expect(staffHoldsSensitiveData({ globalRole: "STAFF" }, [membership({ roleHasSensitiveData: true })], "event-2")).toBe(false);
    expect(staffHoldsSensitiveData({ globalRole: "STAFF" }, [membership({ roleHasSensitiveData: true })], "event-1")).toBe(true);
  });

  it("names the actor in audit fields without any guardian value", () => {
    expect(guardianAuditActor(staff)).toEqual({ actorUserId: "staff-1", metadata: { viewerKind: "STAFF" } });
    expect(guardianAuditActor(coordinator)).toEqual({ metadata: { viewerKind: "AREA_COORDINATOR", actorAttendeeAccountId: "coordinator-1" } });
    expect(guardianAuditActor({ kind: "AREA_COORDINATOR", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1" } }))
      .toEqual({ actorUserId: "admin-1", metadata: { viewerKind: "AREA_COORDINATOR", actAsId: "act-1" } });
  });
});
