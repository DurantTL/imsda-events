import { describe, expect, it } from "vitest";
import { requireEventCreationPermission } from "@/modules/events/authorization";
import { getEventPublishReadiness } from "@/modules/events/readiness";
import { eventSettingsInputSchema } from "@/modules/events/schemas";

const validEvent = {
  name: "Women’s Retreat 2027",
  slug: "womens-retreat-2027",
  startsOn: "2027-10-08",
  endsOn: "2027-10-10",
  timezone: "America/Chicago",
  location: "Camp Heritage",
  capacity: 350,
  publicInfoUrl: "https://imsda.org/event/womens-retreat/",
  supportContact: "registration@imsda.org",
  isPublished: false,
  registrationOpensOn: "2027-05-01",
  registrationClosesOn: "2027-10-01",
  waitlistEnabled: true,
  autoPromoteWaitlist: true,
} as const;

describe("event settings", () => {
  it("normalizes a valid event payload", () => {
    const parsed = eventSettingsInputSchema.parse({
      ...validEvent,
      name: "  Women’s Retreat 2027 ",
      slug: "WOMENS-RETREAT-2027",
      location: "  Camp Heritage ",
    });
    expect(parsed).toMatchObject({
      name: "Women’s Retreat 2027",
      slug: "womens-retreat-2027",
      location: "Camp Heritage",
    });
  });

  it("turns empty optional text into null", () => {
    const parsed = eventSettingsInputSchema.parse({
      ...validEvent,
      location: "",
      publicInfoUrl: "",
      supportContact: "",
    });
    expect(parsed.location).toBeNull();
    expect(parsed.publicInfoUrl).toBeNull();
    expect(parsed.supportContact).toBeNull();
  });

  it("rejects invalid schedules, URLs, and waitlist combinations", () => {
    expect(() => eventSettingsInputSchema.parse({
      ...validEvent,
      endsOn: "2027-10-07",
    })).toThrow("The event cannot end before it starts.");
    expect(() => eventSettingsInputSchema.parse({
      ...validEvent,
      publicInfoUrl: "imsda.org/event/test",
    })).toThrow("Enter a complete http:// or https:// web address.");
    expect(() => eventSettingsInputSchema.parse({
      ...validEvent,
      waitlistEnabled: false,
      autoPromoteWaitlist: true,
    })).toThrow("Automatic promotion requires the waitlist to be enabled.");
  });

  it("reports a plain-language publish checklist", () => {
    const incomplete = getEventPublishReadiness({
      ...validEvent,
      location: null,
      supportContact: null,
    }, 0);
    expect(incomplete.ready).toBe(false);
    expect(incomplete.items.filter((item) => !item.complete).map((item) => item.id)).toEqual([
      "location",
      "support",
      "registration-form",
    ]);

    const ready = getEventPublishReadiness(validEvent, 1);
    expect(ready.ready).toBe(true);
    expect(ready.completedCount).toBe(ready.items.length);
  });

  it("allows only a system administrator to create events", () => {
    expect(() => requireEventCreationPermission({
      user: {
        id: "usr_staff",
        email: "staff@example.test",
        displayName: "Staff",
        globalRole: null,
      },
    })).toThrowError(expect.objectContaining({ status: 403, code: "PERMISSION_DENIED" }));

    expect(requireEventCreationPermission({
      user: {
        id: "usr_system",
        email: "system@example.test",
        displayName: "System Admin",
        globalRole: "SYSTEM_ADMIN",
      },
    }).id).toBe("usr_system");
  });
});
