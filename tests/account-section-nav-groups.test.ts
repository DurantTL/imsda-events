import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/account/clubs/club-1/honors" }));

import { AccountSectionNav } from "@/components/account-section-nav";

/** Grouped menu markup (#644): each group is a labelled nested list, ungrouped items stay top level. */
describe("AccountSectionNav groups", () => {
  it("renders a labelled nested list per group and marks the current page", () => {
    const html = renderToStaticMarkup(createElement(AccountSectionNav, {
      label: "Club",
      items: [
        { href: "/account/clubs/club-1", label: "Home" },
        { href: "/account/clubs/club-1/roster", label: "Roster", group: "People" },
        { href: "/account/clubs/club-1/honors", label: "Honors", group: "People" },
        { href: "/account/clubs/club-1/transfers", label: "Transfers", group: "Requests" },
      ],
    }));
    expect(html).not.toContain('role="presentation"');
    expect(html.match(/account-nav-group-label/g)).toHaveLength(2);
    expect(html.match(/<ul aria-labelledby="/g)).toHaveLength(2);
    expect(html).toContain('aria-current="page" href="/account/clubs/club-1/honors"');
    // Home sits outside any group.
    expect(html.indexOf("Home")).toBeLessThan(html.indexOf("account-nav-group"));
  });

  it("leaves off a group heading that one of its own tabs already says, keeping the name for assistive tech", () => {
    const html = renderToStaticMarkup(createElement(AccountSectionNav, {
      label: "Club",
      items: [
        { href: "/account/clubs/club-1/events", label: "Events", group: "Events" },
        { href: "/account/clubs/club-1/forms", label: "Forms", group: "Events" },
        { href: "/account/clubs/club-1/records", label: "Monthly Records", group: "Records" },
        { href: "/account/clubs/club-1/club-info", label: "Club info", group: "Club" },
        { href: "/account/clubs/club-1/roster", label: "Roster", group: "People" },
      ],
    }));
    expect(html.match(/account-nav-group-label/g)).toHaveLength(1);
    expect(html).toContain(">People</span>");
    expect(html).toContain('<ul aria-label="Events">');
    expect(html).toContain('<ul aria-label="Records">');
    expect(html).toContain('<ul aria-label="Club">');
  });
});
