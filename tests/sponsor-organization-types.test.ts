import { describe, expect, it } from "vitest";
import {
  SPONSOR_ORGANIZATION_TYPES,
  canSponsorClub,
  isSponsorOrganizationType,
  sponsorOptionLabel,
} from "@/modules/organizations/domain";

/** The shared "who can sponsor a club" rule (#822). Synthetic names only. */
describe("club sponsor rule", () => {
  it("lists church, company and group, and nothing else", () => {
    expect([...SPONSOR_ORGANIZATION_TYPES]).toEqual(["CHURCH", "COMPANY", "GROUP"]);
  });

  it.each(["CHURCH", "COMPANY", "GROUP"])("treats %s as a sponsor kind", (type) => {
    expect(isSponsorOrganizationType(type)).toBe(true);
  });

  it.each(["CLUB", "SCHOOL", "EARLY_CHILDHOOD", "BOOKSTORE", "COMMUNITY_CENTER", "CAMP", "CONFERENCE", "ASSOCIATION", "", "church"])(
    "does not treat %s as a sponsor kind",
    (type) => {
      expect(isSponsorOrganizationType(type)).toBe(false);
    },
  );

  it("rejects missing kinds", () => {
    expect(isSponsorOrganizationType(null)).toBe(false);
    expect(isSponsorOrganizationType(undefined)).toBe(false);
  });

  it("lets only an active church, company or group sponsor", () => {
    expect(canSponsorClub({ type: "CHURCH", isActive: true })).toBe(true);
    expect(canSponsorClub({ type: "COMPANY", isActive: true })).toBe(true);
    expect(canSponsorClub({ type: "GROUP", isActive: true })).toBe(true);
    expect(canSponsorClub({ type: "COMPANY", isActive: false })).toBe(false);
    expect(canSponsorClub({ type: "SCHOOL", isActive: true })).toBe(false);
    expect(canSponsorClub({ type: "CAMP", isActive: true })).toBe(false);
    expect(canSponsorClub(null)).toBe(false);
    expect(canSponsorClub(undefined)).toBe(false);
  });

  it("shows the kind after the name for anything that is not a church", () => {
    expect(sponsorOptionLabel({ name: "Sample Hills SDA Church", type: "CHURCH" })).toBe("Sample Hills SDA Church");
    expect(sponsorOptionLabel({ name: "Sample Youth Company", type: "COMPANY" })).toBe("Sample Youth Company (Company)");
    expect(sponsorOptionLabel({ name: "Sample Fellowship", type: "GROUP" })).toBe("Sample Fellowship (Group)");
  });
});
