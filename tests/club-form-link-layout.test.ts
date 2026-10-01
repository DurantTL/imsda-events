import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClubFormFillIn } from "@/components/club-form-fill-in";
import { updateField } from "@/components/club-form-builder-state";
import { withAutoDateAnswers } from "@/components/club-form-state";
import { checkClubFormDraft, NO_PROTECTION_HISTORY, specFromRecord } from "@/modules/club-forms/builder-domain";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { allFields } from "@/modules/club-forms/domain";
import { registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";

// #719: layout of the private club form link, the director's fill page and the health record link.
// Vitest has no layout engine, so these guard the markup classes and the stylesheet rules.
const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const definition: RegistrationFormDefinition = {
  title: "Sample",
  description: "",
  confirmationMessage: "Thanks",
  sections: [{
    id: "sec_a",
    title: "Applicant",
    description: "",
    fields: [
      { id: "f_signed", key: "signed", label: "Date signed by applicant", helpText: "", type: "DATE", scope: "REGISTRATION", required: true, options: [] },
      { id: "f_filled", key: "filled", label: "Another date", helpText: "", type: "DATE", scope: "REGISTRATION", required: false, options: [] },
    ],
  }],
};

function render(initialAnswers: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(ClubFormFillIn, { definition, sectionNotes: {}, sensitiveFieldKeys: [], mode: "link", token: "t", initialAnswers }));
}

describe("private club form layout (#719)", () => {
  it("makes the form column one column at the hero's width instead of the 820px strip", () => {
    expect(css).toMatch(/\.club-form-public \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(css).not.toMatch(/\.club-form-public \{[^}]*max-width/);
    expect(css).not.toMatch(/\.club-form-public \{[^}]*margin/);
  });

  it("pairs fields only when there is room, and lets the grid fill the card (#733)", () => {
    const rule = css.match(/\.club-form-fill \.form-grid\.two-column \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("repeat(auto-fit, minmax(min(16rem, 100%), 1fr))");
    expect(rule).not.toContain("max-width");
    expect(css).toMatch(/\.club-form-fill \{[^}]*max-width: 1[0-9]{3}px/);
    expect(css).toMatch(/\.club-form-fill \.form-grid\.two-column > :not\(\.club-form-field-wide\) \{ max-width: 40rem; \}/);
  });

  it("puts section headings inside the card: a hidden legend names the group and a block shows the heading (#733)", () => {
    expect(css).toMatch(/\.club-form-section-legend \{[^}]*position: absolute;[^}]*clip: rect\(0, 0, 0, 0\)/);
    expect(css).not.toMatch(/fieldset\.public-manage-card > legend \{[^}]*float: left/);
    const markup = render();
    expect(markup).toContain("<legend class=\"club-form-section-legend\">Applicant</legend>");
    expect(markup).toContain("<p aria-hidden=\"true\" class=\"club-form-section-title public-registration-eyebrow\">Applicant</p>");
  });

  it("keeps the required marker attached to the label with a non-breaking space", () => {
    expect(render()).toContain("Date signed by applicant<span aria-hidden=\"true\"> *</span>");
  });
});

describe("empty date fields (#719)", () => {
  it("shows an mm/dd/yyyy hint and the empty-state class on an empty date, and not on a filled one", () => {
    const markup = render({ filled: "2026-10-01" });
    expect(markup.match(/club-form-date-hint/g)).toHaveLength(1);
    expect(markup.match(/club-form-date is-empty/g)).toHaveLength(1);
    expect(markup.match(/mm\/dd\/yyyy/g)).toHaveLength(1);
    expect(markup).toContain("required=\"\" type=\"date\"");
  });

  it("hides the native date text while empty and unfocused, and the hint once focused", () => {
    expect(css).toContain(".club-form-date.is-empty input:not(:focus)::-webkit-datetime-edit,");
    expect(css).toContain(".club-form-date:focus-within .club-form-date-hint { display: none; }");
  });
});

describe("date inputs fit their card on iOS Safari (#733)", () => {
  const dateInput = css.match(/\.club-form-date input\[type="date"\] \{([^}]*)\}/)?.[1] ?? "";

  it("resets the native look and sizes the input to its box", () => {
    for (const declaration of ["-webkit-appearance: none", "appearance: none", "box-sizing: border-box", "width: 100%", "min-width: 0", "max-width: 100%", "min-height: 44px", "text-align: left"]) {
      expect(dateInput).toContain(declaration);
    }
    expect(css).toMatch(/\.club-form-date-field \{ min-width: 0; max-width: 100%; \}/);
    expect(css).toMatch(/\.club-form-date \{[^}]*width: 100%;[^}]*min-width: 0/);
  });

  it("hides the native value text of an empty, unfocused date, including iOS's value pseudo-element", () => {
    expect(css).toMatch(/\.club-form-date\.is-empty input:not\(:focus\)::-webkit-date-and-time-value \{[^}]*color: transparent/);
    expect(css).toMatch(/\.club-form-date input\[type="date"\]::-webkit-date-and-time-value \{[^}]*text-align: left/);
    expect(css).toMatch(/\.club-form-date-hint \{[^}]*z-index: 1/);
  });

  it("keeps the calendar button inside the box", () => {
    expect(css).toMatch(/\.club-form-date-button \{[^}]*position: absolute;[^}]*right: 0/);
    expect(dateInput).toContain("padding: 10px 52px 10px 11px");
  });
});

describe("signing dates fill in automatically (#719)", () => {
  const autoDefinition: RegistrationFormDefinition = {
    ...definition,
    sections: [{
      id: "sec_a",
      title: "Signature",
      description: "",
      fields: [{ id: "f_auto", key: "signed_on", label: "Date", helpText: "", type: "DATE", scope: "REGISTRATION", required: true, options: [], autoDate: "TODAY" }],
    }],
  };

  it("shows a private link's auto date as today's date, read-only, with no picker button", () => {
    const markup = renderToStaticMarkup(createElement(ClubFormFillIn, { definition: autoDefinition, sectionNotes: {}, sensitiveFieldKeys: [], mode: "link", token: "t", todayDate: "2026-10-05", initialAnswers: { signed_on: "1999-01-01" } }));
    expect(markup).toContain("value=\"2026-10-05\"");
    expect(markup).not.toContain("1999-01-01");
    expect(markup).toContain("readOnly=\"\"");
    expect(markup).toContain("Filled in automatically");
    expect(markup).not.toContain("Choose date");
  });

  it("pre-fills a director's new form but leaves it editable, and keeps a saved value", () => {
    const base = { definition: autoDefinition, sectionNotes: {}, sensitiveFieldKeys: [], mode: "club" as const, organizationId: "club-a", templateKey: "k", rosterMembers: [], doneHref: "/x", todayDate: "2026-10-05" };
    const fresh = renderToStaticMarkup(createElement(ClubFormFillIn, base));
    expect(fresh).toContain("value=\"2026-10-05\"");
    expect(fresh).not.toContain("readOnly");
    expect(fresh).toContain("Choose date");
    const saved = renderToStaticMarkup(createElement(ClubFormFillIn, { ...base, submissionId: "s1", initialAnswers: { signed_on: "2026-09-20" } }));
    expect(saved).toContain("value=\"2026-09-20\"");
    expect(saved).not.toContain("2026-10-05");
  });

  it("gives every editable date a Choose date button and keeps the mm/dd/yyyy hint", () => {
    const markup = render();
    expect(markup.match(/aria-label="Choose date for /g)).toHaveLength(2);
    expect(markup.match(/mm\/dd\/yyyy/g)).toHaveLength(2);
    expect(css).toMatch(/\.club-form-date-button \{[^}]*width: 44px;[^}]*height: 44px/);
  });

  it("keeps the Choose date button outside the label so the input's name is just its label", () => {
    const markup = render();
    for (const label of markup.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? []) expect(label).not.toContain("<button");
    expect(markup).toContain("aria-label=\"Choose date for Date signed by applicant\"");
    expect(markup).toMatch(/<label for="([^"]+)">[\s\S]*?Date signed by applicant[\s\S]*?<\/label>[\s\S]*?<input id="\1"/);
    const health = readFileSync(path.join(process.cwd(), "components/health-record-form.tsx"), "utf8");
    expect(health).toContain("labelText={label}");
  });

  it("opens the picker from the input only while it is empty, and always from the button", () => {
    const source = readFileSync(path.join(process.cwd(), "components/club-form-date-input.tsx"), "utf8");
    expect(source).toContain("if (fromInput && input.value) return;");
    expect(source).toContain("onClick={() => openPicker(true)}");
    expect(source).toContain("onClick={() => openPicker()}");
  });

  it("fills missing auto dates only, or all of them when overwriting", () => {
    expect(withAutoDateAnswers(autoDefinition, {}, "2026-10-05")).toEqual({ signed_on: "2026-10-05" });
    expect(withAutoDateAnswers(autoDefinition, { signed_on: "2026-09-20" }, "2026-10-05")).toEqual({ signed_on: "2026-09-20" });
    expect(withAutoDateAnswers(autoDefinition, { signed_on: "2026-09-20" }, "2026-10-05", true)).toEqual({ signed_on: "2026-10-05" });
  });

  it("round-trips through the builder: the setting survives the draft check, and clearing or retyping drops it", () => {
    const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === "off_premises_permission_slip")!;
    const spec = specFromRecord({
      name: seed.name, description: seed.description, definition: registrationFormDefinitionSchema.parse(seed.definition), sectionNotes: seed.sectionNotes,
      sensitiveFieldKeys: seed.sensitiveFieldKeys, birthDateFieldKeys: seed.birthDateFieldKeys, staffOnlyFieldKeys: seed.staffOnlyFieldKeys,
      hiddenFieldKeys: [], printLayout: seed.printLayout, sortOrder: seed.sortOrder,
    });
    const dateField = allFields(spec.definition).find((field) => field.key === "activity_date")!;
    expect(dateField.autoDate).toBeUndefined();
    const on = updateField(spec, dateField.id, { autoDate: "TODAY" });
    const checked = checkClubFormDraft(JSON.parse(JSON.stringify(on)), NO_PROTECTION_HISTORY);
    expect(checked.ok).toBe(true);
    expect(checked.spec && allFields(checked.spec.definition).find((field) => field.key === "activity_date")?.autoDate).toBe("TODAY");
    const off = updateField(on, dateField.id, { autoDate: undefined });
    expect(allFields(off.definition).find((field) => field.key === "activity_date")).not.toHaveProperty("autoDate");
    const retyped = updateField(on, dateField.id, { type: "TEXT" });
    expect(allFields(retyped.definition).find((field) => field.key === "activity_date")).not.toHaveProperty("autoDate");
  });
});
