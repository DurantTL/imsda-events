import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RegistrationBuilderWorkspace } from "@/components/registration-builder-workspace";
import { formTemplates, type RegistrationFormDefinition } from "@/modules/forms/definition";

// Synthetic fixtures only.
type Status = "DRAFT" | "PUBLISHED" | "ARCHIVED";

function makeVersion(versionNumber: number, status: Status, validTest = false) {
  const definition = structuredClone(formTemplates[0].definition) as RegistrationFormDefinition;
  return {
    id: `version-${versionNumber}`,
    versionNumber,
    status,
    definition,
    publishedAt: status === "DRAFT" ? null : "2028-08-01T00:00:00.000Z",
    createdAt: "2028-08-01T00:00:00.000Z",
    updatedAt: "2028-08-01T00:00:00.000Z",
    createdBy: "Synthetic Staff",
    testSubmissionCount: validTest ? 1 : 0,
    choiceUsage: {},
    testSubmissions: validTest
      ? [{ id: "test-1", isValid: true, validation: { issues: [] }, responses: {}, submittedBy: "Synthetic Staff", createdAt: "2028-08-01T00:00:00.000Z" }]
      : [],
  };
}

function render(versions: ReturnType<typeof makeVersion>[]) {
  const active = versions.find((version) => version.status === "DRAFT") ?? versions.find((version) => version.status === "PUBLISHED") ?? versions[0]!;
  return renderToStaticMarkup(createElement(RegistrationBuilderWorkspace, {
    eventId: "event-1",
    eventSlug: "fall-camporee-2028",
    eventName: "Fall Camporee 2028",
    initialForms: [{
      id: "form-1", eventId: "event-1", name: active.definition.title, slug: "synthetic-form", status: active.status,
      createdAt: "2028-08-01T00:00:00.000Z", updatedAt: "2028-08-01T00:00:00.000Z", createdBy: "Synthetic Staff",
      activeVersion: active, versions,
    }],
    templates: [],
  }));
}

function buttonFor(markup: string, label: string) {
  const match = markup.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`));
  return match?.[0] ?? "";
}

describe("registration builder revisions (#564)", () => {
  it("offers a new version from a published form instead of a dead disabled button", () => {
    const markup = render([makeVersion(1, "PUBLISHED")]);
    const button = buttonFor(markup, "Create new version");
    expect(button).not.toBe("");
    expect(button).not.toContain('disabled=""');
    expect(markup).toContain("is live and is never changed in place");
    expect(markup).toContain("Existing registrations keep the version they were submitted under");
    expect(markup).toContain("Withdraw from public page");
  });

  it("keeps a withdrawn form editable and says it is withdrawn", () => {
    const markup = render([makeVersion(1, "ARCHIVED")]);
    const button = buttonFor(markup, "Create new version");
    expect(button).not.toBe("");
    expect(button).not.toContain('disabled=""');
    expect(markup).toContain("is withdrawn from the public page");
    expect(markup).not.toContain("Withdraw from public page");
  });

  it("holds v2 behind its own test even though v1 was published, and says why", () => {
    const markup = render([makeVersion(2, "DRAFT"), makeVersion(1, "ARCHIVED", true)]);
    expect(buttonFor(markup, "Publish version")).toContain('disabled=""');
    expect(markup).toContain("Run a test submission first");
    expect(markup).toContain('href="#live-form-preview"');
    expect(markup).not.toContain("Optional — this form is already published");
  });

  it("enables publishing once the selected draft has a valid test", () => {
    const markup = render([makeVersion(2, "DRAFT", true), makeVersion(1, "ARCHIVED")]);
    expect(buttonFor(markup, "Publish version")).not.toContain('disabled=""');
    expect(markup).not.toContain("Run a test submission first");
  });
});
