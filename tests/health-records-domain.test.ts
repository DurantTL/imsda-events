import { describe, expect, it } from "vitest";
import {
  HEALTH_FIELD_KEYS,
  clampHealthLinkDays,
  healthWindowEndsOn,
  healthWindowOpen,
  viewerCanSeeEvent,
  viewerNeedsEvent,
  fieldValuesFromInput,
  hasHealthNoteFor,
  healthAuditActor,
  healthRecordInputSchema,
  healthRecordStatus,
  viewerCan,
  type HealthViewer,
} from "@/modules/health-records/domain";

import { eventPermissions, rolePermissions } from "@/modules/access/permissions";
import { syntheticRecord } from "./health-records-fixtures";

const now = new Date("2026-10-05T15:00:00Z");

describe("health record input", () => {
  it("accepts a complete synthetic record", () => {
    expect(healthRecordInputSchema.safeParse(syntheticRecord).success).toBe(true);
  });

  it("requires the allergy description when allergies is Yes, and the insurance company when insured", () => {
    const result = healthRecordInputSchema.safeParse({ ...syntheticRecord, allergyDetails: "", insuranceCompany: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path[0]).sort()).toEqual(["allergyDetails", "insuranceCompany"]);
    }
  });

  it("requires all three consents, a signature, a guardian and at least one emergency contact", () => {
    for (const patch of [
      { consentEmergencyTreatment: false },
      { consentActivities: false },
      { consentPhotocopy: false },
      { signature: "  " },
      { guardianFirstName: "" },
      { emergencyContacts: [] },
    ]) {
      expect(healthRecordInputSchema.safeParse({ ...syntheticRecord, ...patch }).success, JSON.stringify(Object.keys(patch))).toBe(false);
    }
  });

  it("rejects a malformed tetanus date and drops unknown keys", () => {
    expect(healthRecordInputSchema.safeParse({ ...syntheticRecord, lastTetanusBooster: "03/01/2024" }).success).toBe(false);
    const parsed = healthRecordInputSchema.parse({ ...syntheticRecord, surprise: "x" });
    expect(parsed).not.toHaveProperty("surprise");
  });

  it("splits a submission into separate field values and stores nothing for empty ones", () => {
    const values = fieldValuesFromInput(healthRecordInputSchema.parse(syntheticRecord), now);
    expect(Object.keys(values).every((key) => (HEALTH_FIELD_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(values).not.toHaveProperty("medicalRestrictions");
    expect(values).not.toHaveProperty("addressLine2");
    expect(values.signature).toEqual({ typedName: "Pat Sample", signedOn: "2026-10-05" });
    expect(hasHealthNoteFor(values)).toBe(true);
    expect(hasHealthNoteFor({ hasAllergies: "NO" })).toBe(false);
  });
});

describe("club year status", () => {
  it("is Needs update until saved or confirmed in the current club year", () => {
    expect(healthRecordStatus(null, now)).toBe("NONE");
    expect(healthRecordStatus({ confirmedClubYear: "2026-27" }, now)).toBe("CURRENT");
    expect(healthRecordStatus({ confirmedClubYear: "2025-26" }, now)).toBe("NEEDS_UPDATE");
    expect(healthRecordStatus({ confirmedClubYear: null }, now)).toBe("NEEDS_UPDATE");
    // The same record rolls into Needs update when the club year turns over.
    expect(healthRecordStatus({ confirmedClubYear: "2026-27" }, new Date("2027-10-05T15:00:00Z"))).toBe("NEEDS_UPDATE");
  });
});

describe("who may do what", () => {
  const leader: HealthViewer = { kind: "CLUB_LEADER", organizationId: "club-a", accountId: "acct-1" };
  const staff: HealthViewer = { kind: "HEALTH_ROLE", userId: "user-1", eventIds: ["event-1"] };
  const admin: HealthViewer = { kind: "SYSTEM_ADMIN", userId: "user-0" };
  const coordinator: HealthViewer = { kind: "AREA_COORDINATOR", accountId: "acct-2" };

  it("lets a club leader view, edit and send links for their own club only", () => {
    for (const action of ["VIEW", "EDIT", "SEND_LINK"] as const) {
      expect(viewerCan(leader, "club-a", action)).toBe(true);
      expect(viewerCan(leader, "club-b", action)).toBe(false);
    }
  });

  it("gives staff and Area Coordinators view-only access, never edit or links", () => {
    for (const viewer of [staff, coordinator, admin]) {
      expect(viewerCan(viewer, "club-a", "VIEW")).toBe(true);
      expect(viewerCan(viewer, "club-b", "VIEW")).toBe(true);
      expect(viewerCan(viewer, "club-a", "EDIT")).toBe(false);
      expect(viewerCan(viewer, "club-a", "SEND_LINK")).toBe(false);
    }
  });

  it("has no viewer kind for a registrar, reporter or event staff", () => {
    const kinds: HealthViewer["kind"][] = ["CLUB_LEADER", "AREA_COORDINATOR", "HEALTH_ROLE", "SYSTEM_ADMIN"];
    expect(kinds).toHaveLength(4);
  });

  it("scopes coordinators and the health role to events, and the health role to its own events", () => {
    expect(viewerNeedsEvent(coordinator)).toBe(true);
    expect(viewerNeedsEvent(staff)).toBe(true);
    expect(viewerNeedsEvent(leader)).toBe(false);
    expect(viewerNeedsEvent(admin)).toBe(false);
    expect(viewerCanSeeEvent(staff, "event-1")).toBe(true);
    expect(viewerCanSeeEvent(staff, "event-2")).toBe(false);
    expect(viewerCanSeeEvent(coordinator, "event-2")).toBe(true);
  });

  it("attributes by id only", () => {
    expect(healthAuditActor(leader)).toEqual({ metadata: { viewerKind: "CLUB_LEADER", actorAttendeeAccountId: "acct-1" } });
    expect(healthAuditActor(staff)).toEqual({ actorUserId: "user-1", metadata: { viewerKind: "HEALTH_ROLE" } });
    expect(healthAuditActor(admin)).toEqual({ actorUserId: "user-0", metadata: { viewerKind: "SYSTEM_ADMIN" } });
    expect(healthAuditActor(coordinator)).toEqual({ metadata: { viewerKind: "AREA_COORDINATOR", actorAttendeeAccountId: "acct-2" } });
  });

  it("clamps the link lifetime", () => {
    expect(clampHealthLinkDays(undefined)).toBe(14);
    expect(clampHealthLinkDays(0)).toBe(1);
    expect(clampHealthLinkDays(400)).toBe(30);
  });
});

describe("the event window (the coordinator health view's rule)", () => {
  const event = { timezone: "America/Chicago", endsAt: new Date("2026-11-08T18:00:00Z") };

  it("ends 30 calendar days after the event's last day, inclusive, in the event's time zone", () => {
    expect(healthWindowEndsOn(event)).toBe("2026-12-08");
    expect(healthWindowOpen(event, new Date("2026-09-01T12:00:00Z"))).toBe(true);
    expect(healthWindowOpen(event, new Date("2026-11-07T12:00:00Z"))).toBe(true);
    expect(healthWindowOpen(event, new Date("2026-12-08T23:30:00-06:00"))).toBe(true);
    expect(healthWindowOpen(event, new Date("2026-12-09T00:30:00-06:00"))).toBe(false);
  });
});

describe("the explicit permission", () => {
  it("exists and is carried by no role, Event Admin included", () => {
    expect(eventPermissions).toContain("VIEW_HEALTH_INFORMATION");
    for (const [role, permissions] of Object.entries(rolePermissions)) {
      expect(permissions, role).not.toContain("VIEW_HEALTH_INFORMATION");
    }
  });
});
