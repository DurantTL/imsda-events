import { describe, expect, it } from "vitest";
import {
  badgeTemplates,
  buildBadgeLabels,
  normalizeBadgeStartingPosition,
  normalizeBadgeTemplate,
  paginateBadgeLabels,
  type BadgeLabel,
} from "@/modules/checkin/badge-labels";
import { formTemplates } from "@/modules/forms/definition";
import type { RegistrationRecord } from "@/modules/registrations/repository";

function label(index: number): BadgeLabel {
  return {
    attendeeId: `attendee-${index}`,
    attendeeType: "Adult",
    confirmationCode: `REG-${index}`,
    firstName: `First ${index}`,
    lastName: `Last ${index}`,
    groupLabel: "Central Church",
    shirtSize: "Adult L",
    shirtSizeConfirmed: true,
  };
}

describe("printable badge labels", () => {
  it("normalizes supported templates and sheet positions", () => {
    expect(normalizeBadgeTemplate("avery-5392")).toBe("avery-5392");
    expect(normalizeBadgeTemplate("unknown")).toBe("avery-5395");
    expect(normalizeBadgeStartingPosition("6", 8)).toBe(6);
    expect(normalizeBadgeStartingPosition("9", 8)).toBe(1);
    expect(badgeTemplates["avery-5163"].perSheet).toBe(10);
  });

  it("leaves consumed labels blank on the first reusable sheet", () => {
    const sheets = paginateBadgeLabels(
      [label(1), label(2), label(3)],
      "avery-5392",
      5,
    );

    expect(sheets).toHaveLength(2);
    expect(sheets[0]).toHaveLength(6);
    expect(sheets[0].slice(0, 4)).toEqual([null, null, null, null]);
    expect(sheets[0][4]?.attendeeId).toBe("attendee-1");
    expect(sheets[1][0]?.attendeeId).toBe("attendee-3");
  });

  it("adds church and current shirt confirmation data to sorted badges", () => {
    const definition = formTemplates.find(
      (template) => template.key === "womens_retreat_export",
    )!.definition;
    const registrations = [{
      id: "registration-1",
      confirmationCode: "REG-WR",
      status: "SUBMITTED",
      accountHolder: { firstName: "Account", lastName: "Holder" },
      attendees: [{
        id: "attendee-z",
        firstName: "Zoe",
        lastName: "Young",
        attendeeType: "Adult",
        position: 0,
        responses: {
          shirt_size: "Adult M",
          shirt_size_confirmed_at: "2026-08-02T15:30:00.000Z",
        },
      }, {
        id: "attendee-a",
        firstName: "Ana",
        lastName: "Adams",
        attendeeType: "Teen",
        position: 1,
        responses: {},
      }],
      publicSubmission: {
        definition,
        responses: { church: "Ames SDA Church" },
        attendeeResponses: [{}, {}],
      },
    }] as unknown as RegistrationRecord[];

    const labels = buildBadgeLabels(registrations);

    expect(labels.map((entry) => entry.attendeeId)).toEqual([
      "attendee-a",
      "attendee-z",
    ]);
    expect(labels[0].groupLabel).toBe("Ames SDA Church");
    expect(labels[1]).toMatchObject({
      shirtSize: "Adult M",
      shirtSizeConfirmed: true,
    });
  });
});
