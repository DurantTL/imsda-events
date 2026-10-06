import { describe, expect, it } from "vitest";
import {
  assignmentActionSchema,
  assignmentCsvCells,
  assignmentWarnings,
  canMoveWaitlist,
  checkUnitPlacement,
  firstNameOf,
  householdColorIndex,
  isOfferLapsed,
  noticeIsObsolete,
  occupancyByNight,
  occupancyOf,
  overBedsByNight,
  offerExpiry,
  parseAssignmentCsv,
  placementSchema,
  planCancellation,
  planPlacements,
  planPlacementsLenient,
  planStayChange,
  planTransfer,
  proposeAssignments,
  rangesOverlap,
  subtractRange,
  unitConflicts,
  waitlistRegistrantActionSchema,
  waitlistStaffActionSchema,
  waitlistTransitions,
  type PlanPlacement,
  type PlanUnit,
  type ProposalPerson,
  type ProposalUnit,
  type Segment,
} from "@/modules/lodging/assignment-domain";
import { lodgingReportCsv } from "@/modules/lodging/assignment-export";
import type { RoomingReports } from "@/modules/lodging/assignment-view";
import { parseCsvMatrix } from "@/modules/imports/csv-parser";

const nights = ["2027-06-15", "2027-06-16", "2027-06-17", "2027-06-18"];

function unit(id: string, capacity: number | null, extra: Partial<PlanUnit> = {}): PlanUnit {
  return {
    unitId: id, assignable: true, retired: false, defaultCapacity: capacity, capacityOverride: null, unavailable: false,
    activeFrom: null, activeUntil: null, holds: [], name: `Room ${id}`, specialUse: false, ...extra,
  };
}

const units = (...list: PlanUnit[]) => new Map(list.map((entry) => [entry.unitId, entry]));

function place(key: string, unitId: string, first = nights[0]!, last = nights[3]!, extra: Partial<PlanPlacement> = {}): PlanPlacement {
  return {
    occupantKey: key, occupant: { attendeeId: key, placeholderId: null }, people: 1, place: { unitId },
    firstNight: first, lastNight: last, mode: "ASSIGN", confirmSpecialUse: false, source: "STAFF", ...extra,
  };
}

const segment = (id: string, key: string, unitId: string | null, first = nights[0]!, last = nights[3]!, people = 1, bucketId: string | null = null): Segment => ({
  id, occupantKey: key, unitId, bucketId, people, firstNight: first, lastNight: last,
});

const base = { buckets: new Set(["bucket-hotel"]), eventNights: nights };

describe("night ranges", () => {
  it("subtracts a cut: nothing, one piece, or a split in two", () => {
    expect(subtractRange({ firstNight: "2027-06-15", lastNight: "2027-06-18" }, { firstNight: "2027-06-15", lastNight: "2027-06-18" })).toEqual([]);
    expect(subtractRange({ firstNight: "2027-06-15", lastNight: "2027-06-18" }, { firstNight: "2027-06-17", lastNight: "2027-06-18" })).toEqual([{ firstNight: "2027-06-15", lastNight: "2027-06-16" }]);
    expect(subtractRange({ firstNight: "2027-06-15", lastNight: "2027-06-18" }, { firstNight: "2027-06-16", lastNight: "2027-06-17" })).toEqual([
      { firstNight: "2027-06-15", lastNight: "2027-06-15" },
      { firstNight: "2027-06-18", lastNight: "2027-06-18" },
    ]);
    expect(subtractRange({ firstNight: "2027-06-15", lastNight: "2027-06-16" }, { firstNight: "2027-06-17", lastNight: "2027-06-18" })).toEqual([{ firstNight: "2027-06-15", lastNight: "2027-06-16" }]);
    expect(rangesOverlap({ firstNight: "2027-06-15", lastNight: "2027-06-16" }, { firstNight: "2027-06-16", lastNight: "2027-06-17" })).toBe(true);
    expect(rangesOverlap({ firstNight: "2027-06-15", lastNight: "2027-06-16" }, { firstNight: "2027-06-17", lastNight: "2027-06-17" })).toBe(false);
  });
});

describe("placement checks", () => {
  it("blocks a held, unavailable or retired unit night by night and says which night", () => {
    const held = unit("a", 2, { holds: [{ id: "h", firstNight: "2027-06-16", lastNight: "2027-06-16" }] });
    expect(checkUnitPlacement({ unit: held, occupancy: undefined, nights: nights, people: 1, confirmSpecialUse: false })).toMatchObject({ code: "UNIT_OUT_OF_SERVICE", night: "2027-06-16" });
    // The nights around the hold are fine: a partial stay fits.
    expect(checkUnitPlacement({ unit: held, occupancy: undefined, nights: ["2027-06-17", "2027-06-18"], people: 1, confirmSpecialUse: false })).toBeNull();
    expect(checkUnitPlacement({ unit: unit("b", 2, { unavailable: true }), occupancy: undefined, nights, people: 1, confirmSpecialUse: false })?.code).toBe("UNIT_OUT_OF_SERVICE");
    expect(checkUnitPlacement({ unit: unit("c", 2, { retired: true }), occupancy: undefined, nights, people: 1, confirmSpecialUse: false })?.code).toBe("UNIT_OUT_OF_SERVICE");
    expect(checkUnitPlacement({ unit: unit("d", 0, { assignable: false }), occupancy: undefined, nights, people: 1, confirmSpecialUse: false })?.code).toBe("UNIT_OUT_OF_SERVICE");
  });

  it("counts people night by night against the override, and a room with no fixed limit never fills", () => {
    const room = unit("a", 2, { capacityOverride: 3 });
    const full = new Map([["2027-06-17", 3]]);
    expect(checkUnitPlacement({ unit: room, occupancy: full, nights, people: 1, confirmSpecialUse: false })).toMatchObject({ code: "UNIT_FULL", night: "2027-06-17" });
    expect(checkUnitPlacement({ unit: room, occupancy: full, nights: ["2027-06-15", "2027-06-16"], people: 3, confirmSpecialUse: false })).toBeNull();
    expect(checkUnitPlacement({ unit: unit("area", null), occupancy: new Map(nights.map((night) => [night, 500])), nights, people: 40, confirmSpecialUse: false })).toBeNull();
  });

  it("asks for a confirmation before a special-use room", () => {
    const special = unit("s", 8, { specialUse: true });
    expect(checkUnitPlacement({ unit: special, occupancy: undefined, nights, people: 1, confirmSpecialUse: false })?.code).toBe("SPECIAL_USE_UNCONFIRMED");
    expect(checkUnitPlacement({ unit: special, occupancy: undefined, nights, people: 1, confirmSpecialUse: true })).toBeNull();
  });
});

describe("planPlacements", () => {
  it("assigns, refuses a double assignment, and treats an identical request as unchanged", () => {
    const result = planPlacements({ ...base, segments: [], units: units(unit("a", 2)), placements: [place("p1", "a"), place("p1", "a")] });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.plan.creates).toHaveLength(1);
    expect(result.plan.unchanged).toBe(1);
    expect(result.plan.creates[0]!.type).toBe("ASSIGNED");

    const conflict = planPlacements({ ...base, segments: [segment("s1", "p1", "a")], units: units(unit("a", 2), unit("b", 2)), placements: [place("p1", "b", nights[1], nights[2])] });
    expect(conflict).toMatchObject({ ok: false, problem: { code: "ALREADY_ASSIGNED", night: nights[1] } });
  });

  it("moves two separate nights out of one stay in one batch, editing the remainder the first move created", () => {
    const result = planPlacements({
      ...base, segments: [segment("s1", "p1", "a")], units: units(unit("a", 2), unit("b", 2), unit("c", 2)),
      placements: [place("p1", "b", nights[1], nights[1], { mode: "MOVE" }), place("p1", "c", nights[2], nights[2], { mode: "MOVE" })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the real row is released (once: it keeps the first night); nothing releases a row that does not exist yet.
    expect(result.plan.releases.map((release) => release.id)).toEqual(["s1"]);
    expect(result.plan.releases.every((release) => !release.id.startsWith("new:"))).toBe(true);
    const ranges = result.plan.after.map((entry) => `${entry.unitId}:${entry.firstNight}..${entry.lastNight}`).sort();
    expect(ranges).toEqual([`a:${nights[0]}..${nights[0]}`, `a:${nights[3]}..${nights[3]}`, `b:${nights[1]}..${nights[1]}`, `c:${nights[2]}..${nights[2]}`]);
    // Every create is a row to write, and the one that is a remainder of a created row names no key that will not exist.
    const keys = new Set(result.plan.creates.map((create) => create.key));
    expect(result.plan.creates.every((create) => !create.relatedId || !create.relatedId.startsWith("new:") || keys.has(create.relatedId))).toBe(true);
  });

  it("records a batch's own earlier placement as it began: assign to X then move to Y is an assignment to Y", () => {
    const fresh = planPlacements({ ...base, segments: [], units: units(unit("a", 2), unit("b", 2)), placements: [place("p1", "a"), place("p1", "b", nights[0]!, nights[3]!, { mode: "MOVE" })] });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.plan.releases).toHaveLength(0);
    expect(fresh.plan.creates).toHaveLength(1);
    expect(fresh.plan.creates[0]).toMatchObject({ type: "ASSIGNED", segment: { unitId: "b" } });
    expect(fresh.plan.creates[0]!.previous).toBeUndefined();
    expect(fresh.plan.creates[0]!.relatedId).toBeUndefined();

    // Moved out of a real row to X, then on to Y: a move in from the real row, never from X.
    const chained = planPlacements({ ...base, segments: [segment("s1", "p1", "a")], units: units(unit("a", 2), unit("b", 2), unit("c", 2)), placements: [place("p1", "b", nights[0]!, nights[3]!, { mode: "MOVE" }), place("p1", "c", nights[0]!, nights[3]!, { mode: "MOVE" })] });
    expect(chained.ok).toBe(true);
    if (!chained.ok) return;
    expect(chained.plan.creates).toHaveLength(1);
    expect(chained.plan.creates[0]).toMatchObject({ type: "MOVED_IN", relatedId: "s1", segment: { unitId: "c" }, previous: { unitId: "a" } });
  });

  describe("a stay cut several times in one batch", () => {
    const week = Array.from({ length: 7 }, (_, index) => `2027-06-${String(15 + index).padStart(2, "0")}`);
    const weekBase = { ...base, eventNights: week };
    const cuts = (indexes: number[]) => indexes.map((index, order) => place("p1", ["b", "c", "d"][order]!, week[index]!, week[index]!, { mode: "MOVE" }));
    const allUnits = units(unit("a", 2), unit("b", 2), unit("c", 2), unit("d", 2));

    function check(first: number, last: number, cutIndexes: number[]) {
      const result = planPlacements({ ...weekBase, segments: [segment("s1", "p1", "a", week[first]!, week[last]!)], units: allUnits, placements: cuts(cutIndexes) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Every create can be written: it names its occupant, or a real row (never a key of this plan) to take it from.
      for (const create of result.plan.creates) {
        const resolvable = Boolean(create.occupant.attendeeId || create.occupant.placeholderId) || Boolean(create.relatedId && !create.relatedId.startsWith("new:"));
        expect(resolvable, `${create.type} ${create.key} relatedId ${create.relatedId}`).toBe(true);
      }
      expect(result.plan.releases.every((release) => !release.id.startsWith("new:"))).toBe(true);
      // Exact coverage: every night of the stay, once, in the right room.
      const covered = new Map<string, string>();
      for (const entry of result.plan.after) {
        for (let index = week.indexOf(entry.firstNight); index <= week.indexOf(entry.lastNight); index += 1) {
          expect(covered.has(week[index]!)).toBe(false);
          covered.set(week[index]!, entry.unitId!);
        }
      }
      expect([...covered.keys()].sort()).toEqual(week.slice(first, last + 1));
      cutIndexes.forEach((index, order) => expect(covered.get(week[index]!)).toBe(["b", "c", "d"][order]));
      week.slice(first, last + 1).forEach((night, offset) => { if (!cutIndexes.includes(first + offset)) expect(covered.get(night)).toBe("a"); });
    }

    it("takes the occupant of a remainder cut again from the real row", () => check(0, 4, [1, 3]));
    it("does the same for three cuts out of seven nights", () => check(0, 6, [1, 3, 5]));
  });

  describe("history of a batch's own placements", () => {
    const six = Array.from({ length: 6 }, (_, index) => `2027-06-${String(15 + index).padStart(2, "0")}`);
    const sixBase = { ...base, eventNights: six };
    const sixUnits = units(unit("a", null), unit("b", null), unit("c", null), unit("d", null));
    const step = (unitId: string, first: number, last: number, mode: "ASSIGN" | "MOVE" = "MOVE") => place("p1", unitId, six[first]!, six[last]!, { mode });

    it("records someone never placed before as assigned, however the batch cuts and moves them", () => {
      for (const placements of [
        [step("d", 1, 4), step("d", 2, 2), step("d", 3, 3)],
        [step("a", 0, 2, "ASSIGN"), step("a", 1, 1), step("a", 0, 1), step("a", 0, 2)],
      ]) {
        const result = planPlacements({ ...sixBase, segments: [], units: sixUnits, placements });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        for (const create of result.plan.creates) {
          expect(create).toMatchObject({ type: "ASSIGNED" });
          expect(create.relatedId).toBeUndefined();
          expect(create.previous).toBeUndefined();
        }
      }
    });

    it("never links a create to a key of the same plan (seeded random batches)", () => {
      let seed = 20261006;
      const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
      for (let run = 0; run < 3000; run += 1) {
        const fresh = run % 2 === 0;
        const placements = Array.from({ length: 1 + random(6) }, () => {
          const first = random(6);
          return step(["a", "b", "c", "d"][random(4)]!, first, first + random(6 - first), random(3) === 0 ? "ASSIGN" : "MOVE");
        });
        const outcome = planPlacementsLenient({ ...sixBase, segments: fresh ? [] : [segment("s1", "p1", "a", six[0]!, six[5]!)], units: sixUnits, placements });
        for (const create of outcome.plan.creates) {
          expect(create.relatedId?.startsWith("new:") ?? false, `run ${run}: ${create.type} ${create.key} -> ${create.relatedId}`).toBe(false);
          if (fresh) expect(create.type, `run ${run}`).toBe("ASSIGNED");
          else if (create.type !== "ASSIGNED") expect(create.relatedId, `run ${run}`).toBe("s1");
        }
        for (const release of outcome.plan.releases) {
          if (release.relatedKey) expect(outcome.plan.creates.some((create) => create.key === release.relatedKey), `run ${run}`).toBe(true);
        }
      }
    });
  });

  it("points a release at the placement that replaced the one it was linked to", () => {
    const chained = planPlacements({ ...base, segments: [segment("s1", "p1", "a")], units: units(unit("a", 2), unit("b", 2), unit("c", 2)), placements: [place("p1", "b", nights[0]!, nights[3]!, { mode: "MOVE" }), place("p1", "c", nights[0]!, nights[3]!, { mode: "MOVE" })] });
    expect(chained.ok).toBe(true);
    if (!chained.ok) return;
    expect(chained.plan.creates).toHaveLength(1);
    expect(chained.plan.releases).toHaveLength(1);
    expect(chained.plan.releases[0]!.relatedKey).toBe(chained.plan.creates[0]!.key);
  });

  it("never overbooks a batch with itself: the last bed goes to one person", () => {
    const result = planPlacements({ ...base, segments: [], units: units(unit("a", 1)), placements: [place("p1", "a"), place("p2", "a")] });
    expect(result).toMatchObject({ ok: false, index: 1, problem: { code: "UNIT_FULL" } });
  });

  it("lets two people share a bed on different nights (partial stays)", () => {
    const result = planPlacements({ ...base, segments: [], units: units(unit("a", 1)), placements: [place("p1", "a", nights[0], nights[1]), place("p2", "a", nights[2], nights[3])] });
    expect(result.ok).toBe(true);
  });

  it("moves someone from the middle of a stay: the old row keeps the nights before, a remainder keeps the nights after, and capacity follows", () => {
    const result = planPlacements({
      ...base, segments: [segment("s1", "p1", "a")], units: units(unit("a", 1), unit("b", 1)),
      placements: [place("p1", "b", nights[1], nights[2], { mode: "MOVE" })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.releases).toHaveLength(1);
    expect(result.plan.releases[0]).toMatchObject({ id: "s1", type: "MOVED_OUT", after: { firstNight: nights[0], lastNight: nights[0] } });
    expect(result.plan.creates.map((create) => create.type).sort()).toEqual(["MOVED_IN", "SPLIT_REMAINDER"]);
    const remainder = result.plan.creates.find((create) => create.type === "SPLIT_REMAINDER")!;
    expect(remainder.segment).toMatchObject({ unitId: "a", firstNight: nights[3], lastNight: nights[3] });
    // The room they left has its middle nights free again, the room they entered is taken on exactly those nights.
    const occupancy = occupancyOf(result.plan.after);
    expect(occupancy.get("a")?.get(nights[1])).toBeUndefined();
    expect(occupancy.get("a")?.get(nights[0])).toBe(1);
    expect(occupancy.get("a")?.get(nights[3])).toBe(1);
    expect(occupancy.get("b")?.get(nights[1])).toBe(1);
    expect(occupancy.get("b")?.get(nights[0])).toBeUndefined();
  });

  it("moves a whole stay by cancelling the old row, and refuses a move into a full room without changing anything", () => {
    const moved = planPlacements({ ...base, segments: [segment("s1", "p1", "a")], units: units(unit("a", 1), unit("b", 1)), placements: [place("p1", "b", nights[0], nights[3], { mode: "MOVE" })] });
    expect(moved.ok && moved.plan.releases[0]!.after).toBeNull();
    const full = planPlacements({ ...base, segments: [segment("s1", "p1", "a"), segment("s2", "p2", "b")], units: units(unit("a", 1), unit("b", 1)), placements: [place("p1", "b", nights[0], nights[3], { mode: "MOVE" })] });
    expect(full).toMatchObject({ ok: false, problem: { code: "UNIT_FULL" } });
  });

  it("uses alternate housing with no capacity check, and refuses a place that is not on the event", () => {
    const hotel: PlanPlacement = { ...place("p1", "x"), place: { bucketId: "bucket-hotel" } };
    expect(planPlacements({ ...base, segments: [], units: units(), placements: [hotel] }).ok).toBe(true);
    expect(planPlacements({ ...base, segments: [], units: units(), placements: [place("p1", "nope")] })).toMatchObject({ ok: false, problem: { code: "UNKNOWN_PLACE" } });
  });

  it("keeps nights inside the event", () => {
    expect(planPlacements({ ...base, segments: [], units: units(unit("a", 2)), placements: [place("p1", "a", "2027-06-14", "2027-06-16")] })).toMatchObject({ ok: false, problem: { code: "DATES_OUTSIDE_EVENT" } });
    expect(planPlacements({ ...base, segments: [], units: units(unit("a", 2)), eventNights: [], placements: [place("p1", "a")] })).toMatchObject({ ok: false, problem: { code: "DATES_OUTSIDE_EVENT" } });
  });

  it("counts a placeholder group by its head count", () => {
    const club = place("club", "area", nights[0], nights[1], { people: 14, occupant: { attendeeId: null, placeholderId: "club" } });
    expect(planPlacements({ ...base, segments: [], units: units(unit("area", 20)), placements: [club] }).ok).toBe(true);
    expect(planPlacements({ ...base, segments: [segment("s", "x", "area", nights[0], nights[0], 10)], units: units(unit("area", 20)), placements: [club] })).toMatchObject({ ok: false, problem: { code: "UNIT_FULL" } });
  });

  it("the lenient plan records each problem and keeps going, leaving the failed row untouched", () => {
    const outcome = planPlacementsLenient({ ...base, segments: [], units: units(unit("a", 1)), placements: [place("p1", "a"), place("p2", "a"), place("p3", "nope")] });
    expect(outcome.problems.map((entry) => [entry.index, entry.problem.code])).toEqual([[1, "UNIT_FULL"], [2, "UNKNOWN_PLACE"]]);
    expect(outcome.plan.creates).toHaveLength(1);
    expect(outcome.plan.after).toHaveLength(1);
  });
});

describe("cancellation, stay changes and transfers", () => {
  const stay = [segment("s1", "p1", "a")];

  it("cancels a whole assignment or only some nights, and releases the capacity", () => {
    const whole = planCancellation(stay, "s1", null)!;
    expect(whole.releases[0]).toMatchObject({ type: "CANCELLED", after: null });
    expect(occupancyOf(whole.after).get("a")).toBeUndefined();
    const part = planCancellation(stay, "s1", { firstNight: nights[2], lastNight: nights[3] })!;
    expect(part.releases[0]!.after).toEqual({ firstNight: nights[0], lastNight: nights[1] });
    expect(planCancellation(stay, "missing", null)).toBeNull();
  });

  it("a late arrival and an early departure release the nights given up, or keep them held when asked", () => {
    const late = planStayChange(stay, "LATE_ARRIVAL", nights[2], false);
    expect(late.releases[0]).toMatchObject({ type: "LATE_ARRIVAL", after: { firstNight: nights[2], lastNight: nights[3] } });
    const early = planStayChange(stay, "EARLY_DEPARTURE", nights[1], false);
    expect(early.releases[0]).toMatchObject({ type: "EARLY_DEPARTURE", after: { firstNight: nights[0], lastNight: nights[1] } });
    const kept = planStayChange(stay, "LATE_ARRIVAL", nights[2], true);
    expect(kept.releases).toHaveLength(0);
    expect(kept.notes).toHaveLength(1);
    expect(kept.after).toEqual(stay);
    // Nothing to give up: no change.
    expect(planStayChange(stay, "LATE_ARRIVAL", nights[0], false).releases).toHaveLength(0);
  });

  it("transfers a segment to another occupant in the same place, with the capacity effect checked", () => {
    const result = planTransfer({ segments: stay, segmentId: "s1", to: { occupantKey: "p2", attendeeId: "p2", placeholderId: null, people: 1 }, units: units(unit("a", 1)), buckets: new Set(), eventNights: nights, confirmSpecialUse: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.releases[0]).toMatchObject({ id: "s1", type: "TRANSFERRED_OUT", after: null });
    expect(result.plan.creates[0]).toMatchObject({ type: "TRANSFERRED_IN", relatedId: "s1" });
    expect(occupancyOf(result.plan.after).get("a")?.get(nights[0])).toBe(1);
    // Transferring to a group bigger than the room is refused; to the same person is refused.
    const group = planTransfer({ segments: stay, segmentId: "s1", to: { occupantKey: "club", attendeeId: null, placeholderId: "club", people: 3 }, units: units(unit("a", 2)), buckets: new Set(), eventNights: nights, confirmSpecialUse: true });
    expect(group).toMatchObject({ ok: false, problem: { code: "UNIT_FULL" } });
    expect(planTransfer({ segments: stay, segmentId: "s1", to: { occupantKey: "p1", attendeeId: "p1", placeholderId: null, people: 1 }, units: units(unit("a", 1)), buckets: new Set(), eventNights: nights, confirmSpecialUse: true }).ok).toBe(false);
  });
});

describe("warnings, conflicts and reports", () => {
  const together = {
    people: [{ personId: "pa", registrationId: "r1" }, { personId: "pb", registrationId: "r1" }, { personId: "pc", registrationId: "r2" }],
    rules: [{ id: "rule1", kind: "SEPARATE" as const, personAId: "pb", personBId: "pc", effectiveFrom: null, effectiveUntil: null, ended: false }],
    guardians: [],
  };
  const keys = new Map([["pa", "ka"], ["pb", "kb"], ["pc", "kc"]]);

  it("warns about a household split across rooms, and about keep-apart people sharing one", () => {
    const warnings = assignmentWarnings({
      nights, together, occupantKeyByPerson: keys,
      segments: [segment("s1", "ka", "a"), segment("s2", "kb", "b"), segment("s3", "kc", "b")],
    });
    expect(warnings.map((warning) => warning.kind).sort()).toEqual(["KEEP_APART", "SPLIT_HOUSEHOLD"]);
    // A household that is together, and nobody placed yet, give no warning.
    expect(assignmentWarnings({ nights, together, occupantKeyByPerson: keys, segments: [segment("s1", "ka", "a"), segment("s2", "kb", "a"), segment("s3", "kc", "c")] })).toEqual([]);
    expect(assignmentWarnings({ nights, together, occupantKeyByPerson: keys, segments: [] })).toEqual([]);
    // Half of a household placed and half not is a split.
    expect(assignmentWarnings({ nights, together, occupantKeyByPerson: keys, segments: [segment("s1", "ka", "a")] }).map((warning) => warning.kind)).toEqual(["SPLIT_HOUSEHOLD"]);
  });

  it("reports a room closed or held after people were placed, and a room over capacity, night by night", () => {
    const closed = unit("a", 2, { unavailable: true });
    const over = unit("b", 1);
    const rows = unitConflicts({
      nights, units: units(closed, over),
      segments: [{ ...segment("s1", "p1", "a"), assignmentId: "s1" }, { ...segment("s2", "p2", "b"), assignmentId: "s2" }, { ...segment("s3", "p3", "b", nights[1], nights[1]), assignmentId: "s3" }],
    });
    expect(rows.map((row) => row.kind).sort()).toEqual(["OVER_CAPACITY", "UNIT_OUT_OF_SERVICE"]);
    expect(rows.find((row) => row.kind === "OVER_CAPACITY")).toMatchObject({ night: nights[1], assignmentIds: ["s2", "s3"] });
  });

  it("reproduces occupancy night by night, with nights partly covered, people in housing elsewhere and people in a closed room", () => {
    const rows = occupancyByNight({
      nights, units: [unit("a", 2), unit("b", 4, { holds: [{ id: "h", firstNight: nights[0], lastNight: nights[0] }] })],
      segments: [
        segment("s1", "p1", "a", nights[0], nights[1]), segment("s2", "p2", "a", nights[1], nights[3]),
        segment("s3", "p3", null, nights[2], nights[2], 2, "bucket-hotel"),
        // Placed in room b, which is then held on the first night: still counted, and flagged.
        segment("s4", "p4", "b", nights[0], nights[0]),
      ],
    });
    expect(rows.map((row) => [row.night, row.capacity, row.occupied, row.available, row.offsite, row.inClosedRooms])).toEqual([
      [nights[0], 2, 2, 1, 0, 1], // b is held on the first night but its guest is still counted
      [nights[1], 6, 2, 4, 0, 0],
      [nights[2], 6, 1, 5, 2, 0],
      [nights[3], 6, 1, 5, 0, 0],
    ]);
  });
});

describe("rule-assisted proposal", () => {
  const proposalUnit = (id: string, capacity: number, extra: Partial<ProposalUnit> = {}): ProposalUnit => ({
    ...unit(id, capacity), category: "DORM_ROOM", kind: "ROOM", isArea: false, groundLevel: false, sortOrder: Number(id.replace(/\D/g, "") || 0), ...extra,
  });
  const person = (key: string, registrationId: string, extra: Partial<ProposalPerson> = {}): ProposalPerson => ({
    occupantKey: key, occupant: { attendeeId: key, placeholderId: null }, people: 1, registrationId, personId: `p-${key}`, nights, category: "DORM_ROOM", needsGroundFloor: false, ...extra,
  });
  const empty = { rules: [], guardians: [] };

  it("keeps households together, honours the category, puts accessibility needs on the ground floor and never proposes held or special rooms", () => {
    const result = proposeAssignments({
      eventNights: nights, segments: [],
      units: [
        proposalUnit("r1", 2, { groundLevel: false }),
        proposalUnit("r2", 2, { groundLevel: true }),
        proposalUnit("r3", 4),
        proposalUnit("r4", 2, { holds: [{ id: "h", firstNight: nights[0], lastNight: nights[3] }] }),
        proposalUnit("r5", 8, { specialUse: true }),
        proposalUnit("tent", 6, { kind: "TENT", category: "TENT", isArea: true, groundLevel: true }),
      ],
      people: [
        person("a1", "regA"), person("a2", "regA"), person("a3", "regA"),
        person("b1", "regB", { needsGroundFloor: true }),
        person("c1", "regC", { category: "TENT" }),
      ],
      together: { people: [{ personId: "p-a1", registrationId: "regA" }, { personId: "p-a2", registrationId: "regA" }, { personId: "p-a3", registrationId: "regA" }, { personId: "p-b1", registrationId: "regB" }, { personId: "p-c1", registrationId: "regC" }], ...empty },
    });
    const unitOf = (key: string) => (result.placements.find((placement) => placement.occupantKey === key)!.place as { unitId: string }).unitId;
    expect(result.unplaced).toEqual([]);
    expect(new Set(["a1", "a2", "a3"].map(unitOf)).size).toBe(1);
    expect(unitOf("a1")).toBe("r3"); // the household of three needs the room for four
    expect(unitOf("b1")).toBe("r2"); // ground floor, smallest that fits
    expect(unitOf("c1")).toBe("tent");
    expect(result.placements.every((placement) => placement.source === "PROPOSAL")).toBe(true);
    expect(result.placements.some((placement) => ["r4", "r5"].includes((placement.place as { unitId: string }).unitId))).toBe(false);
  });

  it("reports who it could not place, and never splits a household to make it fit", () => {
    const result = proposeAssignments({
      eventNights: nights, segments: [],
      units: [proposalUnit("r1", 2)],
      people: [person("a1", "regA"), person("a2", "regA"), person("a3", "regA")],
      together: { people: ["a1", "a2", "a3"].map((key) => ({ personId: `p-${key}`, registrationId: "regA" })), ...empty },
    });
    expect(result.placements).toEqual([]);
    expect(result.unplaced.map((entry) => entry.occupantKey).sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("keeps keep-apart people out of one room and leaves people who are already placed alone", () => {
    const result = proposeAssignments({
      eventNights: nights, segments: [segment("s0", "x1", "r1", nights[0], nights[3])],
      units: [proposalUnit("r1", 4), proposalUnit("r2", 4)],
      people: [person("x1", "regX"), person("k1", "regK"), person("k2", "regL")],
      together: {
        people: [{ personId: "p-x1", registrationId: "regX" }, { personId: "p-k1", registrationId: "regK" }, { personId: "p-k2", registrationId: "regL" }],
        rules: [{ id: "apart", kind: "SEPARATE", personAId: "p-k1", personBId: "p-k2", effectiveFrom: null, effectiveUntil: null, ended: false }],
        guardians: [],
      },
    });
    expect(result.placements.map((placement) => placement.occupantKey).sort()).toEqual(["k1", "k2"]);
    const rooms = result.placements.map((placement) => (placement.place as { unitId: string }).unitId);
    expect(new Set(rooms).size).toBe(2);
  });

  it("is deterministic", () => {
    const input = {
      eventNights: nights, segments: [] as Segment[],
      units: [proposalUnit("r1", 2), proposalUnit("r2", 2), proposalUnit("r3", 2)],
      people: [person("a", "r1x"), person("b", "r2x"), person("c", "r3x")],
      together: { people: [], ...empty },
    };
    expect(proposeAssignments(input)).toEqual(proposeAssignments(input));
  });
});

describe("CSV import", () => {
  it("reads the export's own columns, ignores names, and reports every problem with its line", () => {
    const matrix = parseCsvMatrix([
      "Occupant ID,Kind,Registration code,Name,Building,Place,Place key,First night,Last night,People",
      "att1,Attendee,REG1,\"'=BAD()\",Dorm,101,unit:boys-101,2027-06-15,2027-06-17,1",
      "att2,Attendee,REG2,Someone,Dorm,102,unit:boys-102,2027-06-17,2027-06-15,1",
      "att3,Attendee,REG3,Someone,Dorm,102,unit:boys-102,not-a-date,2027-06-15,1",
      ",Attendee,REG4,Someone,Dorm,102,unit:boys-102,2027-06-15,2027-06-15,1",
      "att5,Attendee,REG5,Someone,Dorm,102,,2027-06-15,2027-06-15,1",
      "att1,Attendee,REG1,Again,Dorm,101,unit:boys-101,2027-06-15,2027-06-17,1",
    ].join("\r\n"));
    const result = parseAssignmentCsv(matrix);
    expect(result.rows).toEqual([{ line: 2, occupantId: "att1", placeKey: "unit:boys-101", firstNight: "2027-06-15", lastNight: "2027-06-17" }]);
    expect(result.problems.map((problem) => problem.line)).toEqual([3, 4, 5, 6, 7]);
  });

  it("refuses a file without the columns it needs", () => {
    const result = parseAssignmentCsv(parseCsvMatrix("Name,Room\nA,101"));
    expect(result.rows).toEqual([]);
    expect(result.problems[0]!.message).toContain("Occupant ID");
  });
});

describe("waitlist rules", () => {
  it("allows only the moves the lifecycle has", () => {
    expect(canMoveWaitlist("JOINED", "OFFERED")).toBe(true);
    expect(canMoveWaitlist("OFFERED", "ACCEPTED")).toBe(true);
    expect(canMoveWaitlist("EXPIRED", "OFFERED")).toBe(true);
    expect(canMoveWaitlist("ACCEPTED", "PROMOTED")).toBe(true);
    expect(canMoveWaitlist("JOINED", "PROMOTED")).toBe(false);
    expect(canMoveWaitlist("DECLINED", "OFFERED")).toBe(false);
    expect(canMoveWaitlist("PROMOTED", "REMOVED")).toBe(false);
    expect(waitlistTransitions.REMOVED).toEqual([]);
  });

  it("treats an offer as lapsed once its expiry passes, and only an offer", () => {
    const now = new Date("2027-06-10T12:00:00Z");
    expect(isOfferLapsed({ status: "OFFERED", offerExpiresAt: new Date("2027-06-10T11:59:59Z") }, now)).toBe(true);
    expect(isOfferLapsed({ status: "OFFERED", offerExpiresAt: new Date("2027-06-10T12:00:01Z") }, now)).toBe(false);
    expect(isOfferLapsed({ status: "JOINED", offerExpiresAt: null }, now)).toBe(false);
    expect(offerExpiry(now, 48).toISOString()).toBe("2027-06-12T12:00:00.000Z");
  });

  it("an offer without confirm is only a preview, a batch is capped, and the registrant cannot offer or promote", () => {
    expect(waitlistStaffActionSchema.parse({ action: "offer", entryIds: ["e1"] })).toMatchObject({ confirm: false, expiresInHours: 48 });
    expect(() => waitlistStaffActionSchema.parse({ action: "offer", entryIds: Array.from({ length: 26 }, (_, index) => `e${index}`) })).toThrow();
    expect(() => waitlistStaffActionSchema.parse({ action: "offer", entryIds: [] })).toThrow();
    expect(() => waitlistRegistrantActionSchema.parse({ action: "offer" })).toThrow();
    expect(() => waitlistRegistrantActionSchema.parse({ action: "promote" })).toThrow();
    expect(waitlistRegistrantActionSchema.parse({ action: "accept" })).toEqual({ action: "accept" });
  });
});

describe("input schemas", () => {
  it("require a reason for a cancel, a stay change and a transfer, and reject unknown fields", () => {
    expect(() => assignmentActionSchema.parse({ action: "cancel", assignmentId: "a" })).toThrow();
    expect(() => assignmentActionSchema.parse({ action: "transfer", assignmentId: "a", to: { kind: "ATTENDEE", id: "b" } })).toThrow();
    expect(() => assignmentActionSchema.parse({ action: "stay_change", occupant: { kind: "ATTENDEE", id: "a" }, kind: "LATE_ARRIVAL", night: "2027-06-16" })).toThrow();
    expect(() => assignmentActionSchema.parse({ action: "cancel", assignmentId: "a", reason: "x", medicalReason: "no" })).toThrow();
    expect(assignmentActionSchema.parse({ action: "stay_change", occupant: { kind: "ATTENDEE", id: "a" }, kind: "LATE_ARRIVAL", night: "2027-06-16", reason: "Flight delayed" })).toMatchObject({ keepCapacity: false });
  });

  it("validates a placement's nights and defaults to assign without confirming a special-use room", () => {
    const placement = placementSchema.parse({ occupant: { kind: "ATTENDEE", id: "a" }, place: { kind: "UNIT", eventUnitId: "u" }, firstNight: "2027-06-15", lastNight: "2027-06-16" });
    expect(placement).toMatchObject({ mode: "ASSIGN", confirmSpecialUse: false });
    expect(() => placementSchema.parse({ ...placement, firstNight: "2027-06-17" })).toThrow();
    expect(() => placementSchema.parse({ ...placement, firstNight: "June 15" })).toThrow();
  });
});

describe("small helpers", () => {
  it("shows a first name only", () => {
    expect(firstNameOf("  Maria Elena Garcia ")).toBe("Maria");
    expect(firstNameOf("Cher")).toBe("Cher");
    expect(firstNameOf("")).toBe("");
  });

  it("colours a household the same way every time", () => {
    expect(householdColorIndex("reg-1", 12)).toBe(householdColorIndex("reg-1", 12));
    expect(householdColorIndex("reg-1", 12)).toBeLessThan(12);
  });

  it("a notice is obsolete as soon as the assignment version grows", () => {
    expect(noticeIsObsolete(3, 3)).toBe(false);
    expect(noticeIsObsolete(3, 4)).toBe(true);
  });
});

describe("report CSVs", () => {
  const reports: RoomingReports = {
    eventId: "e1", nights, canSeeSensitive: false,
    rooming: [{
      placeKey: "unit:boys-101", building: "Boys Dorm", place: "101", floor: 1, capacity: 2,
      occupants: [{ assignmentId: "a1", occupantId: "att1", kind: "Attendee", name: "=cmd|' /C calc'!A0", registrationCode: "REG1", firstNight: nights[0]!, lastNight: nights[2]!, people: 1, groundFloorNeeded: true, accessibleRoomNeeded: false }],
    }],
    occupancy: [{ night: nights[0]!, capacity: 2, occupied: 1, available: 1, unitsInService: 1, unlimited: false, offsite: 0, inClosedRooms: 0 }],
    occupancyByUnit: [], unassigned: [], conflicts: [], closeout: [],
    keyHandoff: [{ building: "Boys Dorm", place: "101", placeKey: "unit:boys-101", people: 1, arrival: nights[0]!, departure: "2027-06-18", holder: "Pat", registrationCodes: ["REG1"] }],
  };

  it("writes the assignments file the import reads, defuses spreadsheet formulas, and holds no accessibility column without sensitive access", () => {
    const csv = lodgingReportCsv("assignments", reports);
    expect(csv.split("\r\n")[0]).toBe('"Occupant ID","Kind","Registration code","Name","Building","Place","Place key","First night","Last night","People"');
    expect(csv).toContain("\"'=cmd|");
    expect(csv).not.toContain("Ground floor needed");
    // The file it writes is the file the import reads.
    const parsed = parseAssignmentCsv(parseCsvMatrix(csv));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ occupantId: "att1", placeKey: "unit:boys-101", firstNight: nights[0], lastNight: nights[2] });
  });

  it("adds the two accessibility columns only for staff who may see them", () => {
    const csv = lodgingReportCsv("assignments", { ...reports, canSeeSensitive: true });
    expect(csv.split("\r\n")[0]).toContain("Ground floor needed");
    expect(csv.split("\r\n")[1]).toContain('"Yes","No"');
  });

  it("writes the other reports and no contact detail anywhere", () => {
    for (const kind of ["occupancy", "unassigned", "conflicts", "closeout", "keys"] as const) {
      const csv = lodgingReportCsv(kind, reports);
      expect(csv.split("\r\n").length).toBeGreaterThan(1);
      expect(csv.toLowerCase()).not.toMatch(/@|phone|email/);
    }
    expect(lodgingReportCsv("keys", reports)).toContain('"2027-06-18"');
  });

  it("assignment cells match the headers", () => {
    expect(assignmentCsvCells({ occupantId: "a", kind: "Attendee", registrationCode: "R", name: "N", building: "B", place: "P", placeKey: "unit:p", firstNight: "x", lastNight: "y", people: 1 }, false)).toHaveLength(10);
  });
});

describe("a party above a room's beds is a warning; two parties still cannot overfill a room (#803)", () => {
  const room = (id: string, beds = 2, extra: Partial<PlanUnit> = {}) => unit(id, beds, { roomLike: true, ...extra });
  const member = (key: string, group: string | null, unitId: string, first = nights[0]!, last = nights[0]!): PlanPlacement => place(key, unitId, first, last, { groupKey: group });
  const seg = (id: string, key: string, group: string | null, unitId: string): Segment => ({ ...segment(id, key, unitId, nights[0], nights[0]), groupKey: group });

  it("places a party of five in a two-bed room with a warning, not a refusal", () => {
    const result = planPlacements({ ...base, segments: [], units: units(room("r1")), placements: ["a", "b", "c", "d", "e"].map((key) => member(key, "reg-1", "r1")) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.creates).toHaveLength(5);
    expect(result.plan.warnings).toEqual([{ kind: "OVER_BEDS", unitId: "r1", unitName: "Room r1", beds: 2, people: 5, night: nights[0] }]);
  });

  it("is still refused when the placement would be above the beds without being one party", () => {
    // An unlinked expected guest has no registration: it never gets the allowance.
    const guest = planPlacements({ ...base, segments: [], units: units(room("r1")), placements: ["a", "b", "c"].map((key) => member(key, null, "r1")) });
    expect(guest).toMatchObject({ ok: false, index: 2, problem: { code: "UNIT_FULL" } });
    // A tent area is not a numbered room: its capacity always holds.
    const area = planPlacements({ ...base, segments: [], units: units(unit("t", 2, { roomLike: false })), placements: ["a", "b", "c"].map((key) => member(key, "reg-1", "t")) });
    expect(area).toMatchObject({ ok: false, index: 2, problem: { code: "UNIT_FULL" } });
  });

  it("stops a second party from overfilling a room another party already holds", () => {
    const second = planPlacements({ ...base, segments: [seg("s1", "a", "reg-1", "r1"), seg("s2", "b", "reg-1", "r1")], units: units(room("r1")), placements: [member("x", "reg-2", "r1")] });
    expect(second).toMatchObject({ ok: false, problem: { code: "UNIT_FULL" } });
    // A third person of party 1 may not go over the beds while someone from party 2 is in the room.
    const mixed = planPlacements({ ...base, segments: [seg("s1", "a", "reg-1", "r1"), seg("s3", "x", "reg-2", "r1")], units: units(room("r1")), placements: [member("c", "reg-1", "r1")] });
    expect(mixed).toMatchObject({ ok: false, problem: { code: "UNIT_FULL" } });
    const overMixed = planPlacements({ ...base, segments: [seg("s1", "a", "reg-1", "r1"), seg("s2", "b", "reg-1", "r1"), seg("s3", "x", "reg-2", "r1")], units: units(room("r1", 3)), placements: [member("c", "reg-1", "r1")] });
    expect(overMixed).toMatchObject({ ok: false, problem: { code: "UNIT_FULL" } });
    // Within the beds two parties still share a room as before.
    const shared = planPlacements({ ...base, segments: [seg("s1", "a", "reg-1", "r1")], units: units(room("r1", 3)), placements: [member("x", "reg-2", "r1")] });
    expect(shared.ok).toBe(true);
    // In one batch the same holds: party 1's third person goes over the beds only while nobody else is in the room.
    const batch = planPlacements({ ...base, segments: [], units: units(room("r1")), placements: [member("a", "reg-1", "r1"), member("x", "reg-2", "r1"), member("b", "reg-1", "r1"), member("c", "reg-1", "r1")] });
    expect(batch).toMatchObject({ ok: false, index: 2, problem: { code: "UNIT_FULL" } });
  });

  it("does not turn the room into a conflict while one party holds it, and does the moment someone else is in it", () => {
    const rows = (segments: Segment[]) => unitConflicts({ nights: [nights[0]!], units: units(room("r1")), segments: segments.map((entry) => ({ ...entry, assignmentId: entry.id })) });
    const oneParty = rows(["a", "b", "c", "d"].map((key, index) => seg(`s${index}`, key, "reg-1", "r1")));
    expect(oneParty.map((row) => row.kind)).toEqual(["EXTRA_BEDDING"]);
    const twoParties = rows([seg("s1", "a", "reg-1", "r1"), seg("s2", "b", "reg-1", "r1"), seg("s3", "x", "reg-2", "r1")]);
    expect(twoParties.map((row) => row.kind)).toEqual(["OVER_CAPACITY"]);
    // An unlinked group never gets it either.
    expect(rows(["a", "b", "c"].map((key, index) => seg(`s${index}`, key, null, "r1"))).map((row) => row.kind)).toEqual(["OVER_CAPACITY"]);
  });

  it("keeps the allowance through a move and a transfer", () => {
    const moved = planPlacements({
      ...base, segments: [seg("s1", "a", "reg-1", "r2")], units: units(room("r1"), room("r2")),
      placements: [{ ...member("a", "reg-1", "r1"), mode: "MOVE" as const }, member("b", "reg-1", "r1"), member("c", "reg-1", "r1")],
    });
    expect(moved.ok && moved.plan.warnings).toHaveLength(1);
    const transferred = planTransfer({
      segments: [seg("s1", "a", "reg-1", "r1"), seg("s2", "b", "reg-1", "r1"), seg("s3", "c", null, "r1")], segmentId: "s3",
      to: { occupantKey: "d", attendeeId: "d", placeholderId: null, people: 1, groupKey: "reg-1" }, units: units(room("r1")), buckets: base.buckets, eventNights: nights, confirmSpecialUse: true,
    });
    expect(transferred.ok).toBe(true);
  });
});

describe("over-beds nights are classified night by night, the same way for the workspace and the closeout report (#803)", () => {
  const room = unit("r1", 2, { roomLike: true });
  const seg = (id: string, key: string, group: string, first: string, last: string): Segment => ({ ...segment(id, key, "r1", first, last), groupKey: group });

  it("calls a night above the beds one party when only that registration is in the room, and an overfill when anyone else is", () => {
    // Party 1 (three people) holds the room on the 15th and 16th; on the 17th a second party shares it above the beds.
    const segments = [
      seg("a", "a1", "reg-1", nights[0]!, nights[1]!), seg("b", "a2", "reg-1", nights[0]!, nights[1]!), seg("c", "a3", "reg-1", nights[0]!, nights[1]!),
      seg("d", "a4", "reg-1", nights[2]!, nights[2]!), seg("e", "x1", "reg-2", nights[2]!, nights[2]!), seg("f", "x2", "reg-2", nights[2]!, nights[2]!),
    ];
    const over = overBedsByNight(room, segments, nights);
    expect(over.map((entry) => [entry.night, entry.oneParty])).toEqual([[nights[0], true], [nights[1], true], [nights[2], false]]);
    // The closeout report lists both, the workspace reads the room as over capacity because one night is an overfill.
    const rows = unitConflicts({ nights, units: units(room), segments: segments.map((entry) => ({ ...entry, assignmentId: entry.id })) });
    expect(rows.map((row) => row.kind).sort()).toEqual(["EXTRA_BEDDING", "OVER_CAPACITY"]);
    expect(over.some((entry) => !entry.oneParty)).toBe(true);
  });

  it("is a warning only when every night above the beds holds one party", () => {
    const segments = ["a", "b", "c"].map((id) => seg(id, id, "reg-1", nights[0]!, nights[1]!));
    expect(overBedsByNight(room, segments, nights).every((entry) => entry.oneParty)).toBe(true);
    expect(overBedsByNight(unit("r1", 2), segments, nights).every((entry) => !entry.oneParty)).toBe(true); // not a numbered room
    expect(overBedsByNight(room, [seg("a", "a", "reg-1", nights[0]!, nights[1]!)], nights)).toEqual([]); // within the beds
  });
});
