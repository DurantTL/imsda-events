import { describe, expect, it } from "vitest";
import {
  LODGING_REQUEST_ACCESSIBILITY_HEADERS,
  LODGING_REQUEST_CSV_HEADERS,
  buildReviewItems,
  categoryFits,
  demandByCategoryNight,
  isPastLodgingDeadline,
  lodgingDeadlineDay,
  lodgingRequestExportCells,
  lodgingRequestSchema,
  lodgingSettingsSchema,
  normalizeName,
  registrantRoommateSchema,
  requestGrew,
  roommateStatus,
  ruleCreateSchema,
  separationViolations,
  staffLodgingRequestSchema,
  togetherGroupsOn,
  type CategoryCapacity,
  type GuardianLink,
  type RequestSnapshot,
  type ReviewFacts,
  type RoommateRow,
  type RuleRow,
} from "@/modules/lodging/preferences-domain";
import { lodgingRequestsCsv } from "@/modules/lodging/export";

/** Synthetic people, registrations and nights only. */
const nights = ["2027-06-15", "2027-06-16", "2027-06-17", "2027-06-18"];

describe("lodging request input", () => {
  it("accepts a category, nights and yes/no flags", () => {
    const parsed = lodgingRequestSchema.parse({ category: "DORM_ROOM", firstNight: "2027-06-16", lastNight: "2027-06-17", partySize: 2, groundFloorNeeded: true, privateRoomRequested: false });
    expect(parsed.category).toBe("DORM_ROOM");
  });

  it("refuses any free-text or unknown field, so no medical detail can reach lodging", () => {
    for (const extra of [{ medicalReason: "knee surgery" }, { accessibilityNotes: "walker" }, { notes: "x" }, { reason: "x" }]) {
      expect(lodgingRequestSchema.safeParse({ category: "TENT", ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("makes the flags booleans only", () => {
    expect(lodgingRequestSchema.safeParse({ category: null, groundFloorNeeded: "first-floor request for medical reasons" }).success).toBe(false);
    expect(lodgingRequestSchema.safeParse({ category: null, accessibleRoomNeeded: 1 }).success).toBe(false);
  });

  it("needs both nights or neither, in order", () => {
    expect(lodgingRequestSchema.safeParse({ category: "TENT", firstNight: "2027-06-16" }).success).toBe(false);
    expect(lodgingRequestSchema.safeParse({ category: "TENT", firstNight: "2027-06-17", lastNight: "2027-06-16" }).success).toBe(false);
    expect(lodgingRequestSchema.safeParse({ category: "TENT", firstNight: "not-a-date", lastNight: "2027-06-16" }).success).toBe(false);
    expect(lodgingRequestSchema.safeParse({ category: "TENT" }).success).toBe(true);
  });

  it("requires a reason for a staff edit", () => {
    expect(staffLodgingRequestSchema.safeParse({ category: "TENT" }).success).toBe(false);
    expect(staffLodgingRequestSchema.safeParse({ category: "TENT", reason: "  " }).success).toBe(false);
    expect(staffLodgingRequestSchema.safeParse({ category: "TENT", reason: "Phoned the office" }).success).toBe(true);
  });

  it("validates settings, roommate and rule input strictly", () => {
    expect(lodgingSettingsSchema.safeParse({}).success).toBe(false);
    expect(lodgingSettingsSchema.safeParse({ fullBehavior: "WAITLIST", preferencesDeadline: null }).success).toBe(true);
    expect(lodgingSettingsSchema.safeParse({ fullBehavior: "EVERYONE_IN" }).success).toBe(false);
    expect(registrantRoommateSchema.safeParse({ action: "add_by_code", name: "Pat Example", confirmationCode: "REG-ABCDEF123456", email: "x@example.test" }).success).toBe(false);
    expect(registrantRoommateSchema.safeParse({ action: "add_by_code", name: "Pat Example", confirmationCode: "REG-ABCDEF123456" }).success).toBe(true);
    expect(ruleCreateSchema.safeParse({ kind: "SEPARATE", personAId: "a", reason: "Staff decision" }).success).toBe(false);
    expect(ruleCreateSchema.safeParse({ kind: "SEPARATE", personAId: "a", personBId: "a", reason: "Staff decision" }).success).toBe(false);
    expect(ruleCreateSchema.safeParse({ kind: "SPLIT_HOUSEHOLD", personAId: "a", personBId: "b", reason: "Staff decision" }).success).toBe(false);
    expect(ruleCreateSchema.safeParse({ kind: "SPLIT_HOUSEHOLD", personAId: "a", reason: "Staff decision" }).success).toBe(true);
    expect(ruleCreateSchema.safeParse({ kind: "KEEP_TOGETHER", personAId: "a", personBId: "b", reason: "x", effectiveFrom: "2027-06-17", effectiveUntil: "2027-06-16" }).success).toBe(false);
  });
});

describe("the lodging deadline", () => {
  it("is the event's own setting, else the registration close date, else the day the event starts", () => {
    expect(lodgingDeadlineDay({ preferencesDeadline: "2027-05-01", registrationClosesOn: "2027-06-01", eventStartDay: "2027-06-15" })).toBe("2027-05-01");
    expect(lodgingDeadlineDay({ preferencesDeadline: null, registrationClosesOn: "2027-06-01", eventStartDay: "2027-06-15" })).toBe("2027-06-01");
    expect(lodgingDeadlineDay({ preferencesDeadline: null, registrationClosesOn: null, eventStartDay: "2027-06-15" })).toBe("2027-06-15");
    expect(lodgingDeadlineDay({ preferencesDeadline: null, registrationClosesOn: "soon", eventStartDay: "2027-06-15" })).toBe("2027-06-15");
  });

  it("includes the deadline day itself, in the event's time zone", () => {
    // 2027-06-02 02:00 UTC is still June 1 in Chicago.
    expect(isPastLodgingDeadline("2027-06-01", new Date("2027-06-02T02:00:00Z"), "America/Chicago")).toBe(false);
    expect(isPastLodgingDeadline("2027-06-01", new Date("2027-06-02T06:00:00Z"), "America/Chicago")).toBe(true);
  });
});

describe("matching typed names", () => {
  it("ignores case, accents and spacing", () => {
    expect(normalizeName("  José  O'Neil ")).toBe(normalizeName("jose o neil"));
    expect(normalizeName("Pat Example")).not.toBe(normalizeName("Pat Exemplar"));
  });
});

const row = (overrides: Partial<RoommateRow> & Pick<RoommateRow, "id" | "fromRegistrationId" | "targetRegistrationId">): RoommateRow => ({
  fromPersonId: null, targetPersonId: null, decision: "PENDING", withdrawn: false, ...overrides,
});

describe("roommate requests are directional until both ask or staff approve", () => {
  it("treats one request as one-sided", () => {
    const a = row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r2" });
    expect(roommateStatus(a, [a])).toEqual({ status: "ONE_SIDED" });
  });

  it("is mutual when the other side asks back", () => {
    const a = row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r2" });
    const b = row({ id: "b", fromRegistrationId: "r2", targetRegistrationId: "r1" });
    expect(roommateStatus(a, [a, b])).toEqual({ status: "MUTUAL", basis: "BOTH_ASKED" });
    expect(roommateStatus(b, [a, b])).toEqual({ status: "MUTUAL", basis: "BOTH_ASKED" });
  });

  it("does not count a third registration or a withdrawn request as asking back", () => {
    const a = row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r2" });
    const other = row({ id: "c", fromRegistrationId: "r3", targetRegistrationId: "r1" });
    const withdrawn = row({ id: "b", fromRegistrationId: "r2", targetRegistrationId: "r1", withdrawn: true });
    expect(roommateStatus(a, [a, other, withdrawn]).status).toBe("ONE_SIDED");
  });

  it("requires named people to agree", () => {
    const a = row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r2", fromPersonId: "p1", targetPersonId: "p3" });
    const wrong = row({ id: "b", fromRegistrationId: "r2", targetRegistrationId: "r1", fromPersonId: "p4", targetPersonId: "p1" });
    const right = row({ id: "c", fromRegistrationId: "r2", targetRegistrationId: "r1", fromPersonId: "p3", targetPersonId: null });
    expect(roommateStatus(a, [a, wrong]).status).toBe("ONE_SIDED");
    expect(roommateStatus(a, [a, right]).status).toBe("MUTUAL");
  });

  it("lets staff approve a one-sided request or decline a mutual one", () => {
    const approved = row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r2", decision: "APPROVED" });
    expect(roommateStatus(approved, [approved])).toEqual({ status: "MUTUAL", basis: "STAFF_APPROVED" });
    const declined = row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r2", decision: "DECLINED" });
    const back = row({ id: "b", fromRegistrationId: "r2", targetRegistrationId: "r1" });
    expect(roommateStatus(declined, [declined, back]).status).toBe("DECLINED");
    // A declined request also stops counting as the other side asking back.
    expect(roommateStatus(back, [declined, back]).status).toBe("ONE_SIDED");
  });

  it("counts a request between two people on the same registration at once", () => {
    const same = row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r1", fromPersonId: "p1", targetPersonId: "p2" });
    expect(roommateStatus(same, [same])).toEqual({ status: "MUTUAL", basis: "SAME_REGISTRATION" });
  });
});

const people = [
  { personId: "adult1", registrationId: "r1" },
  { personId: "teen1", registrationId: "r1" },
  { personId: "adult2", registrationId: "r2" },
  { personId: "son2", registrationId: "r2" },
  { personId: "friend", registrationId: "r3" },
];
const rule = (overrides: Partial<RuleRow> & Pick<RuleRow, "id" | "kind" | "personAId">): RuleRow => ({
  personBId: null, effectiveFrom: null, effectiveUntil: null, ended: false, ...overrides,
});
const asSets = (groups: string[][]) => groups.map((group) => [...group].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));

describe("who is kept together", () => {
  it("keeps a registration's attendees together by default", () => {
    expect(asSets(togetherGroupsOn("2027-06-16", { people, rules: [], guardians: [] }))).toEqual([["adult1", "teen1"], ["adult2", "son2"]]);
  });

  it("keeps a minor with a declared responsible adult on another registration", () => {
    const guardians: GuardianLink[] = [{ authorityId: "g1", minorPersonId: "teen1", adultPersonId: "friend", declaredAt: "2027-01-01T00:00:00Z" }];
    expect(asSets(togetherGroupsOn("2027-06-16", { people, rules: [], guardians }))).toEqual([["adult1", "friend", "teen1"], ["adult2", "son2"]]);
  });

  it("ignores a guardian link whose adult is no longer registered", () => {
    const guardians: GuardianLink[] = [{ authorityId: "g1", minorPersonId: "teen1", adultPersonId: "gone", declaredAt: "2027-01-01T00:00:00Z" }];
    expect(asSets(togetherGroupsOn("2027-06-16", { people, rules: [], guardians }))).toEqual([["adult1", "teen1"], ["adult2", "son2"]]);
  });

  it("lets staff split a person out of the household and join two registrations", () => {
    const rules = [
      rule({ id: "s", kind: "SPLIT_HOUSEHOLD", personAId: "teen1" }),
      rule({ id: "j", kind: "KEEP_TOGETHER", personAId: "adult2", personBId: "friend" }),
    ];
    expect(asSets(togetherGroupsOn("2027-06-16", { people, rules, guardians: [] }))).toEqual([["adult2", "friend", "son2"]]);
  });

  it("applies a rule only on its nights and not once it has ended", () => {
    const windowed = rule({ id: "s", kind: "SPLIT_HOUSEHOLD", personAId: "teen1", effectiveFrom: "2027-06-17", effectiveUntil: "2027-06-18" });
    expect(asSets(togetherGroupsOn("2027-06-16", { people, rules: [windowed], guardians: [] }))[0]).toEqual(["adult1", "teen1"]);
    expect(asSets(togetherGroupsOn("2027-06-17", { people, rules: [windowed], guardians: [] })).flat()).not.toContain("teen1");
    const ended = { ...windowed, ended: true };
    expect(asSets(togetherGroupsOn("2027-06-17", { people, rules: [ended], guardians: [] }))[0]).toEqual(["adult1", "teen1"]);
  });

  it("finds a keep-apart rule that the household or responsible-adult rules contradict", () => {
    const apart = rule({ id: "x", kind: "SEPARATE", personAId: "adult1", personBId: "teen1" });
    expect(separationViolations(nights, { people, rules: [apart], guardians: [] })).toEqual([{ ruleId: "x", personAId: "adult1", personBId: "teen1", firstNight: "2027-06-15" }]);
    // Splitting the teen out of the household resolves it.
    const split = rule({ id: "s", kind: "SPLIT_HOUSEHOLD", personAId: "teen1" });
    expect(separationViolations(nights, { people, rules: [apart, split], guardians: [] })).toEqual([]);
    // A rule that only applies on a later night is reported from that night.
    const late = rule({ id: "y", kind: "SEPARATE", personAId: "adult1", personBId: "teen1", effectiveFrom: "2027-06-17" });
    expect(separationViolations(nights, { people, rules: [late], guardians: [] })[0]?.firstNight).toBe("2027-06-17");
    expect(separationViolations(nights, { people, rules: [{ ...late, ended: true }], guardians: [] })).toEqual([]);
  });
});

const capacity = (perNight: number | null, extra: Partial<CategoryCapacity> = {}): CategoryCapacity => ({
  perNight: Object.fromEntries(nights.map((night) => [night, perNight])), unitsInService: 2, groundLevelUnits: 1, ...extra,
});

describe("a party that can be split", () => {
  it("is not joined into one group by the household default", () => {
    const rules = [rule({ id: "x", kind: "SEPARATE", personAId: "adult1", personBId: "teen1" })];
    expect(separationViolations(nights, { people, rules, guardians: [] })).toHaveLength(1);
    expect(separationViolations(nights, { people, rules, guardians: [], flexibleRegistrationIds: ["r1"] })).toEqual([]);
    expect(asSets(togetherGroupsOn("2027-06-16", { people, rules: [], guardians: [], flexibleRegistrationIds: ["r1"] }))).toEqual([["adult2", "son2"]]);
  });

  it("still keeps a minor with a declared responsible adult", () => {
    const guardians: GuardianLink[] = [{ authorityId: "g1", minorPersonId: "teen1", adultPersonId: "adult1", declaredAt: "2027-01-01T00:00:00Z" }];
    expect(asSets(togetherGroupsOn("2027-06-16", { people, rules: [], guardians, flexibleRegistrationIds: ["r1"] }))).toContainEqual(["adult1", "teen1"]);
  });
});

describe("when a changed request needs room again", () => {
  const before = { category: "DORM_ROOM" as const, partySize: 2, nights: ["2027-06-15", "2027-06-16"] };
  it("does for a new request, another type, a bigger party or a new night", () => {
    expect(requestGrew(null, before)).toBe(true);
    expect(requestGrew(before, { ...before, category: "TENT" })).toBe(true);
    expect(requestGrew(before, { ...before, partySize: 3 })).toBe(true);
    expect(requestGrew(before, { ...before, nights: ["2027-06-15", "2027-06-16", "2027-06-17"] })).toBe(true);
    expect(requestGrew(before, { ...before, nights: ["2027-06-16", "2027-06-17"] })).toBe(true);
  });
  it("does not for the same, fewer people or fewer nights", () => {
    expect(requestGrew(before, before)).toBe(false);
    expect(requestGrew(before, { ...before, partySize: 1 })).toBe(false);
    expect(requestGrew(before, { ...before, nights: ["2027-06-16"] })).toBe(false);
  });
});

describe("the capacity at selection", () => {
  it("counts the people already asking, per night, for partial stays", () => {
    const demand = demandByCategoryNight([
      { registrationId: "r1", category: "DORM_ROOM", nights: ["2027-06-15", "2027-06-16"], partySize: 3 },
      { registrationId: "r2", category: "DORM_ROOM", nights: ["2027-06-16"], partySize: 1 },
      { registrationId: "r3", category: null, nights: nights, partySize: 9 },
    ]).get("DORM_ROOM");
    expect(demand?.get("2027-06-15")).toBe(3);
    expect(demand?.get("2027-06-16")).toBe(4);
    expect(categoryFits({ capacity: capacity(5), demand, nights: ["2027-06-15"], partySize: 2 }).fits).toBe(true);
    // The 16th is the full night: a stay that includes it does not fit, and one that ends before it does.
    expect(categoryFits({ capacity: capacity(5), demand, nights: ["2027-06-16", "2027-06-17"], partySize: 2 })).toMatchObject({ fits: false, firstFullNight: "2027-06-16", minimumAvailable: 1 });
    expect(categoryFits({ capacity: capacity(5), demand, nights: ["2027-06-17", "2027-06-18"], partySize: 5 }).fits).toBe(true);
  });

  it("never fills a category with no fixed limit and never fits one with nothing in service", () => {
    expect(categoryFits({ capacity: capacity(null), demand: new Map([["2027-06-15", 500]]), nights, partySize: 40 }).fits).toBe(true);
    expect(categoryFits({ capacity: capacity(10, { unitsInService: 0 }), demand: undefined, nights, partySize: 1 }).fits).toBe(false);
  });
});

const registrations: ReviewFacts["registrations"] = new Map([
  ["r1", { confirmationCode: "REG-1", label: "REG-1 (Alex Example)", active: true }],
  ["r2", { confirmationCode: "REG-2", label: "REG-2 (Blair Example)", active: true }],
  ["r3", { confirmationCode: "REG-3", label: "REG-3 (Casey Example)", active: true }],
  ["r4", { confirmationCode: "REG-4", label: "REG-4 (Drew Example)", active: false }],
]);
const request = (overrides: Partial<RequestSnapshot> & Pick<RequestSnapshot, "registrationId">): RequestSnapshot => ({
  requestId: `q-${overrides.registrationId}`, version: 1, category: "DORM_ROOM", firstNight: null, lastNight: null, partySize: 2,
  groundFloorNeeded: false, accessibleRoomNeeded: false, privateRoomRequested: false, householdPreference: "TOGETHER",
  afterDeadline: false, source: "REGISTRANT", updatedAt: "2027-02-01T00:00:00.000Z", ...overrides,
});
const facts = (overrides: Partial<ReviewFacts>): ReviewFacts => ({
  nights, registrations, people, requests: [], roommates: [], rules: [], guardians: [],
  capacity: { DORM_ROOM: capacity(100), TENT: capacity(null, { groundLevelUnits: 1 }), RV_SITE: capacity(2) }, ...overrides,
});
const kinds = (items: ReturnType<typeof buildReviewItems>) => items.map((item) => item.kind);

describe("the staff review queue", () => {
  it("lists a one-sided request, and drops it once mutual", () => {
    const one = row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r2" });
    const items = buildReviewItems(facts({ roommates: [one] }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "ONE_SIDED_ROOMMATE", roommateRequestId: "a", registrationIds: ["r1", "r2"] });
    const back = row({ id: "b", fromRegistrationId: "r2", targetRegistrationId: "r1" });
    expect(kinds(buildReviewItems(facts({ roommates: [one, back] })))).toEqual([]);
    expect(kinds(buildReviewItems(facts({ roommates: [{ ...one, decision: "DECLINED", } as RoommateRow] })))).toEqual([]);
  });

  it("lists a roommate request to a cancelled registration as impossible", () => {
    const gone = row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r4" });
    expect(kinds(buildReviewItems(facts({ roommates: [gone] })))).toEqual(["ROOMMATE_TARGET_UNAVAILABLE"]);
  });

  it("flags mutual roommates who asked for different lodging or share no night", () => {
    const pair = [row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r2" }), row({ id: "b", fromRegistrationId: "r2", targetRegistrationId: "r1" })];
    const differing = buildReviewItems(facts({
      roommates: pair,
      requests: [request({ registrationId: "r1", category: "DORM_ROOM" }), request({ registrationId: "r2", category: "RV_SITE" })],
    }));
    expect(kinds(differing)).toEqual(["CONFLICT_CATEGORY"]);
    const apart = buildReviewItems(facts({
      roommates: pair,
      requests: [
        request({ registrationId: "r1", firstNight: "2027-06-15", lastNight: "2027-06-16" }),
        request({ registrationId: "r2", firstNight: "2027-06-17", lastNight: "2027-06-18" }),
      ],
    }));
    expect(kinds(apart)).toEqual(["IMPOSSIBLE_DATES"]);
    // Overlapping partial stays are fine.
    const overlapping = buildReviewItems(facts({
      roommates: pair,
      requests: [
        request({ registrationId: "r1", firstNight: "2027-06-15", lastNight: "2027-06-17" }),
        request({ registrationId: "r2", firstNight: "2027-06-17", lastNight: "2027-06-18" }),
      ],
    }));
    expect(kinds(overlapping)).toEqual([]);
  });

  it("flags a keep-apart rule that contradicts roommates or the household", () => {
    const pair = [row({ id: "a", fromRegistrationId: "r1", targetRegistrationId: "r2" }), row({ id: "b", fromRegistrationId: "r2", targetRegistrationId: "r1" })];
    const apart = rule({ id: "x", kind: "SEPARATE", personAId: "adult1", personBId: "adult2" });
    expect(kinds(buildReviewItems(facts({ roommates: pair, rules: [apart] })))).toEqual(["CONFLICT_SEPARATION"]);
    const household = rule({ id: "y", kind: "SEPARATE", personAId: "adult1", personBId: "teen1" });
    expect(kinds(buildReviewItems(facts({ rules: [household] })))).toEqual(["CONFLICT_SEPARATION"]);
  });

  it("flags requests changed after the deadline and a type with nothing in service", () => {
    const items = buildReviewItems(facts({
      requests: [request({ registrationId: "r1", afterDeadline: true }), request({ registrationId: "r2", category: "TENT_WITH_POWER" })],
    }));
    expect(kinds(items).sort()).toEqual(["CATEGORY_UNAVAILABLE", "PAST_DEADLINE"]);
  });

  it("flags nights outside the event after the event's window changed", () => {
    const items = buildReviewItems(facts({ requests: [request({ registrationId: "r1", firstNight: "2027-06-10", lastNight: "2027-06-12" })] }));
    expect(kinds(items)).toEqual(["IMPOSSIBLE_DATES"]);
  });

  it("flags more people asking than a category takes on some night, and ignores cancelled registrations", () => {
    const over = buildReviewItems(facts({
      capacity: { RV_SITE: capacity(3) },
      requests: [request({ registrationId: "r1", category: "RV_SITE", partySize: 2 }), request({ registrationId: "r2", category: "RV_SITE", partySize: 2 })],
    }));
    expect(over.map((item) => item.kind)).toEqual(["OVER_CAPACITY"]);
    expect(over[0]?.title).toContain("4 people");
    const cancelled = buildReviewItems(facts({
      capacity: { RV_SITE: capacity(3) },
      requests: [request({ registrationId: "r1", category: "RV_SITE", partySize: 2 }), request({ registrationId: "r4", category: "RV_SITE", partySize: 2 })],
    }));
    expect(kinds(cancelled)).toEqual([]);
  });

  it("marks accessibility items sensitive, and reports a ground floor need that a type cannot meet", () => {
    const items = buildReviewItems(facts({
      capacity: { DORM_ROOM: capacity(100, { groundLevelUnits: 0 }) },
      requests: [request({ registrationId: "r1", groundFloorNeeded: true }), request({ registrationId: "r2", accessibleRoomNeeded: true, category: null })],
    }));
    expect(items.map((item) => [item.kind, item.sensitive])).toEqual([
      ["ACCESSIBILITY_NEEDED", true],
      ["ACCESSIBILITY_NEEDED", true],
      ["ACCESSIBILITY_UNMET", true],
    ]);
    // A review item never carries free text from the guest: only the flags' meaning.
    for (const item of items) expect(`${item.title} ${item.detail}`).not.toMatch(/surgery|medication|diagnos/i);
    expect(buildReviewItems(facts({ requests: [request({ registrationId: "r1" })] })).filter((item) => item.sensitive)).toEqual([]);
  });

  it("lists an open change request for an active registration", () => {
    const items = buildReviewItems(facts({ changeRequests: [{ id: "c1", registrationId: "r1", category: "DORM_ROOM" }, { id: "c2", registrationId: "r4", category: "TENT" }] }));
    expect(items.map((item) => [item.kind, item.key])).toEqual([["CHANGE_REQUESTED", "change:c1"]]);
  });

  it("names the charge change a registrant asked for, with its sign", () => {
    const up = buildReviewItems(facts({ changeRequests: [{ id: "c1", registrationId: "r1", category: "DORM_ROOM", chargedCents: 4000, requestedCents: 6000 }] }));
    expect(up[0]?.title).toContain("lodging charge change requested (+$20.00)");
    const down = buildReviewItems(facts({ changeRequests: [{ id: "c1", registrationId: "r1", category: "TENT", chargedCents: 6000, requestedCents: 4000 }] }));
    expect(down[0]?.title).toContain("-$20.00");
    expect(up[0]?.fingerprint).not.toBe(down[0]?.fingerprint);
  });

  it("flags a party larger than the registration's active attendees, and only then", () => {
    const larger = buildReviewItems(facts({ requests: [request({ registrationId: "r1", partySize: 5 })] }));
    expect(kinds(larger)).toContain("PARTY_EXCEEDS_ATTENDEES");
    const fits = buildReviewItems(facts({ requests: [request({ registrationId: "r1", partySize: 1 })] }));
    expect(kinds(fits)).not.toContain("PARTY_EXCEEDS_ATTENDEES");
  });

  it("lists a charge that differs from the request, and nothing when they agree", () => {
    const differs = buildReviewItems(facts({ lodgingCharges: [{ registrationId: "r1", chargedCents: 4000, currentCents: 6000 }] }));
    expect(kinds(differs)).toEqual(["PRICE_DIFFERS"]);
    expect(buildReviewItems(facts({ lodgingCharges: [{ registrationId: "r1", chargedCents: 4000, currentCents: 4000 }] }))).toEqual([]);
  });

  it("changes an item's fingerprint when the request changes, so an acknowledged item returns", () => {
    const first = buildReviewItems(facts({ requests: [request({ registrationId: "r1", afterDeadline: true, version: 2 })] }));
    const later = buildReviewItems(facts({ requests: [request({ registrationId: "r1", afterDeadline: true, version: 3 })] }));
    expect(first[0]?.key).toBe(later[0]?.key);
    expect(first[0]?.fingerprint).not.toBe(later[0]?.fingerprint);
  });
});

describe("the general export", () => {
  const exportRow = {
    confirmationCode: "REG-1", category: "DORM_ROOM" as const, firstNight: "2027-06-16", lastNight: "2027-06-17", partySize: 2,
    privateRoomRequested: true, householdPreference: "TOGETHER" as const, mutualRoommates: 1, waitingRoommates: 2,
    updatedAt: "2027-02-01T00:00:00.000Z", groundFloorNeeded: true, accessibleRoomNeeded: false,
  };

  it("holds approved fields only and adds the accessibility columns only on request", () => {
    expect(lodgingRequestExportCells(exportRow, false)).toHaveLength(LODGING_REQUEST_CSV_HEADERS.length);
    expect(lodgingRequestExportCells(exportRow, true)).toHaveLength(LODGING_REQUEST_CSV_HEADERS.length + LODGING_REQUEST_ACCESSIBILITY_HEADERS.length);
    const plain = lodgingRequestsCsv([exportRow], false);
    expect(plain).not.toMatch(/ground floor|accessible/i);
    expect(plain).toContain("REG-1");
    const restricted = lodgingRequestsCsv([exportRow], true);
    expect(restricted).toMatch(/Ground floor needed/);
    expect(restricted).toMatch(/Yes/);
  });

  it("has no name, email, phone or address column", () => {
    const headers = [...LODGING_REQUEST_CSV_HEADERS, ...LODGING_REQUEST_ACCESSIBILITY_HEADERS].join(" ").toLowerCase();
    for (const forbidden of ["name", "email", "phone", "address", "note", "medical"]) expect(headers).not.toContain(forbidden);
  });
});
