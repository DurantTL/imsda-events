import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #131 (narrow slice): recording, reviewing and changing declared guardian authority, against an in-memory
 * stand-in for the few Prisma calls the service makes. The stand-in refuses to be asked about households,
 * account links or anything else that could stand in for a declaration, so a service that read one would fail
 * here. The real database guarantees (one ACTIVE row per minor, the immutability trigger, cascades) are proved
 * by scripts/verify-guardian-authority.ts. Synthetic data only.
 */
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

type Seed = {
  registrationId: string;
  code: string;
  holder: string;
  /** Person id, name, and what the form recorded about their age. */
  people: Array<{ personId: string; name: string; responses?: Row; snapshot?: Row }>;
  status?: string;
  club?: boolean;
  group?: boolean;
  eventId?: string;
  /** The stored form definition; absent for a registration staff made by hand. */
  definition?: unknown;
};

const state = vi.hoisted(() => ({
  event: { id: "event-1", name: "Synthetic Camp", startsAt: new Date("2027-03-05T14:00:00Z"), timezone: "America/Chicago", ageOfMajority: 18 } as Row,
  otherEvent: { id: "event-2", name: "Other Camp", startsAt: new Date("2027-03-05T14:00:00Z"), timezone: "America/Chicago", ageOfMajority: 18 } as Row,
  seeds: [] as unknown[],
  authorities: [] as Row[],
  conflicts: [] as Row[],
  audits: [] as Row[],
  clock: 0,
  /** Tables the service must never read: any of these is something that could stand in for a declaration. */
  touched: [] as string[],
}));

const seeds = () => state.seeds as Seed[];
const eventOf = (id: string) => (id === "event-1" ? state.event : id === "event-2" ? state.otherEvent : null);

function attendeeRows(seed: Seed) {
  return seed.people.map((person, index) => ({
    id: `att-${seed.registrationId}-${person.personId}`,
    eventId: seed.eventId ?? "event-1",
    registrationId: seed.registrationId,
    personId: person.personId,
    position: index,
    profileSnapshot: { firstName: person.name.split(" ")[0], lastName: person.name.split(" ")[1] ?? "", ...(person.snapshot ?? {}) },
    formResponses: person.responses ?? {},
    person: { firstName: person.name.split(" ")[0], lastName: person.name.split(" ")[1] ?? "" },
    registration: {
      confirmationCode: seed.code,
      accountHolderPersonId: seed.holder,
      status: seed.status ?? "SUBMITTED",
      clubRegistration: seed.club ? { id: "club" } : null,
      groupRegistration: seed.group ? { id: "group" } : null,
      publicFormSubmission: seed.definition ? { formVersionId: `v-${seed.registrationId}` } : null,
    },
  }));
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const condition = expected as Row;
      if ("in" in condition) return (condition.in as unknown[]).includes(actual);
      if ("not" in condition) return actual !== condition.not;
    }
    return actual === expected;
  });
}

const uniqueError = () => new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
const byRecent = (left: Row, right: Row) => (right.declaredAt as Date).getTime() - (left.declaredAt as Date).getTime() || String(right.id).localeCompare(String(left.id));

/** The same rules the migration's trigger enforces, so a service that skipped a check still fails here. */
function assertTriggerAllows(data: Row) {
  const seed = seeds().find((candidate) => candidate.registrationId === data.registrationId && (candidate.eventId ?? "event-1") === data.eventId);
  if (!seed) throw new Error("trigger: The registration is not on this event.");
  if (!seed.people.some((person) => person.personId === data.minorPersonId)) throw new Error("trigger: The minor is not on that registration.");
  if (data.adultPersonId) {
    if (data.source === "REGISTRATION_FORM" && !seed.people.some((person) => person.personId === data.adultPersonId)) throw new Error("trigger: The adult is not on that registration.");
    if (data.source === "STAFF" && !seeds().some((candidate) => (candidate.eventId ?? "event-1") === data.eventId && candidate.people.some((person) => person.personId === data.adultPersonId))) {
      throw new Error("trigger: The adult is not registered for this event.");
    }
    if (data.adultPersonId === data.minorPersonId) throw new Error("check: adult_not_minor");
  }
}

const fakeDb = {
  event: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => eventOf(where.id)),
  },
  registration: {
    findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: { attendees?: { where?: { personId?: string } } } }) => {
      const seed = seeds().find((candidate) => candidate.registrationId === where.id);
      if (!seed) return null;
      const onlyPerson = select?.attendees?.where?.personId;
      const attendees = attendeeRows(seed).filter((row) => !onlyPerson || row.personId === onlyPerson);
      return {
        id: seed.registrationId,
        eventId: seed.eventId ?? "event-1",
        accountHolderPersonId: seed.holder,
        status: seed.status ?? "SUBMITTED",
        clubRegistration: seed.club ? { id: "club" } : null,
        groupRegistration: seed.group ? { id: "group" } : null,
        event: eventOf(seed.eventId ?? "event-1"),
        attendees,
      };
    }),
  },
  registrationFormVersion: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      seeds().filter((seed) => seed.definition && where.id.in.includes(`v-${seed.registrationId}`)).map((seed) => ({ id: `v-${seed.registrationId}`, definition: seed.definition }))),
  },
  registrationAttendee: {
    findMany: vi.fn(async ({ where }: { where: { eventId: string; registration: { status: { in: string[] } } } }) =>
      seeds()
        .filter((seed) => (seed.eventId ?? "event-1") === where.eventId && where.registration.status.in.includes(seed.status ?? "SUBMITTED") && !seed.club && !seed.group)
        .flatMap(attendeeRows)),
  },
  guardianAuthority: {
    findMany: vi.fn(async ({ where }: { where: Row }) => state.authorities.filter((row) => matches(row, where)).sort(byRecent)),
    findFirst: vi.fn(async ({ where }: { where: Row }) => state.authorities.filter((row) => matches(row, where)).sort(byRecent)[0] ?? null),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = state.authorities.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      assertTriggerAllows(data);
      if (state.authorities.some((row) => row.state === "ACTIVE" && row.eventId === data.eventId && row.minorPersonId === data.minorPersonId)) throw uniqueError();
      state.clock += 1;
      const row = {
        id: `auth-${state.clock}`,
        state: "ACTIVE",
        declaredAt: new Date(Date.UTC(2027, 0, 1, 0, 0, state.clock)),
        declarationReason: null,
        actorUserId: null,
        actorPersonId: null,
        revokedAt: null,
        revokedByUserId: null,
        revocationReason: null,
        supersededAt: null,
        supersededById: null,
        ...data,
      };
      state.authorities.push(row);
      return row;
    }),
  },
  guardianAuthorityConflict: {
    findMany: vi.fn(async ({ where }: { where: Row }) => state.conflicts.filter((row) => matches(row, where))),
    findFirst: vi.fn(async ({ where }: { where: Row }) => state.conflicts.find((row) => matches(row, where)) ?? null),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = state.conflicts.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      state.clock += 1;
      const row = { id: `conflict-${state.clock}`, state: "OPEN", declaredAt: new Date(Date.UTC(2027, 0, 1, 0, 0, state.clock)), resolvedAt: null, resolvedByUserId: null, resolutionReason: null, ...data };
      state.conflicts.push(row);
      return row;
    }),
  },
  auditLog: { create: vi.fn(async ({ data }: { data: Row }) => { state.audits.push(data); return data; }) },
  $executeRaw: vi.fn(async () => 0),
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(guarded)),
};

/** Reading a table outside the allowed list is recorded and fails the test that did it. */
const allowedTables = new Set(["event", "registration", "registrationAttendee", "registrationFormVersion", "guardianAuthority", "guardianAuthorityConflict", "auditLog", "$executeRaw", "$transaction"]);
const guarded = new Proxy(fakeDb, {
  get(target, property: string) {
    if (!allowedTables.has(property) && !(property in target)) {
      state.touched.push(property);
      throw new Error(`The guardian-authority service must not read ${property}.`);
    }
    return (target as Record<string, unknown>)[property];
  },
});

vi.mock("@/lib/prisma", () => ({ getPrisma: () => guarded }));

import { formTemplates } from "@/modules/forms/definition";
import { formCollectsAge } from "@/modules/guardian-authority/domain";
import {
  getResponsibleAdultsByAttendee,
  GuardianAuthorityError,
  declareResponsibleAdultsForRegistration,
  dismissConflict,
  getGuardianReview,
  getRegistrationResponsibleAdultView,
  getResponsibleAdultExportRows,
  recordRegistrationDeclarations,
  revokeResponsibleAdult,
  setResponsibleAdult,
} from "@/modules/guardian-authority/repository";

/** A stored form that asks each attendee for an age; Women's Retreat asks for none. */
const agedForm = { sections: [{ fields: [{ scope: "ATTENDEE", key: "attendee_age" }, { scope: "REGISTRATION", key: "email" }] }] };
const dad = { personId: "p-dad", name: "Dan Sample", responses: { attendee_age: "44" } };
const son = { personId: "p-son", name: "Sam Sample", responses: { attendee_age: "12" } };
const att = (registrationId: string, personId: string) => `att-${registrationId}-${personId}`;

function seed(extra: Partial<Seed> & Pick<Seed, "registrationId" | "code" | "holder" | "people">) {
  seeds().push(extra);
}

async function inTransaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  return fakeDb.$transaction((tx) => callback(tx as Prisma.TransactionClient)) as Promise<T>;
}

const activeFor = (minor: string, event = "event-1") => state.authorities.filter((row) => row.state === "ACTIVE" && row.minorPersonId === minor && row.eventId === event);
const historyFor = (minor: string) => state.authorities.filter((row) => row.minorPersonId === minor);

beforeEach(() => {
  vi.clearAllMocks();
  state.seeds = [];
  state.authorities = [];
  state.conflicts = [];
  state.audits = [];
  state.clock = 0;
  state.touched = [];
  state.event.ageOfMajority = 18;
});

describe("authority comes only from a declaration: nothing is inferred", () => {
  // Each case sets up the signal and shows the minor has no authority record, is listed for staff as
  // "no responsible adult recorded", and that nothing wrote one. The fake refuses to read households,
  // account links or people, so the service could not have looked at them either.
  const minorHasNoAuthority = async (registrationId: string) => {
    const review = await getGuardianReview("event-1");
    const minor = review.minors.find((item) => item.personId === "p-son");
    expect(minor, "the minor is known").toBeTruthy();
    expect(minor!.responsibleAdult).toBeNull();
    expect(minor!.noneOfUs).toBe(false);
    expect(minor!.kinds).toEqual(["NOT_DECLARED"]);
    expect(activeFor("p-son")).toEqual([]);
    expect(historyFor("p-son")).toEqual([]);
    expect(fakeDb.guardianAuthority.create).not.toHaveBeenCalled();
    expect(state.touched).toEqual([]);
    const view = await getRegistrationResponsibleAdultView(registrationId);
    expect(view?.minors[0]?.choice).toBeNull();
    expect(await getResponsibleAdultExportRows("event-1")).toEqual([expect.objectContaining({ minorName: "Sam Sample", responsibleAdult: "", state: "Not recorded" })]);
  };

  it("household membership alone creates none (two household members, canManage on both)", async () => {
    // A household where Dan can manage Sam: modelled by the fact the table exists in the real database; the
    // service is not allowed to read it.
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
    await minorHasNoAuthority("reg-1");
  });

  it("a shared surname alone creates none", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, { ...son, name: "Sam Sample" }, { personId: "p-cousin", name: "Cleo Sample", responses: { attendee_age: "40" } }] });
    const review = await getGuardianReview("event-1");
    expect(review.minors.map((minor) => minor.name)).toEqual(["Sam Sample"]);
    expect(review.minors[0]!.responsibleAdult).toBeNull();
    expect(activeFor("p-son")).toEqual([]);
    expect(fakeDb.guardianAuthority.create).not.toHaveBeenCalled();
  });

  it("a shared email alone creates none", async () => {
    seed({
      registrationId: "reg-1",
      code: "REG-1",
      holder: "p-dad",
      people: [{ ...dad, snapshot: { email: "family@example.test" } }, { ...son, snapshot: { email: "family@example.test" } }],
    });
    await minorHasNoAuthority("reg-1");
  });

  it("canManage alone creates none (a person who can manage the household but is not on the registration)", async () => {
    // The manager is a registered adult elsewhere; being able to manage a household is not authority.
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-manager", people: [son] });
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-manager", people: [{ personId: "p-manager", name: "Mia Manager", responses: { attendee_age: "50" } }] });
    const review = await getGuardianReview("event-1");
    const minor = review.minors.find((item) => item.personId === "p-son")!;
    expect(minor.responsibleAdult).toBeNull();
    expect(minor.kinds).toEqual(["NO_ADULT_ON_REGISTRATION"]);
    expect(fakeDb.guardianAuthority.create).not.toHaveBeenCalled();
  });

  it("being the account holder alone creates none, even for the only adult on the registration", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
    await minorHasNoAuthority("reg-1");
  });

  it("the server never fills in a missing choice: a save with no choice is refused and writes nothing", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
    await expect(inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: {} })))
      .rejects.toMatchObject({ code: "CHOICES_INVALID" });
    expect(fakeDb.guardianAuthority.create).not.toHaveBeenCalled();
    expect(state.authorities).toEqual([]);
  });

  it("the only code that writes a declaration is the guardian-authority repository", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const roots = ["app", "modules", "components", "lib"];
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && /guardianAuthority(Conflict)?\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    roots.forEach(walk);
    expect(offenders.map((path) => path.replaceAll("\\", "/"))).toEqual(["modules/guardian-authority/repository.ts"]);
  });
});

describe("recording the registrant's declaration", () => {
  beforeEach(() => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
  });

  it("records who, when, how and for which event and registration (the registration form)", async () => {
    const outcome = await inTransaction((tx) => recordRegistrationDeclarations(tx, { eventId: "event-1", registrationId: "reg-1", actorPersonId: "p-dad", declarations: [{ minorPersonId: "p-son", adultPersonId: "p-dad" }] }));
    expect(outcome).toMatchObject({ created: 1, superseded: 0, conflicts: 0 });
    expect(activeFor("p-son")).toEqual([expect.objectContaining({
      eventId: "event-1",
      registrationId: "reg-1",
      minorPersonId: "p-son",
      adultPersonId: "p-dad",
      source: "REGISTRATION_FORM",
      accessTokenId: null,
      actorPersonId: "p-dad",
      declaredAt: expect.any(Date),
    })]);
    expect(state.audits).toEqual([expect.objectContaining({ action: "GUARDIAN_AUTHORITY_DECLARED", metadata: expect.objectContaining({ minorPersonId: "p-son", adultPersonId: "p-dad", source: "REGISTRATION_FORM", accessTokenId: null }) })]);
    // The review no longer lists this minor.
    const review = await getGuardianReview("event-1");
    expect(review.items).toEqual([]);
    expect(review.minors[0]).toMatchObject({ name: "Sam Sample", responsibleAdult: expect.objectContaining({ name: "Dan Sample", source: "REGISTRATION_FORM" }) });
  });

  it("a change from the private page is a distinct source and names the access grant, in the record and the audit", async () => {
    const outcome = await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "access-9", registrationId: "reg-1", choices: { [att("reg-1", "p-son")]: att("reg-1", "p-dad") } }));
    expect(outcome).toMatchObject({ created: 1 });
    expect(activeFor("p-son")).toEqual([expect.objectContaining({ source: "MANAGE_LINK", accessTokenId: "access-9", actorPersonId: "p-dad", adultPersonId: "p-dad" })]);
    expect(state.audits).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ source: "MANAGE_LINK", accessTokenId: "access-9" }) })]);
    await expect(inTransaction((tx) => recordRegistrationDeclarations(tx, { eventId: "event-1", registrationId: "reg-1", actorPersonId: "p-dad", source: "MANAGE_LINK", declarations: [] }))).rejects.toThrow(/access grant/);
    const review = await getGuardianReview("event-1");
    expect(review.minors[0]).toMatchObject({ responsibleAdult: expect.objectContaining({ source: "MANAGE_LINK" }) });
  });

  it("records None of us explicitly and sends the minor to staff", async () => {
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [att("reg-1", "p-son")]: "NONE" } }));
    expect(activeFor("p-son")).toEqual([expect.objectContaining({ adultPersonId: null, source: "MANAGE_LINK" })]);
    const review = await getGuardianReview("event-1");
    expect(review.items.map((item) => [item.name, item.kinds])).toEqual([["Sam Sample", ["NONE_OF_US"]]]);
    expect(review.counts.NONE_OF_US).toBe(1);
  });

  it("changing the choice supersedes the earlier record and keeps it as history", async () => {
    seeds()[0]!.people.push({ personId: "p-uncle", name: "Ulf Sample", responses: { attendee_age: "40" } });
    const sonAttendee = att("reg-1", "p-son");
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-dad") } }));
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-uncle") } }));
    expect(activeFor("p-son").map((row) => row.adultPersonId)).toEqual(["p-uncle"]);
    const history = historyFor("p-son");
    expect(history.map((row) => [row.adultPersonId, row.state])).toEqual([["p-dad", "SUPERSEDED"], ["p-uncle", "ACTIVE"]]);
    expect(history[0]).toMatchObject({ supersededById: history[1]!.id, supersededAt: expect.any(Date) });
    // Saving the same choice again changes nothing.
    const again = await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-uncle") } }));
    expect(again).toMatchObject({ created: 0, superseded: 0, unchanged: 1 });
    expect(historyFor("p-son")).toHaveLength(2);
  });

  it("refuses an adult who is not on this registration, another minor, and a person of unknown age", async () => {
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-other", people: [{ personId: "p-other", name: "Olga Other", responses: { attendee_age: "50" } }] });
    seeds()[0]!.people.push({ personId: "p-unknown", name: "Una Unknown" }, { personId: "p-teen", name: "Tia Sample", responses: { attendee_age: "15" } });
    const sonAttendee = att("reg-1", "p-son");
    const teenAttendee = att("reg-1", "p-teen");
    for (const bad of [att("reg-2", "p-other"), att("reg-1", "p-unknown"), teenAttendee, "att-made-up"]) {
      await expect(
        inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: bad, [teenAttendee]: "NONE" } })),
        bad,
      ).rejects.toMatchObject({ code: "CHOICES_INVALID" });
    }
    expect(state.authorities).toEqual([]);
  });

  it("the database refuses an adult who is not on the registration even if the service were asked to write one", async () => {
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-other", people: [{ personId: "p-other", name: "Olga Other", responses: { attendee_age: "50" } }] });
    await expect(inTransaction((tx) => recordRegistrationDeclarations(tx, { eventId: "event-1", registrationId: "reg-1", actorPersonId: "p-dad", declarations: [{ minorPersonId: "p-son", adultPersonId: "p-other" }] })))
      .rejects.toThrow(/not on that registration/);
    // A minor who is not on the registration is refused as well.
    await expect(inTransaction((tx) => recordRegistrationDeclarations(tx, { eventId: "event-1", registrationId: "reg-2", actorPersonId: "p-other", declarations: [{ minorPersonId: "p-son", adultPersonId: null }] })))
      .rejects.toThrow(/minor is not on that registration/);
  });

  it("a guardian cannot reach into an event they are not registered for: a registration of another event is untouched", async () => {
    // Olga is registered for event 2 only, and names Dan's son as hers from there. The registration is hers, the minor is not on it.
    seed({ registrationId: "reg-x", code: "REG-X", holder: "p-other", eventId: "event-2", people: [{ personId: "p-other", name: "Olga Other", responses: { attendee_age: "50" } }] });
    await expect(inTransaction((tx) => recordRegistrationDeclarations(tx, { eventId: "event-2", registrationId: "reg-x", actorPersonId: "p-other", declarations: [{ minorPersonId: "p-son", adultPersonId: "p-other" }] })))
      .rejects.toThrow(/minor is not on that registration/);
    // And through the manage page: Olga's registration has no minors to choose for, and no way to name Sam.
    expect(await getRegistrationResponsibleAdultView("reg-x")).toBeNull();
    await expect(inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-x", choices: { [att("reg-1", "p-son")]: "att-x" } }))).resolves.toMatchObject({ created: 0 });
    expect(state.authorities).toEqual([]);
    expect((await getGuardianReview("event-1")).minors[0]!.responsibleAdult).toBeNull();
  });

  it("does not ask club or group registrations, whose rosters have their own adults and youth", async () => {
    seeds().length = 0;
    seed({ registrationId: "reg-club", code: "REG-C", holder: "p-dad", club: true, people: [dad, son] });
    seed({ registrationId: "reg-group", code: "REG-G", holder: "p-dad", group: true, people: [dad, son] });
    expect(await getRegistrationResponsibleAdultView("reg-club")).toBeNull();
    expect(await getRegistrationResponsibleAdultView("reg-group")).toBeNull();
    expect((await getGuardianReview("event-1")).minors).toEqual([]);
    await expect(inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-club", choices: {} }))).rejects.toBeInstanceOf(GuardianAuthorityError);
  });
});

describe("minor status at the event start", () => {
  it("a person who turns 18 on the second day is still a minor for the event, and one who turned 18 the day before is not", async () => {
    seed({
      registrationId: "reg-1",
      code: "REG-1",
      holder: "p-dad",
      people: [
        dad,
        { personId: "p-birthday", name: "Bo Birthday", responses: { date_of_birth: "2009-03-06" } },
        { personId: "p-adult", name: "Ada Adult", responses: { date_of_birth: "2009-03-04" } },
      ],
    });
    const review = await getGuardianReview("event-1");
    expect(review.event).toMatchObject({ startDate: "2027-03-05", ageOfMajority: 18 });
    expect(review.minors.map((minor) => [minor.name, minor.age])).toEqual([["Bo Birthday", 17]]);
    expect(review.adults.map((adult) => adult.name)).toEqual(["Ada Adult", "Dan Sample"]);
  });

  it("follows the event's age of majority", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, { personId: "p-teen", name: "Tia Teen", responses: { date_of_birth: "2008-06-01" } }] });
    expect((await getGuardianReview("event-1")).minors).toHaveLength(0);
    state.event.ageOfMajority = 19;
    expect((await getGuardianReview("event-1")).minors.map((minor) => minor.name)).toEqual(["Tia Teen"]);
  });

  it("an unknown date of birth is not an adult and is flagged for staff, on a form that asks for an age", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", definition: agedForm, people: [dad, { personId: "p-unknown", name: "Una Unknown" }] });
    const review = await getGuardianReview("event-1");
    expect(review.adults.map((adult) => adult.name)).toEqual(["Dan Sample"]);
    expect(review.items.map((item) => [item.name, item.kinds, item.status])).toEqual([["Una Unknown", ["UNKNOWN_AGE"], "UNKNOWN"]]);
    // Staff cannot name them as the responsible adult for someone else either.
    seeds()[0]!.people.push(son);
    await expect(setResponsibleAdult({ eventId: "event-1", attendeeId: att("reg-1", "p-son"), adultPersonId: "p-unknown", reason: "Checking", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "ADULT_INVALID" });
  });
});

describe("two adults claiming one minor", () => {
  const sonAttendee = att("reg-1", "p-son");
  /** What the public form's submit does for a registration whose minor is already declared by another registration. */
  const submitFromSecondRegistration = (adultPersonId: string | null) => inTransaction((tx) => recordRegistrationDeclarations(tx, {
    eventId: "event-1",
    registrationId: "reg-2",
    actorPersonId: "p-mum",
    declarations: [{ minorPersonId: "p-son", adultPersonId }],
  }));
  beforeEach(() => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
    // The same child appears on a second registration with a different adult (a split family).
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-mum", people: [{ personId: "p-mum", name: "Mia Sample", responses: { attendee_age: "41" } }, son] });
  });

  it("creates a review item and neither adult is silently replaced or blocked", async () => {
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-dad") } }));
    const outcome = await submitFromSecondRegistration("p-mum");
    expect(outcome).toMatchObject({ created: 0, superseded: 0, conflicts: 1 });
    // The first declaration stands, untouched; the second is a review item.
    expect(activeFor("p-son")).toEqual([expect.objectContaining({ adultPersonId: "p-dad", registrationId: "reg-1" })]);
    expect(state.conflicts).toEqual([expect.objectContaining({ minorPersonId: "p-son", claimedAdultPersonId: "p-mum", registrationId: "reg-2", state: "OPEN", existingAuthorityId: activeFor("p-son")[0]!.id })]);
    const review = await getGuardianReview("event-1");
    const items = review.items.filter((item) => item.personId === "p-son");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.kinds.includes("CONFLICT"))).toBe(true);
    expect(items[0]!.conflicts).toEqual([expect.objectContaining({ claimedAdultName: "Mia Sample", claimingConfirmationCode: "REG-2" })]);
    expect(items[0]!.responsibleAdult?.name).toBe("Dan Sample");
    expect(state.audits.map((audit) => audit.action)).toContain("GUARDIAN_AUTHORITY_CONFLICT_OPENED");
  });

  it("does not duplicate the review item when the same claim is submitted again", async () => {
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-dad") } }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await submitFromSecondRegistration("p-mum");
    }
    expect(state.conflicts).toHaveLength(1);
  });

  it("a later None of us from the other registration claims nothing", async () => {
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-dad") } }));
    const outcome = await submitFromSecondRegistration(null);
    expect(outcome).toMatchObject({ ignored: 1, conflicts: 0 });
    expect(state.conflicts).toEqual([]);
    expect(activeFor("p-son")[0]).toMatchObject({ adultPersonId: "p-dad" });
  });

  it("staff closing the claim keeps the current adult; staff naming an adult resolves it and supersedes", async () => {
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-dad") } }));
    await submitFromSecondRegistration("p-mum");
    const conflictId = state.conflicts[0]!.id as string;
    await dismissConflict({ eventId: "event-1", conflictId, reason: "Mother confirmed the father is responsible", actorUserId: "staff-1" });
    expect(state.conflicts[0]).toMatchObject({ state: "RESOLVED", resolvedByUserId: "staff-1", resolutionReason: "Mother confirmed the father is responsible" });
    expect(activeFor("p-son")[0]).toMatchObject({ adultPersonId: "p-dad" });
    await expect(dismissConflict({ eventId: "event-1", conflictId, reason: "again", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "CONFLICT_ALREADY_RESOLVED" });
    await expect(dismissConflict({ eventId: "event-2", conflictId, reason: "wrong event", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "CONFLICT_NOT_FOUND" });
  });

  it("staff choosing the other adult resolves the open claim", async () => {
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-dad") } }));
    await submitFromSecondRegistration("p-mum");
    const result = await setResponsibleAdult({ eventId: "event-1", attendeeId: att("reg-2", "p-son"), adultPersonId: "p-mum", reason: "Court order on file with the registrar", actorUserId: "staff-1" });
    expect(result.resolvedConflictIds).toHaveLength(1);
    expect(state.conflicts[0]).toMatchObject({ state: "RESOLVED" });
    expect(activeFor("p-son")).toEqual([expect.objectContaining({ adultPersonId: "p-mum", source: "STAFF", actorUserId: "staff-1", declarationReason: "Court order on file with the registrar" })]);
  });
});

describe("staff set, change and revoke", () => {
  const sonAttendee = att("reg-1", "p-son");
  beforeEach(() => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son, { personId: "p-uncle", name: "Ulf Sample", responses: { attendee_age: "40" } }] });
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-other", people: [{ personId: "p-other", name: "Olga Other", responses: { attendee_age: "50" } }] });
  });

  it("sets the responsible adult with a reason and audits ids only", async () => {
    const result = await setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "p-uncle", reason: "Father is not attending; uncle is", actorUserId: "staff-1" });
    expect(result.supersededAuthorityId).toBeNull();
    expect(activeFor("p-son")).toEqual([expect.objectContaining({ adultPersonId: "p-uncle", source: "STAFF", actorUserId: "staff-1", registrationId: "reg-1" })]);
    expect(state.audits).toHaveLength(1);
    const audit = state.audits[0]!;
    expect(audit).toMatchObject({ action: "GUARDIAN_AUTHORITY_SET_BY_STAFF", actorUserId: "staff-1", eventId: "event-1" });
    // Ids and counts only: no names, no reason text.
    expect(Object.keys(audit.metadata as Row).sort()).toEqual(["adultPersonId", "eventId", "minorPersonId", "registrationId", "resolvedConflictIds", "supersededAuthorityId"]);
    expect(JSON.stringify(audit)).not.toMatch(/Father is not attending|Sam|Ulf|Dan/);
  });

  it("changes it by superseding, keeping the earlier record", async () => {
    await setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "p-dad", reason: "First", actorUserId: "staff-1" });
    const changed = await setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "p-uncle", reason: "Second", actorUserId: "staff-2" });
    expect(changed.supersededAuthorityId).toBeTruthy();
    expect(historyFor("p-son").map((row) => [row.adultPersonId, row.state])).toEqual([["p-dad", "SUPERSEDED"], ["p-uncle", "ACTIVE"]]);
    await expect(setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "p-uncle", reason: "Third", actorUserId: "staff-2" })).rejects.toMatchObject({ code: "NO_CHANGE" });
  });

  it("can name an adult registered on another registration of the same event, and nobody else", async () => {
    await setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "p-other", reason: "Aunt registered separately", actorUserId: "staff-1" });
    expect(activeFor("p-son")[0]).toMatchObject({ adultPersonId: "p-other", registrationId: "reg-1" });
    seed({ registrationId: "reg-x", code: "REG-X", holder: "p-away", eventId: "event-2", people: [{ personId: "p-away", name: "Abe Away", responses: { attendee_age: "50" } }] });
    await expect(setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "p-away", reason: "Registered for another event", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "ADULT_INVALID" });
    await expect(setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "p-son", reason: "Themself", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "ADULT_INVALID" });
    await expect(setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "nobody", reason: "Unknown", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "ADULT_INVALID" });
  });

  it("requires a reason for every change", async () => {
    await expect(setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "p-uncle", reason: "   ", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(revokeResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, reason: "", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(dismissConflict({ eventId: "event-1", conflictId: "c", reason: "", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    expect(state.authorities).toEqual([]);
  });

  it("does not make an adult a ward, and refuses an attendee of another event with 404", async () => {
    await expect(setResponsibleAdult({ eventId: "event-1", attendeeId: att("reg-1", "p-dad"), adultPersonId: "p-uncle", reason: "Adult", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "NOT_A_MINOR" });
    // Staff of event 2 name Sam's attendee id: it is not on their event.
    await expect(setResponsibleAdult({ eventId: "event-2", attendeeId: sonAttendee, adultPersonId: "p-other", reason: "Cross event", actorUserId: "staff-2" })).rejects.toMatchObject({ code: "ATTENDEE_NOT_FOUND" });
    await expect(revokeResponsibleAdult({ eventId: "event-2", attendeeId: sonAttendee, reason: "Cross event", actorUserId: "staff-2" })).rejects.toMatchObject({ code: "ATTENDEE_NOT_FOUND" });
    await expect(setResponsibleAdult({ eventId: "event-9", attendeeId: sonAttendee, adultPersonId: "p-uncle", reason: "No such event", actorUserId: "staff-2" })).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(state.authorities).toEqual([]);
  });

  it("revocation takes effect at once, is not an edit, and keeps who, when and why", async () => {
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-dad") } }));
    expect((await getGuardianReview("event-1")).minors[0]!.responsibleAdult?.name).toBe("Dan Sample");
    const revoked = await revokeResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, reason: "Father withdrew", actorUserId: "staff-1" });
    // Immediately: nothing is ACTIVE, the next read has no responsible adult, the export shows no adult.
    expect(activeFor("p-son")).toEqual([]);
    const after = (await getGuardianReview("event-1")).minors[0]!;
    expect(after.responsibleAdult).toBeNull();
    expect(after.kinds).toEqual(["NOT_DECLARED"]);
    expect((await getResponsibleAdultExportRows("event-1"))[0]).toMatchObject({ responsibleAdult: "", state: "Not recorded" });
    // History kept.
    expect(historyFor("p-son")).toEqual([expect.objectContaining({ id: revoked.authorityId, state: "REVOKED", revocationReason: "Father withdrew", revokedByUserId: "staff-1", revokedAt: expect.any(Date), adultPersonId: "p-dad" })]);
    // Revoking again has nothing to revoke.
    await expect(revokeResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, reason: "Again", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "NO_ACTIVE_AUTHORITY" });
    expect(JSON.stringify(state.audits)).not.toContain("Father withdrew");
  });

  it("the registrant cannot undo a staff revocation or a staff decision from the private page", async () => {
    await setResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, adultPersonId: "p-uncle", reason: "Uncle is responsible", actorUserId: "staff-1" });
    let view = await getRegistrationResponsibleAdultView("reg-1");
    expect(view?.minors[0]).toMatchObject({ choice: att("reg-1", "p-uncle"), lockedByStaff: true });
    // Saving from the page leaves a staff decision alone (the locked minor is neither asked for nor changed).
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: {} }));
    expect(activeFor("p-son")[0]).toMatchObject({ adultPersonId: "p-uncle", source: "STAFF" });
    await revokeResponsibleAdult({ eventId: "event-1", attendeeId: sonAttendee, reason: "Revoked", actorUserId: "staff-1" });
    view = await getRegistrationResponsibleAdultView("reg-1");
    expect(view?.minors[0]).toMatchObject({ choice: null, lockedByStaff: true });
    await inTransaction((tx) => declareResponsibleAdultsForRegistration(tx, { accessTokenId: "token-1", registrationId: "reg-1", choices: { [sonAttendee]: att("reg-1", "p-dad") } }));
    expect(activeFor("p-son")).toEqual([]);
    expect(state.conflicts).toEqual([]);
  });
});

describe("an unknown age only matters when the form asked for one", () => {
  const womensRetreat = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;
  const unknownGuest = { personId: "p-guest", name: "Gia Guest" };

  it("a Women's Retreat style form (no age field) shows nothing: no review item, no people line, no export row", async () => {
    expect(formCollectsAge(womensRetreat)).toBe(false);
    seed({ registrationId: "reg-1", code: "WR-1", holder: "p-guest", definition: womensRetreat, people: [unknownGuest, { personId: "p-friend", name: "Fay Friend" }] });
    const review = await getGuardianReview("event-1");
    expect(review.items).toEqual([]);
    expect(review.minors).toEqual([]);
    expect(review.counts.UNKNOWN_AGE).toBe(0);
    expect(await getResponsibleAdultsByAttendee("event-1")).toEqual(new Map());
    expect(await getResponsibleAdultExportRows("event-1")).toEqual([]);
  });

  it("a registration made by hand (no stored form) with no known minor shows nothing either", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-guest", people: [unknownGuest, dad] });
    expect((await getGuardianReview("event-1")).minors).toEqual([]);
  });

  it("shows an unknown age beside a known minor, even on a form that never asks", async () => {
    seed({ registrationId: "reg-1", code: "WR-1", holder: "p-dad", definition: womensRetreat, people: [dad, { ...son, responses: {}, snapshot: { ageOnEventDate: 12 } }, unknownGuest] });
    const review = await getGuardianReview("event-1");
    expect(review.items.map((item) => [item.name, item.kinds])).toEqual([["Gia Guest", ["UNKNOWN_AGE"]], ["Sam Sample", ["NOT_DECLARED"]]]);
  });

  it("shows an unknown age on a form that asks for a birth date or an age", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-guest", definition: { sections: [{ fields: [{ scope: "ATTENDEE", key: "date_of_birth" }] }] }, people: [unknownGuest] });
    expect((await getGuardianReview("event-1")).items.map((item) => item.kinds)).toEqual([["UNKNOWN_AGE"]]);
    // An age field on the registration (the contact) is not one for each attendee.
    state.seeds = [];
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-guest", definition: { sections: [{ fields: [{ scope: "REGISTRATION", key: "attendee_age" }] }] }, people: [unknownGuest] });
    expect((await getGuardianReview("event-1")).minors).toEqual([]);
  });
});

describe("a cancelled registration or a removed attendee is not a current declaration", () => {
  const sonOn = (registrationId: string) => att(registrationId, "p-son");
  const declareFor = (registrationId: string, adultPersonId: string | null, holder: string) => inTransaction((tx) => recordRegistrationDeclarations(tx, {
    eventId: "event-1", registrationId, actorPersonId: holder, declarations: [{ minorPersonId: "p-son", adultPersonId }],
  }));
  const mum = { personId: "p-mum", name: "Mia Sample", responses: { attendee_age: "41" } };

  it("cancel, then re-register with the other parent: the old declaration is not shown and makes no conflict", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
    await declareFor("reg-1", "p-dad", "p-dad");
    expect(activeFor("p-son")).toHaveLength(1);
    seeds()[0]!.status = "CANCELLED";
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-mum", people: [mum, son] });
    // Read side: the cancelled registration's declaration is ignored.
    let review = await getGuardianReview("event-1");
    expect(review.minors.map((minor) => [minor.confirmationCode, minor.responsibleAdult, minor.kinds])).toEqual([["REG-2", null, ["NOT_DECLARED"]]]);
    expect(await getResponsibleAdultExportRows("event-1")).toEqual([expect.objectContaining({ confirmationCode: "REG-2", responsibleAdult: "", state: "Not recorded" })]);
    // Write side: the spouse's declaration is the first current one, not a conflict, and the stale row is superseded.
    const outcome = await declareFor("reg-2", "p-mum", "p-mum");
    expect(outcome).toMatchObject({ created: 0, superseded: 1, conflicts: 0, ignored: 0 });
    expect(state.conflicts).toEqual([]);
    expect(historyFor("p-son").map((row) => [row.registrationId, row.adultPersonId, row.state])).toEqual([["reg-1", "p-dad", "SUPERSEDED"], ["reg-2", "p-mum", "ACTIVE"]]);
    expect(historyFor("p-son")[0]).toMatchObject({ supersededById: historyFor("p-son")[1]!.id });
    review = await getGuardianReview("event-1");
    expect(review.items).toEqual([]);
    expect(review.minors[0]!.responsibleAdult).toMatchObject({ name: "Mia Sample", confirmationCode: "REG-2" });
  });

  it("a stale None of us from a cancelled registration does not block a new claim either", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
    await declareFor("reg-1", null, "p-dad");
    seeds()[0]!.status = "CANCELLED";
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-mum", people: [mum, son] });
    expect(await declareFor("reg-2", "p-mum", "p-mum")).toMatchObject({ superseded: 1, conflicts: 0 });
    expect(activeFor("p-son")[0]).toMatchObject({ adultPersonId: "p-mum" });
  });

  it("a minor removed from the registration that declared for them is ignored, and a new declaration supersedes the old row", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
    await declareFor("reg-1", "p-dad", "p-dad");
    seeds()[0]!.people = [dad];
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-mum", people: [mum, son] });
    expect((await getGuardianReview("event-1")).minors.map((minor) => minor.responsibleAdult)).toEqual([null]);
    expect(await declareFor("reg-2", "p-mum", "p-mum")).toMatchObject({ superseded: 1, conflicts: 0 });
    expect(activeFor("p-son").map((row) => row.registrationId)).toEqual(["reg-2"]);
  });

  it("an open claim made from a cancelled registration drops out of the review", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-mum", people: [mum, son] });
    await declareFor("reg-1", "p-dad", "p-dad");
    await declareFor("reg-2", "p-mum", "p-mum");
    expect((await getGuardianReview("event-1")).items.some((item) => item.kinds.includes("CONFLICT"))).toBe(true);
    seeds()[1]!.status = "CANCELLED";
    const review = await getGuardianReview("event-1");
    expect(review.items).toEqual([]);
    expect(review.minors[0]!.conflicts).toEqual([]);
  });

  it("staff cannot revoke a record that is no longer current, and setting an adult replaces the stale row", async () => {
    seed({ registrationId: "reg-1", code: "REG-1", holder: "p-dad", people: [dad, son] });
    await declareFor("reg-1", "p-dad", "p-dad");
    seeds()[0]!.status = "CANCELLED";
    seed({ registrationId: "reg-2", code: "REG-2", holder: "p-mum", people: [mum, son] });
    await expect(revokeResponsibleAdult({ eventId: "event-1", attendeeId: sonOn("reg-2"), reason: "Nothing current", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "NO_ACTIVE_AUTHORITY" });
    // Dan is only on the cancelled registration, so he is not an adult of the event now.
    await expect(setResponsibleAdult({ eventId: "event-1", attendeeId: sonOn("reg-2"), adultPersonId: "p-dad", reason: "Father still attends", actorUserId: "staff-1" })).rejects.toMatchObject({ code: "ADULT_INVALID" });
    await setResponsibleAdult({ eventId: "event-1", attendeeId: sonOn("reg-2"), adultPersonId: "p-mum", reason: "Mother attends", actorUserId: "staff-1" });
    expect(historyFor("p-son").map((row) => [row.registrationId, row.state])).toEqual([["reg-1", "SUPERSEDED"], ["reg-2", "ACTIVE"]]);
  });
});
