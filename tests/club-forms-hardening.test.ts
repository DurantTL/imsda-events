import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("lucide-react", () => ({ LockKeyhole: () => null }));

import { ClubFormSubmissionView } from "@/components/club-form-submission-view";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { redactTokenPath } from "@/lib/request-context";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

describe("private-link tokens never reach a logged path (#610)", () => {
  it("redacts the segment after /club-forms/ and /manage/, in pages and APIs", () => {
    expect(redactTokenPath("/club-forms/AbC_123-secretTokenValue")).toBe("/club-forms/[redacted]");
    expect(redactTokenPath("/api/public/club-forms/AbC_123-secretTokenValue")).toBe("/api/public/club-forms/[redacted]");
    expect(redactTokenPath("/manage/AbC_123-secretTokenValue")).toBe("/manage/[redacted]");
    expect(redactTokenPath("/api/public/manage/AbC_123-secretTokenValue/attendee-passes/a1/qr")).toBe("/api/public/manage/[redacted]/attendee-passes/a1/qr");
  });

  it("leaves other paths alone", () => {
    for (const path of ["/", "/api/attendee/clubs/club-1/forms/links", "/more/club-forms", "/more/club-forms/sub-1", "/events/spring/register"]) {
      expect(redactTokenPath(path)).toBe(path);
    }
  });
});

describe("the passenger list print (#610)", () => {
  const seed = clubFormTemplateSeeds.find((template) => template.key === "transportation_passenger_list")!;
  const submission = (answers: Record<string, unknown>, restrictedKeys: string[] = []) => ({
    id: "sub-1",
    template: {
      key: seed.key,
      name: seed.name,
      description: seed.description,
      printLayout: seed.printLayout,
      definition: registrationFormDefinitionSchema.parse(seed.definition),
      sectionNotes: seed.sectionNotes,
      sensitiveFieldKeys: seed.sensitiveFieldKeys,
      staffOnlyFieldKeys: [],
      enabled: true,
    },
    organization: { id: "club-a", name: "Example Pathfinders" },
    clubYear: "2026-27",
    rosterMemberId: null,
    subjectName: "",
    status: "SUBMITTED" as const,
    submittedAt: "2026-10-05T15:00:00.000Z",
    enteredVia: "ATTENDEE" as const,
    answers,
    sensitiveRevealed: restrictedKeys.length === 0,
    restrictedKeys,
  });
  const render = (value: ReturnType<typeof submission>) => renderToStaticMarkup(createElement(ClubFormSubmissionView, { submission: value }));

  it("prints roll-call columns 1 to 5 for each passenger", () => {
    const html = render(submission({ passenger_1_name: "Riley Sample", passenger_1_phone: "555-0100", passenger_1_emergency_contact: "Pat Sample 555-0101" }));
    for (const call of [1, 2, 3, 4, 5]) expect(html).toContain(`>${call}</th>`);
    expect(html.match(/club-form-roll-box/g)).toHaveLength(5);
    expect(html).toContain("Riley Sample");
    expect(html).toContain("Pat Sample 555-0101");
  });

  it("keeps a row that has an emergency contact but no name", () => {
    const html = render(submission({ passenger_2_emergency_contact: "Only Contact 555-0199" }));
    expect(html).toContain("Only Contact 555-0199");
    expect(html).toContain("(no name)");
    expect(html.match(/club-form-roll-box/g)).toHaveLength(5);
  });

  it("keeps a row that has only a phone", () => {
    expect(render(submission({ passenger_3_phone: "555-0123" }))).toContain("555-0123");
  });

  it("shows Restricted, never the contact, to a viewer who may not read emergency contacts", () => {
    // The repository leaves a restricted answer out, so nothing leaks and no row is invented for it.
    const html = render(submission({ passenger_1_name: "Riley Sample" }, seed.sensitiveFieldKeys));
    expect(html).toContain("Restricted");
    expect(html).not.toContain("Pat Sample");
    expect(html.match(/club-form-roll-box/g)).toHaveLength(5);
  });

  it("says so when no one is listed", () => {
    expect(render(submission({}))).toContain("No passengers listed.");
  });
});
