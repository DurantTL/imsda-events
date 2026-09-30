import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClubEarnedAwardsWorkspace, type ClubEarnedAwardsData, emptyEarnedAwardsData } from "@/components/club-earned-awards-workspace";
import { ClubOrderWorkspace, type ClubOrderWorkspaceData } from "@/components/club-order-workspace";

/**
 * The Earned awards screen (#532), initial-render markup. Synthetic data only.
 */

const data: ClubEarnedAwardsData = {
  catalog: [
    { itemId: "gc", section: "MISCELLANEOUS", sectionLabel: "Miscellaneous", name: "Good Conduct Bar", catalogNumber: "002304" },
    { itemId: "tlt", section: "TEEN_LEADERSHIP_TRAINING", sectionLabel: "Teen Leadership Training", name: "TLT Pin", catalogNumber: "004100" },
  ],
  members: [
    { personId: "p1", firstName: "Alex", lastName: "Sample", classLabel: "Friend" },
    { personId: "p2", firstName: "Casey", lastName: "Demo", classLabel: "Guide" },
  ],
  needs: [
    { needId: "n1", personId: "p1", firstName: "Alex", lastName: "Sample", itemName: "Friend Pin", origin: "Class insignia", missingCatalogNumber: false, status: "NEEDED" },
    { needId: "n2", personId: "p2", firstName: "Casey", lastName: "Demo", itemName: "Fall Camporee Patch", origin: "Event patch", missingCatalogNumber: true, status: "ORDERED" },
  ],
  awardedCount: 4,
  insignia: [{
    completionId: "c1", personId: "p1", firstName: "Alex", lastName: "Sample", classLevel: "FRIEND", classLabel: "Friend", completedOn: "2026-06-06",
    items: [
      { itemId: "strip", name: "Friend Class Name Strip", catalogNumber: "002140" },
      { itemId: "pin", name: "Friend Pin", catalogNumber: "002120" },
    ],
    missing: ["Trail Friend Ribbon Bar"],
  }],
  patches: [{
    eventId: "e1", eventName: "Fall Camporee", eventDate: "2026-09-19", itemId: "camp", itemName: "Fall Camporee Patch", catalogNumber: null, basis: "CHECK_IN",
    people: [{ personId: "p1", firstName: "Alex", lastName: "Sample" }, { personId: "p2", firstName: "Casey", lastName: "Demo" }],
  }],
  masterAwards: [{
    ruleId: "r1", name: "Health Master Award", requirement: "3 of 7 + 2 of 5 + 2 of 5", missingItem: false,
    eligible: [{ personId: "p1", firstName: "Alex", lastName: "Sample" }],
    onOrder: [{ personId: "p2", firstName: "Casey", lastName: "Demo" }],
    givenElsewhere: [{ personId: "p4", firstName: "Sky", lastName: "Placeholder" }],
    awardedCount: 2,
    closest: [{ personId: "p3", firstName: "Riley", lastName: "Test", counted: 5, required: 7, label: "5 of 7" }],
  }],
};

const render = (readOnly: boolean, value: ClubEarnedAwardsData = data) => renderToStaticMarkup(
  createElement(ClubEarnedAwardsWorkspace, { organizationId: "club-1", initial: value, ordersHref: "/account/clubs/club-1/orders", readOnly }),
);

describe("the Earned awards screen (#532)", () => {
  it("gives a director or deputy the suggestions, each needing a confirming click, with nothing pre-added", () => {
    const html = render(false);
    expect(html).toContain("Earned awards");
    expect(html).toContain("Suggested (2)");
    expect(html).toContain("Nothing here is added until you confirm it.");
    // Insignia: every catalog item ticked to start with, a confirm button, "Not now", and the missing item flagged.
    expect(html).toContain("Friend insignia");
    expect(html).toContain("Friend Class Name Strip");
    expect(html).toContain("Add to order list (2)");
    expect(html).toContain("Not now");
    expect(html).toContain("Not in the supply catalog yet, so not suggested: Trail Friend Ribbon Bar.");
    // Patches: attendance basis and a conference-made patch flagged, not dropped.
    expect(html).toContain("Fall Camporee Patch");
    expect(html).toContain("Members who were checked in at the event.");
    expect(html).toContain("No AdventSource number (conference-made)");
  });

  it("marks a class completed, and adds Good Conduct and TLT items by hand with 'already has it'", () => {
    const html = render(false);
    expect(html).toContain("Mark a class completed");
    expect(html).toContain("It orders nothing by itself.");
    expect(html).toContain("<option value=\"MASTER_GUIDE\">Master Guide</option>");
    expect(html).toContain("Add by hand");
    expect(html).toContain('<optgroup label="Miscellaneous">');
    expect(html).toContain("Good Conduct Bar");
    expect(html).toContain('<optgroup label="Teen Leadership Training">');
    expect(html).toContain("They already have it");
    expect(html).toContain("Alex Sample");
    expect(html).toContain("Casey Demo");
  });

  it("lists open earned items with their origin and status, and offers 'Already has it' and 'Remove' only for needed ones", () => {
    const html = render(false);
    expect(html).toContain("Open earned items (2)");
    expect(html).toContain("4 awarded so far");
    expect(html).toContain("Needed · Class insignia");
    expect(html).toContain("Ordered · Event patch · no AdventSource number");
    expect(html).toContain("Already has it");
    expect(html).toContain("Remove");
  });

  it("shows Master Award progress: eligible not yet awarded, on order, awarded, and the closest as 'N of M'", () => {
    const html = render(false);
    expect(html).toContain("Health Master Award");
    expect(html).toContain("Needs 3 of 7 + 2 of 5 + 2 of 5");
    expect(html).toContain("Eligible, not yet awarded (1)");
    expect(html).toContain("On the order list: Casey Demo");
    expect(html).toContain("Already given (another club): Sky Placeholder");
    expect(html).toContain("2 awarded");
    expect(html).toContain("Riley Test");
    expect(html).toContain("5 of 7");
    expect(html).toContain("Add to order list");
  });

  it("gives a registrar or Area Coordinator the same lists with no controls", () => {
    const html = render(true, { ...data, catalog: [], members: [], insignia: [], patches: [] });
    expect(html).toContain("View only");
    expect(html).toContain("Open earned items (2)");
    expect(html).toContain("Eligible, not yet awarded (1)");
    expect(html).toContain("5 of 7");
    for (const control of ["Suggested (", "Mark a class completed", "Add by hand", "Mark completed", "Record items", "Already has it (", "Remove", "Add to order list", "Not now", "<input"]) {
      expect(html, control).not.toContain(control);
    }
  });

  it("carries no birth date, contact, or medical field", () => {
    expect(render(false)).not.toMatch(/birth|phone|email|medical|allerg|insurance|guardian/i);
  });

  it("says so when there are no suggestions, no rules, and no items", () => {
    const html = render(false, emptyEarnedAwardsData);
    expect(html).toContain("No suggestions right now.");
    expect(html).toContain("No Master Award rules are active yet.");
    expect(html).toContain("No open earned items.");
    expect(html).toContain("No earned-award items are in the supply catalog yet.");
  });

  it("flags a Master Award with no catalog item and offers no add button for it", () => {
    const html = render(false, { ...data, insignia: [], patches: [], masterAwards: [{ ...data.masterAwards[0], missingItem: true }] });
    expect(html).toContain("Not linked to a catalog item yet");
    expect(html).not.toContain("Add to order list (");
  });
});

describe("earned awards on the order screen", () => {
  const orders: ClubOrderWorkspaceData = {
    helper: [{ itemId: "camp", section: "OTHER", name: "Fall Camporee Patch", size: "", catalogNumber: null, computedNeeded: 2, needed: 2, edited: false, onHand: 0, toOrder: 2 }],
    unmatched: [],
    awardable: [],
    waiting: [{ needId: "n1", sourceType: "AWARD", itemName: "Fall Camporee Patch", sourceLabel: "Fall Camporee", sourceDate: "2026-09-19", firstName: "Alex", lastName: "Sample", beforeFirstOrder: true }],
    firstOrderAt: null,
  };

  it("lists an earned item on the same order list, flags its missing number, and never prompts 'already handed out' for it", () => {
    const html = renderToStaticMarkup(createElement(ClubOrderWorkspace, { organizationId: "club-1", initial: orders }));
    expect(html).toContain("Fall Camporee Patch");
    expect(html).toContain("No item number");
    expect(html).toContain("earned awards");
    expect(html).not.toContain("Honors that may already be handed out");
  });
});
