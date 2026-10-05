import { DIRECTORY_NOT_LISTED_VALUE, registrationFormDefinitionSchema, type RegistrationFormField } from "@/modules/forms/definition";
import { attendeeAnswerRecord } from "@/modules/registrations/choice-answer-filter";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import { toCsv } from "@/modules/reporting/csv";

/**
 * The attendee listing (#784): one row per attendee, with meal, dietary,
 * childcare, volunteer and church answers, for the event's staff and a CSV that
 * matches the screen.
 *
 * Form answers resolve from each registration's OWN form definition, so an
 * event whose form lacks a question shows a blank, never a guess. A question
 * is found by its well-known key (the one the form templates and the WR26
 * import write: `meal_preference`, `dietary_needs`, `childcare_needed`,
 * `volunteer`, `church_name` / `church`), then by its label when the key is
 * absent. Nothing here is specific to one event. The page and the export both
 * require VIEW_SENSITIVE_DATA before calling this.
 */

export type ListingStatus = "CONFIRMED" | "SUBMITTED" | "CANCELLED";
export const LISTING_STATUSES: readonly ListingStatus[] = ["CONFIRMED", "SUBMITTED", "CANCELLED"];
export const DEFAULT_LISTING_STATUSES: readonly ListingStatus[] = ["CONFIRMED"];

export type MealCategory = "regular" | "vegetarian" | "vegan" | "gluten_free" | "other" | "none";
export const MEAL_CATEGORIES: ReadonlyArray<{ value: MealCategory; label: string }> = [
  { value: "regular", label: "Regular" },
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "gluten_free", label: "Gluten-free" },
  { value: "other", label: "Other" },
  { value: "none", label: "No answer" },
];

export type AttendeeListingRow = {
  registrationId: string;
  attendeeId: string;
  confirmationCode: string;
  status: string;
  name: string;
  attendeeType: string;
  church: string;
  mealPreference: string;
  mealCategory: MealCategory;
  dietaryNeeds: string;
  hasDietaryNeeds: boolean;
  childcareNeeded: string;
  volunteer: string;
  phone: string;
  accountHolderName: string;
  accountHolderEmail: string;
};

type Role = "meal" | "dietary" | "childcare" | "volunteer" | "church" | "churchOther";

const ROLE_KEYS: Record<Role, readonly string[]> = {
  meal: ["meal_preference"],
  dietary: ["dietary_needs"],
  childcare: ["childcare_needed"],
  volunteer: ["volunteer"],
  church: ["church_name", "church", "home_church"],
  churchOther: ["church_name_other", "church_other"],
};

/** Used only when no field carries a well-known key. */
const ROLE_LABELS: Partial<Record<Role, { pattern: RegExp; types: ReadonlySet<string> }>> = {
  meal: { pattern: /\bmeals?\b/i, types: new Set(["SELECT", "RADIO"]) },
  dietary: { pattern: /\b(?:dietary|diet|allerg)/i, types: new Set(["TEXT", "LONG_TEXT"]) },
  childcare: { pattern: /\bchild\s?care\b/i, types: new Set(["SELECT", "RADIO", "CHECKBOX"]) },
  volunteer: { pattern: /\bvolunteer/i, types: new Set(["SELECT", "RADIO", "CHECKBOX"]) },
  church: { pattern: /\bchurch\b/i, types: new Set(["SELECT", "RADIO", "TEXT"]) },
};

type Resolver = Partial<Record<Role, RegistrationFormField>>;
const resolverCache = new WeakMap<object, Resolver>();

function resolverFor(definition: Record<string, unknown> | null | undefined): Resolver {
  if (!definition) return {};
  const cached = resolverCache.get(definition);
  if (cached) return cached;
  const resolver: Resolver = {};
  const parsed = registrationFormDefinitionSchema.safeParse(definition);
  if (parsed.success) {
    const fields = parsed.data.sections.flatMap((section) => section.fields);
    for (const role of Object.keys(ROLE_KEYS) as Role[]) {
      const byKey = ROLE_KEYS[role].map((key) => fields.find((field) => field.key === key)).find(Boolean);
      const label = ROLE_LABELS[role];
      resolver[role] = byKey ?? (label
        ? fields.find((field) => label.types.has(field.type) && label.pattern.test(field.label) && !/\b(?:details?|notes?|how many|number)\b/i.test(field.label))
        : undefined);
    }
  }
  resolverCache.set(definition, resolver);
  return resolver;
}

/** A stored answer as people read it: the form's choice labels, several choices joined, blanks trimmed. */
function displayValue(field: RegistrationFormField | undefined, raw: unknown): string {
  if (!field) return "";
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map((value) => {
      if (typeof value === "boolean") return value ? "Yes" : "No";
      if (typeof value !== "string" && typeof value !== "number") return "";
      const text = String(value).trim();
      return field.optionLabels?.[text] ?? text;
    })
    .filter(Boolean)
    .join("; ");
}

export function mealCategoryOf(meal: string): MealCategory {
  const text = meal.trim().toLowerCase();
  if (!text) return "none";
  if (/gluten/.test(text)) return "gluten_free";
  if (/vegan/.test(text)) return "vegan";
  if (/vegetarian/.test(text)) return "vegetarian";
  if (/\b(?:standard|regular|no restrictions?|omnivore|everything)\b/.test(text)) return "regular";
  return "other";
}

const NO_DIETARY_NEEDS = /^(?:none|n\/?a|na|no|nil|nothing|-+|\.)\.?$/i;

export function hasDietaryNeeds(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && !NO_DIETARY_NEEDS.test(trimmed);
}

/** One row per attendee, in registration then roster order. Every registration status is kept; filter afterwards. */
export function buildAttendeeListingRows(registrations: readonly RegistrationRecord[]): AttendeeListingRow[] {
  const rows: AttendeeListingRow[] = [];
  for (const registration of registrations) {
    const submission = registration.publicSubmission;
    const resolver = resolverFor(submission?.definition);
    const registrationAnswers = (submission?.responses ?? {}) as Record<string, unknown>;
    const accountHolderName = `${registration.accountHolder.firstName} ${registration.accountHolder.lastName}`.trim();
    registration.attendees.forEach((attendee, index) => {
      const answers = attendeeAnswerRecord(registration, index);
      // The question may sit on the attendee or on the registration; the attendee's own answer wins.
      const answer = (role: Role) => {
        const field = resolver[role];
        if (!field) return "";
        const own = displayValue(field, answers[field.key]);
        return own || displayValue(field, registrationAnswers[field.key]);
      };
      let church = answer("church");
      if (!church || church === DIRECTORY_NOT_LISTED_VALUE || church === "Other") church = answer("churchOther");
      const mealPreference = answer("meal");
      const dietaryNeeds = answer("dietary");
      rows.push({
        registrationId: registration.id,
        attendeeId: attendee.id,
        confirmationCode: registration.confirmationCode,
        status: registration.status,
        name: `${attendee.firstName} ${attendee.lastName}`.trim(),
        attendeeType: attendee.attendeeType,
        church,
        mealPreference,
        mealCategory: mealCategoryOf(mealPreference),
        dietaryNeeds,
        hasDietaryNeeds: hasDietaryNeeds(dietaryNeeds),
        childcareNeeded: answer("childcare"),
        volunteer: answer("volunteer"),
        phone: attendee.phone ?? "",
        accountHolderName,
        accountHolderEmail: registration.accountHolder.email,
      });
    });
  }
  return rows;
}

export type ListingSortKey = Exclude<keyof AttendeeListingRow, "registrationId" | "attendeeId" | "mealCategory" | "hasDietaryNeeds">;
export const LISTING_COLUMNS: ReadonlyArray<{ key: ListingSortKey; label: string }> = [
  { key: "confirmationCode", label: "Confirmation code" },
  { key: "status", label: "Status" },
  { key: "name", label: "Attendee" },
  { key: "attendeeType", label: "Type" },
  { key: "church", label: "Church" },
  { key: "mealPreference", label: "Meal preference" },
  { key: "dietaryNeeds", label: "Dietary needs" },
  { key: "childcareNeeded", label: "Childcare needed" },
  { key: "volunteer", label: "Volunteer" },
  { key: "phone", label: "Phone" },
  { key: "accountHolderName", label: "Account holder" },
  { key: "accountHolderEmail", label: "Account holder email" },
];

export type AttendeeListingQuery = {
  statuses: ListingStatus[];
  meal: MealCategory | null;
  dietaryOnly: boolean;
  search: string;
  sort: ListingSortKey | null;
  direction: "asc" | "desc";
};

const SORT_KEYS: ReadonlySet<string> = new Set(LISTING_COLUMNS.map((column) => column.key));
const MEAL_VALUES: ReadonlySet<string> = new Set(MEAL_CATEGORIES.map((category) => category.value));

/**
 * The listing's filters from URL parameters. Anything unknown is ignored, so a
 * hand-edited URL cannot widen the list: statuses default to Confirmed only,
 * and Draft or Waitlisted can never be asked for.
 */
export function parseAttendeeListingQuery(params: URLSearchParams | Record<string, string | string[] | undefined>): AttendeeListingQuery {
  const all = (key: string): string[] => {
    if (params instanceof URLSearchParams) return params.getAll(key);
    const value = params[key];
    return Array.isArray(value) ? value : value === undefined ? [] : [value];
  };
  const get = (key: string) => all(key)[0] ?? "";
  // The page's checkboxes send one `statuses` parameter each; links carry a comma-separated list.
  const requested = all("statuses").flatMap((value) => value.split(",")).map((value) => value.trim().toUpperCase());
  const statuses = LISTING_STATUSES.filter((status) => requested.includes(status));
  const meal = get("meal");
  const sort = get("sort");
  return {
    statuses: statuses.length > 0 ? statuses : [...DEFAULT_LISTING_STATUSES],
    meal: MEAL_VALUES.has(meal) ? (meal as MealCategory) : null,
    dietaryOnly: get("dietary") === "1",
    search: get("q").trim().slice(0, 100),
    sort: SORT_KEYS.has(sort) ? (sort as ListingSortKey) : null,
    direction: get("dir") === "desc" ? "desc" : "asc",
  };
}

/** The query as URL parameters (defaults left out), for links, the form and the export button. */
export function attendeeListingParams(query: AttendeeListingQuery): URLSearchParams {
  const params = new URLSearchParams();
  const isDefault = query.statuses.length === DEFAULT_LISTING_STATUSES.length && query.statuses.every((status) => DEFAULT_LISTING_STATUSES.includes(status));
  if (!isDefault) params.set("statuses", query.statuses.join(","));
  if (query.meal) params.set("meal", query.meal);
  if (query.dietaryOnly) params.set("dietary", "1");
  if (query.search) params.set("q", query.search);
  if (query.sort) {
    params.set("sort", query.sort);
    if (query.direction === "desc") params.set("dir", "desc");
  }
  return params;
}

export function filterAttendeeListing(rows: readonly AttendeeListingRow[], query: AttendeeListingQuery): AttendeeListingRow[] {
  const needle = query.search.toLowerCase();
  const filtered = rows.filter((row) => {
    if (!query.statuses.includes(row.status as ListingStatus)) return false;
    if (query.meal && row.mealCategory !== query.meal) return false;
    if (query.dietaryOnly && !row.hasDietaryNeeds) return false;
    if (needle && !row.name.toLowerCase().includes(needle) && !row.confirmationCode.toLowerCase().includes(needle)) return false;
    return true;
  });
  if (!query.sort) return filtered;
  const key = query.sort;
  const factor = query.direction === "desc" ? -1 : 1;
  // Array.prototype.sort is stable, so equal values keep registration order.
  return filtered.sort((a, b) => factor * a[key].localeCompare(b[key], "en", { numeric: true, sensitivity: "base" }));
}

/** Count per meal type over the rows given (the filtered listing). */
export function mealTotals(rows: readonly AttendeeListingRow[]): Array<{ value: MealCategory; label: string; count: number }> {
  return MEAL_CATEGORIES.map((category) => ({ ...category, count: rows.filter((row) => row.mealCategory === category.value).length }));
}

export const ATTENDEE_LISTING_BOM = "﻿";

/** The CSV for exactly the rows shown, UTF-8 with a BOM so Excel opens it correctly. Cells are formula-escaped by `toCsv`. */
export function attendeeListingCsv(rows: readonly AttendeeListingRow[]): string {
  const table: Array<Array<string | number>> = [LISTING_COLUMNS.map((column) => column.label)];
  for (const row of rows) table.push(LISTING_COLUMNS.map((column) => row[column.key]));
  return ATTENDEE_LISTING_BOM + toCsv(table);
}
