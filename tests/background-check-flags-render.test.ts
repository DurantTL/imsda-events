import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackgroundCheckList } from "@/components/background-check-flags";
import type { BackgroundFlag } from "@/modules/background-checks/repository";

/**
 * The "Background check needed" list (#388, #544): a system administrator's
 * flags carry the issues text and readable reasons; anyone else's carry
 * neither (null and empty), and nothing about them is rendered.
 */

const flag = (overrides: Partial<BackgroundFlag> = {}): BackgroundFlag => ({
  attendeeId: "attendee-1",
  personId: "person-1",
  firstName: "Dana",
  lastName: "Example",
  attendeeType: "ADULT",
  clubName: "Test Club",
  organizationId: "club-1",
  confirmationCode: "TEST-1",
  registrationId: "registration-1",
  state: "NOT_COMPLIANT",
  expiresOn: null,
  issuesNote: null,
  issueReasons: [],
  ...overrides,
});

const render = (people: BackgroundFlag[]) => renderToStaticMarkup(createElement(BackgroundCheckList, { people }));

describe("the background-check-needed list renders the issues text and reasons only when given them (#544)", () => {
  it("shows the text as written and each reason for an administrator", () => {
    const html = render([flag({ issuesNote: "Synthetic issue, Non-Driver, BGC", issueReasons: ["Marked Non-Driver", "Background check expired"] })]);
    expect(html).toContain("Issues: Synthetic issue, Non-Driver, BGC");
    expect(html).toContain("Marked Non-Driver; Background check expired");
  });

  it("renders no text and no reasons when the note is null and the reasons are empty", () => {
    const html = render([flag()]);
    expect(html).toContain("Dana");
    expect(html).not.toContain("Issues:");
    expect(html).not.toContain("background-check-note");
    expect(html).not.toContain("Non-Driver");
  });
});
