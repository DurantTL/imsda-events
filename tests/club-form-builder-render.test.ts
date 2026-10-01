import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ClubFormBuilder } from "@/components/club-form-builder";
import { ClubFormCreate } from "@/components/club-form-create";
import { specFromRecord } from "@/modules/club-forms/builder-domain";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === "off_premises_permission_slip")!;
const spec = specFromRecord({
  name: seed.name,
  description: seed.description,
  definition: registrationFormDefinitionSchema.parse(seed.definition),
  sectionNotes: seed.sectionNotes,
  sensitiveFieldKeys: seed.sensitiveFieldKeys,
  birthDateFieldKeys: seed.birthDateFieldKeys,
  staffOnlyFieldKeys: seed.staffOnlyFieldKeys,
  hiddenFieldKeys: [],
  printLayout: seed.printLayout,
  sortOrder: seed.sortOrder,
});

describe("the club form builder page (#712)", () => {
  it("renders the details, every section and question, and the versions", () => {
    const markup = renderToStaticMarkup(createElement(ClubFormBuilder, {
      templateKey: seed.key,
      version: 3,
      enabled: true,
      submissionCount: 2,
      initial: spec,
      hasDraft: false,
      draftUpdatedAt: null,
      lockedSensitiveKeys: seed.sensitiveFieldKeys,
      lockedBirthDateKeys: [],
      publishedKeys: spec.definition.sections.flatMap((section) => section.fields.map((field) => field.key)),
      versions: [{ version: 3, recordedAt: "2026-10-01T00:00:00.000Z" }, { version: 1, recordedAt: "2026-09-29T00:00:00.000Z" }],
    }));
    expect(markup).toContain("Save draft");
    expect(markup).toContain("Publish version 4");
    expect(markup).toContain("Print layout");
    expect(markup).toContain("Add a section");
    expect(markup).toContain("Section 1");
    expect(markup).toContain(`Section ${spec.definition.sections.length}`);
    for (const field of spec.definition.sections[0].fields) expect(markup).toContain(field.label.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
    expect(markup).toContain("Version 3 (current)");
  });

  it("renders the create form with every template as a copy source", () => {
    const markup = renderToStaticMarkup(createElement(ClubFormCreate, { templates: [{ key: seed.key, name: seed.name }] }));
    expect(markup).toContain("New form");
    expect(markup).toContain("A blank form");
    expect(markup).toContain("A copy of");
  });
});
