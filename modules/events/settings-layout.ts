/**
 * Layout of the event settings form (#743): which collapsible blocks it has,
 * which block owns each field (so an error or a "Go to ..." link can open the
 * right one), and the one-line summary a collapsed block shows. Pure, so the
 * workspace and its tests agree.
 *
 * Which blocks show for an event type is decided by `resolveSectionPlacement`
 * in `settings-sections.ts`; this file only adds what each block is called and
 * holds.
 */

export const settingsBlockIds = ["basics", "timing", "options", "public-info", "lodging", "more"] as const;
export type SettingsBlockId = (typeof settingsBlockIds)[number];

export const settingsBlockTitles: Record<SettingsBlockId, string> = {
  basics: "Event basics",
  timing: "Registration timing & waitlist",
  options: "Registration options",
  "public-info": "Public information & help",
  lodging: "Lodging",
  more: "More settings",
};

/** The jump-link label, kept short. */
export const settingsBlockJumpLabels: Record<SettingsBlockId, string> = {
  basics: "Basics",
  timing: "Timing",
  options: "Options",
  "public-info": "Public info",
  lodging: "Lodging",
  more: "More settings",
};

/** The DOM id of a block's `<details>`, the target of its jump link. */
export const settingsBlockDomId = (id: SettingsBlockId) => `event-settings-block-${id}`;

/** The block that holds each settings field, by the schema key the server reports. */
export const settingsFieldBlock: Record<string, SettingsBlockId> = {
  name: "basics",
  slug: "basics",
  startsOn: "basics",
  endsOn: "basics",
  timezone: "basics",
  location: "basics",
  capacity: "basics",
  registrationOpensOn: "timing",
  registrationClosesOn: "timing",
  waitlistEnabled: "timing",
  autoPromoteWaitlist: "timing",
  audience: "timing",
  billingMode: "timing",
  attendeeEditPolicy: "options",
  approvedPaymentInstructions: "options",
  seminarPreferenceClosesOn: "options",
  seminarPreferenceSelfServiceLocked: "options",
  collectsShirtSizes: "options",
  checksAdultBackgrounds: "options",
  hostedPaymentLinkEnabled: "options",
  publicInfoUrl: "public-info",
  supportContact: "public-info",
  tagline: "public-info",
  subtitle: "public-info",
  helpEmail: "public-info",
  hotelName: "lodging",
  hotelBookingUrl: "lodging",
  hotelPhone: "lodging",
  hotelGroupName: "lodging",
  hotelRate: "lodging",
  hotelInstructions: "lodging",
};

const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The DOM id of a settings field's control. */
export const settingsFieldDomId = (key: string) => `event-field-${kebab(key)}`;

/** The DOM id of a settings field's error message. */
export const settingsFieldErrorId = (key: string) => `${settingsFieldDomId(key)}-error`;

/**
 * The block a control id lives in (a `settingsFieldDomId`, which is also what
 * the readiness checklist's "Go to ..." links target), or null.
 */
export function blockForControlId(controlId: string): SettingsBlockId | null {
  const key = Object.keys(settingsFieldBlock).find((candidate) => settingsFieldDomId(candidate) === controlId);
  return key ? settingsFieldBlock[key] : null;
}

export type SettingsFieldIssue = { path?: ReadonlyArray<string | number>; message?: string };

/** The first field-level error per settings field, from the issues the API returned. */
export function fieldErrorsFromIssues(issues: readonly SettingsFieldIssue[] | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues ?? []) {
    const key = typeof issue.path?.[0] === "string" ? issue.path[0] : "";
    if (key && key in settingsFieldBlock && !errors[key]) errors[key] = issue.message ?? "Check this value.";
  }
  return errors;
}

/** The first of these field errors, in form order. */
export function firstFieldWithError(errors: Record<string, string>): { block: SettingsBlockId; key: string } | null {
  const keys = Object.keys(errors).filter((key) => key in settingsFieldBlock);
  if (keys.length === 0) return null;
  const order = (key: string) => settingsBlockIds.indexOf(settingsFieldBlock[key]);
  const first = [...keys].sort((left, right) => order(left) - order(right))[0];
  return { block: settingsFieldBlock[first], key: first };
}

type HotelValues = {
  hotelName?: string | null;
  hotelBookingUrl?: string | null;
  hotelPhone?: string | null;
  hotelGroupName?: string | null;
  hotelRate?: string | null;
  hotelInstructions?: string | null;
};

const text = (value: string | null | undefined) => (value ?? "").trim();

/** A blank hotel section reads "No hotel set"; a filled one names the hotel and rate. */
export function hotelSummary(values: HotelValues): string {
  const name = text(values.hotelName);
  const others = [values.hotelBookingUrl, values.hotelPhone, values.hotelGroupName, values.hotelRate, values.hotelInstructions];
  if (!name) {
    return others.some((value) => text(value))
      ? "Hotel name missing, so the details below are unused"
      : "No hotel set";
  }
  const rate = text(values.hotelRate);
  return rate ? `${name} · ${rate}` : name;
}

type SummaryValues = HotelValues & {
  name?: string;
  startsOn?: string;
  endsOn?: string;
  location?: string | null;
  registrationOpensOn?: string | null;
  registrationClosesOn?: string | null;
  waitlistEnabled?: boolean;
  audience?: string;
  supportContact?: string | null;
  publicInfoUrl?: string | null;
};

const join = (parts: Array<string | null | undefined | false>) => parts.filter((part): part is string => Boolean(part)).join(" · ");

/** The one-line summary a collapsed block shows under its title. */
export function blockSummary(id: SettingsBlockId, values: SummaryValues, extra?: { count?: number }): string {
  switch (id) {
    case "basics":
      return join([
        text(values.name) || "No name yet",
        values.startsOn && values.endsOn ? `${values.startsOn} to ${values.endsOn}` : values.startsOn || "No dates yet",
        text(values.location),
      ]);
    case "timing":
      return join([
        values.registrationOpensOn ? `Opens ${values.registrationOpensOn}` : "Opens when published",
        values.registrationClosesOn ? `closes ${values.registrationClosesOn}` : "no closing date",
        values.waitlistEnabled ? "Waitlist on" : "Waitlist off",
        values.audience === "CLUB" ? "Club or church event" : "General event",
      ]);
    case "options": {
      const count = extra?.count ?? 0;
      return `${count} setting${count === 1 ? "" : "s"} for this kind of event`;
    }
    case "public-info":
      return join([
        text(values.supportContact) ? `Support: ${text(values.supportContact)}` : "No support contact yet",
        text(values.publicInfoUrl) ? "IMSDA.org page linked" : "",
      ]);
    case "lodging":
      return hotelSummary(values);
    case "more": {
      const count = extra?.count ?? 0;
      return `${count} setting${count === 1 ? "" : "s"} that do not apply to this kind of event`;
    }
  }
}

/** Save-status wording shown at the top and in the save bar. */
export function saveStatusLabel(state: { saving: boolean; dirty: boolean }): "Saving…" | "Changes not saved" | "No unsaved changes" {
  if (state.saving) return "Saving…";
  return state.dirty ? "Changes not saved" : "No unsaved changes";
}

/**
 * The block a field is actually shown in: a setting that does not apply to the
 * event's type is placed under "More settings", so its error flag and its open
 * state belong to that block, not the one it normally lives in.
 */
export function effectiveBlockForField(key: string, moved: { optionsInMore: (key: string) => boolean; lodgingInMore: boolean }): SettingsBlockId | null {
  const base = settingsFieldBlock[key];
  if (!base) return null;
  if (base === "options" && moved.optionsInMore(key)) return "more";
  if (base === "lodging" && moved.lodgingInMore) return "more";
  return base;
}

/** Which settings section (see `settings-sections.ts`) owns each option field. */
export const optionFieldSection = {
  attendeeEditPolicy: "attendee-edit-policy",
  approvedPaymentInstructions: "payment-instructions",
  seminarPreferenceClosesOn: "seminar-preferences",
  seminarPreferenceSelfServiceLocked: "seminar-preferences",
  collectsShirtSizes: "shirt-sizes",
  checksAdultBackgrounds: "adult-background-checks",
  hostedPaymentLinkEnabled: "hosted-payment-link",
} as const;

/** Returns the id to focus once, and clears it: a later change to the errors never moves focus. */
export function takePendingFocus(ref: { current: string | null }): string | null {
  const id = ref.current;
  ref.current = null;
  return id;
}
