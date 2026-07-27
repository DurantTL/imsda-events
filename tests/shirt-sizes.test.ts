import { describe, expect, it } from "vitest";
import {
  publicShirtSizeConfirmationSchema,
  shirtSizeConfirmedAtFromResponses,
  shirtSizeFromResponses,
  shirtSizeOptions,
} from "@/modules/registrations/shirt-sizes";

describe("registration shirt sizes", () => {
  it("covers youth and extended adult convention sizes", () => {
    expect(shirtSizeOptions).toEqual(expect.arrayContaining([
      "Youth S",
      "Youth XL",
      "Adult XS",
      "Adult 5XL",
    ]));
  });

  it("requires one valid selection per unique attendee", () => {
    expect(publicShirtSizeConfirmationSchema.safeParse({
      attendees: [
        { attendeeId: "attendee-1", shirtSize: "Adult L" },
        { attendeeId: "attendee-2", shirtSize: "Youth M" },
      ],
    }).success).toBe(true);
    expect(publicShirtSizeConfirmationSchema.safeParse({
      attendees: [
        { attendeeId: "attendee-1", shirtSize: "Adult L" },
        { attendeeId: "attendee-1", shirtSize: "Adult XL" },
      ],
    }).success).toBe(false);
    expect(publicShirtSizeConfirmationSchema.safeParse({
      attendees: [{ attendeeId: "attendee-1", shirtSize: "Custom" }],
    }).success).toBe(false);
  });

  it("reads only valid operational values", () => {
    expect(shirtSizeFromResponses({ shirt_size: "Adult 2XL" }))
      .toBe("Adult 2XL");
    expect(shirtSizeFromResponses({ shirt_size: "Extra enormous" }))
      .toBeNull();
    expect(shirtSizeConfirmedAtFromResponses({
      shirt_size_confirmed_at: "2026-08-02T15:30:00.000Z",
    })).toBe("2026-08-02T15:30:00.000Z");
    expect(shirtSizeConfirmedAtFromResponses({
      shirt_size_confirmed_at: "not-a-date",
    })).toBeNull();
  });
});
