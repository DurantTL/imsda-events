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
  isDraftExcludedField,
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
