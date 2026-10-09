import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
import { ClubFormFillIn } from "@/components/club-form-fill-in";
import { updateField } from "@/components/club-form-builder-state";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { sanitizeClubFormAnswers, validateClubFormAnswers, type ClubFormTemplateRecord } from "@/modules/club-forms/domain";
import { exportColumnsAcrossVersions } from "@/modules/club-forms/versions";
import { registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";

const staff = clubFormTemplateSeeds.find((seed) => seed.key === "pathfinder_staff_service_information")!;
const references: RegistrationFormDefinition = registrationFormDefinitionSchema.parse({
  ...staff.definition,
  sections: staff.definition.sections.filter((section) => section.id === "sec_references"),
});

const answers = {
  reference_1_name: "Pastor Example", reference_1_address: "1 Example Road", reference_1_phone: "515-555-0101",
  reference_2_name: "Local Example", reference_2_address: "2 Example Road", reference_2_phone: "515-555-0102",
  reference_3_name: "Other Example", reference_3_address: "3 Example Road", reference_3_phone: "515-555-0103",
};

describe("staff form references laid out per person (#856)", () => {
  it("names the reference in a validation message", () => {
    const blank = sanitizeClubFormAnswers(references, { ...answers, reference_2_name: "   " });
    const issues = validateClubFormAnswers(references, blank);
    expect(issues.map((issue) => issue.message)).toEqual(["2. Local reference — Name is required."]);
  });

  it("renders one labelled group card per reference with plain labels and tel phones", () => {
    const markup = renderToStaticMarkup(createElement(ClubFormFillIn, { definition: references, sectionNotes: {}, sensitiveFieldKeys: [], mode: "link", token: "t", initialAnswers: {} }));
    expect(markup.match(/class="club-form-field-group"/g)).toHaveLength(3);
    for (const heading of ["1. Pastor", "2. Local reference", "3. Other reference"]) {
      expect(markup).toContain(`aria-label="${heading}"`);
      expect(markup).toContain(`class="club-form-field-group-heading">${heading}</p>`);
    }
    expect(markup.match(/type="tel"/g)).toHaveLength(3);
    expect(markup.match(/inputMode="tel"/gi)).toHaveLength(3);
  });

  it("heads the export column with the person and the plain label", () => {
    const record = { version: 4, definition: references } as unknown as ClubFormTemplateRecord;
    const headings = exportColumnsAcrossVersions([record], new Set()).map((column) => column.heading);
    expect(headings).toContain("1. Pastor — Name");
    expect(headings).toContain("3. Other reference — Phone");
  });

  it("keeps the group when the builder edits a question", () => {
    const spec = { definition: references } as Parameters<typeof updateField>[0];
    const field = references.sections[0].fields[0];
    const next = updateField(spec, field.id, { label: "Full name" });
    expect(next.definition.sections[0].fields[0].group).toBe("1. Pastor");
  });
});
