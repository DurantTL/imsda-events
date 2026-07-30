import { describe, expect, it } from "vitest";
import {
  buildOperationalReport,
  type OperationalReportRegistration,
} from "@/modules/reporting/operational-reports";
import { buildRetreatPacketGroups } from "@/modules/reporting/retreat-packets";
import type { RegistrationRecord } from "@/modules/registrations/repository";

const definition = {
  title: "Women’s Retreat",
  description: "",
  confirmationMessage: "Registered.",
  sections: [{
    id: "group",
    title: "Church",
    description: "",
    fields: [{
      id: "church",
      key: "church",
      label: "Home church",
      helpText: "",
      type: "SELECT",
      scope: "REGISTRATION",
      required: true,
      options: ["Central", "Other"],
    }, {
      id: "allergy",
      key: "allergy",
      label: "Medical allergies",
      helpText: "",
      type: "LONG_TEXT",
      scope: "ATTENDEE",
      required: false,
      options: [],
    }],
  }],
} as const;

function registration(): RegistrationRecord {
  return {
    id: "registration-1",
    confirmationCode: "WR-001",
    status: "CONFIRMED",
    totalAmountCents: 25000,
    paidCents: 25000,
    balanceCents: 0,
    submittedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    accountHolder: {
      id: "person-1",
      firstName: "Ana",
      lastName: "Rivera",
      email: "ana@example.org",
      phone: "555-0100",
    },
    attendees: [{
      id: "attendee-1",
      firstName: "Ana",
      lastName: "Rivera",
      email: "ana@example.org",
      phone: "555-0100",
      attendeeType: "Adult",
      position: 0,
      source: "PUBLIC_REGISTRATION",
      responses: { shirt_size: "Adult M", allergy: "PRIVATE-ALLERGY" },
      checkedIn: false,
      checkInId: null,
      checkedInAt: null,
    }],
    attendeeType: "Adult",
    attendeeCount: 1,
    checkedInCount: 0,
    payments: [],
    messages: [],
    publicSubmission: {
      formName: "Women’s Retreat",
      formSlug: "womens-retreat",
      versionNumber: 1,
      responses: { church: "Central" },
      originalResponses: { church: "Central" },
      attendeeResponses: [{ shirt_size: "Adult M", allergy: "PRIVATE-ALLERGY" }],
      definition,
      rosterEnabled: true,
      pricingSnapshot: {},
      originalPricingSnapshot: {},
      submittedAt: "2026-01-01T00:00:00.000Z",
      amendedAt: null as never,
      amendmentOperationId: null as never,
    },
  };
}

describe("grouped retreat packets", () => {
  it("combines group contacts, shirt sizes, arrival state, and current assignments", () => {
    const source = registration();
    const report = buildOperationalReport([source as OperationalReportRegistration]);
    const packets = buildRetreatPacketGroups(
      [source],
      report.rosterGroups,
      [{ fieldLabel: "Seminar", attendeeId: "attendee-1", option: "Prayer" }],
    );

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      label: "Central",
      registrations: [{
        confirmationCode: "WR-001",
        email: "ana@example.org",
      }],
      attendees: [{
        firstName: "Ana",
        shirtSize: "Adult M",
        checkedIn: false,
        assignments: [{ label: "Seminar", option: "Prayer" }],
      }],
    });
    expect(JSON.stringify(packets)).not.toContain("PRIVATE-ALLERGY");
  });
});
