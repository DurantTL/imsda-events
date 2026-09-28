import type { RegistrationFormField } from "@/modules/forms/definition";

export type BuilderModuleCategory = "Common" | "People" | "Housing" | "Group event";

export type BuilderModuleDefinition = {
  key: string;
  category: BuilderModuleCategory;
  name: string;
  description: string;
  fields: Array<Omit<RegistrationFormField, "id">>;
};

export const promoCodeBuilderModule = {
  key: "promo_code",
  category: "Common" as const,
  name: "Promo code",
  description: "Apply an event discount with a clear Apply / Remove control",
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
 * age or birth date, gender, role, class, and skills/induction conditional
 * on role. Every field is a plain, individually editable field afterward —
 * nothing about the bundle is special once it's on the form, so an
 * event-specific difference (different roles, a renamed class list, dropping
 * gender) is just an ordinary field edit or removal.
 *
 * `attendee_type` is the same role-field key `roster-cards.ts` and
 * `roster-summary.ts` (#483) already look for, so the roster summary's role
 * counts and the attendee card's role label pick this field up automatically.
 * The class list uses the same eight Pathfinder class levels as the club
 * roster (`modules/club-rosters/domain.ts`) — exactly the radio-card
 * threshold (`RADIO_CARD_MAX_OPTIONS` in `modules/forms/choice-defaults.ts`).
 * The induction field's key/label matches the roster summary's induction
 * pattern (`/induct\w*|investiture/i`), so it's also counted there without
 * any extra wiring.
 */
export const rosterFieldBundleModule = {
  key: "roster_bundle",
  category: "People" as const,
  name: "Roster field bundle",
  description: "Name, age or birth date, gender, role, class, and skills/induction shown only for the matching role",
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
      helpText: "Change this field's type to Date to collect a birth date instead.",
      type: "NUMBER" as const,
      scope: "ATTENDEE" as const,
      required: false,
      options: [],
    },
    {
      key: "attendee_gender",
      label: "Gender",
      helpText: "",
      type: "RADIO" as const,
      scope: "ATTENDEE" as const,
      required: false,
      options: ["Female", "Male"],
    },
    {
      key: "attendee_type",
      label: "Role",
      helpText: "",
      type: "RADIO" as const,
      scope: "ATTENDEE" as const,
      required: true,
      options: ["Pathfinder", "Adventurer", "Staff"],
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
