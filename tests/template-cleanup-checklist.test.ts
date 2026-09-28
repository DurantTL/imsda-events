import { describe, expect, it } from "vitest";
import {
  buildTemplateCleanupChecklistItems,
  isTemplateCleanupDismissed,
  parseTemplateCleanupIdList,
  readTemplateCleanupCreatedFormIds,
  readTemplateCleanupDismissedFormIds,
  readTemplateCleanupRaw,
  shouldShowTemplateCleanupChecklist,
  subscribeTemplateCleanupChecklistChanges,
  withTemplateCleanupCreated,
  withTemplateCleanupDismissed,
  writeTemplateCleanupCreatedFormIds,
  writeTemplateCleanupDismissedFormIds,
} from "@/components/template-cleanup-checklist";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const definition = registrationFormDefinitionSchema.parse({
  title: "Spring Camporee 2026",
  description: "",
  confirmationMessage: "Saved.",
  sections: [
    {
      id: "s_contact",
      title: "Club & contact",
      description: "",
      fields: [
        { id: "f_club", key: "club_name", label: "Pathfinder club", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
        { id: "f_director", key: "director_name", label: "Club director", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      ],
    },
    {
      id: "s_roster",
      title: "Roster",
      description: "",
      fields: [
        { id: "f_name", key: "attendee_name", label: "Name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      ],
    },
  ],
});

describe("template cleanup checklist: visibility (#484)", () => {
  it("shows only for a form this browser recorded as created from a template, until dismissed", () => {
    expect(shouldShowTemplateCleanupChecklist(["form_1"], [], "form_1")).toBe(true);
    expect(shouldShowTemplateCleanupChecklist([], [], "form_1")).toBe(false);
    expect(shouldShowTemplateCleanupChecklist(["form_1"], ["form_1"], "form_1")).toBe(false);
    expect(shouldShowTemplateCleanupChecklist(["form_1"], [], null)).toBe(false);
    expect(shouldShowTemplateCleanupChecklist(["form_1"], [], "")).toBe(false);
  });

  it("it is not a publish gate — visibility carries no signal about whether the form can publish", () => {
    // The checklist logic never reads or reports any publish-readiness state;
    // it only answers whether to render a review aid.
    expect(shouldShowTemplateCleanupChecklist(["form_1"], [], "form_1")).toBe(true);
  });
});

describe("template cleanup checklist: created/dismissed bookkeeping", () => {
  it("adds a form id once and is idempotent", () => {
    const once = withTemplateCleanupCreated([], "form_1");
    expect(once).toEqual(["form_1"]);
    expect(withTemplateCleanupCreated(once, "form_1")).toEqual(["form_1"]);
  });

  it("dismissal never mutates the array passed in", () => {
    const original = ["form_1"];
    const next = withTemplateCleanupDismissed(original, "form_2");
    expect(original).toEqual(["form_1"]);
    expect(next).toEqual(["form_1", "form_2"]);
    expect(isTemplateCleanupDismissed(next, "form_2")).toBe(true);
  });

  it("bounds the remembered lists instead of growing without limit", () => {
    const many = Array.from({ length: 200 }, (_, index) => `form_${index}`);
    const next = withTemplateCleanupCreated(many, "form_new");
    expect(next).toHaveLength(200);
    expect(next.at(-1)).toBe("form_new");
    expect(next).not.toContain("form_0");
  });

  it("round-trips through an injected storage-like object", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    writeTemplateCleanupCreatedFormIds(storage, ["form_1", "form_2"]);
    expect(readTemplateCleanupCreatedFormIds(storage)).toEqual(["form_1", "form_2"]);

    writeTemplateCleanupDismissedFormIds(storage, ["form_1"]);
    expect(readTemplateCleanupDismissedFormIds(storage)).toEqual(["form_1"]);
  });

  it("reads as empty from missing or corrupt storage instead of throwing", () => {
    expect(readTemplateCleanupCreatedFormIds(undefined)).toEqual([]);
    const corrupt = { getItem: () => "not json" };
    expect(readTemplateCleanupCreatedFormIds(corrupt)).toEqual([]);
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readTemplateCleanupCreatedFormIds(throwing)).toEqual([]);
    expect(() => writeTemplateCleanupCreatedFormIds(throwing, ["form_1"])).not.toThrow();
  });
});

describe("template cleanup checklist: raw reads and change notifications (#484 N2)", () => {
  it("readTemplateCleanupRaw and parseTemplateCleanupIdList agree with the storage-object readers", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    writeTemplateCleanupCreatedFormIds(storage, ["form_1", "form_2"]);
    const raw = readTemplateCleanupRaw(storage, "imsda-events:template-cleanup-checklist:created");
    expect(parseTemplateCleanupIdList(raw)).toEqual(["form_1", "form_2"]);
    expect(readTemplateCleanupRaw(undefined, "any-key")).toBeNull();
  });

  it("notifies subscribers on every write, so a same-tab useSyncExternalStore reader re-renders", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    let notifications = 0;
    const unsubscribe = subscribeTemplateCleanupChecklistChanges(() => { notifications += 1; });
    try {
      writeTemplateCleanupCreatedFormIds(storage, ["form_1"]);
      writeTemplateCleanupDismissedFormIds(storage, ["form_1"]);
      expect(notifications).toBe(2);
    } finally {
      unsubscribe();
    }
    // No notification once unsubscribed.
    writeTemplateCleanupCreatedFormIds(storage, ["form_1", "form_2"]);
    expect(notifications).toBe(2);
  });

  it("never notifies when the write is a no-op because storage is unavailable", () => {
    let notifications = 0;
    const unsubscribe = subscribeTemplateCleanupChecklistChanges(() => { notifications += 1; });
    try {
      writeTemplateCleanupCreatedFormIds(undefined, ["form_1"]);
      expect(notifications).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe("template cleanup checklist: inherited items", () => {
  it("lists one item per section and one item per field", () => {
    const items = buildTemplateCleanupChecklistItems(definition);
    expect(items).toEqual([
      { id: "section:s_contact", kind: "section", label: "Club & contact", sectionId: "s_contact" },
      { id: "field:f_club", kind: "field", label: "Pathfinder club", sectionId: "s_contact" },
      { id: "field:f_director", kind: "field", label: "Club director", sectionId: "s_contact" },
      { id: "section:s_roster", kind: "section", label: "Roster", sectionId: "s_roster" },
      { id: "field:f_name", kind: "field", label: "Name", sectionId: "s_roster" },
    ]);
  });

  it("reflects the current definition, so a removed field simply drops off the list", () => {
    const trimmed = { ...definition, sections: [definition.sections[0]] };
    const items = buildTemplateCleanupChecklistItems(trimmed);
    expect(items.some((item) => item.id === "section:s_roster")).toBe(false);
    expect(items.some((item) => item.id === "field:f_name")).toBe(false);
  });
});
