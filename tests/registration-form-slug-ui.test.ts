import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FormSlugDialog } from "@/components/form-slug-dialog";
import { RegistrationBuilderWorkspace } from "@/components/registration-builder-workspace";
import { formTemplates, type RegistrationFormDefinition } from "@/modules/forms/definition";

// Synthetic fixture only.
function dialogMarkup(overrides: Partial<Parameters<typeof FormSlugDialog>[0]> = {}) {
  return renderToStaticMarkup(createElement(FormSlugDialog, {
    open: true,
    eventSlug: "fall-camporee-2028",
    currentSlug: "womens-retreat-registration",
    offeredSlug: "honors-weekend-registration",
    error: "",
    busy: false,
    onKeep: vi.fn(),
    onUpdate: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }));
}

describe("form slug prompt dialog (#476)", () => {
  it("offers both choices with the full addresses", () => {
    const markup = dialogMarkup();
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("/register/fall-camporee-2028/honors-weekend-registration");
    expect(markup).toContain("/register/fall-camporee-2028/womens-retreat-registration");
    expect(markup).toContain("Keep womens-retreat-registration");
    expect(markup).toContain("Update to honors-weekend-registration");
    expect(markup).not.toContain('role="alert"');
  });

  it("shows a failed update inside the dialog as an alert", () => {
    const markup = dialogMarkup({ error: "That web address is already used by another form for this event. Choose another address." });
    const dialogStart = markup.indexOf('role="dialog"');
    const alertAt = markup.indexOf('role="alert"');
    expect(dialogStart).toBeGreaterThan(-1);
    expect(alertAt).toBeGreaterThan(dialogStart);
    expect(markup).toContain("That web address is already used by another form for this event.");
  });

  it("disables both choices while the update is in flight", () => {
    const markup = dialogMarkup({ busy: true });
    expect(markup).toContain("Updating…");
    expect(markup.match(/<button[^>]*disabled=""/g)?.length).toBe(3);
  });

  it("renders nothing when closed", () => {
    expect(dialogMarkup({ open: false })).toBe("");
  });
});

describe("registration builder public-form shortcut (#476)", () => {
  function draftForm() {
    const definition = structuredClone(formTemplates[0].definition) as RegistrationFormDefinition;
    const version = {
      id: "version-1",
      versionNumber: 1,
      status: "DRAFT",
      definition,
      publishedAt: null,
      createdAt: "2028-08-01T00:00:00.000Z",
      updatedAt: "2028-08-01T00:00:00.000Z",
      createdBy: "Synthetic Staff",
      testSubmissionCount: 0,
      choiceUsage: {},
      testSubmissions: [],
    };
    return {
      id: "form-1",
      eventId: "event-1",
      name: definition.title,
      slug: "synthetic-draft-form",
      status: "DRAFT",
      createdAt: "2028-08-01T00:00:00.000Z",
      updatedAt: "2028-08-01T00:00:00.000Z",
      createdBy: "Synthetic Staff",
      activeVersion: version,
      versions: [version],
    };
  }

  it("shows no working public link for an unpublished form, only a disabled button with its reason", () => {
    const markup = renderToStaticMarkup(createElement(RegistrationBuilderWorkspace, {
      eventId: "event-1",
      eventSlug: "fall-camporee-2028",
      eventName: "Fall Camporee 2028",
      initialForms: [draftForm()],
      templates: [],
    }));

    expect(markup).not.toContain("/register/");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*title="Publish this form to create its public link"[^>]*>(?:(?!<\/button>).)*Open public form/);
  });
});
