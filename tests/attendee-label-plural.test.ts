import { describe, expect, it } from "vitest";
import { pluralAttendeeLabel, pluralizeAttendeeLabel } from "@/modules/forms/attendee-label";
import { formHasPrices, NO_COST_NOTICE, noCostPrice, perPersonPrice } from "@/modules/club-registrations/per-person-price";

describe("pluralAttendeeLabel (#809)", () => {
  it("makes each part of an 'or' label plural", () => {
    expect(pluralizeAttendeeLabel("Team member or coach")).toBe("team members or coaches");
    expect(pluralAttendeeLabel("Team member or coach", 1)).toBe("team member or coach");
    expect(pluralAttendeeLabel("Team member or coach", 2)).toBe("team members or coaches");
  });

  it("knows people, and the usual endings", () => {
    expect(pluralAttendeeLabel("Person", 1)).toBe("person");
    expect(pluralAttendeeLabel("Person", 3)).toBe("people");
    expect(pluralAttendeeLabel("Attendee", 2)).toBe("attendees");
    expect(pluralAttendeeLabel("Church", 0)).toBe("churches");
    expect(pluralAttendeeLabel("Family", 2)).toBe("families");
    expect(pluralAttendeeLabel("Boy and girl", 2)).toBe("boys and girls");
  });
});

describe("a free team event's price notice (#809)", () => {
  it("says no cost when nothing is priced, and leaves real prices alone", () => {
    const free = perPersonPrice({ lineItems: [], roster: true, attendeeCount: 3 });
    expect(noCostPrice(free).notice).toBe(NO_COST_NOTICE);
    const priced = perPersonPrice({ lineItems: [{ label: "Fee", amountCents: 2500, attendeeIndex: 0 }], roster: true, attendeeCount: 1 });
    expect(noCostPrice(priced)).toBe(priced);
  });

  it("finds a price on any field", () => {
    expect(formHasPrices({ sections: [{ fields: [{}, {}] }] })).toBe(false);
    expect(formHasPrices({ sections: [{ fields: [{}, { priceCents: 0 }] }] })).toBe(true);
    expect(formHasPrices({ sections: [{ fields: [{ latePricing: { priceCents: 5 } }] }] })).toBe(true);
  });
});
