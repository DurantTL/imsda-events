import { describe, expect, it } from "vitest";
import {
  mobileNavigationOrder,
  navigation,
  staffPageTitles,
  staffSubpageTitle,
} from "@/components/staff-navigation";

describe("staff page names (#685)", () => {
  it("uses one name per section in the navigation", () => {
    const labelByHref = Object.fromEntries(navigation.map((item) => [item.href, item.label]));
    expect(labelByHref["/overview"]).toBe("Dashboard");
    expect(labelByHref["/people"]).toBe("Registrations");
    expect(labelByHref["/finance"]).toBe("Payments");
    expect(labelByHref["/more/promo-codes"]).toBe("Promo codes");
    expect(labelByHref["/registration-builder"]).toBe("Registration form");
  });

  it("shows the same label on the phone tab bar as in the sidebar", () => {
    // The tab bar renders each item's `label`; there is no separate short name to drift.
    for (const href of mobileNavigationOrder) {
      expect(navigation.find((item) => item.href === href)?.label).toBeTruthy();
    }
    expect(navigation.every((item) => !("mobileLabel" in item))).toBe(true);
  });

  it("names /more/* pages that are not nav items instead of 'More'", () => {
    expect(staffSubpageTitle("/more/honors")).toBe(staffPageTitles.honors);
    expect(staffSubpageTitle("/more/honors/rosters")).toBe(staffPageTitles.honors);
    expect(staffSubpageTitle("/more/reports/clubs")).toBe("Operational reports");
    expect(staffSubpageTitle("/more/clubs")).toBe("Clubs");
    expect(staffSubpageTitle("/more")).toBeNull();
    expect(staffSubpageTitle("/people")).toBeNull();
  });
});
