/**
 * Published forms that look the same to the public (#720). The public event
 * page lists every published form by its own title and description, so two
 * published forms sharing both leave a visitor no way to tell them apart.
 * Pure and client-safe: the builder, the readiness checks, and the public page
 * all decide "same" the same way.
 */

export const DUPLICATE_PUBLIC_FORMS_MESSAGE =
  "Two forms look the same to the public. Rename one or unpublish it.";

type PublicFormLook = { title: string; description?: string | null };

function normalize(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The public title and description, folded so spacing and case never hide a duplicate. */
export function publicFormLookKey(form: PublicFormLook) {
  return `${normalize(form.title)}\u0000${normalize(form.description)}`;
}

/**
 * Groups of two or more forms sharing a public title and description. Pass
 * only published forms: a draft or withdrawn form is never shown publicly.
 */
export function duplicatePublicFormGroups<T extends PublicFormLook>(forms: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const form of forms) {
    const key = publicFormLookKey(form);
    groups.set(key, [...(groups.get(key) ?? []), form]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

type DifferentiableForm = {
  name: string;
  title: string;
  description: string;
  audienceLabel: string;
  highlights: readonly string[];
};

function fold(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Cards that would render identically get a neutral differentiator: the
 * form's internal name when it differs and is unique, else its place in the
 * group. Never an ID or a link. A card that already differs in any visible
 * way gets none. Index-aligned with `forms`.
 */
export function publicFormDifferentiators<T extends DifferentiableForm>(forms: readonly T[]): (string | null)[] {
  const signature = (form: T) => [form.title, form.description, form.audienceLabel, ...form.highlights].map(fold).join("\u0000");
  const groups = new Map<string, number[]>();
  forms.forEach((form, index) => {
    const key = signature(form);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const result: (string | null)[] = forms.map(() => null);
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const nameCounts = new Map<string, number>();
    for (const index of indexes) {
      const name = fold(forms[index]!.name);
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    indexes.forEach((index, position) => {
      const form = forms[index]!;
      const name = fold(form.name);
      result[index] = name && name !== fold(form.title) && nameCounts.get(name) === 1
        ? `Form name: ${form.name.trim()}`
        : `Option ${position + 1} of ${indexes.length}`;
    });
  }
  return result;
}
