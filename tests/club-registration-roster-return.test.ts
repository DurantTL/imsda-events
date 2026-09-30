import { describe, expect, it } from "vitest";
import { registrationReturnTo, rosterHrefFromRegistration } from "@/modules/club-registrations/roster-return";

describe("roster returnTo (#643)", () => {
  it("builds a roster link that round-trips through validation", () => {
    const href = rosterHrefFromRegistration("club_1", "event_9");
    expect(href.startsWith("/account/clubs/club_1/roster?returnTo=")).toBe(true);
    const value = new URL(href, "https://example.test").searchParams.get("returnTo");
    expect(registrationReturnTo("club_1", value)).toBe("/account/clubs/club_1/events/event_9");
  });

  it.each([
    ["another club", "/account/clubs/club_2/events/event_9"],
    ["club home", "/account/clubs/club_1"],
    ["a non-registration page", "/account/clubs/club_1/roster"],
    ["extra path", "/account/clubs/club_1/events/event_9/packet"],
    ["a query string", "/account/clubs/club_1/events/event_9?x=1"],
    ["a fragment", "/account/clubs/club_1/events/event_9#x"],
    ["an absolute URL", "https://evil.test/account/clubs/club_1/events/event_9"],
    ["protocol-relative", "//evil.test/account/clubs/club_1/events/event_9"],
    ["dot segments", "/account/clubs/club_1/events/.."],
    ["encoded slashes", "/account/clubs/club_1/events/a%2F..%2Fb"],
    ["an empty value", ""],
  ])("ignores %s", (_label, value) => {
    expect(registrationReturnTo("club_1", value)).toBeNull();
  });

  it("ignores missing and repeated values", () => {
    expect(registrationReturnTo("club_1", undefined)).toBeNull();
    expect(registrationReturnTo("club_1", ["/account/clubs/club_1/events/e", "/x"])).toBeNull();
  });
});
