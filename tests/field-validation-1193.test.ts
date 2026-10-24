import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/x",
}));

import { AttendeeRegistrationAnswersForm } from "@/components/attendee-registration-answers-form";
import { ChurchPastorContact } from "@/components/church-pastor-contact";
import { RosterGuardianFields } from "@/components/roster-guardian-fields";
import { StaffInvitationQuestions } from "@/components/staff-invitation-questions";
import { PHONE_FIELD_MESSAGE, resolvePhoneChange } from "@/lib/field-validation";
import { parseAlertRecipients } from "@/modules/club-forms/alert-recipients";
import { guardianEmailProblem, guardianInputSchema } from "@/modules/club-rosters/guardians-domain";
import { checkContactBlockData, parseBlockData } from "@/modules/events/content-schemas";
import { messagingSettingsInputSchema } from "@/modules/communications/schemas";
import { registrationFormDefinitionSchema, typedFieldNote } from "@/modules/forms/definition";
import { pastorContactInputSchema } from "@/modules/organizations/contacts-schemas";
import { invitationRegistrationSchema } from "@/modules/staff-invitations/domain";
import { normalizeTypedAnswers } from "@/modules/forms/definition";
import { checkPartyAnswers } from "@/modules/staff-invitations/event-questions";

/** #1193 (the #855 leftovers): synthetic data only; no assertion lets a submitted value into a message. */
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const BAD_PHONE = "idk-call-me";
const BAD_EMAIL = "not an email";
const GOOD_PHONE = "515 555 0134";
const STORED_PHONE = "(515) 555-0134";

describe("phone grandfathering with the shared helpers (#871, used by #1193)", () => {
  it("passes a blank, normalises a changed valid phone, and rejects a changed bad one without echoing it", () => {
    expect(resolvePhoneChange("  ", undefined)).toEqual({ ok: true, value: "" });
    expect(resolvePhoneChange(GOOD_PHONE, undefined)).toEqual({ ok: true, value: STORED_PHONE });
    const bad = resolvePhoneChange(BAD_PHONE, undefined);
    expect(bad).toMatchObject({ ok: false });
    expect(JSON.stringify(bad)).not.toContain(BAD_PHONE);
  });

  it("keeps an unchanged old value exactly as stored, decided from the stored value only", () => {
    expect(resolvePhoneChange(` ${BAD_PHONE} `, BAD_PHONE)).toEqual({ ok: true, value: BAD_PHONE });
    expect(resolvePhoneChange(BAD_PHONE, "some other stored value")).toMatchObject({ ok: false });
    expect(resolvePhoneChange(BAD_PHONE, null)).toMatchObject({ ok: false });
  });
});

describe("roster emergency contact inputs (#1193)", () => {
  const markup = renderToStaticMarkup(createElement(RosterGuardianFields, { errors: {}, guardianState: "ready", records: undefined }));
  const tagFor = (name: string) => markup.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";

  it("gives phones a phone keypad and autofill and emails an email keypad, keeping the names", () => {
    for (const slot of [1, 2]) {
      const phone = tagFor(`g${slot}Phone`);
      expect(phone).toContain('type="tel"');
      expect(phone).toContain('inputMode="tel"');
      expect(phone).toContain('autoComplete="tel"');
      const email = tagFor(`g${slot}Email`);
      expect(email).toContain('type="email"');
      expect(email).toContain('inputMode="email"');
      expect(email).toContain('autoComplete="email"');
    }
  });

  it("does the same in the add-from-form dialog and keeps its literal names", () => {
    const source = read("components/club-form-roster-add.tsx");
    expect(source).toMatch(/autoComplete="tel"[^>]*inputMode="tel"[^>]*name=\{`g\$\{slot\}Phone`\}[^>]*type="tel"/);
    expect(source).toMatch(/autoComplete="email"[^>]*inputMode="email"[^>]*name=\{`g\$\{slot\}Email`\}[^>]*type="email"/);
  });

  it("checks email with the shared validator, so a lookalike the old pattern let through is refused", () => {
    expect(guardianEmailProblem("parent@example.test")).toBeNull();
    expect(guardianEmailProblem("a@b.c")).not.toBeNull();
    expect(guardianEmailProblem("two words@example.test")).not.toBeNull();
    const parsed = guardianInputSchema.safeParse({ name: "Pat", relationship: "Parent", email: BAD_EMAIL, phone: "" });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain(BAD_EMAIL);
    expect(read("modules/club-rosters/guardians-domain.ts")).not.toContain("EMAIL_PATTERN");
  });
});

describe("church pastor contact (#1193)", () => {
  it("validates the email with the shared check and keeps the phone as typed for the repository to resolve", () => {
    expect(pastorContactInputSchema.parse({ name: "Pat Pastor", email: "Pastor@Example.test", phone: GOOD_PHONE })).toEqual({ name: "Pat Pastor", email: "pastor@example.test", phone: GOOD_PHONE });
    const bad = pastorContactInputSchema.safeParse({ name: "Pat", email: BAD_EMAIL });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).not.toContain(BAD_EMAIL);
  });

  it("leaves a phone that fails as typed for the repository to judge against the stored contact", () => {
    expect(pastorContactInputSchema.parse({ name: "Pat", phone: BAD_PHONE }).phone).toBe(BAD_PHONE);
  });

  it("shows the phone check inline on the form", () => {
    const source = read("components/church-pastor-contact.tsx");
    expect(source).toContain('inlinePhoneProblem("Phone", phone');
    expect(source).toContain('inlineFieldProblem("Email", "email"');
    expect(source).toContain('inputMode="tel"');
    expect(renderToStaticMarkup(createElement(ChurchPastorContact, { organizationId: "church-1", active: null, history: [] }))).toContain('type="tel"');
  });
});

describe("staff invitation phone and answers (#1193)", () => {
  const person = { firstName: "Ada", lastName: "Synthetic" };

  it("stores a valid phone in one form, allows none, and rejects a bad one without echoing it", () => {
    expect(invitationRegistrationSchema.parse({ ...person, phone: GOOD_PHONE }).phone).toBe(STORED_PHONE);
    expect(invitationRegistrationSchema.parse(person).phone).toBe("");
    const bad = invitationRegistrationSchema.safeParse({ ...person, phone: BAD_PHONE });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe(PHONE_FIELD_MESSAGE);
    expect(JSON.stringify(bad.error?.issues)).not.toContain(BAD_PHONE);
  });

  const definition = registrationFormDefinitionSchema.parse({
    title: "Staff fixture",
    description: "Fictitious.",
    confirmationMessage: "Done.",
    sections: [{
      id: "about_you",
      title: "About you",
      description: "",
      fields: [
        { id: "f_cell", key: "cell", label: "Cell phone", helpText: "", type: "PHONE", scope: "ATTENDEE", required: false, options: [] },
        { id: "f_mail", key: "backup_email", label: "Backup email", helpText: "", type: "EMAIL", scope: "ATTENDEE", required: false, options: [] },
      ],
    }],
  });

  it("stores a typed phone answer in one form and rejects a bad one without echoing it", () => {
    const good = checkPartyAnswers(definition, [{ cell: GOOD_PHONE }], 1);
    expect(good.problems).toEqual([]);
    expect(good.answers[0].cell).toBe(STORED_PHONE);
    const bad = checkPartyAnswers(definition, [{ cell: BAD_PHONE, backup_email: BAD_EMAIL }], 1);
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(JSON.stringify(bad.problems)).not.toContain(BAD_PHONE);
    expect(JSON.stringify(bad.problems)).not.toContain(BAD_EMAIL);
  });

  it("asks phone and email questions with the right keypad and autofill, and flags a bad answer once it is left", () => {
    const questions = definition.sections[0].fields.map((field) => ({ ...field }));
    const markup = renderToStaticMarkup(createElement(StaffInvitationQuestions, { idPrefix: "you", personLabel: "you", questions, answers: { cell: BAD_PHONE }, onChange: () => {} }));
    expect(markup).toMatch(/<input[^>]*type="tel"/);
    expect(markup).toContain('autoComplete="tel"');
    expect(markup).toContain('inputMode="email"');
    // Nothing is shown before the person leaves the field.
    expect(markup).not.toContain("must be a 10-digit US number");
    expect(read("components/staff-invitation-questions.tsx")).toContain("typedAnswerProblem(field, value)");
    expect(read("components/staff-invitation-registration.tsx")).toContain('inlinePhoneProblem("Phone", phone');
  });
});

describe("event contact blocks (#1193)", () => {
  const block = (...contacts: Array<{ name: string; phone: string; email?: string }>) => ({ contacts: contacts.map((contact) => ({ role: "", email: "", ...contact })) });

  it("still reads a block whose old phone fails today's check, so the public page keeps it", () => {
    expect(parseBlockData("CONTACT", block({ name: "Sam Example", phone: "555-0100" }))).not.toBeNull();
  });

  it("rejects a new bad phone without echoing it and stores a valid one in one form", () => {
    const data = parseBlockData("CONTACT", block({ name: "Sam Example", phone: BAD_PHONE }))!;
    const result = checkContactBlockData(data, []);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(BAD_PHONE);
    expect(JSON.stringify(result)).not.toContain("Sam Example");
    const good = checkContactBlockData(parseBlockData("CONTACT", block({ name: "Sam Example", phone: GOOD_PHONE }))!, []);
    expect(good).toMatchObject({ ok: true, data: { contacts: [{ phone: STORED_PHONE }] } });
  });

  it("leaves an old phone alone only for the same contact (same position or name), compared with what is stored", () => {
    const stored = [block({ name: "Sam Example", phone: "555-0100" })];
    const same = parseBlockData("CONTACT", block({ name: " sam example ", phone: "555-0100" }))!;
    expect(checkContactBlockData(same, stored)).toMatchObject({ ok: true, data: { contacts: [{ phone: "555-0100" }] } });
    // Renaming the contact in that position keeps its phone; the same text for a contact in another position does not.
    const renamed = parseBlockData("CONTACT", block({ name: "Sam Renamed", phone: "555-0100" }))!;
    expect(checkContactBlockData(renamed, stored)).toMatchObject({ ok: true, data: { contacts: [{ phone: "555-0100" }] } });
    const other = parseBlockData("CONTACT", block({ name: "Sam Example", phone: "", email: "sam@example.test" }, { name: "Someone Else", phone: "555-0100" }))!;
    expect(checkContactBlockData(other, stored)).toMatchObject({ ok: false });
    const changed = parseBlockData("CONTACT", block({ name: "Sam Example", phone: "555-0199" }))!;
    expect(checkContactBlockData(changed, stored)).toMatchObject({ ok: false });
  });

  it("flags an unchanged bad value in the editor and checks phone and email there", () => {
    const source = read("components/event-block-editors.tsx");
    expect(source).toContain('valueType="phone"');
    expect(source).toContain('valueType="email"');
    expect(source).toContain("inlinePhoneProblem(label, value, saved, touched)");
  });
});

describe("event email settings (#1193)", () => {
  const base = { senderName: "IMSDA Women's Retreat", replyToEmail: "", internalNotificationEmails: [] as string[] };

  it("checks the reply-to and staff alert addresses with the shared validator and never echoes them", () => {
    expect(messagingSettingsInputSchema.parse({ ...base, replyToEmail: " Retreat@Example.test ", internalNotificationEmails: [" Staff@Example.test "] })).toMatchObject({
      replyToEmail: "retreat@example.test",
      internalNotificationEmails: ["staff@example.test"],
    });
    for (const patch of [{ replyToEmail: BAD_EMAIL }, { internalNotificationEmails: [BAD_EMAIL] }]) {
      const result = messagingSettingsInputSchema.safeParse({ ...base, ...patch });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain(BAD_EMAIL);
    }
  });
});

describe("event email settings form (#1193)", () => {
  it("checks the reply-to and the recipient list inline with the shared validator, naming the line and never the address", () => {
    const source = read("components/communications-workspace.tsx");
    expect(source).toContain('inlineFieldProblem("Reply-to email", "email"');
    expect(source).toContain("problemMessage(`Recipient ${badRecipientLine + 1}`, EMAIL_PROBLEM)");
    expect(source).toContain('id="internal-recipients-error"');
  });
});

describe("club form alert recipients (#1193)", () => {
  it("rejects a new bad address by its line number, never by the address", () => {
    const result = parseAlertRecipients(`office@imsda-events.test\n${BAD_EMAIL}`);
    expect(result).toMatchObject({ ok: false, message: "Address 2: Enter a valid email address.", reason: "ADDRESS" });
    expect(JSON.stringify(result)).not.toContain(BAD_EMAIL);
  });

  it("leaves an address already saved alone, however it would fail today", () => {
    expect(parseAlertRecipients("Old@Odd-Domain\nnew@imsda-events.test", ["old@odd-domain"])).toEqual({ ok: true, emails: ["old@odd-domain", "new@imsda-events.test"] });
    expect(parseAlertRecipients("old@odd-domain", [])).toMatchObject({ ok: false });
  });

  it("counts a long list apart from a bad address", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `person${index}@imsda-events.test`);
    expect(parseAlertRecipients(eleven)).toMatchObject({ ok: false, reason: "COUNT" });
  });
});

describe("inline note for a typed answer (#1193)", () => {
  const field = (type: string, label: string) => registrationFormDefinitionSchema.parse({
    title: "Fixture", description: "", confirmationMessage: "Done.",
    sections: [{ id: "sec_one", title: "Section", description: "", fields: [{ id: "f_one", key: "kk", label, helpText: "", type, scope: "ATTENDEE", required: false, options: [] }] }],
  }).sections[0].fields[0];

  it("shows a changed bad answer only once the field is left, with no value in the message", () => {
    const phone = field("PHONE", "Cell phone");
    expect(typedFieldNote(phone, BAD_PHONE, undefined, false)).toEqual({ message: "", flagged: false, invalid: false });
    const shown = typedFieldNote(phone, BAD_PHONE, undefined, true);
    expect(shown).toMatchObject({ flagged: false, invalid: true });
    expect(shown.message).toMatch(/^Cell phone must be a 10-digit US number/);
    expect(shown.message).not.toContain(BAD_PHONE);
    expect(typedFieldNote(phone, GOOD_PHONE, undefined, true).message).toBe("");
  });

  it("flags an old saved answer for correcting at once, without blocking", () => {
    const email = field("EMAIL", "Backup email");
    const note = typedFieldNote(email, BAD_EMAIL, BAD_EMAIL, false);
    expect(note).toMatchObject({ flagged: true, invalid: false });
    expect(note.message).toContain("This saved answer needs correcting.");
    expect(note.message).not.toContain(BAD_EMAIL);
    expect(typedFieldNote(email, "other bad", BAD_EMAIL, false).flagged).toBe(false);
  });

  it("is used by the public registration form, under the field, for registration and club edits alike", () => {
    const source = read("components/public-registration-form.tsx");
    expect(source).toContain("typedFieldNote(field, context.values[field.key], storedAnswer");
    expect(source).toContain("club?.previousResponses?.[");
    expect(source).toContain("onBlur={() => setTypedTouched");
  });

  it("normalises a phone answer in one form", () => {
    const definition = registrationFormDefinitionSchema.parse({
      title: "Fixture", description: "", confirmationMessage: "Done.",
      sections: [{ id: "sec_one", title: "Section", description: "", fields: [{ id: "f_one", key: "cell", label: "Cell", helpText: "", type: "PHONE", scope: "ATTENDEE", required: false, options: [] }] }],
    });
    expect(normalizeTypedAnswers(definition, { cell: GOOD_PHONE }).cell).toBe(STORED_PHONE);
  });
});

describe("attendee answers form checks phone, email and date as well as numbers (#1193)", () => {
  const field = (type: string, key: string, label: string) => ({
    id: `f_${key}`, key, label, helpText: "", type, required: false, options: [], minSelections: null, maxSelections: null, conditional: null, conditionalGroup: null,
  });
  const render = (responses: Record<string, unknown>) => renderToStaticMarkup(createElement(AttendeeRegistrationAnswersForm, {
    initialExpectedUpdatedAt: "2026-10-01T00:00:00.000Z",
    fields: [field("PHONE", "cell", "Cell phone"), field("EMAIL", "mail", "Backup email"), field("DATE", "when", "Arrival date"), field("NUMBER", "extra", "Extra tickets")] as never,
    initialAttendees: [{ attendeeId: "a1", name: "Avery Guest", responses }],
  }));

  it("flags every old invalid saved answer for correcting, without echoing it", () => {
    const markup = render({ cell: BAD_PHONE, mail: BAD_EMAIL, when: "someday", extra: "lots" });
    for (const label of ["Cell phone", "Backup email", "Arrival date", "Extra tickets"]) {
      expect(markup).toContain(`${label} must be`);
    }
    expect(markup.match(/This saved answer needs correcting\./g)?.length).toBe(4);
    // Each message is tied to its input, so a screen reader reads it with the field.
    for (const key of ["f_cell", "f_mail", "f_when", "f_extra"]) {
      expect(markup).toContain(`id="a1_${key}_error"`);
      expect(markup).toContain(`aria-describedby="a1_${key}_error"`);
    }
    for (const value of [BAD_PHONE, BAD_EMAIL, "someday", "lots"]) expect(markup.replace(/value="[^"]*"/g, "")).not.toContain(value);
  });

  it("gives each type its own keypad and shows nothing for good answers", () => {
    const markup = render({ cell: STORED_PHONE, mail: "avery@example.test", when: "2026-10-30", extra: "2" });
    expect(markup).toMatch(/<input[^>]*type="tel"/);
    expect(markup).toMatch(/<input[^>]*type="email"/);
    expect(markup).toMatch(/<input[^>]*type="date"/);
    expect(markup).not.toContain("needs correcting");
  });
});
