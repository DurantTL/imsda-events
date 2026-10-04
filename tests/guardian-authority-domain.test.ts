import { describe, expect, it, vi } from "vitest";

/**
 * #131 (narrow slice): the pure rules for declared guardian authority. Authority comes only from a recorded
 * declaration; these rules decide who is a minor at the event start, which adult the form preselects, whether a
 * submitted choice is valid, and what a staff reviewer is told. Synthetic data only.
 */
vi.mock("server-only", () => ({}));

import {
  NONE_OF_US_LABEL,
  RESPONSIBLE_ADULT_NONE,
  defaultResponsibleAdultKey,
  eventStartDate,
  formCollectsAge,
  minorStatusAt,
  personAgeFromAnswers,
  planPublicResponsibleAdults,
  planRegistrationDeclaration,
  reviewKindsFor,
  responsibleAdultPersonId,
  sameFullName,
  validateResponsibleAdultChoices,
  type ReviewPerson,
  type RosterPerson,
} from "@/modules/guardian-authority/domain";
import { responsibleAdultsCsv } from "@/modules/guardian-authority/export";

const person = (key: string, status: RosterPerson["status"], extra: Partial<RosterPerson> = {}): RosterPerson => ({
  key,
  name: `Person ${key}`,
  status,
  isAccountHolder: false,
  ...extra,
});

describe("minor status is decided from age at the event's start date", () => {
  it("uses the birth date against the age of majority on the start date", () => {
    expect(minorStatusAt({ birthDate: "2010-06-01", statedAge: null }, "2027-03-05", 18)).toEqual({ status: "MINOR", age: 16, basis: "BIRTH_DATE" });
    expect(minorStatusAt({ birthDate: "2000-06-01", statedAge: null }, "2027-03-05", 18).status).toBe("ADULT");
  });

  it("treats someone who turns 18 mid-event as a minor, because the start date decides", () => {
    // 18th birthday is the second day of a Friday-to-Sunday event.
    const dob = "2009-03-06";
    expect(minorStatusAt({ birthDate: dob, statedAge: null }, "2027-03-05", 18)).toMatchObject({ status: "MINOR", age: 17 });
    // The same person at an event starting the day after their birthday is an adult.
    expect(minorStatusAt({ birthDate: dob, statedAge: null }, "2027-03-07", 18)).toMatchObject({ status: "ADULT", age: 18 });
    // On the birthday itself the person is 18.
    expect(minorStatusAt({ birthDate: dob, statedAge: null }, "2027-03-06", 18).status).toBe("ADULT");
  });

  it("follows the event's configured age of majority", () => {
    expect(minorStatusAt({ birthDate: "2008-06-01", statedAge: null }, "2027-03-05", 19).status).toBe("MINOR");
    expect(minorStatusAt({ birthDate: "2008-06-01", statedAge: null }, "2027-03-05", 18).status).toBe("ADULT");
  });

  it("does not treat an unknown date of birth as an adult", () => {
    expect(minorStatusAt({ birthDate: null, statedAge: null }, "2027-03-05", 18)).toEqual({ status: "UNKNOWN", age: null, basis: "NONE" });
    // A birth date in the future is not usable either.
    expect(minorStatusAt({ birthDate: "2030-01-01", statedAge: null }, "2027-03-05", 18).status).toBe("UNKNOWN");
  });

  it("falls back to a stated age (already the age at the event) when no birth date was asked", () => {
    expect(minorStatusAt({ birthDate: null, statedAge: 12 }, "2027-03-05", 18)).toEqual({ status: "MINOR", age: 12, basis: "STATED_AGE" });
    expect(minorStatusAt({ birthDate: null, statedAge: 18 }, "2027-03-05", 18).status).toBe("ADULT");
    // A birth date wins over a stated age.
    expect(minorStatusAt({ birthDate: "1980-01-01", statedAge: 12 }, "2027-03-05", 18).status).toBe("ADULT");
  });

  it("reads ages and birth dates from the answers, and never from a label", () => {
    expect(personAgeFromAnswers({ date_of_birth: "2014-02-03" })).toEqual({ birthDate: "2014-02-03", statedAge: null });
    expect(personAgeFromAnswers({ attendee_age: "11" }).statedAge).toBe(11);
    expect(personAgeFromAnswers({ age: "11 years" }).statedAge).toBe(11);
    expect(personAgeFromAnswers({}, { ageOnEventDate: 9 }).statedAge).toBe(9);
    // Junk, impossible dates and attendee types decide nothing.
    expect(personAgeFromAnswers({ dob: "2014-02-30", attendee_age: "many", attendee_type: "Child" })).toEqual({ birthDate: null, statedAge: null });
  });

  it("works out the start date in the event's own time zone", () => {
    // 03:00 UTC on the 6th is still the evening of the 5th in Chicago.
    expect(eventStartDate("2027-03-06T03:00:00.000Z", "America/Chicago")).toBe("2027-03-05");
    expect(eventStartDate(new Date("2027-03-06T03:00:00.000Z"), "UTC")).toBe("2027-03-06");
  });
});

describe("which forms ask for an age", () => {
  it("is true only for an attendee-scope birth date or age field", () => {
    const form = (scope: string, key: string) => ({ sections: [{ fields: [{ scope, key }] }] });
    expect(formCollectsAge(form("ATTENDEE", "attendee_age"))).toBe(true);
    expect(formCollectsAge(form("ATTENDEE", "date_of_birth"))).toBe(true);
    expect(formCollectsAge(form("ATTENDEE", "guest_age"))).toBe(true);
    expect(formCollectsAge(form("REGISTRATION", "attendee_age"))).toBe(false);
    expect(formCollectsAge(form("ATTENDEE", "shirt_size"))).toBe(false);
    expect(formCollectsAge(null)).toBe(false);
    expect(formCollectsAge({ sections: "nope" })).toBe(false);
  });
});

describe("the responsible-adult default is a preselection, never blank", () => {
  it("preselects the only adult", () => {
    expect(defaultResponsibleAdultKey([person("dad", "ADULT"), person("kid", "MINOR")])).toBe("dad");
  });

  it("preselects the account holder when several adults and the holder is an adult", () => {
    const people = [person("uncle", "ADULT"), person("dad", "ADULT", { isAccountHolder: true }), person("kid", "MINOR")];
    expect(defaultResponsibleAdultKey(people)).toBe("dad");
  });

  it("preselects the first adult listed when the account holder is not an adult here", () => {
    const people = [person("kid", "MINOR", { isAccountHolder: true }), person("uncle", "ADULT"), person("aunt", "ADULT")];
    expect(defaultResponsibleAdultKey(people)).toBe("uncle");
  });

  it("falls to None of us when no adult is on the registration", () => {
    expect(defaultResponsibleAdultKey([person("kid", "MINOR"), person("teen", "UNKNOWN")])).toBe(RESPONSIBLE_ADULT_NONE);
  });

  it("never counts a person of unknown age as an adult", () => {
    expect(defaultResponsibleAdultKey([person("dad", "UNKNOWN"), person("kid", "MINOR")])).toBe(RESPONSIBLE_ADULT_NONE);
  });

  it("matches the account holder by the primary contact's typed name, only to preselect", () => {
    expect(sameFullName("Sam  Example", { primary_first_name: "sam", primary_last_name: "Example" })).toBe(true);
    expect(sameFullName("Sam Example", { first_name: "Sam", last_name: "Other" })).toBe(false);
    expect(sameFullName("", {})).toBe(false);
  });
});

describe("validating the submitted choices", () => {
  const people = [person("dad", "ADULT"), person("uncle", "ADULT"), person("kid", "MINOR"), person("teen", "MINOR"), person("mystery", "UNKNOWN")];

  it("accepts an adult on the registration or None of us for each minor", () => {
    const result = validateResponsibleAdultChoices(people, { kid: "dad", teen: RESPONSIBLE_ADULT_NONE });
    expect(result.issues).toEqual([]);
    expect(result.declarations).toEqual([{ minorKey: "kid", adultKey: "dad" }, { minorKey: "teen", adultKey: null }]);
  });

  it("refuses a minor with no choice (it cannot be left blank)", () => {
    const result = validateResponsibleAdultChoices(people, { kid: "dad" });
    expect(result.issues.map((issue) => [issue.code, issue.minorKey])).toEqual([["RESPONSIBLE_ADULT_REQUIRED", "teen"]]);
    expect(validateResponsibleAdultChoices(people, { kid: "", teen: "dad" }).issues[0]?.code).toBe("RESPONSIBLE_ADULT_REQUIRED");
  });

  it("refuses an adult who is not on the registration, another minor, a person of unknown age, or the minor themself", () => {
    for (const bad of ["stranger-from-another-registration", "teen", "mystery", "kid"]) {
      const result = validateResponsibleAdultChoices(people, { kid: bad, teen: "dad" });
      expect(result.issues.map((issue) => issue.code), bad).toEqual(["RESPONSIBLE_ADULT_INVALID"]);
      expect(result.declarations.map((declaration) => declaration.minorKey)).toEqual(["teen"]);
    }
  });

  it("ignores a choice for someone who is not a minor: it creates nothing", () => {
    const result = validateResponsibleAdultChoices([person("dad", "ADULT"), person("mum", "ADULT")], { dad: "mum" });
    expect(result).toEqual({ issues: [], declarations: [] });
  });

  it("does not read inherited object keys as choices", () => {
    const result = validateResponsibleAdultChoices([person("constructor", "MINOR"), person("dad", "ADULT")], {});
    expect(result.issues.map((issue) => issue.code)).toEqual(["RESPONSIBLE_ADULT_REQUIRED"]);
  });

  it("states the None of us label the form shows", () => {
    expect(NONE_OF_US_LABEL).toBe("None of us");
  });
});

describe("the server decides who is a minor from the submitted answers", () => {
  const dad = { clientId: "a1", name: "Dan Sample", responses: { attendee_age: "44" } };
  const son = { clientId: "a2", name: "Sam Sample", responses: { attendee_age: "12" } };
  const common = { startDate: "2027-03-05", ageOfMajority: 18 };

  it("asks nothing when nobody is a minor", () => {
    expect(planPublicResponsibleAdults({ ...common, attendees: [dad], choices: undefined })).toEqual({ minorKeys: [], issues: [], declarations: [] });
  });

  it("requires a choice for a minor even when the browser sent none", () => {
    const plan = planPublicResponsibleAdults({ ...common, attendees: [dad, son], choices: undefined });
    expect(plan.minorKeys).toEqual(["a2"]);
    expect(plan.issues[0]!.message).toContain("Please reload this page and try again.");
    expect(plan.issues).toEqual([{ code: "RESPONSIBLE_ADULT_REQUIRED", message: expect.stringContaining("Sam Sample"), attendeeIndex: 1, path: "attendees.1.responsibleAdult", key: "responsible_adult" }]);
    expect(plan.declarations).toEqual([]);
  });

  it("records the submitted choice as the declaration", () => {
    const plan = planPublicResponsibleAdults({ ...common, attendees: [dad, son], choices: { a2: "a1" } });
    expect(plan.issues).toEqual([]);
    expect(plan.declarations).toEqual([{ minorKey: "a2", adultKey: "a1" }]);
  });

  it("does not let a browser claim a minor is an adult, or a minor is the adult", () => {
    const plan = planPublicResponsibleAdults({ ...common, attendees: [son, { clientId: "a3", name: "Kay Sample", responses: { attendee_age: "15" } }], choices: { a2: "a3", a3: RESPONSIBLE_ADULT_NONE } });
    expect(plan.issues.map((issue) => issue.code)).toEqual(["RESPONSIBLE_ADULT_INVALID"]);
    expect(plan.declarations).toEqual([{ minorKey: "a3", adultKey: null }]);
  });

  it("flags a minor on a registration with no adult and only allows None of us", () => {
    const plan = planPublicResponsibleAdults({ ...common, attendees: [son], choices: { a2: "a2" } });
    expect(plan.issues.map((issue) => issue.code)).toEqual(["RESPONSIBLE_ADULT_INVALID"]);
    expect(planPublicResponsibleAdults({ ...common, attendees: [son], choices: { a2: RESPONSIBLE_ADULT_NONE } }).declarations).toEqual([{ minorKey: "a2", adultKey: null }]);
  });

  it("does not ask for a person of unknown age, and does not count them as an adult", () => {
    const unknown = { clientId: "a4", name: "Pat Sample", responses: {} };
    const plan = planPublicResponsibleAdults({ ...common, attendees: [unknown, son], choices: { a2: "a4" } });
    expect(plan.minorKeys).toEqual(["a2"]);
    expect(plan.issues.map((issue) => issue.code)).toEqual(["RESPONSIBLE_ADULT_INVALID"]);
  });
});

describe("what a declaration does when it arrives", () => {
  const registrationA = "reg-a";
  const registrationB = "reg-b";
  const active = (overrides: Partial<{ registrationId: string; adultPersonId: string | null; source: "REGISTRATION_FORM" | "STAFF"; state: "ACTIVE" | "REVOKED" }> = {}) => ({
    registrationId: registrationA,
    adultPersonId: "adult-1",
    source: "REGISTRATION_FORM" as const,
    state: "ACTIVE" as const,
    ...overrides,
  });

  it("creates the first declaration", () => {
    expect(planRegistrationDeclaration(null, { registrationId: registrationA, adultPersonId: "adult-1" })).toEqual({ kind: "CREATE" });
    expect(planRegistrationDeclaration(null, { registrationId: registrationA, adultPersonId: null })).toEqual({ kind: "CREATE" });
  });

  it("leaves the same declaration alone", () => {
    expect(planRegistrationDeclaration(active(), { registrationId: registrationA, adultPersonId: "adult-1" })).toEqual({ kind: "UNCHANGED" });
    expect(planRegistrationDeclaration(active({ adultPersonId: null }), { registrationId: registrationA, adultPersonId: null })).toEqual({ kind: "UNCHANGED" });
  });

  it("lets the registrant change their own declaration on the same registration", () => {
    expect(planRegistrationDeclaration(active(), { registrationId: registrationA, adultPersonId: "adult-2" })).toEqual({ kind: "SUPERSEDE" });
    expect(planRegistrationDeclaration(active(), { registrationId: registrationA, adultPersonId: null })).toEqual({ kind: "SUPERSEDE" });
    expect(planRegistrationDeclaration(active({ adultPersonId: null }), { registrationId: registrationA, adultPersonId: "adult-2" })).toEqual({ kind: "SUPERSEDE" });
  });

  it("sends a different adult from a different registration to staff review, never a silent replacement", () => {
    expect(planRegistrationDeclaration(active(), { registrationId: registrationB, adultPersonId: "adult-2" })).toEqual({ kind: "CONFLICT" });
    expect(planRegistrationDeclaration(active({ adultPersonId: null }), { registrationId: registrationB, adultPersonId: "adult-2" })).toEqual({ kind: "CONFLICT" });
  });

  it("claims nothing when another registration only says None of us, or names the same adult", () => {
    expect(planRegistrationDeclaration(active(), { registrationId: registrationB, adultPersonId: null })).toEqual({ kind: "IGNORE" });
    expect(planRegistrationDeclaration(active(), { registrationId: registrationB, adultPersonId: "adult-1" })).toEqual({ kind: "UNCHANGED" });
  });

  it("never lets a registrant overwrite what staff decided", () => {
    expect(planRegistrationDeclaration(active({ source: "STAFF" }), { registrationId: registrationA, adultPersonId: "adult-2" })).toEqual({ kind: "CONFLICT" });
    expect(planRegistrationDeclaration(active({ source: "STAFF" }), { registrationId: registrationA, adultPersonId: null })).toEqual({ kind: "IGNORE" });
    // After a staff revocation a new claim is a review item, and None of us changes nothing.
    expect(planRegistrationDeclaration(active({ state: "REVOKED" }), { registrationId: registrationA, adultPersonId: "adult-1" })).toEqual({ kind: "CONFLICT" });
    expect(planRegistrationDeclaration(active({ state: "REVOKED" }), { registrationId: registrationA, adultPersonId: null })).toEqual({ kind: "IGNORE" });
  });
});

describe("what staff are asked to review", () => {
  const base: ReviewPerson = {
    attendeeId: "att-kid",
    personId: "p-kid",
    registrationId: "reg-1",
    status: "MINOR",
    registrationAdultPersonIds: ["p-dad"],
    registrationPersonIds: ["p-dad", "p-kid"],
    authority: { id: "g1", adultPersonId: "p-dad", source: "REGISTRATION_FORM" },
    openConflictIds: [],
  };

  it("lists nothing for a minor with a recorded adult who is still on the registration", () => {
    expect(reviewKindsFor(base)).toEqual([]);
  });

  it("lists a minor whose registrant chose None of us", () => {
    expect(reviewKindsFor({ ...base, authority: { id: "g1", adultPersonId: null, source: "REGISTRATION_FORM" } })).toEqual(["NONE_OF_US"]);
  });

  it("lists a minor on a registration with no adult", () => {
    expect(reviewKindsFor({ ...base, registrationAdultPersonIds: [], registrationPersonIds: ["p-kid"], authority: { id: "g1", adultPersonId: null, source: "REGISTRATION_FORM" } }))
      .toEqual(["NONE_OF_US", "NO_ADULT_ON_REGISTRATION"]);
    // A staff-set adult elsewhere in the event answers it.
    expect(reviewKindsFor({ ...base, registrationAdultPersonIds: [], registrationPersonIds: ["p-kid"], authority: { id: "g2", adultPersonId: "p-other", source: "STAFF" } })).toEqual([]);
  });

  it("lists a person of unknown age and does not treat them as an adult", () => {
    expect(reviewKindsFor({ ...base, status: "UNKNOWN", authority: null })).toEqual(["UNKNOWN_AGE"]);
  });

  it("lists a minor with no declaration at all (never inferred from the household)", () => {
    expect(reviewKindsFor({ ...base, authority: null })).toEqual(["NOT_DECLARED"]);
    expect(responsibleAdultPersonId(null)).toBeNull();
  });

  it("lists a minor whose recorded adult left the registration", () => {
    expect(reviewKindsFor({ ...base, registrationAdultPersonIds: [], registrationPersonIds: ["p-kid"] })).toEqual(["ADULT_LEFT_REGISTRATION"]);
  });

  it("lists a conflicting claim and keeps the current adult", () => {
    const kinds = reviewKindsFor({ ...base, openConflictIds: ["c1"] });
    expect(kinds).toEqual(["CONFLICT"]);
    expect(responsibleAdultPersonId(base.authority)).toBe("p-dad");
  });

  it("never lists an adult", () => {
    expect(reviewKindsFor({ ...base, status: "ADULT", authority: null })).toEqual([]);
  });
});

describe("the export", () => {
  it("defuses spreadsheet formulas in names and keeps one row per minor", () => {
    const csv = responsibleAdultsCsv([
      { confirmationCode: "REG-1", minorName: "=HYPERLINK(\"http://example.test\")", minorAge: 12, minorStatus: "MINOR", responsibleAdult: "+Dad Sample", adultConfirmationCode: "REG-1", state: "Recorded" },
      { confirmationCode: "REG-2", minorName: "@Kid Sample", minorAge: null, minorStatus: "UNKNOWN", responsibleAdult: "", adultConfirmationCode: "", state: "Not recorded" },
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('"Confirmation code","Minor","Age at event start","Age status","Responsible adult","Adult\'s confirmation code","Status"');
    expect(lines[1]).toContain("\"'=HYPERLINK");
    expect(lines[1]).toContain("\"'+Dad Sample\"");
    expect(lines[2]).toContain("\"'@Kid Sample\"");
    expect(lines[2]).toContain("Age unknown");
  });
});
