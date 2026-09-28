import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  templateCleanupCreatedStorageKey,
  templateCleanupDismissedStorageKey,
} from "@/components/template-cleanup-checklist";
import { TemplateCleanupChecklistPanel } from "@/components/template-cleanup-checklist-panel";

const definition = registrationFormDefinitionSchema.parse({
  title: "Spring Camporee 2026",
  description: "",
  confirmationMessage: "Saved.",
  sections: [{
    id: "s_roster",
    title: "Roster",
    description: "",
    fields: [
      { id: "f_name", key: "attendee_name", label: "Name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
    ],
  }],
});

let store: Map<string, string>;

function stubWindow() {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
}

function render(formId: string) {
  return renderToStaticMarkup(createElement(TemplateCleanupChecklistPanel, { formId, definition }));
}

beforeEach(() => {
  store = new Map();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("template cleanup checklist panel (#484)", () => {
  it("renders nothing without a window (server render, e.g. an isolated snapshot)", () => {
    expect(render("form_1")).toBe("");
  });

  it("renders nothing for a form never recorded as created from a template", () => {
    stubWindow();
    expect(render("form_1")).toBe("");
  });

  it("renders the checklist with one item per inherited section and field once created from a template", () => {
    store.set(templateCleanupCreatedStorageKey, JSON.stringify(["form_1"]));
    stubWindow();
    const markup = render("form_1");
    expect(markup).toContain("Review what this template brought in");
    expect(markup).toContain("Roster");
    expect(markup).toContain("Name");
  });

  it("renders nothing once dismissed for that form", () => {
    store.set(templateCleanupCreatedStorageKey, JSON.stringify(["form_1"]));
    store.set(templateCleanupDismissedStorageKey, JSON.stringify(["form_1"]));
    stubWindow();
    expect(render("form_1")).toBe("");
  });

  it("still shows for a different, non-dismissed form", () => {
    store.set(templateCleanupCreatedStorageKey, JSON.stringify(["form_1", "form_2"]));
    store.set(templateCleanupDismissedStorageKey, JSON.stringify(["form_1"]));
    stubWindow();
    expect(render("form_1")).toBe("");
    expect(render("form_2")).toContain("Review what this template brought in");
  });
});
