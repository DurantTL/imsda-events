import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClassRequirementNotes } from "@/components/class-requirement-notes";
import { classRequirementGaps, unavailableReason } from "@/modules/honors/class-picker-view";
import {
  hasClassRequirements,
  requirementGaps,
  requirementResolution,
  selectionProblem,
  type SelectableOffering,
} from "@/modules/honors/enrollment-domain";
import { firstPickProblem, pickingAttendees, pruneConfirmations } from "@/modules/honors/registration-picks";
import { honorOfferingInputSchema, honorOfferingUpdateSchema } from "@/modules/honors/schemas";

// Synthetic classes and people only (#832).
const offering = (id: string, overrides: Partial<SelectableOffering> = {}): SelectableOffering => ({
  id, honorName: id, span: "SINGLE_SESSION", sessionId: id, minimumAge: null, isActive: true, ...overrides,
});
const knotsBasic = { id: "honor-knots", name: "Knots" };
const birds = { id: "honor-birds", name: "Birds" };
const advanced = offering("advanced", { minimumClassLevel: "GUIDE" });
const needsKnots = offering("needs-knots", { prerequisiteHonors: [knotsBasic] });
const both = offering("both", { minimumClassLevel: "RANGER", prerequisiteHonors: [knotsBasic, birds] });
const catalog = new Map([advanced, needsKnots, both, offering("plain")].map((row) => [row.id, row]));

describe("class level and prerequisite rules (#832)", () => {
  it("knows which classes ask for anything", () => {
    expect(hasClassRequirements(advanced)).toBe(true);
    expect(hasClassRequirements(needsKnots)).toBe(true);
    expect(hasClassRequirements(offering("plain"))).toBe(false);
    expect(hasClassRequirements(offering("none", { prerequisiteHonors: [] }))).toBe(false);
  });

  it("allows a level at or above the minimum, in the roster's order", () => {
    for (const classLevel of ["GUIDE", "TLT", "MASTER_GUIDE"] as const) {
      expect(selectionProblem({ ageOnEventDate: 15, classLevel }, ["advanced"], catalog)).toBeNull();
    }
  });

  it("refuses a level known to be below the minimum, and a director confirmation does not help", () => {
    const attendee = { ageOnEventDate: 12, classLevel: "RANGER" as const };
    expect(selectionProblem(attendee, ["advanced"], catalog)).toMatch(/class level Guide or higher, and this person is Ranger/);
    expect(selectionProblem(attendee, ["advanced"], catalog, new Set(), { confirmed: new Set(["advanced"]) })).toMatch(/this person is Ranger/);
  });

  it("allows a missing level only when the director confirms it", () => {
    const attendee = { ageOnEventDate: 12, classLevel: null };
    expect(selectionProblem(attendee, ["advanced"], catalog)).toMatch(/class level isn't on the roster/);
    expect(selectionProblem(attendee, ["advanced"], catalog, new Set(), { confirmed: new Set(["advanced"]) })).toBeNull();
    // A person with no class-level field at all (an extra person) is treated the same way.
    expect(selectionProblem({ ageOnEventDate: 12 }, ["advanced"], catalog)).toMatch(/isn't on the roster/);
  });

  it("requires every prerequisite honor to be on the member's honor record", () => {
    expect(selectionProblem({ ageOnEventDate: 12, completedHonorIds: [knotsBasic.id] }, ["needs-knots"], catalog)).toBeNull();
    expect(selectionProblem({ ageOnEventDate: 12, completedHonorIds: [] }, ["needs-knots"], catalog)).toMatch(/needs Knots completed first/);
    const partial = { ageOnEventDate: 12, classLevel: "GUIDE" as const, completedHonorIds: [knotsBasic.id] };
    expect(selectionProblem(partial, ["both"], catalog)).toMatch(/needs Birds completed first/);
  });

  it("allows a missing honor record only when the director confirms it", () => {
    const attendee = { ageOnEventDate: 12, completedHonorIds: [] as string[] };
    expect(selectionProblem(attendee, ["needs-knots"], catalog, new Set(), { confirmed: new Set(["needs-knots"]) })).toBeNull();
    // The tick is per class: confirming another class does nothing here.
    expect(selectionProblem(attendee, ["needs-knots"], catalog, new Set(), { confirmed: new Set(["advanced"]) })).toMatch(/Knots/);
  });

  it("lets staff place someone past either rule with a reason, and nothing without one", () => {
    const attendee = { ageOnEventDate: 12, classLevel: "FRIEND" as const, completedHonorIds: [] as string[] };
    expect(selectionProblem(attendee, ["both"], catalog)).not.toBeNull();
    expect(selectionProblem(attendee, ["both"], catalog, new Set(), { overrides: new Map([["both", "  "]]) })).not.toBeNull();
    expect(selectionProblem(attendee, ["both"], catalog, new Set(), { overrides: new Map([["both", "Approved by the Area Coordinator"]]) })).toBeNull();
  });

  it("records how each rule was waived", () => {
    const attendee = { classLevel: null, completedHonorIds: [] as string[] };
    expect(requirementResolution(attendee, both, { confirmed: new Set(["both"]) })).toEqual({
      problem: null, levelConfirmed: true, prerequisitesConfirmed: true, overrideReason: null,
    });
    const below = { classLevel: "FRIEND" as const, completedHonorIds: [knotsBasic.id, birds.id] };
    expect(requirementResolution(below, both, { overrides: new Map([["both", "  Reason  "]]) })).toEqual({
      problem: null, levelConfirmed: false, prerequisitesConfirmed: false, overrideReason: "Reason",
    });
    // A reason that was not needed is not recorded.
    expect(requirementResolution({ classLevel: "GUIDE" }, advanced, { overrides: new Map([["advanced", "Not needed"]]) }).overrideReason).toBeNull();
  });

  it("does not ask staff, adults or underage children, who take no seat", () => {
    expect(requirementGaps({ consumesSeat: false, classLevel: null }, both)).toEqual([]);
    expect(selectionProblem({ ageOnEventDate: 40, consumesSeat: false }, ["both"], catalog)).toBeNull();
  });

  it("never re-checks a class the person already holds", () => {
    expect(selectionProblem({ ageOnEventDate: 12, classLevel: "FRIEND" }, ["advanced"], catalog, new Set(["advanced"]))).toBeNull();
  });

  it("checks every class chosen, not just the first", () => {
    const attendee = { ageOnEventDate: 12, classLevel: "GUIDE" as const, completedHonorIds: [] as string[] };
    expect(selectionProblem(attendee, ["advanced", "needs-knots"], catalog)).toMatch(/needs Knots/);
  });
});

describe("what the class picker shows (#832)", () => {
  const picker = { ...advanced, perClubLimit: null, capacity: 10, seatsTaken: 0, clubSeatsTaken: 0 };
  const person = { attendeeType: "YOUTH", consumesSeat: true, ageOnEventDate: 12 };

  it("greys out a level known to be too low, with the reason", () => {
    expect(unavailableReason(picker, false, { ...person, classLevel: "EXPLORER" })).toBe("Guide+ (this person is Explorer)");
    expect(unavailableReason(picker, false, { ...person, classLevel: "GUIDE" })).toBeNull();
  });

  it("leaves a class pickable when only a confirmation is needed, but not for a group", () => {
    expect(unavailableReason(picker, false, { ...person, classLevel: null })).toBeNull();
    expect(unavailableReason(picker, false, { ...person, classLevel: null }, { canConfirm: false })).toBe("Guide+ (level not on roster)");
  });

  it("lets staff acting as the director pick a class that is too advanced", () => {
    expect(unavailableReason(picker, false, { ...person, classLevel: "FRIEND" }, { canOverride: true })).toBeNull();
  });

  it("describes the prerequisites a person is missing", () => {
    const prerequisite = { ...needsKnots, perClubLimit: null, capacity: 10, seatsTaken: 0, clubSeatsTaken: 0 };
    expect(classRequirementGaps(prerequisite, { ...person, completedHonorIds: [] })[0]).toMatchObject({ kind: "HONORS_MISSING", confirmable: true });
    expect(classRequirementGaps(prerequisite, { ...person, completedHonorIds: [knotsBasic.id] })).toEqual([]);
  });

  it("keeps the old reasons first", () => {
    expect(unavailableReason({ ...picker, minimumAge: 14 }, false, { ...person, classLevel: "FRIEND" })).toBe("ages 14+");
    expect(unavailableReason({ ...picker, isActive: false }, false, person)).toBe("no longer offered");
  });

  it("shows the confirmation under a person who picked such a class", () => {
    const html = renderToStaticMarkup(createElement(ClassRequirementNotes, {
      canConfirm: true,
      canOverride: false,
      confirmed: [],
      heldIds: [],
      offerings: [{ ...both, perClubLimit: null, capacity: 10, seatsTaken: 0, clubSeatsTaken: 0 }],
      onConfirmedChange: () => undefined,
      onReasonChange: () => undefined,
      person: { firstName: "Ada", lastName: "Demo", consumesSeat: true, attendeeType: "YOUTH", ageOnEventDate: 12, classLevel: null, completedHonorIds: [] },
      reasons: {},
    }));
    expect(html).toContain("I confirm");
    expect(html).toContain("class level Ranger or higher");
    expect(html).toContain("Knots, Birds completed");
    expect(html).not.toContain("Reason staff are placing");
  });

  it("asks staff for a reason instead, and group registrations get no confirmation", () => {
    const base = {
      confirmed: [] as string[], heldIds: [] as string[], onConfirmedChange: () => undefined, onReasonChange: () => undefined, reasons: {},
      offerings: [{ ...advanced, perClubLimit: null, capacity: 10, seatsTaken: 0, clubSeatsTaken: 0 }],
      person: { firstName: "Ada", lastName: "Demo", consumesSeat: true, attendeeType: "YOUTH", ageOnEventDate: 12, classLevel: "FRIEND" as const, completedHonorIds: [] },
    };
    expect(renderToStaticMarkup(createElement(ClassRequirementNotes, { ...base, canConfirm: true, canOverride: true }))).toContain("Reason staff are placing");
    expect(renderToStaticMarkup(createElement(ClassRequirementNotes, { ...base, person: { ...base.person, classLevel: null }, canConfirm: false, canOverride: false }))).not.toContain("I confirm");
  });
});

describe("registration-time picks (#832)", () => {
  const roster = [
    { memberId: "m1", firstName: "Ada", lastName: "Demo", ageOnEventDate: 12, attendeeType: "YOUTH" as const },
    { memberId: "m2", firstName: "Ben", lastName: "Demo", ageOnEventDate: 14, attendeeType: "YOUTH" as const },
  ];
  const people = pickingAttendees({
    roster, selectedMemberIds: ["m1", "m2"], guests: [{ id: "g1", firstName: "Gus", lastName: "Demo", age: 11 }],
    memberRequirements: { m1: { classLevel: "GUIDE", completedHonorIds: [] }, m2: { classLevel: "FRIEND", completedHonorIds: [] } },
  });
  const pickable = [{ ...advanced, siteId: null }];

  it("hands each person their roster level, and an extra person none", () => {
    expect(people.map((person) => person.classLevel)).toEqual(["GUIDE", "FRIEND", null]);
  });

  it("blocks the form until the director confirms, and never lets a too-low level through", () => {
    const picks = { "member:m1": ["advanced"], "guest:g1": ["advanced"] };
    expect(firstPickProblem({ "member:m1": ["advanced"] }, people, pickable)).toBeNull();
    expect(firstPickProblem({ "member:m2": ["advanced"] }, people, pickable, { "member:m2": ["advanced"] })).toMatch(/Ben Demo.*this person is Friend/);
    expect(firstPickProblem(picks, people, pickable)).toMatch(/Gus Demo.*isn't on the roster/);
    expect(firstPickProblem(picks, people, pickable, { "guest:g1": ["advanced"] })).toBeNull();
  });

  it("drops a tick for a class that is no longer picked", () => {
    expect(pruneConfirmations({ a: ["x", "y"], b: ["z"] }, { a: ["y"] })).toEqual({ a: ["y"] });
  });
});

describe("the staff catalog form (#832)", () => {
  const base = { honorIds: ["h1"], span: "ALL_SESSIONS" as const, capacity: 10 };

  it("takes a minimum level and prerequisite honors, defaulting to none", () => {
    const plain = honorOfferingInputSchema.parse(base) as { minimumClassLevel: unknown; prerequisiteHonorIds: unknown };
    expect(plain.minimumClassLevel).toBeNull();
    expect(plain.prerequisiteHonorIds).toEqual([]);
    const set = honorOfferingInputSchema.parse({ ...base, minimumClassLevel: "GUIDE", prerequisiteHonorIds: ["h2", "h3"] }) as { minimumClassLevel: unknown };
    expect(set.minimumClassLevel).toBe("GUIDE");
  });

  it("refuses an unknown level and a prerequisite listed twice", () => {
    expect(honorOfferingInputSchema.safeParse({ ...base, minimumClassLevel: "WIZARD" }).success).toBe(false);
    expect(honorOfferingInputSchema.safeParse({ ...base, prerequisiteHonorIds: ["h2", "h2"] }).success).toBe(false);
  });

  it("leaves both alone on an edit that names neither", () => {
    expect(honorOfferingUpdateSchema.parse({ capacity: 5 })).toEqual({ capacity: 5 });
    expect(honorOfferingUpdateSchema.parse({ minimumClassLevel: null, prerequisiteHonorIds: [] })).toEqual({ minimumClassLevel: null, prerequisiteHonorIds: [] });
  });
});

describe("which honors count as completed (#486, #832)", () => {
  it("counts only the latest non-voided entry per person and honor", async () => {
    const { completedFromLatestEntries } = await import("@/modules/honors/completed-honors");
    // Newest first, as the repository reads them.
    const completed = completedFromLatestEntries([
      { personId: "p1", honorId: "knots", status: "IN_PROGRESS" },
      { personId: "p1", honorId: "knots", status: "COMPLETED" },
      { personId: "p1", honorId: "birds", status: "COMPLETED" },
      { personId: "p2", honorId: "knots", status: "COMPLETED" },
      { personId: "p2", honorId: "knots", status: "IN_PROGRESS" },
    ]);
    // A completion later corrected to in progress doesn't count; a re-completion after it would.
    expect([...(completed.get("p1") ?? [])]).toEqual(["birds"]);
    expect([...(completed.get("p2") ?? [])]).toEqual(["knots"]);
  });
});
