import { DIRECTORY_NOT_LISTED_VALUE, localCalendarDate, type RegistrationFormDefinition, type RegistrationFormField } from "@/modules/forms/definition";
import { fullNameKeys, splitNameKeyPairs } from "@/modules/forms/public-domain";
import { shirtSizeOptions } from "@/modules/registrations/shirt-sizes";

export type BuilderModuleCategory = "Common" | "People" | "Housing" | "Group event";

/**
 * A module's own field. `coveredBy` lists key sets that, when every key in
 * one set is already on the form (on fields of the same scope), make this
 * field redundant for a `singleton` insert: it is skipped and the existing
 * fields are reported as reused. The first matching set wins.
 */
export type BuilderModuleField = Omit<RegistrationFormField, "id"> & { coveredBy?: string[][] };

/**
 * Key sets that already capture a person's name, in the same precedence the
 * roster name prefill uses (`attendeeNameKeys` in
 * `modules/club-registrations/domain.ts`): a first/last pair, then any
 * single full-name key.
 */
export const attendeeNameCoverage: string[][] = [
  ...splitNameKeyPairs.map((pair) => [pair.first, pair.last]),
  ...fullNameKeys.map((key) => [key]),
];

export type BuilderModuleDefinition = {
  key: string;
  category: BuilderModuleCategory;
  name: string;
  description: string;
  fields: BuilderModuleField[];
  /**
   * True when a module's field keys should never be key-suffixed (as
   * `promo_code` already did). Some modules are recognized elsewhere by
   * their exact field keys — the roster bundle's `attendee_type`/`gender`
   * are the #483 roster prefill/summary hooks — so a suffixed duplicate
   * would silently lose that wiring. A singleton is refused as "already on
   * the form" only when every one of its `presenceKeys` exists; otherwise
   * only the fields the form is missing (by key, or by `coveredBy`) are
   * inserted, and the existing fields are reused in place of the rest (see
   * `planModuleInsert`).
   */
  singleton?: boolean;
  /**
   * For a `singleton`: the field keys that, all present together, mark
   * this module as already on the form. Defaults to every one of its field
   * keys. The roster bundle
   * narrows this to its own distinctive keys, since the others
   * (`attendee_type`, `attendee_age`, `gender`, `attendee_name`) are common
   * on starter templates and other modules.
   */
  presenceKeys?: string[];
  /** True when inserting this module should also turn on the repeatable
   * attendee roster (as `guest_roster` already did), when it isn't already
   * on — including a roster that exists but is switched off
   * (`moduleAttendeeRoster`). */
  enablesAttendeeRoster?: boolean;
  /** The roster settings to turn on with `enablesAttendeeRoster`. Defaults
   * to the builder's own "Household or group" defaults (Attendee / Add
   * another attendee, up to 20) when omitted. */
  attendeeRosterDefaults?: { minAttendees: number; maxAttendees: number; attendeeLabel: string; addButtonLabel: string };
};

export const defaultModuleAttendeeRoster = { minAttendees: 1, maxAttendees: 20, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" };

export const promoCodeBuilderModule = {
  key: "promo_code",
  category: "Common" as const,
  name: "Promo code",
  description: "Apply an event discount with a clear Apply / Remove control",
  singleton: true,
  fields: [{
    key: "promo_code",
    label: "Promo code",
    helpText: "Enter a code supplied by the event team, then select Apply.",
    placeholder: "Enter code",
    type: "TEXT" as const,
    scope: "REGISTRATION" as const,
    required: false,
    options: [],
  }],
} satisfies BuilderModuleDefinition;

/**
 * The common per-attendee roster group (#484), inserted as one action: name,
 * age, gender, role, class, and skills/induction conditional on role. Every
 * field is a plain, individually editable field afterward — nothing about
 * the bundle is special once it's on the form, so an event-specific
 * difference (different roles, a renamed class list, dropping gender) is
 * just an ordinary field edit or removal.
 *
 * Only age, never a birth date: club registration refuses any form whose
 * fields read as a birth date (`birthDateFields` in
 * `modules/club-registrations/domain.ts`, ADR 0005 Addendum A — a birth date
 * is never written to registration answers, which aren't encrypted), so this
 * bundle offers no hint toward collecting one.
 *
 * `attendee_type` and `gender` are the same keys
 * `modules/club-registrations/domain.ts` (`rosterRolePrefill`,
 * `rosterGenderPrefill`) and `roster-cards.ts`/`roster-summary.ts` (#483)
 * already look for, so the roster prefill, mismatch prompt, role counts, and
 * attendee-card role label all pick these fields up automatically — as long
 * as the keys land unchanged, which is why this module is a `singleton`
 * rather than key-suffixed on a second insert. Role options match the
 * existing Spring Camporee / Honors Weekend "Roster role" templates
 * (`modules/forms/definition.ts`) so `rosterRolePrefill`'s type fallback
 * (Staff/Adult/Underage) still matches when a director's roster role is
 * blank or unrecognized.
 *
 * The class list uses the same eight Pathfinder class levels as the club
 * roster (`modules/club-rosters/domain.ts`). Eight is within the radio-card
 * threshold (`RADIO_CARD_MAX_OPTIONS`), so it is declared as RADIO here in
 * the data; inserting a module never rewrites a declared type.
 *
 * Most roster templates already carry some of these keys (Spring Camporee
 * and Honors Weekend have `attendee_age`, `gender` and `attendee_type`; the
 * "Attendee preferences" module adds `attendee_name` and `attendee_type`),
 * so the bundle is only "already on the form" when its own distinctive keys
 * (`presenceKeys`) exist. Otherwise it adds just the missing fields and its
 * skills/induction conditionals point at the form's existing role field.
 *
 * The induction field's key/label matches the roster summary's induction
 * pattern (`/induct\w*|investiture/i`), so it's also counted there without
 * any extra wiring.
 */
export const rosterFieldBundleModule = {
  key: "roster_bundle",
  category: "People" as const,
  name: "Roster field bundle",
  description: "Name, age, gender, role, class, and skills/induction shown only for the matching role",
  singleton: true,
  presenceKeys: ["attendee_class", "skills_in_progress"],
  enablesAttendeeRoster: true,
  attendeeRosterDefaults: { minAttendees: 1, maxAttendees: 50, attendeeLabel: "Attendee", addButtonLabel: "Add another attendee" },
  fields: [
    {
      key: "attendee_name",
      label: "Name",
      helpText: "",
      placeholder: "First and last name",
      type: "TEXT" as const,
      scope: "ATTENDEE" as const,
      required: true,
      options: [],
      // A roster that already has first/last name (Spring Camporee, Honors
      // Weekend) or a full-name field is prefilled from those; a second,
      // required Name field would stay blank and force retyping.
      coveredBy: attendeeNameCoverage,
    },
    {
      key: "attendee_age",
      label: "Age",
      helpText: "",
      type: "NUMBER" as const,
      scope: "ATTENDEE" as const,
      required: false,
      options: [],
    },
    {
      key: "gender",
      label: "Gender",
      helpText: "",
      type: "RADIO" as const,
      scope: "ATTENDEE" as const,
      required: false,
      options: ["Female", "Male"],
    },
    {
      key: "attendee_type",
      label: "Roster role",
      helpText: "",
      type: "RADIO" as const,
      scope: "ATTENDEE" as const,
      required: true,
      options: ["Pathfinder", "TLT", "Staff", "Child"],
    },
    {
      key: "attendee_class",
      label: "Current class",
      helpText: "",
      type: "RADIO" as const,
      scope: "ATTENDEE" as const,
      required: false,
      options: ["Friend", "Companion", "Explorer", "Ranger", "Voyager", "Guide", "TLT", "Master Guide"],
    },
    {
      key: "skills_in_progress",
      label: "Skills / honors in progress",
      helpText: "Shown only for a Pathfinder.",
      placeholder: "List skills, honors, or requirements this attendee is working on",
      type: "LONG_TEXT" as const,
      scope: "ATTENDEE" as const,
      required: false,
      options: [],
      conditional: { fieldKey: "attendee_type", operator: "EQUALS" as const, value: "Pathfinder" },
    },
    {
      key: "induction_ready",
      label: "Ready for induction / investiture",
      helpText: "Shown only for a Pathfinder.",
      type: "CHECKBOX" as const,
      scope: "ATTENDEE" as const,
      required: false,
      options: [],
      conditional: { fieldKey: "attendee_type", operator: "EQUALS" as const, value: "Pathfinder" },
    },
  ],
} satisfies BuilderModuleDefinition;

/**
 * The keys that show a `singleton` module is already on the form: its
 * `presenceKeys` (by default, all of its field keys), returned only when
 * every one of them is in use — otherwise an empty list. A singleton insert
 * is refused when this is non-empty. Promo code has one key, so this is the
 * same as "any" for it.
 */
export function moduleKeyCollisions(
  module: Pick<BuilderModuleDefinition, "fields" | "presenceKeys">,
  usedKeys: ReadonlySet<string>,
): string[] {
  const presenceKeys = module.presenceKeys ?? module.fields.map((field) => field.key);
  return presenceKeys.length > 0 && presenceKeys.every((key) => usedKeys.has(key)) ? [...presenceKeys] : [];
}

/** Maps each of a module's own field keys to the key it will actually use
 * once inserted — unchanged unless it collides with an already-used key on
 * the form, in which case it gets the next free `_2`, `_3`, … suffix. */
export function resolveModuleFieldKeyMap(
  module: Pick<BuilderModuleDefinition, "fields">,
  usedKeys: ReadonlySet<string>,
): Map<string, string> {
  const moduleKeys = new Map<string, string>();
  const used = new Set(usedKeys);
  for (const source of module.fields) {
    const baseKey = source.key;
    let key = baseKey;
    let suffix = 2;
    while (used.has(key)) { key = `${baseKey}_${suffix}`; suffix += 1; }
    used.add(key);
    moduleKeys.set(source.key, key);
  }
  return moduleKeys;
}

/**
 * The fields a module contributes once inserted: each gets a fresh id (from
 * `makeFieldId`), a collision-free key (remapped via
 * `resolveModuleFieldKeyMap`), and any `conditional`/`optionalWhen`
 * reference to another field in the *same* module is remapped to that
 * field's final key too, so an internal reference such as the roster
 * bundle's skills/induction fields pointing at its own role field survives a
 * key suffix. Module-only metadata (`coveredBy`) is dropped.
 *
 * Every field keeps the type its module declares. Choice-control size
 * defaults (#484) live in the module data itself and in the builder's
 * dismissible hint (`singleChoiceTypeHint`), never in an insert-time
 * rewrite.
 */
export function instantiateModuleFields(
  module: Pick<BuilderModuleDefinition, "fields">,
  usedKeys: ReadonlySet<string>,
  makeFieldId: () => string,
): RegistrationFormField[] {
  const moduleKeys = resolveModuleFieldKeyMap(module, usedKeys);
  return module.fields.map((source) => {
    const { coveredBy: _coveredBy, ...cloned } = structuredClone(source);
    void _coveredBy;
    const conditional = cloned.conditional
      ? { ...cloned.conditional, fieldKey: moduleKeys.get(cloned.conditional.fieldKey) ?? cloned.conditional.fieldKey }
      : undefined;
    const optionalWhen = cloned.optionalWhen
      ? { ...cloned.optionalWhen, fieldKey: moduleKeys.get(cloned.optionalWhen.fieldKey) ?? cloned.optionalWhen.fieldKey }
      : undefined;
    return { ...cloned, id: makeFieldId(), key: moduleKeys.get(source.key)!, conditional, optionalWhen };
  });
}

type ExistingFormField = Pick<RegistrationFormField, "key" | "label"> & Partial<Pick<RegistrationFormField, "scope" | "type" | "options" | "optionSource">>;

/** A reused field that a newly inserted field's condition can never match. */
export type ModuleConditionWarning = {
  controllerLabel: string;
  value: string;
  dependentLabels: string[];
};

export type ModuleInsertPlan =
  | {
    kind: "already-present";
    /** Existing form fields that mark the module as already there. */
    existingKeys: string[];
    /** Labels of those existing fields, for the notice. */
    existingLabels: string[];
  }
  | {
    kind: "insert";
    fields: RegistrationFormField[];
    /** Labels of the module fields being added. */
    addedLabels: string[];
    /** Labels of the form's existing fields reused instead of a module
     * field — by the same key, or by `coveredBy` ("First name and Last
     * name") — for singleton modules only. */
    reusedLabels: string[];
    /** Conditions on added fields that point at a reused field which can't
     * satisfy them (no such option, or options sourced from attendee
     * types). */
    conditionWarnings: ModuleConditionWarning[];
  };

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function labelFor(existingFields: readonly ExistingFormField[], key: string): string {
  return existingFields.find((field) => field.key === key)?.label ?? key;
}

function conditionWarnings(
  fields: readonly RegistrationFormField[],
  existingFields: readonly ExistingFormField[],
): ModuleConditionWarning[] {
  const warnings: ModuleConditionWarning[] = [];
  for (const field of fields) {
    const condition = field.conditional;
    if (!condition || (condition.operator !== "EQUALS" && condition.operator !== "INCLUDES")) continue;
    const controller = existingFields.find((candidate) => candidate.key === condition.fieldKey);
    if (!controller) continue;
    const satisfiable = !controller.optionSource && (controller.options ?? []).includes(condition.value);
    if (satisfiable) continue;
    const existing = warnings.find((warning) => warning.controllerLabel === controller.label && warning.value === condition.value);
    if (existing) existing.dependentLabels.push(field.label);
    else warnings.push({ controllerLabel: controller.label, value: condition.value, dependentLabels: [field.label] });
  }
  return warnings;
}

/**
 * Decides what inserting `module` into a form whose fields are
 * `existingFields` should do.
 *
 * - An ordinary module is always inserted whole, with any colliding key
 *   suffixed (`instantiateModuleFields`).
 * - A `singleton` whose `presenceKeys` are all on the form is refused as
 *   already present.
 * - Otherwise a singleton inserts only the fields the form is missing: a
 *   field is skipped when its key is already used, or when one of its
 *   `coveredBy` key sets is on the form in the same scope. The form's
 *   existing fields stand in for the skipped ones, so a
 *   `conditional`/`optionalWhen` that pointed at a skipped module field
 *   points at the existing field with that same key — and a condition that
 *   field can't satisfy is reported in `conditionWarnings`.
 */
export function planModuleInsert(
  module: Pick<BuilderModuleDefinition, "fields" | "singleton" | "presenceKeys">,
  existingFields: readonly ExistingFormField[],
  makeFieldId: () => string,
): ModuleInsertPlan {
  const usedKeys = new Set(existingFields.map((field) => field.key));
  if (!module.singleton) {
    const fields = instantiateModuleFields(module, usedKeys, makeFieldId);
    return { kind: "insert", fields, addedLabels: fields.map((field) => field.label), reusedLabels: [], conditionWarnings: [] };
  }
  const existingKeys = moduleKeyCollisions(module, usedKeys);
  if (existingKeys.length > 0) {
    return { kind: "already-present", existingKeys, existingLabels: existingKeys.map((key) => labelFor(existingFields, key)) };
  }
  const missing: BuilderModuleField[] = [];
  const reusedLabels: string[] = [];
  for (const field of module.fields) {
    if (usedKeys.has(field.key)) {
      reusedLabels.push(labelFor(existingFields, field.key));
      continue;
    }
    const scopedKeys = new Set(existingFields
      .filter((existing) => (existing.scope ?? "REGISTRATION") === field.scope)
      .map((existing) => existing.key));
    const cover = field.coveredBy?.find((keys) => keys.length > 0 && keys.every((key) => scopedKeys.has(key)));
    if (cover) {
      reusedLabels.push(joinLabels(cover.map((key) => labelFor(existingFields, key))));
      continue;
    }
    missing.push(field);
  }
  // Missing keys are, by definition, unused, so none of them is suffixed and
  // references to skipped keys stay on the existing field's key.
  const fields = instantiateModuleFields({ fields: missing }, usedKeys, makeFieldId);
  return {
    kind: "insert",
    fields,
    addedLabels: fields.map((field) => field.label),
    reusedLabels,
    conditionWarnings: conditionWarnings(fields, existingFields),
  };
}

/**
 * The notice to show after an insert that reused existing fields, naming
 * both what was added and what was skipped, plus a warning for any added
 * condition a reused field can't satisfy — or null when the whole module
 * was added and there's nothing to explain.
 */
export function moduleInsertNotice(plan: Extract<ModuleInsertPlan, { kind: "insert" }>): string | null {
  const parts: string[] = [];
  if (plan.reusedLabels.length > 0) {
    parts.push(plan.addedLabels.length > 0
      ? `Added ${joinLabels(plan.addedLabels)}; this form already had ${joinLabels(plan.reusedLabels)}.`
      : `This form already had ${joinLabels(plan.reusedLabels)}.`);
  }
  for (const warning of plan.conditionWarnings) {
    parts.push(`"${warning.controllerLabel}" has no "${warning.value}" option, so ${joinLabels(warning.dependentLabels)} won't show until you add one or change their condition.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The notice for a singleton that's already on the form, naming the
 * existing fields that show it. */
export function moduleAlreadyPresentNotice(
  module: Pick<BuilderModuleDefinition, "name">,
  plan: Extract<ModuleInsertPlan, { kind: "already-present" }>,
): string {
  return `This form already has its ${module.name} module (found ${joinLabels(plan.existingLabels)}).`;
}

/**
 * The attendee roster to use after inserting `module`: a module with
 * `enablesAttendeeRoster` turns the roster on — creating it from its
 * defaults when the form has none, or switching an existing but disabled
 * roster on while keeping its own min/max and labels. Any other module
 * leaves the roster as it is.
 */
export function moduleAttendeeRoster(
  current: RegistrationFormDefinition["attendeeRoster"],
  module: Pick<BuilderModuleDefinition, "key" | "enablesAttendeeRoster" | "attendeeRosterDefaults">,
): RegistrationFormDefinition["attendeeRoster"] {
  if (!module.enablesAttendeeRoster) return current;
  if (current) return current.enabled ? current : { ...current, enabled: true };
  return { enabled: true, ...(module.attendeeRosterDefaults ?? defaultModuleAttendeeRoster) };
}

/**
 * The builder's field module library. Each module's single-choice fields
 * are declared with the control the size default suggests
 * (`suggestedSingleChoiceType`: radio cards up to `RADIO_CARD_MAX_OPTIONS`
 * options, a searchable dropdown beyond), since inserting a module keeps
 * the declared type as is.
 */
export const builderFieldModules: BuilderModuleDefinition[] = [
  {
    key: "contact",
    category: "Common",
    name: "Contact details",
    description: "First name, last name, and email",
    fields: [
      { key: "first_name", label: "First name", helpText: "", placeholder: "First name", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { key: "last_name", label: "Last name", helpText: "", placeholder: "Last name", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { key: "email", label: "Email address", helpText: "Confirmation and edit details are sent here.", placeholder: "name@example.com", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
    ],
  },
  {
    key: "address",
    category: "Common",
    name: "Mailing address",
    description: "One accessible address field with street, city, state, postal code, and country",
    fields: [
      { key: "mailing_address", label: "Mailing address", helpText: "", type: "ADDRESS", scope: "REGISTRATION", required: true, options: [] },
    ],
  },
  {
    key: "church_club",
    category: "Group event",
    name: "Church & club contact",
    description: "Club, director, church, email, and phone",
    fields: [
      { key: "club_name", label: "Club name", helpText: "", placeholder: "Pathfinder club or group", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { key: "director_name", label: "Club director", helpText: "", placeholder: "Full name", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { key: "church_name", label: "Home church", helpText: "Start typing to search the IMSDA church directory.", type: "SELECT", scope: "REGISTRATION", required: true, options: [], optionSource: "CHURCHES_DIRECTORY" },
      { key: "church_other", label: "Home church — not listed", helpText: "", placeholder: "Church or organization name", type: "TEXT", scope: "REGISTRATION", required: true, options: [], conditional: { fieldKey: "church_name", operator: "EQUALS", value: DIRECTORY_NOT_LISTED_VALUE } },
      { key: "email", label: "Contact email", helpText: "", placeholder: "name@example.com", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
      { key: "phone", label: "Contact phone", helpText: "", placeholder: "Phone number", type: "PHONE", scope: "REGISTRATION", required: true, options: [] },
    ],
  },
  {
    key: "attendee",
    category: "People",
    name: "Attendee preferences",
    description: "Name, type, meal, and dietary needs",
    fields: [
      { key: "attendee_name", label: "Attendee name", helpText: "", placeholder: "First and last name", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { key: "attendee_type", label: "Attendee type", helpText: "", type: "RADIO", scope: "ATTENDEE", required: true, options: ["Adult", "Teen"] },
      { key: "meal_preference", label: "Meal preference", helpText: "", type: "RADIO", scope: "ATTENDEE", required: true, options: ["Regular", "Vegetarian", "Vegan", "Gluten-free"] },
      { key: "dietary_needs", label: "Dietary needs / allergies", helpText: "Optional notes for the retreat team.", placeholder: "Share any food allergies or accommodations", type: "LONG_TEXT", scope: "ATTENDEE", required: false, options: [] },
    ],
  },
  {
    key: "guest_roster",
    category: "People",
    name: "Guest roster",
    description: "Turn on a repeatable guest list with name, age, and type",
    enablesAttendeeRoster: true,
    attendeeRosterDefaults: { minAttendees: 1, maxAttendees: 20, attendeeLabel: "Guest", addButtonLabel: "Add another guest" },
    fields: [
      { key: "guest_name", label: "Guest name", helpText: "This block repeats for every person in the registration.", placeholder: "First and last name", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { key: "guest_age", label: "Guest age", helpText: "", type: "NUMBER", scope: "ATTENDEE", required: false, options: [] },
      { key: "guest_type", label: "Guest type", helpText: "", type: "RADIO", scope: "ATTENDEE", required: true, options: ["Adult", "Youth", "Child"] },
    ],
  },
  rosterFieldBundleModule,
  {
    key: "shirt_size",
    category: "People",
    name: "Convention shirt size",
    description: "Required shirt size repeated for each attendee",
    fields: [
      {
        key: "shirt_size",
        label: "T-shirt size",
        helpText: "Choose the size this attendee wants for the convention shirt. Registrants can reconfirm it from their private registration page.",
        type: "SELECT",
        scope: "ATTENDEE",
        required: true,
        options: [...shirtSizeOptions],
      },
    ],
  },
  {
    key: "housing",
    category: "Housing",
    name: "Housing & nights",
    description: "Capacity-aware lodging with stay details",
    fields: [
      { key: "housing_selection", label: "Housing selection", helpText: "Each housing option can have its own room or site limit.", type: "RADIO", scope: "REGISTRATION", required: true, options: ["Dorm room", "RV / camper site", "Tent campsite", "No housing needed"], availabilityMode: "CAPACITY", choiceLimits: {} },
      { key: "nights_staying", label: "Nights staying", helpText: "Select every night needed.", type: "MULTISELECT", scope: "REGISTRATION", required: true, options: ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], minSelections: 1, maxSelections: 5 },
      { key: "first_floor_needed", label: "First-floor accommodation needed?", helpText: "For health or mobility needs.", type: "RADIO", scope: "REGISTRATION", required: true, options: ["No", "Yes"] },
      { key: "rv_details", label: "RV / camper details", helpText: "Length and type if bringing an RV or camper.", placeholder: "For example: 28-foot travel trailer", type: "TEXT", scope: "REGISTRATION", required: false, options: [], conditional: { fieldKey: "housing_selection", operator: "EQUALS", value: "RV / camper site" } },
    ],
  },
  {
    key: "attendee_housing",
    category: "Housing",
    name: "Housing per attendee",
    description: "A room or lodging choice repeated for each person",
    fields: [
      { key: "attendee_housing", label: "Housing choice", helpText: "Each option can have its own room or bed limit.", type: "RADIO", scope: "ATTENDEE", required: true, options: ["Dorm room", "Shared cabin", "RV / camper", "No housing needed"], availabilityMode: "CAPACITY", choiceLimits: {} },
      { key: "roommate_request", label: "Roommate request", helpText: "Optional; requests are not guaranteed.", placeholder: "Name of requested roommate", type: "TEXT", scope: "ATTENDEE", required: false, options: [] },
      { key: "mobility_accommodation", label: "First-floor or mobility accommodation?", helpText: "", type: "RADIO", scope: "ATTENDEE", required: true, options: ["No", "Yes"] },
    ],
  },
  {
    key: "campsite",
    category: "Housing",
    name: "Campsite footprint",
    description: "Tents, trailers, canopy, size, and neighbor request",
    fields: [
      { key: "tents", label: "Tents and sizes", helpText: "", placeholder: "List quantities and sizes", type: "LONG_TEXT", scope: "REGISTRATION", required: false, options: [] },
      { key: "trailers", label: "Trailers", helpText: "", placeholder: "List trailers and lengths", type: "LONG_TEXT", scope: "REGISTRATION", required: false, options: [] },
      { key: "kitchen_canopy", label: "Kitchen canopy / size", helpText: "", placeholder: "Canopy dimensions", type: "TEXT", scope: "REGISTRATION", required: false, options: [] },
      { key: "total_sqft", label: "Total square feet", helpText: "Estimated campsite footprint.", type: "NUMBER", scope: "REGISTRATION", required: true, options: [] },
      { key: "camp_next_to", label: "Camp-next-to request", helpText: "Optional club or group name.", placeholder: "Club name", type: "TEXT", scope: "REGISTRATION", required: false, options: [] },
    ],
  },
  {
    key: "meal_tickets",
    category: "Group event",
    name: "Meal ticket quantities",
    description: "Adult and child counts by meal",
    fields: [
      { key: "breakfast_adult_qty", label: "Adult breakfast tickets", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [] },
      { key: "breakfast_child_qty", label: "Child breakfast tickets", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [] },
      { key: "lunch_adult_qty", label: "Adult lunch tickets", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [] },
      { key: "lunch_child_qty", label: "Child lunch tickets", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [] },
      { key: "supper_adult_qty", label: "Adult supper tickets", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [] },
      { key: "supper_child_qty", label: "Child supper tickets", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [] },
      { key: "dietary_restrictions", label: "Dietary restrictions or allergies", helpText: "", placeholder: "Optional notes", type: "LONG_TEXT", scope: "REGISTRATION", required: false, options: [] },
    ],
  },
  {
    key: "activity_slots",
    category: "Group event",
    name: "Activity signup",
    description: "Capacity-aware volunteer and activity slots",
    fields: [{ key: "activity_slots", label: "Activity or volunteer slots", helpText: "Each activity can have its own participation limit.", type: "MULTISELECT", scope: "REGISTRATION", required: false, options: ["Flag raising / lowering", "Bathroom clean-up", "Special music or skit", "Campfire singing", "Bring or lead a game"], minSelections: 1, maxSelections: 3, availabilityMode: "CAPACITY", choiceLimits: {} }],
  },
  {
    key: "seminar",
    category: "Group event",
    name: "Seminar ranking",
    description: "Two ranked choices with room limits",
    fields: [{ key: "seminar_preferences", label: "Seminar preferences", helpText: "Choose a first and second option.", type: "RANKED_CHOICE", scope: "ATTENDEE", required: true, options: ["Seminar A", "Seminar B", "Seminar C"], minSelections: 2, maxSelections: 2, availabilityMode: "RANKED_INTEREST", choiceLimits: {} }],
  },
  {
    key: "agreement",
    category: "Common",
    name: "Acknowledgment",
    description: "Required agreement checkbox",
    fields: [{ key: "acknowledgment", label: "Acknowledgment", helpText: "", placeholder: "Yes, I understand and agree.", type: "CHECKBOX", scope: "REGISTRATION", required: true, options: [] }],
  },
  {
    key: "scheduled_fee",
    category: "Common",
    name: "Scheduled registration fee",
    description: "Automatic standard and late-date pricing",
    fields: [{ key: "registration_fee", label: "Registration fee", helpText: "Automatically included in the order total.", type: "CALCULATED", scope: "REGISTRATION", required: false, options: [], priceCents: 0, latePricing: { startsOn: localCalendarDate(), label: "Late registration pricing", priceCents: 0 } }],
  },
  {
    key: "payment_method",
    category: "Common",
    name: "Payment methods",
    description: "Pay later and card choices without capacity counts",
    fields: [{ key: "payment_method", label: "Payment method", helpText: "Card processing fees apply only to card payments.", type: "RADIO", scope: "REGISTRATION", required: true, options: ["Pay later", "Credit / debit card"], availabilityMode: "NONE" }],
  },
  promoCodeBuilderModule,
  {
    key: "blank",
    category: "Common",
    name: "Blank field",
    description: "Start with a short-answer field",
    fields: [{ key: "new_field", label: "New field", helpText: "", placeholder: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [] }],
  },
];
