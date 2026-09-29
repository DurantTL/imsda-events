import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  PUBLIC_DRAFT_RESTORED_NOTICE,
  PUBLIC_DRAFT_TTL_MS,
  PUBLIC_DRAFT_VERSION_CHANGED_NOTICE,
  clearPublicDraft,
  draftExcludedKeys,
  draftsAllowed,
  isDraftExcludedField,
  mergeDraftAttendees,
  shouldPersistDraft,
  loadPublicDraft,
  publicDraftKey,
  savePublicDraft,
  type DraftStorage,
} from "@/modules/forms/public-draft";

const base = { helpText: "", options: [] as string[] };
const definition = registrationFormDefinitionSchema.parse({
  title: "Synthetic retreat form", description: "Synthetic.", confirmationMessage: "Received.",
  payment: { enabled: true, currency: "USD", paymentMethodFieldKey: "payment_method", cardOptionValue: "Credit / debit card", percentageBasisPoints: 290, fixedFeeCents: 30, passFeeToRegistrant: true },
  sections: [{ id: "details", title: "Details", description: "", fields: [
    { ...base, id: "contact_field", key: "contact_name", label: "Contact name", type: "TEXT", scope: "REGISTRATION", required: true },
    { ...base, id: "email_field", key: "email", label: "Email", type: "EMAIL", scope: "REGISTRATION", required: true },
    { ...base, id: "insurance_field", key: "insurance_carrier", label: "Insurance carrier", type: "TEXT", scope: "REGISTRATION", required: false },
    { ...base, id: "pay_field", key: "payment_method", label: "Payment method", type: "RADIO", scope: "REGISTRATION", required: true, options: ["Pay later", "Credit / debit card"] },
    { ...base, id: "first_field", key: "first_name", label: "First name", type: "TEXT", scope: "ATTENDEE", required: true },
    { ...base, id: "birth_field", key: "birth_date", label: "Birth date", type: "DATE", scope: "ATTENDEE", required: false },
    { ...base, id: "med_field", key: "medical_notes", label: "Medical notes", type: "LONG_TEXT", scope: "ATTENDEE", required: false },
    { ...base, id: "shirt_field", key: "shirt_size", label: "Shirt size", type: "SELECT", scope: "ATTENDEE", required: false, options: ["S", "M", "L"] },
  ] }],
});

const identity = { eventSlug: "synthetic-retreat", formSlug: "main", versionId: "version-1" };
const now = new Date("2026-09-29T12:00:00Z");
const content = {
  responses: { contact_name: "Avery Guest", email: "guest@example.test", insurance_carrier: "Synthetic Mutual", payment_method: "Credit / debit card" },
  attendees: [{ clientId: "a1", responses: { first_name: "Blake", birth_date: "1990-01-01", medical_notes: "synthetic note", shirt_size: "M" } }],
};

class FakeStorage implements DraftStorage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

describe("public form browser drafts (#574)", () => {
  it("restores saved answers", () => {
    const storage = new FakeStorage();
    savePublicDraft(storage, identity, definition, content, now);
    const result = loadPublicDraft(storage, identity, definition, new Date(now.getTime() + 60_000));
    expect(result.status).toBe("restored");
    if (result.status !== "restored") return;
    expect(result.draft.responses).toEqual({ contact_name: "Avery Guest", email: "guest@example.test" });
    expect(result.draft.attendees).toEqual([{ clientId: "a1", responses: { first_name: "Blake", shirt_size: "M" } }]);
    expect(PUBLIC_DRAFT_RESTORED_NOTICE).toBe("We restored your answers from earlier.");
  });

  it("is keyed by event, form and version", () => {
    const keys = new Set([
      publicDraftKey(identity),
      publicDraftKey({ ...identity, eventSlug: "other" }),
      publicDraftKey({ ...identity, formSlug: "other" }),
      publicDraftKey({ ...identity, versionId: "version-2" }),
    ]);
    expect(keys.size).toBe(4);
  });

  it("discard clears the draft so it is not restored again", () => {
    const storage = new FakeStorage();
    savePublicDraft(storage, identity, definition, content, now);
    clearPublicDraft(storage, identity);
    expect(storage.length).toBe(0);
    expect(loadPublicDraft(storage, identity, definition, now).status).toBe("none");
  });

  it("clears on successful submit (the same clear the form calls) and saving an empty form removes it", () => {
    const storage = new FakeStorage();
    savePublicDraft(storage, identity, definition, content, now);
    clearPublicDraft(storage, identity);
    expect(storage.getItem(publicDraftKey(identity))).toBeNull();
    savePublicDraft(storage, identity, definition, content, now);
    savePublicDraft(storage, identity, definition, { responses: { contact_name: "  " }, attendees: [] }, now);
    expect(storage.length).toBe(0);
  });

  it("expires after 14 days", () => {
    const storage = new FakeStorage();
    savePublicDraft(storage, identity, definition, content, now);
    const almost = new Date(now.getTime() + PUBLIC_DRAFT_TTL_MS - 1000);
    expect(loadPublicDraft(storage, identity, definition, almost).status).toBe("restored");
    const expired = new Date(now.getTime() + PUBLIC_DRAFT_TTL_MS + 1000);
    expect(loadPublicDraft(storage, identity, definition, expired).status).toBe("none");
    expect(storage.length).toBe(0);
  });

  it("ignores a draft from another form version and says so", () => {
    const storage = new FakeStorage();
    savePublicDraft(storage, { ...identity, versionId: "version-0" }, definition, content, now);
    const result = loadPublicDraft(storage, identity, definition, now);
    expect(result).toEqual({ status: "version-changed" });
    expect(storage.length).toBe(0);
    expect(loadPublicDraft(storage, identity, definition, now).status).toBe("none");
    expect(PUBLIC_DRAFT_VERSION_CHANGED_NOTICE).toBe("The form changed since you started. Please re-enter your answers.");
  });

  it("never stores payment, insurance, medical or birth-date answers", () => {
    const storage = new FakeStorage();
    savePublicDraft(storage, identity, definition, content, now);
    const raw = storage.getItem(publicDraftKey(identity)) ?? "";
    for (const secret of ["Synthetic Mutual", "Credit / debit card", "synthetic note", "1990-01-01", "insurance_carrier", "payment_method", "medical_notes", "birth_date"]) {
      expect(raw).not.toContain(secret);
    }
    const excluded = (key: string, label: string, type: "TEXT" | "DATE" = "TEXT") => isDraftExcludedField({ key, label, type }, definition);
    expect(excluded("payment_method", "How will you pay?")).toBe(true);
    expect(excluded("card_number", "Card number")).toBe(true);
    expect(excluded("dob", "DOB")).toBe(true);
    expect(excluded("first_name", "First name")).toBe(false);
  });

  it("drops keys that are not in the form even if a stored draft contains them", () => {
    const storage = new FakeStorage();
    storage.setItem(publicDraftKey(identity), JSON.stringify({
      format: 1, versionId: "version-1", savedAt: now.getTime(),
      responses: { contact_name: "Avery", payment_method: "Credit / debit card", website: "spam" }, attendees: [],
    }));
    const result = loadPublicDraft(storage, identity, definition, now);
    expect(result.status === "restored" && result.draft.responses).toEqual({ contact_name: "Avery" });
  });

  it("survives corrupt data and storage that throws", () => {
    const storage = new FakeStorage();
    storage.setItem(publicDraftKey(identity), "{not json");
    expect(loadPublicDraft(storage, identity, definition, now).status).toBe("none");
    expect(storage.length).toBe(0);
    const throwing: DraftStorage = {
      length: 0,
      key: () => { throw new Error("blocked"); },
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(() => savePublicDraft(throwing, identity, definition, content, now)).not.toThrow();
    expect(() => clearPublicDraft(throwing, identity)).not.toThrow();
    expect(loadPublicDraft(throwing, identity, definition, now).status).toBe("none");
    expect(loadPublicDraft(null, identity, definition, now).status).toBe("none");
  });

  it("renders the form normally when browser storage is unavailable (server render)", () => {
    const html = renderToStaticMarkup(createElement(PublicRegistrationForm, {
      event: { name: "Synthetic Retreat", slug: "synthetic-retreat", startsAt: "2026-10-09T00:00:00.000Z", endsAt: "2026-10-11T00:00:00.000Z", timezone: "America/Chicago", location: null, capacity: null, billingMode: "ATTENDEE_PAY" },
      form: { slug: "main", versionId: "version-1", versionNumber: 1, definition },
      choiceUsage: {},
      pricingDate: "2026-09-29",
      lifecycle: { phase: "OPEN", capacityDecision: "REGISTER", remainingSpots: null, waitingRegistrations: 0 },
    }));
    expect(html).toContain("Contact name");
    expect(html).not.toContain(PUBLIC_DRAFT_RESTORED_NOTICE);
  });
});

describe("draft exclusion rule (#574 review)", () => {
  type T = "TEXT" | "EMAIL" | "LONG_TEXT" | "SELECT" | "RADIO" | "CHECKBOX" | "ADDRESS" | "DATE" | "NUMBER" | "CALCULATED" | "MULTISELECT";
  const excluded = (key: string, label: string, type: T, scope: "REGISTRATION" | "ATTENDEE", required = false, extra: Record<string, unknown> = {}) =>
    isDraftExcludedField({ key, label, type, scope, required, ...extra }, definition);

  it("blocks health, insurance and note style fields even when they are short text or choices", () => {
    expect(excluded("accommodations", "Accommodations", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("current_meds", "Current medications", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("provider", "Healthcare provider", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("insurer", "Insurer", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("medicalNotes", "Notes", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("epipen", "Carries an EpiPen", "RADIO", "REGISTRATION")).toBe(true);
    expect(excluded("pickup_person", "Authorized pickup", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("extra", "Anything we should know?", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("session_health", "Health screening session", "SELECT", "ATTENDEE")).toBe(true);
  });

  it("blocks long text, address, consent checkboxes and required checkboxes", () => {
    expect(excluded("attendee_notes", "Attendee notes", "LONG_TEXT", "ATTENDEE")).toBe(true);
    expect(excluded("comments", "Comments", "LONG_TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("home", "Home", "ADDRESS", "REGISTRATION")).toBe(true);
    expect(excluded("photo_consent", "Photo consent", "CHECKBOX", "REGISTRATION")).toBe(true);
    expect(excluded("ack", "I understand", "CHECKBOX", "REGISTRATION", true)).toBe(true);
    expect(excluded("newsletter", "Send me news", "CHECKBOX", "REGISTRATION")).toBe(false);
  });

  it("allows only name, type, shirt and non-health choice fields for attendees", () => {
    expect(excluded("first_name", "First name", "TEXT", "ATTENDEE")).toBe(false);
    expect(excluded("attendee_type", "Type", "SELECT", "ATTENDEE")).toBe(false);
    expect(excluded("shirt_size", "Shirt size", "SELECT", "ATTENDEE")).toBe(false);
    expect(excluded("workshop", "Workshop session", "SELECT", "ATTENDEE", false, { choiceLimits: { A: 10 } })).toBe(false);
    expect(excluded("lodging", "Lodging", "RADIO", "ATTENDEE", false, { choicePricesCents: { Dorm: 5000 } })).toBe(false);
    expect(excluded("kind", "Kind", "SELECT", "ATTENDEE", false, { optionSource: "ATTENDEE_TYPES" })).toBe(false);
    expect(excluded("workshop", "Workshop session", "SELECT", "ATTENDEE")).toBe(true);
    expect(excluded("t_pref", "Preference", "RADIO", "ATTENDEE")).toBe(true);
    expect(excluded("nickname", "Nickname", "TEXT", "ATTENDEE")).toBe(true);
    expect(excluded("attendee_age", "Age", "NUMBER", "ATTENDEE")).toBe(true);
    expect(excluded("gender", "Gender", "SELECT", "ATTENDEE")).toBe(true);
    expect(excluded("phone", "Phone", "TEXT", "ATTENDEE")).toBe(true);
  });

  it("blocks the reviewed labels and plain-text address parts", () => {
    expect(excluded("diabetic", "Diabetic?", "RADIO", "REGISTRATION")).toBe(true);
    expect(excluded("limits", "Physical limitations", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("ec", "Emergency contact", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("pp", "Parent phone", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("veg", "Vegetarian", "CHECKBOX", "REGISTRATION")).toBe(true);
    expect(excluded("more", "Is there anything else we should know", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("street_line", "Street", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("zip_code", "ZIP", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("email", "Email address", "EMAIL", "REGISTRATION")).toBe(false);
  });

  it("keeps registration contact answers", () => {
    expect(excluded("contact_name", "Contact name", "TEXT", "REGISTRATION")).toBe(false);
    expect(excluded("email", "Email", "TEXT", "REGISTRATION")).toBe(false);
  });
});

describe("draft gating (#574 review)", () => {
  it("does not save before an edit, after submit, or before restore has run", () => {
    const on = { enabled: true, ready: true, dirty: true, submitted: false };
    expect(shouldPersistDraft(on)).toBe(true);
    expect(shouldPersistDraft({ ...on, dirty: false })).toBe(false);
    expect(shouldPersistDraft({ ...on, ready: false })).toBe(false);
    expect(shouldPersistDraft({ ...on, submitted: true })).toBe(false);
    expect(shouldPersistDraft({ ...on, enabled: false })).toBe(false);
  });

  it("has no drafts when signed in or any prefill is present", () => {
    expect(draftsAllowed({ prefill: [{}, {}] })).toBe(true);
    expect(draftsAllowed({ prefill: [{ email: "guest@example.test" }, {}] })).toBe(false);
    expect(draftsAllowed({ prefill: [{}, { first_name: "Avery" }] })).toBe(false);
    expect(draftsAllowed({ signedIn: true, prefill: [{}, {}] })).toBe(false);
  });

  it("renders no draft notice in club mode or with prefill", () => {
    const common = {
      event: { name: "Synthetic Retreat", slug: "synthetic-retreat", startsAt: "2026-10-09T00:00:00.000Z", endsAt: "2026-10-11T00:00:00.000Z", timezone: "America/Chicago", location: null, capacity: null, billingMode: "ATTENDEE_PAY" as const },
      form: { slug: "main", versionId: "version-1", versionNumber: 1, definition },
      choiceUsage: {},
      pricingDate: "2026-09-29",
      lifecycle: { phase: "OPEN" as const, capacityDecision: "REGISTER" as const, remainingSpots: null, waitingRegistrations: 0 },
    };
    const club = renderToStaticMarkup(createElement(PublicRegistrationForm, {
      ...common,
      club: { initialAttendees: [{ clientId: "c1", responses: { first_name: "Blake" } }], lockedAttendeeFieldKeys: [], submitUrl: "/api/club/test" },
    }));
    expect(club).not.toContain(PUBLIC_DRAFT_RESTORED_NOTICE);
    expect(club).not.toContain("public-registration-draft-notice");
    const prefilled = renderToStaticMarkup(createElement(PublicRegistrationForm, {
      ...common, initialResponses: { email: "guest@example.test" },
    }));
    expect(prefilled).not.toContain("public-registration-draft-notice");
  });
});

describe("restore details (#574 review)", () => {
  it("merges draft attendees over the initial roster", () => {
    const initial = [{ clientId: "initial-attendee-1", responses: { first_name: "Seed", last_name: "Prefill" } }];
    const merged = mergeDraftAttendees(initial, [
      { clientId: "initial-attendee-1", responses: { first_name: "Blake" } },
      { clientId: "extra-1", responses: { first_name: "Casey" } },
    ]);
    expect(merged).toEqual([
      { clientId: "initial-attendee-1", responses: { first_name: "Blake", last_name: "Prefill" } },
      { clientId: "extra-1", responses: { first_name: "Casey" } },
    ]);
    expect(mergeDraftAttendees(initial, [])).toBe(initial);
  });

  it("never persists an idempotency key, so a later page load starts a fresh submission", () => {
    const storage = new FakeStorage();
    const key = "9f8f0f3a-4c73-4d7e-89a4-f54d4fe0c388";
    savePublicDraft(storage, identity, definition, { ...content, idempotencyKey: key } as typeof content, now);
    expect(storage.getItem(publicDraftKey(identity)) ?? "").not.toContain(key);
    const result = loadPublicDraft(storage, identity, definition, now);
    expect(result.status === "restored" && "idempotencyKey" in result.draft).toBe(false);
  });

  it("drops excluded attendee keys from a tampered draft on restore", () => {
    const storage = new FakeStorage();
    storage.setItem(publicDraftKey(identity), JSON.stringify({
      format: 1, versionId: "version-1", savedAt: now.getTime(),
      responses: { contact_name: "Avery", insurance_carrier: "Synthetic Mutual" },
      attendees: [{ clientId: "a1", responses: { first_name: "Blake", birth_date: "1990-01-01", medical_notes: "synthetic note", shirt_size: "M" } }],
    }));
    const result = loadPublicDraft(storage, identity, definition, now);
    expect(result.status).toBe("restored");
    if (result.status !== "restored") return;
    expect(result.draft.responses).toEqual({ contact_name: "Avery" });
    expect(result.draft.attendees).toEqual([{ clientId: "a1", responses: { first_name: "Blake", shirt_size: "M" } }]);
  });

  it("only announces a version change when a valid, unexpired draft was dropped", () => {
    const storage = new FakeStorage();
    savePublicDraft(storage, { ...identity, versionId: "version-0" }, definition, content, now);
    const later = new Date(now.getTime() + PUBLIC_DRAFT_TTL_MS + 1000);
    expect(loadPublicDraft(storage, identity, definition, later).status).toBe("none");
    expect(storage.length).toBe(0);
    storage.setItem(publicDraftKey({ ...identity, versionId: "version-0" }), "{corrupt");
    expect(loadPublicDraft(storage, identity, definition, now).status).toBe("none");
  });
});

describe("draft review round 3 (#574)", () => {
  const excluded = (key: string, label: string, type: "TEXT" | "SELECT" | "RADIO" | "CHECKBOX", scope: "REGISTRATION" | "ATTENDEE", extra: Record<string, unknown> = {}) =>
    isDraftExcludedField({ key, label, type, scope, required: false, ...extra }, definition);

  it("does not treat empty pricing objects (Quick choices preset) as paid or limited", () => {
    const preset = { choicePricesCents: {}, choiceLimits: {}, latePricing: { startsOn: "2026-10-01", label: "Late", choicePricesCents: {} } };
    expect(excluded("session_pick", "Session", "RADIO", "ATTENDEE", preset)).toBe(true);
    expect(excluded("photo_ok", "Photo permission", "RADIO", "ATTENDEE", preset)).toBe(true);
    expect(excluded("meal_pref", "Meal preference", "SELECT", "ATTENDEE", { choicePricesCents: {} })).toBe(true);
    expect(excluded("meal_pref", "Meal preference", "SELECT", "REGISTRATION", { choicePricesCents: {} })).toBe(true);
    expect(excluded("food_pick", "Food", "RADIO", "REGISTRATION")).toBe(true);
    expect(excluded("workshop", "Workshop", "SELECT", "ATTENDEE", { priceCents: 0 })).toBe(true);
  });

  it("still saves genuinely priced or limited attendee choices", () => {
    expect(excluded("workshop", "Workshop", "SELECT", "ATTENDEE", { priceCents: 500 })).toBe(false);
    expect(excluded("workshop", "Workshop", "SELECT", "ATTENDEE", { choicePricesCents: { A: 0, B: 500 } })).toBe(false);
    expect(excluded("workshop", "Workshop", "SELECT", "ATTENDEE", { choiceLimits: { A: 5 } })).toBe(false);
    expect(excluded("workshop", "Workshop", "SELECT", "ATTENDEE", { availabilityMode: "RANKED_INTEREST" })).toBe(false);
    expect(excluded("workshop", "Workshop", "SELECT", "ATTENDEE", { latePricing: { startsOn: "2026-10-01", label: "Late", priceCents: 100 } })).toBe(false);
  });

  it("excludes D.O.B. style birth-date labels and keys", () => {
    expect(excluded("d_o_b", "Date", "TEXT", "REGISTRATION")).toBe(true);
    expect(excluded("when", "D.O.B.", "TEXT", "REGISTRATION")).toBe(true);
  });

  const conditional = registrationFormDefinitionSchema.parse({
    title: "Synthetic", description: "Synthetic.", confirmationMessage: "Received.",
    sections: [{ id: "sec", title: "Section", description: "", fields: [
      { ...base, id: "f_name", key: "contact_name", label: "Contact name", type: "TEXT", scope: "REGISTRATION", required: true },
      { ...base, id: "f_flag", key: "any_flag", label: "Any medical conditions?", type: "RADIO", scope: "REGISTRATION", required: false, options: ["No", "Yes"] },
      { ...base, id: "f_desc", key: "flag_more", label: "Please describe", type: "TEXT", scope: "REGISTRATION", required: false, conditional: { fieldKey: "any_flag", operator: "EQUALS", value: "Yes" } },
      { ...base, id: "f_desc2", key: "flag_more_detail", label: "Further detail", type: "TEXT", scope: "REGISTRATION", required: false, conditional: { fieldKey: "flag_more", operator: "NOT_EMPTY", value: "" } },
      { ...base, id: "f_pref", key: "contact_pref", label: "Contact preference", type: "RADIO", scope: "REGISTRATION", required: false, options: ["Email", "Phone"] },
      { ...base, id: "f_phone", key: "best_phone", label: "Best phone", type: "TEXT", scope: "REGISTRATION", required: false, conditional: { fieldKey: "contact_pref", operator: "EQUALS", value: "Phone" } },
    ] }],
  });

  it("excludes follow-ups of an excluded question, through a chain", () => {
    const keys = draftExcludedKeys(conditional);
    expect(keys.has("any_flag")).toBe(true);
    expect(keys.has("flag_more")).toBe(true);
    expect(keys.has("flag_more_detail")).toBe(true);
    expect(keys.has("best_phone")).toBe(false);
    const storage = new FakeStorage();
    savePublicDraft(storage, identity, conditional, {
      responses: { contact_name: "Avery", any_flag: "Yes", flag_more: "synthetic detail", flag_more_detail: "chained detail" },
      attendees: [],
    }, now);
    const raw = storage.getItem(publicDraftKey(identity)) ?? "";
    expect(raw).toContain("Avery");
    for (const leaked of ["synthetic detail", "chained detail", "any_flag", "flag_more"]) expect(raw).not.toContain(leaked);
  });

  it("handles conditional cycles without hanging", () => {
    const cyclic = registrationFormDefinitionSchema.parse({
      title: "Synthetic", description: "Synthetic.", confirmationMessage: "Received.",
      sections: [{ id: "sec", title: "Section", description: "", fields: [
        { ...base, id: "cyc_a", key: "cycle_a", label: "Alpha", type: "TEXT", scope: "REGISTRATION", required: false, conditional: { fieldKey: "cycle_b", operator: "NOT_EMPTY", value: "" } },
        { ...base, id: "cyc_b", key: "cycle_b", label: "Beta", type: "TEXT", scope: "REGISTRATION", required: false, conditional: { fieldKey: "cycle_a", operator: "NOT_EMPTY", value: "" } },
      ] }],
    });
    expect(draftExcludedKeys(cyclic).size).toBe(0);
  });

  it("drops hidden conditional answers on restore", () => {
    const storage = new FakeStorage();
    storage.setItem(publicDraftKey(identity), JSON.stringify({
      format: 1, versionId: "version-1", savedAt: now.getTime(),
      responses: { contact_name: "Avery", contact_pref: "Email", best_phone: "555-0100" }, attendees: [],
    }));
    const result = loadPublicDraft(storage, identity, conditional, now);
    expect(result.status === "restored" && result.draft.responses).toEqual({ contact_name: "Avery", contact_pref: "Email" });
  });
});
