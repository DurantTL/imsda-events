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

  it("leaves off the heading of a group flagged hideGroupLabel, keeping the name for assistive tech", () => {
    const html = renderToStaticMarkup(createElement(AccountSectionNav, {
      label: "Club",
      items: [
        { href: "/account/clubs/club-1/events", label: "Events", group: "Events", hideGroupLabel: true },
        { href: "/account/clubs/club-1/forms", label: "Forms", group: "Events", hideGroupLabel: true },
        { href: "/account/clubs/club-1/roster", label: "Roster", group: "People" },
        { href: "/account/clubs/club-1/honors", label: "Honors", group: "Shown anyway" },
      ],
    }));
    expect(html.match(/account-nav-group-label/g)).toHaveLength(2);
    expect(html).toContain(">People</span>");
    expect(html).toContain('<ul aria-label="Events">');
    expect(html).not.toContain(">Events</span>");
  });

  it("does not hide a group heading just because a tab's name resembles it", () => {
    const html = renderToStaticMarkup(createElement(AccountSectionNav, {
      label: "Club",
      items: [{ href: "/account/clubs/club-1/events", label: "Events", group: "Events" }],
    }));
    expect(html).toContain(">Events</span>");
  });
});
