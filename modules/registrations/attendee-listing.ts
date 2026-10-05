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
 * is found by its well-known key only (see `LISTING_FIELD_KEYS`). Nothing
 * here is specific to one event. The page and the export both require
 * VIEW_SENSITIVE_DATA before calling this, and the free-text dietary answer
 * has a stricter gate (`canViewDietaryDetails`).
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

/**
 * Fields are found by the keys the built-in form templates and the WR26 import
 * write, and by nothing else. There is deliberately no label matching: a label
 * guess would pick up look-alikes (the Spring Camporee's `sponsoring_meals`,
 * `meal_times` and `meal_sponsorship_count` are about sponsoring meals, not an
 * attendee's meal). An event whose form uses another key shows a blank column
 * until the key is added here.
 */
export const LISTING_FIELD_KEYS: Record<Role, readonly string[]> = {
  meal: ["meal_preference"],
  dietary: ["dietary_needs", "dietary_restrictions"],
  childcare: ["childcare_needed"],
  volunteer: ["volunteer"],
  church: ["church_name", "church"],
  churchOther: ["church_name_other", "church_other"],
};

export type ResolvedListingFields = Partial<Record<Role, RegistrationFormField>>;

/** The field each column reads from one form definition, or nothing for a column the form lacks. */
export function resolveListingFields(definition: Record<string, unknown> | null | undefined): ResolvedListingFields {
  const resolved: ResolvedListingFields = {};
  const parsed = definition ? registrationFormDefinitionSchema.safeParse(definition) : null;
  if (!parsed?.success) return resolved;
  const fields = parsed.data.sections.flatMap((section) => section.fields);
  for (const role of Object.keys(LISTING_FIELD_KEYS) as Role[]) {
    for (const key of LISTING_FIELD_KEYS[role]) {
      const field = fields.find((candidate) => candidate.key === key);
      if (field) {
        resolved[role] = field;
        break;
      }
    }
  }
  return resolved;
}

/**
 * Who may read the free-text dietary answer (ADR 0005 Addendum C). Free text
 * is health-type: staff need VIEW_REPORTS and VIEW_SENSITIVE_DATA, and on a
 * club-audience event also VIEW_HEALTH_INFORMATION. Everyone else who can open
 * the listing sees only Yes or No. The page and the export both ask this one
 * function, and rows are built server-side with its answer, so hidden text is
 * never sent to the browser or written to a file.
 */
export function canViewDietaryDetails(input: { permissions: Iterable<string>; clubEvent: boolean }): boolean {
  const held = new Set(input.permissions);
  if (!held.has("VIEW_REPORTS") || !held.has("VIEW_SENSITIVE_DATA")) return false;
  return !input.clubEvent || held.has("VIEW_HEALTH_INFORMATION");
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
  // "Neither" answers a menu of "Vegan / Gluten Free / Both / Neither" (the TLT opportunities
  // form): no special meal, so Regular. "Both" stays Other: it is two categories at once.
  if (/\b(?:standard|regular|neither|no restrictions?|omnivore|everything)\b/.test(text)) return "regular";
  return "other";
}

export const NO_DIETARY_NEEDS = /^(?:none(?: needed)?|n\/?a|na|no(?: (?:dietary )?(?:restrictions?|needs?))?|neither|nil|nothing|-+|\.)\.?$/i;

export function hasDietaryNeeds(text: string): boolean {
  const parts = text.split(";").map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
  return parts.length > 0 && parts.some((part) => !NO_DIETARY_NEEDS.test(part));
}

export type BuildListingOptions = {
  /** From `canViewDietaryDetails`. When false the Dietary needs column holds only Yes or No. */
  showDietaryDetails: boolean;
};

/**
 * One row per attendee, in registration then roster order. Every registration
 * status is kept; filter afterwards.
 *
 * A field's own scope decides where its answer is read, with no fallback
 * between the two: ATTENDEE fields read that attendee's answers, REGISTRATION
 * fields read the registration's. A registration-level meal, dietary,
 * childcare or volunteer answer belongs to the registration, not to each
 * person, so it appears on the FIRST attendee's row only and is counted once.
 * A registration-level church describes everyone, so it is on every row. A
 * group registration (#650) is not tied to a church, so its Church is blank.
 */
export function buildAttendeeListingRows(registrations: readonly RegistrationRecord[], options: BuildListingOptions): AttendeeListingRow[] {
  const rows: AttendeeListingRow[] = [];
  // Records are serialized per registration, so cache by form version, not by object identity.
  const cache = new Map<string, ResolvedListingFields>();
  for (const registration of registrations) {
    const submission = registration.publicSubmission;
    let fields: ResolvedListingFields = {};
    if (submission?.definition) {
      const cacheKey = submission.formSlug && submission.versionNumber != null ? `${submission.formSlug}@${submission.versionNumber}` : null;
      const cached = cacheKey ? cache.get(cacheKey) : undefined;
      fields = cached ?? resolveListingFields(submission.definition);
      if (cacheKey && !cached) cache.set(cacheKey, fields);
    }
    const registrationAnswers = (submission?.responses ?? {}) as Record<string, unknown>;
    const accountHolderName = `${registration.accountHolder.firstName} ${registration.accountHolder.lastName}`.trim();
    registration.attendees.forEach((attendee, index) => {
      const answers = attendeeAnswerRecord(registration, index);
      const answer = (role: Role) => {
        const field = fields[role];
        if (!field) return "";
        if (field.scope === "ATTENDEE") return displayValue(field, answers[field.key]);
        // Registration-wide answers are per registration: first row only, except church.
        if (index > 0 && role !== "church" && role !== "churchOther") return "";
        return displayValue(field, registrationAnswers[field.key]);
      };
      let church = registration.isGroup ? "" : answer("church");
      if (!registration.isGroup && (!church || church === DIRECTORY_NOT_LISTED_VALUE || church === "Other")) church = answer("churchOther");
      const mealPreference = answer("meal");
      const dietaryAnswer = answer("dietary");
      const needs = hasDietaryNeeds(dietaryAnswer);
      let dietaryNeeds = "";
      if (fields.dietary && (index === 0 || fields.dietary.scope === "ATTENDEE")) {
        dietaryNeeds = options.showDietaryDetails ? dietaryAnswer : needs ? "Yes" : "No";
      }
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
        hasDietaryNeeds: needs,
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
