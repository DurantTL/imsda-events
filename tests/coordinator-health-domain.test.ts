import { describe, expect, it } from "vitest";
import { effectivePermissions } from "@/modules/access/authorization";
import { eventPermissions, eventRoles, rolePermissions } from "@/modules/access/permissions";
import {
  dietaryFromResponses,
  healthAuditActor,
  healthWindowEndsOn,
  healthWindowOpen,
  medicalFlagFromResponses,
  passengerContacts,
  pickHealthAnswers,
  slipContact,
  viewerCanSeeClub,
  viewerCanSeeEvent,
  type HealthViewer,
} from "@/modules/coordinator-health/domain";

// Synthetic event: ends Sunday 2026-10-11 (Central time).
const event = { timezone: "America/Chicago", endsAt: new Date("2026-10-11T22:00:00Z") };

describe("the 30-day window (#658)", () => {
  it("is open before, during and up to 30 days after the event, then closed", () => {
    expect(healthWindowEndsOn(event)).toBe("2026-11-10");
    expect(healthWindowOpen(event, new Date("2026-09-01T12:00:00Z"))).toBe(true);
    expect(healthWindowOpen(event, new Date("2026-10-11T12:00:00Z"))).toBe(true);
    expect(healthWindowOpen(event, new Date("2026-11-10T20:00:00Z"))).toBe(true);
    expect(healthWindowOpen(event, new Date("2026-11-11T07:00:00Z"))).toBe(false);
    expect(healthWindowOpen(event, new Date("2027-03-01T12:00:00Z"))).toBe(false);
  });
});

describe("the health permission (#658)", () => {
  it("is carried by no role, Event Admin included", () => {
    for (const role of eventRoles) expect(rolePermissions[role]).not.toContain("VIEW_HEALTH_INFORMATION");
  });

  it("keeps every other permission on Event Admin (but not Finalize invoices, #167, which no role carries)", () => {
    expect(rolePermissions.EVENT_ADMIN).toEqual(eventPermissions.filter((permission) => permission !== "VIEW_HEALTH_INFORMATION" && permission !== "FINALIZE_INVOICES"));
  });

  it("leaves VIEW_SENSITIVE_DATA holders without it", () => {
    for (const role of ["REGISTRATION_MANAGER", "FINANCE_MANAGER", "CHECK_IN_STAFF"] as const) {
      expect(rolePermissions[role]).toContain("VIEW_SENSITIVE_DATA");
      expect(rolePermissions[role]).not.toContain("VIEW_HEALTH_INFORMATION");
    }
  });

  it("reaches a member only through an explicit grant, and a system administrator automatically", () => {
    const staff = { id: "u1", globalRole: null } as never;
    const admin = { id: "u2", globalRole: "SYSTEM_ADMIN" } as never;
    const base = { id: "m1", eventId: "e1", userId: "u1", role: "EVENT_ADMIN", status: "ACTIVE" } as never;
    expect(effectivePermissions(staff, { ...(base as object), permissions: [] } as never)).not.toContain("VIEW_HEALTH_INFORMATION");
    expect(effectivePermissions(staff, { ...(base as object), permissions: ["VIEW_HEALTH_INFORMATION"] } as never)).toContain("VIEW_HEALTH_INFORMATION");
    expect(effectivePermissions(admin, null)).toContain("VIEW_HEALTH_INFORMATION");
  });
});

describe("viewer scope", () => {
  const leader: HealthViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
  const role: HealthViewer = { kind: "HEALTH_ROLE", userId: "u1", eventIds: ["e1"] };
  const coordinator: HealthViewer = { kind: "AREA_COORDINATOR", accountId: "acct-2" };
  const admin: HealthViewer = { kind: "SYSTEM_ADMIN", userId: "u9" };

  it("keeps a club leader to their own club and a role holder to the events they were granted", () => {
    expect(viewerCanSeeClub(leader, "club-a")).toBe(true);
    expect(viewerCanSeeClub(leader, "club-b")).toBe(false);
    for (const viewer of [role, coordinator, admin]) expect(viewerCanSeeClub(viewer, "club-b")).toBe(true);
    expect(viewerCanSeeEvent(role, "e1")).toBe(true);
    expect(viewerCanSeeEvent(role, "e2")).toBe(false);
    for (const viewer of [leader, coordinator, admin]) expect(viewerCanSeeEvent(viewer, "e2")).toBe(true);
  });

  it("names who looked in the audit fields without any health text", () => {
    expect(healthAuditActor(admin)).toEqual({ actorUserId: "u9", metadata: { viewerKind: "SYSTEM_ADMIN" } });
    expect(healthAuditActor(coordinator)).toEqual({ metadata: { viewerKind: "AREA_COORDINATOR", actorAttendeeAccountId: "acct-2" } });
    expect(healthAuditActor(leader).metadata).toEqual({ viewerKind: "CLUB_LEADER", actorAttendeeAccountId: "acct-1" });
    expect(healthAuditActor({ kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "STAFF_ACTING", userId: "u3", actAsId: "act-1" } }))
      .toEqual({ actorUserId: "u3", metadata: { viewerKind: "CLUB_LEADER", actAsId: "act-1" } });
  });
});

describe("what is read from existing answers", () => {
  it("keeps the dietary text as entered, shortened, and the medical flag to yes or no", () => {
    expect(dietaryFromResponses({ dietary_needs: "  Synthetic   peanut  allergy " })).toBe("Synthetic peanut allergy");
    expect(dietaryFromResponses({ dietary_needs: 5 })).toBeNull();
    expect(dietaryFromResponses({ dietary_needs: "x".repeat(900) })?.length).toBe(500);
    expect(medicalFlagFromResponses({ medical_or_accessibility_need: "Yes" })).toBe("Yes");
    expect(medicalFlagFromResponses({ medical_or_accessibility_need: "Needs an inhaler" })).toBeNull();
    expect(medicalFlagFromResponses(null)).toBeNull();
  });

  it("labels the permission slip as phone only and a passenger list as name and phone", () => {
    const submittedAt = new Date("2026-10-02T15:00:00Z");
    expect(slipContact({ rosterMemberId: "r1", formName: "Slip", submittedAt, emergencyPhone: "555-0100" }))
      .toMatchObject({ value: "555-0100", kind: "PHONE_ONLY", matchedBy: "ROSTER_MEMBER", submittedOn: "2026-10-02" });
    expect(slipContact({ rosterMemberId: "r1", formName: "Slip", submittedAt, emergencyPhone: " " })).toBeNull();
    const found = passengerContacts({
      formName: "List",
      submittedAt,
      passengers: [{ name: "Avery Test", emergencyContact: "Parent Test 555-0101" }, { name: "", emergencyContact: "x" }, { name: "Blake Test", emergencyContact: "" }],
    });
    expect(found).toHaveLength(1);
    expect(found[0].contact).toMatchObject({ kind: "NAME_AND_PHONE", matchedBy: "NAME" });
  });
});

describe("pickHealthAnswers (#658)", () => {
  it("keeps only the emergency, activity-date and passenger name keys and drops everything else at once", () => {
    const kept = pickHealthAnswers({
      emergency_contact_phone: "555-0100",
      activity_date: "2026-10-10",
      passenger_1_name: "A",
      passenger_20_emergency_contact: "B",
      passenger_21_name: "too far",
      physician_name: "Synthetic",
      clinic_phone: "555-0112",
      child_name: "Avery",
    });
    expect(Object.keys(kept).sort()).toEqual(["activity_date", "emergency_contact_phone", "passenger_1_name", "passenger_20_emergency_contact"]);
  });
});
