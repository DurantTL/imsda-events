import type { ClubFormDraftSpec } from "@/modules/club-forms/builder-domain";
import { isChoiceFieldType, type RegistrationFormField } from "@/modules/forms/definition";

/**
 * Pure edits to a club form draft (#712), kept out of the builder component
 * so they can be tested without rendering. Every function returns a new spec
 * and never mutates its input. The server checks the result again; these only
 * keep the draft internally consistent (flags follow a renamed or removed field).
 */

export type FieldFlag = "required" | "staffOnly" | "sensitive" | "birthDate" | "hidden";

export function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function allKeys(spec: ClubFormDraftSpec) {
  return spec.definition.sections.flatMap((section) => section.fields.map((field) => field.key));
}

function nextFreeKey(spec: ClubFormDraftSpec, base = "question") {
  const taken = new Set(allKeys(spec));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${newId("k")}`;
}

export function newField(spec: ClubFormDraftSpec, type: RegistrationFormField["type"] = "TEXT"): RegistrationFormField {
  const key = nextFreeKey(spec);
  return {
    id: newId("field"),
    key,
    label: "New question",
    helpText: "",
    type,
    scope: "REGISTRATION",
    required: false,
    options: isChoiceFieldType(type) ? ["Option 1", "Option 2"] : [],
  };
}

export function addSection(spec: ClubFormDraftSpec): ClubFormDraftSpec {
  const field = newField(spec);
  const section = { id: newId("section"), title: "New section", description: "", fields: [field] };
  return { ...spec, definition: { ...spec.definition, sections: [...spec.definition.sections, section] } };
}

export function updateSection(spec: ClubFormDraftSpec, sectionId: string, patch: { title?: string; description?: string }): ClubFormDraftSpec {
  return {
    ...spec,
    definition: {
      ...spec.definition,
      sections: spec.definition.sections.map((section) => (section.id === sectionId ? { ...section, ...patch } : section)),
    },
  };
}

export function setSectionNotes(spec: ClubFormDraftSpec, sectionId: string, notes: string[]): ClubFormDraftSpec {
  const sectionNotes = { ...spec.sectionNotes };
  if (notes.length === 0) delete sectionNotes[sectionId];
  else sectionNotes[sectionId] = notes;
  return { ...spec, sectionNotes };
}

/** Moves an item one place; a move past either end changes nothing. */
export function moveItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function moveSection(spec: ClubFormDraftSpec, sectionId: string, direction: -1 | 1): ClubFormDraftSpec {
  const sections = spec.definition.sections;
  const index = sections.findIndex((section) => section.id === sectionId);
  return { ...spec, definition: { ...spec.definition, sections: moveItem(sections, index, direction) } };
}

export function moveField(spec: ClubFormDraftSpec, sectionId: string, fieldId: string, direction: -1 | 1): ClubFormDraftSpec {
  return {
    ...spec,
    definition: {
      ...spec.definition,
      sections: spec.definition.sections.map((section) => {
        if (section.id !== sectionId) return section;
        const index = section.fields.findIndex((field) => field.id === fieldId);
        return { ...section, fields: moveItem(section.fields, index, direction) };
      }),
    },
  };
}

export function addField(spec: ClubFormDraftSpec, sectionId: string): ClubFormDraftSpec {
  const field = newField(spec);
  return {
    ...spec,
    definition: {
      ...spec.definition,
      sections: spec.definition.sections.map((section) => (section.id === sectionId ? { ...section, fields: [...section.fields, field] } : section)),
    },
  };
}

export function updateField(spec: ClubFormDraftSpec, fieldId: string, patch: Partial<RegistrationFormField>): ClubFormDraftSpec {
  return {
    ...spec,
    definition: {
      ...spec.definition,
      sections: spec.definition.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => (field.id === fieldId ? normalizeField({ ...field, ...patch }) : field)),
      })),
    },
  };
}

/** Keeps type-specific settings consistent when a field's type or choices change. */
function normalizeField(field: RegistrationFormField): RegistrationFormField {
  const next: RegistrationFormField = { ...field };
  if (!isChoiceFieldType(next.type)) {
    next.options = [];
    delete next.optionSource;
  }
  if (next.type !== "MULTISELECT" && next.type !== "RANKED_CHOICE") {
    delete next.minSelections;
    delete next.maxSelections;
  } else if (next.maxSelections !== undefined && next.maxSelections > next.options.length) {
    next.maxSelections = Math.max(1, next.options.length);
  }
  if (isChoiceFieldType(next.type) && !next.optionSource && next.options.length === 0) next.options = ["Option 1", "Option 2"];
  return next;
}

function renameIn(keys: readonly string[], from: string, to: string) {
  return keys.map((key) => (key === from ? to : key));
}

/** Renames a field's key, and everything in the draft that names it. */
export function renameFieldKey(spec: ClubFormDraftSpec, fieldId: string, newKey: string): ClubFormDraftSpec {
  const old = spec.definition.sections.flatMap((section) => section.fields).find((field) => field.id === fieldId);
  if (!old || old.key === newKey) return spec;
  const oldKey = old.key;
  const retarget = <T extends { fieldKey: string } | undefined>(rule: T): T => (rule && rule.fieldKey === oldKey ? { ...rule, fieldKey: newKey } : rule);
  return {
    ...spec,
    definition: {
      ...spec.definition,
      sections: spec.definition.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => {
          const renamed = field.id === fieldId ? { ...field, key: newKey } : field;
          return { ...renamed, conditional: retarget(renamed.conditional), optionalWhen: retarget(renamed.optionalWhen) };
        }),
      })),
    },
    sensitiveFieldKeys: renameIn(spec.sensitiveFieldKeys, oldKey, newKey),
    birthDateFieldKeys: renameIn(spec.birthDateFieldKeys, oldKey, newKey),
    staffOnlyFieldKeys: renameIn(spec.staffOnlyFieldKeys, oldKey, newKey),
    hiddenFieldKeys: renameIn(spec.hiddenFieldKeys, oldKey, newKey),
  };
}

function without(keys: readonly string[], key: string) {
  return keys.filter((candidate) => candidate !== key);
}

function withKey(keys: readonly string[], key: string) {
  return keys.includes(key) ? [...keys] : [...keys, key];
}

/**
 * Turns a flag on or off for a field. Birth date implies sensitive; sensitive
 * and staff-only exclude each other. Whether a flag may be removed at all is
 * the server's rule (and the builder disables the box for a locked field).
 */
export function setFieldFlag(spec: ClubFormDraftSpec, fieldId: string, flag: FieldFlag, on: boolean): ClubFormDraftSpec {
  const field = spec.definition.sections.flatMap((section) => section.fields).find((candidate) => candidate.id === fieldId);
  if (!field) return spec;
  const key = field.key;
  if (flag === "required") return updateField(spec, fieldId, { required: on });
  let { sensitiveFieldKeys, birthDateFieldKeys, staffOnlyFieldKeys, hiddenFieldKeys } = spec;
  if (flag === "hidden") hiddenFieldKeys = on ? withKey(hiddenFieldKeys, key) : without(hiddenFieldKeys, key);
  if (flag === "staffOnly") {
    staffOnlyFieldKeys = on ? withKey(staffOnlyFieldKeys, key) : without(staffOnlyFieldKeys, key);
    if (on) {
      sensitiveFieldKeys = without(sensitiveFieldKeys, key);
      birthDateFieldKeys = without(birthDateFieldKeys, key);
    }
  }
  if (flag === "sensitive") {
    sensitiveFieldKeys = on ? withKey(sensitiveFieldKeys, key) : without(sensitiveFieldKeys, key);
    if (on) staffOnlyFieldKeys = without(staffOnlyFieldKeys, key);
    else birthDateFieldKeys = without(birthDateFieldKeys, key);
  }
  if (flag === "birthDate") {
    birthDateFieldKeys = on ? withKey(birthDateFieldKeys, key) : without(birthDateFieldKeys, key);
    if (on) {
      sensitiveFieldKeys = withKey(sensitiveFieldKeys, key);
      staffOnlyFieldKeys = without(staffOnlyFieldKeys, key);
    }
  }
  return { ...spec, sensitiveFieldKeys, birthDateFieldKeys, staffOnlyFieldKeys, hiddenFieldKeys };
}

/** Removes a field and its flags, and any rule that depended on it. */
export function removeField(spec: ClubFormDraftSpec, fieldId: string): ClubFormDraftSpec {
  const removed = spec.definition.sections.flatMap((section) => section.fields).find((field) => field.id === fieldId);
  if (!removed) return spec;
  const key = removed.key;
  const sections = spec.definition.sections
    .map((section) => ({
      ...section,
      fields: section.fields
        .filter((field) => field.id !== fieldId)
        .map((field) => ({
          ...field,
          conditional: field.conditional?.fieldKey === key ? undefined : field.conditional,
          optionalWhen: field.optionalWhen?.fieldKey === key ? undefined : field.optionalWhen,
        })),
    }))
    .filter((section) => section.fields.length > 0);
  const kept = new Set(sections.map((section) => section.id));
  return {
    ...spec,
    definition: { ...spec.definition, sections },
    sectionNotes: Object.fromEntries(Object.entries(spec.sectionNotes).filter(([id]) => kept.has(id))),
    sensitiveFieldKeys: without(spec.sensitiveFieldKeys, key),
    birthDateFieldKeys: without(spec.birthDateFieldKeys, key),
    staffOnlyFieldKeys: without(spec.staffOnlyFieldKeys, key),
    hiddenFieldKeys: without(spec.hiddenFieldKeys, key),
  };
}

export function removeSection(spec: ClubFormDraftSpec, sectionId: string): ClubFormDraftSpec {
  const section = spec.definition.sections.find((candidate) => candidate.id === sectionId);
  if (!section) return spec;
  return section.fields.reduce((next, field) => removeField(next, field.id), spec);
}

export function sectionNotesFromText(text: string) {
  return text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

export function optionsFromText(text: string) {
  return [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))];
}

export function specSignature(spec: ClubFormDraftSpec) {
  return JSON.stringify(spec);
}
