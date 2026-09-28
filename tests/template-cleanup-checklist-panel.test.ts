import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { templateCleanupCreatedStorageKey } from "@/components/template-cleanup-checklist";
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
    addEventListener: () => {},
    removeEventListener: () => {},
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

describe("template cleanup checklist panel: no hydration mismatch (#484 N2)", () => {
  it("renders nothing on the server, with no window at all", () => {
    expect(render("form_1")).toBe("");
  });

  it("still renders nothing during a server-style render even when storage says the checklist should show", () => {
    // `renderToStaticMarkup` is a server render: React always uses
    // `getServerSnapshot` there, never the real storage read, so this must
    // stay empty regardless of what's stubbed in `window.localStorage` —
    // proving the server markup can never disagree with a genuine browser's
    // own first paint (which likewise starts from the server snapshot,
    // before `useSyncExternalStore` syncs to the real value post-hydration).
    store.set(templateCleanupCreatedStorageKey, JSON.stringify(["form_1"]));
    stubWindow();
    expect(render("form_1")).toBe("");
  });
});
