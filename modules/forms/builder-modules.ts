import { suggestedSingleChoiceType } from "@/modules/forms/choice-defaults";
import type { RegistrationFormField } from "@/modules/forms/definition";

export type BuilderModuleCategory = "Common" | "People" | "Housing" | "Group event";

export type BuilderModuleDefinition = {
  key: string;
  category: BuilderModuleCategory;
  name: string;
  description: string;
  fields: Array<Omit<RegistrationFormField, "id">>;
  /**
   * True when a second insert should be refused rather than key-suffixed
   * (as `promo_code` already did). Some modules are recognized elsewhere by
   * their exact field keys — the roster bundle's `attendee_type`/`gender`
   * are the #483 roster prefill/summary hooks — so a suffixed duplicate
   * would silently lose that wiring instead of visibly failing.
   */
  singleton?: boolean;
  /** True when inserting this module should also turn on the repeatable
   * attendee roster (as `guest_roster` already did), when it isn't already
   * on. */
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
 * roster (`modules/club-rosters/domain.ts`) — the class field's actual
 * control (radio cards vs. a searchable select) is decided by
 * `instantiateModuleFields` from that count at insertion time, the same as
 * every other field here, rather than hardcoded.
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

/** The keys of a module's own fields already present on the form — a second
 * insert of a `singleton` module is refused when this is non-empty. */
export function moduleKeyCollisions(
  module: Pick<BuilderModuleDefinition, "fields">,
  usedKeys: ReadonlySet<string>,
): string[] {
  return module.fields.map((field) => field.key).filter((key) => usedKeys.has(key));
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
 * key suffix.
 *
 * A RADIO or SELECT field with configured options (not one whose options
 * come from the event's attendee types) gets the size-appropriate default
 * control (`suggestedSingleChoiceType`, #484) applied at this, its moment of
 * creation — overriding whatever the module's own data declares — since
 * inserting a module is exactly a batch of fields being newly created.
 */
export function instantiateModuleFields(
  module: Pick<BuilderModuleDefinition, "fields">,
  usedKeys: ReadonlySet<string>,
  makeFieldId: () => string,
): RegistrationFormField[] {
  const moduleKeys = resolveModuleFieldKeyMap(module, usedKeys);
  return module.fields.map((source) => {
    const cloned = structuredClone(source);
    const conditional = cloned.conditional
      ? { ...cloned.conditional, fieldKey: moduleKeys.get(cloned.conditional.fieldKey) ?? cloned.conditional.fieldKey }
      : undefined;
    const optionalWhen = cloned.optionalWhen
      ? { ...cloned.optionalWhen, fieldKey: moduleKeys.get(cloned.optionalWhen.fieldKey) ?? cloned.optionalWhen.fieldKey }
      : undefined;
    const type = (!cloned.optionSource && (cloned.type === "RADIO" || cloned.type === "SELECT"))
      ? suggestedSingleChoiceType(cloned.options.length)
      : cloned.type;
    return { ...cloned, id: makeFieldId(), key: moduleKeys.get(source.key)!, type, conditional, optionalWhen };
  });
}
