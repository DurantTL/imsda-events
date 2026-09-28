/**
 * The templates staff may send to a chosen set, and their labels. Client-safe
 * (the selected-audience dialog imports it): never import a module that
 * reaches `node:` here (#550). `selected-audience.ts` re-exports these.
 */

/**
 * Templates staff may send to a chosen set. Deliberately short: each one
 * describes the registration as it already stands. A template that announces
 * a state change — a promotion, a cancellation, a transfer — is sent by the
 * operation that makes the change, never by hand at a selection, because an
 * email saying a place opened up is not true until one has.
 */
export const selectedAudienceTemplateKeys = [
  "BALANCE_REMINDER",
  "EVENT_ANNOUNCEMENT",
  "REGISTRATION_CONFIRMATION",
] as const;

export type SelectedAudienceTemplateKey =
  typeof selectedAudienceTemplateKeys[number];

export const selectedAudienceTemplateLabels:
  Readonly<Record<SelectedAudienceTemplateKey, string>> = {
  BALANCE_REMINDER: "Balance reminder",
  EVENT_ANNOUNCEMENT: "Event announcement",
  REGISTRATION_CONFIRMATION: "Send confirmation again",
};
