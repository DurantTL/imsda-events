import { describe, expect, it } from "vitest";
import {
  buildTemplateCleanupChecklistItems,
  isTemplateCleanupDismissed,
  parseTemplateCleanupCreatedRecords,
  parseTemplateCleanupIdList,
  readTemplateCleanupCreatedRecords,
  readTemplateCleanupDismissedFormIds,
  readTemplateCleanupRaw,
  shouldShowTemplateCleanupChecklist,
  subscribeTemplateCleanupChecklistChanges,
  templateCleanupCreatedFormIds,
  templateCleanupCreatedStorageKey,
  templateCleanupSnapshot,
  withTemplateCleanupCreated,
  withTemplateCleanupDismissed,
  writeTemplateCleanupCreatedRecords,
  writeTemplateCleanupDismissedFormIds,
  type TemplateCleanupSnapshot,
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

const snap: TemplateCleanupSnapshot = { sectionIds: [], fieldIds: [] };

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
  it("adds a form once and is idempotent, replacing an earlier record for the same form", () => {
    const once = withTemplateCleanupCreated([], { formId: "form_1", snapshot: snap });
    expect(once).toEqual([{ formId: "form_1", snapshot: snap }]);
    const snapshot = templateCleanupSnapshot(definition);
    expect(withTemplateCleanupCreated(once, { formId: "form_1", snapshot })).toEqual([{ formId: "form_1", snapshot }]);
  });

  it("dismissal never mutates the array passed in", () => {
    const original = ["form_1"];
    const next = withTemplateCleanupDismissed(original, "form_2");
    expect(original).toEqual(["form_1"]);
    expect(next).toEqual(["form_1", "form_2"]);
    expect(isTemplateCleanupDismissed(next, "form_2")).toBe(true);
  });

  it("bounds the remembered lists instead of growing without limit", () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ formId: `form_${index}`, snapshot: snap }));
    const next = templateCleanupCreatedFormIds(withTemplateCleanupCreated(many, { formId: "form_new", snapshot: snap }));
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
    const snapshot = templateCleanupSnapshot(definition);
    writeTemplateCleanupCreatedRecords(storage, [{ formId: "form_1", snapshot }, { formId: "form_2", snapshot: snap }]);
    expect(readTemplateCleanupCreatedRecords(storage)).toEqual([{ formId: "form_1", snapshot }, { formId: "form_2", snapshot: snap }]);

    writeTemplateCleanupDismissedFormIds(storage, ["form_1"]);
    expect(readTemplateCleanupDismissedFormIds(storage)).toEqual(["form_1"]);
  });

  it("reads as empty from missing or corrupt storage instead of throwing", () => {
    expect(readTemplateCleanupCreatedRecords(undefined)).toEqual([]);
    const corrupt = { getItem: () => "not json" };
    expect(readTemplateCleanupCreatedRecords(corrupt)).toEqual([]);
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readTemplateCleanupCreatedRecords(throwing)).toEqual([]);
    expect(() => writeTemplateCleanupCreatedRecords(throwing, [{ formId: "form_1", snapshot: snap }])).not.toThrow();
  });
});

describe("template cleanup checklist: raw reads and change notifications (#484 N2)", () => {
  it("readTemplateCleanupRaw and parseTemplateCleanupIdList agree with the storage-object readers", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    writeTemplateCleanupDismissedFormIds(storage, ["form_1", "form_2"]);
    const raw = readTemplateCleanupRaw(storage, "imsda-events:template-cleanup-checklist:dismissed");
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
      writeTemplateCleanupCreatedRecords(storage, [{ formId: "form_1", snapshot: snap }]);
      writeTemplateCleanupDismissedFormIds(storage, ["form_1"]);
      expect(notifications).toBe(2);
    } finally {
      unsubscribe();
    }
    // No notification once unsubscribed.
    writeTemplateCleanupCreatedRecords(storage, [{ formId: "form_1", snapshot: snap }, { formId: "form_2", snapshot: snap }]);
    expect(notifications).toBe(2);
  });

  it("never notifies when the write is a no-op because storage is unavailable", () => {
    let notifications = 0;
    const unsubscribe = subscribeTemplateCleanupChecklistChanges(() => { notifications += 1; });
    try {
      writeTemplateCleanupCreatedRecords(undefined, [{ formId: "form_1", snapshot: snap }]);
      expect(notifications).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe("template cleanup checklist: inherited items", () => {
  it("lists one item per section and one item per field", () => {
    const items = buildTemplateCleanupChecklistItems(definition, templateCleanupSnapshot(definition));
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
    const items = buildTemplateCleanupChecklistItems(trimmed, templateCleanupSnapshot(definition));
    expect(items.some((item) => item.id === "section:s_roster")).toBe(false);
    expect(items.some((item) => item.id === "field:f_name")).toBe(false);
  });
});

describe("template cleanup checklist: only the template's own sections and fields are inherited (#484 N3)", () => {
  const snapshot = templateCleanupSnapshot(definition);
  const added = {
    ...definition,
    sections: [
      { ...definition.sections[0], fields: [...definition.sections[0].fields, { ...definition.sections[0].fields[0], id: "f_added", key: "added_later", label: "Added later" }] },
      definition.sections[1],
      { id: "s_added", title: "Added section", description: "", fields: [{ ...definition.sections[1].fields[0], id: "f_added_2", key: "added_later_2", label: "Also added" }] },
    ],
  };

  it("snapshots every section and field id the form was created with", () => {
    expect(snapshot).toEqual({ sectionIds: ["s_contact", "s_roster"], fieldIds: ["f_club", "f_director", "f_name"] });
  });

  it("leaves out sections and fields added after creation", () => {
    const ids = buildTemplateCleanupChecklistItems(added, snapshot).map((item) => item.id);
    expect(ids).toEqual(["section:s_contact", "field:f_club", "field:f_director", "section:s_roster", "field:f_name"]);
  });

  it("still lists an inherited field the builder moved into a new section", () => {
    const moved = {
      ...definition,
      sections: [
        { ...definition.sections[0], fields: [definition.sections[0].fields[0]] },
        definition.sections[1],
        { id: "s_new", title: "New section", description: "", fields: [definition.sections[0].fields[1]] },
      ],
    };
    const items = buildTemplateCleanupChecklistItems(moved, snapshot);
    expect(items.find((item) => item.id === "field:f_director")?.sectionId).toBe("s_new");
    expect(items.some((item) => item.id === "section:s_new")).toBe(false);
  });

  it("drops a malformed created entry instead of guessing at it", () => {
    const raw = JSON.stringify([{ formId: "form_new", sectionIds: ["s_contact"], fieldIds: ["f_club"] }, 42, { formId: 7 }, { formId: "form_no_ids" }]);
    expect(parseTemplateCleanupCreatedRecords(raw)).toEqual([
      { formId: "form_new", snapshot: { sectionIds: ["s_contact"], fieldIds: ["f_club"] } },
    ]);
  });

  it("stores the snapshot with the created record under the existing key", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    writeTemplateCleanupCreatedRecords(storage, [{ formId: "form_1", snapshot }]);
    expect(JSON.parse(store.get(templateCleanupCreatedStorageKey)!)).toEqual([
      { formId: "form_1", sectionIds: ["s_contact", "s_roster"], fieldIds: ["f_club", "f_director", "f_name"] },
    ]);
  });
});
