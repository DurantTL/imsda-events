import { z } from "zod";
import {
  addDays,
  isNight,
  lodgingCategories,
  nightsInclusive,
  unitNight,
  type LodgingCategory,
  type UnitNightState,
} from "@/modules/lodging/domain";
import { ruleActiveOn, togetherGroupsOn, type TogetherInput } from "@/modules/lodging/preferences-domain";

/**
 * Lodging assignment rules (#200, slice 3): pure and free of server-only imports so the service, the staff workspace
 * and the tests share one definition. Nights are calendar dates ("YYYY-MM-DD"); both ends of a range are slept.
 *
 * An assignment places one occupant (a registration attendee, or a placeholder for an expected guest or group) in an
 * on-site unit or in an alternate-housing bucket for a range of nights. Capacity is counted in people, night by night.
 * The planner below works on an in-memory copy of the event's current segments so a batch can never overbook
 * itself, and it produces the exact rows to write; the service writes them under the unit locks.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const lodgingBucketKinds = ["HOTEL", "AIRBNB", "HOME", "OFFSITE", "OTHER"] as const;
export type LodgingBucketKind = (typeof lodgingBucketKinds)[number];
export const defaultBucketLabels: Record<LodgingBucketKind, string> = {
  HOTEL: "Hotel",
  AIRBNB: "Airbnb",
  HOME: "Home",
  OFFSITE: "Offsite",
  OTHER: "Other",
};

export const assignmentSources = ["STAFF", "PROPOSAL", "CSV_IMPORT", "WAITLIST"] as const;
export type AssignmentSource = (typeof assignmentSources)[number];

export const assignmentEventTypes = [
  "ASSIGNED",
  "MOVED_IN",
  "MOVED_OUT",
  "SPLIT_REMAINDER",
  "CANCELLED",
  "TRANSFERRED_IN",
  "TRANSFERRED_OUT",
  "LATE_ARRIVAL",
  "EARLY_DEPARTURE",
  "LINKED",
] as const;
export type AssignmentEventType = (typeof assignmentEventTypes)[number];
export const assignmentEventLabels: Record<AssignmentEventType, string> = {
  ASSIGNED: "Assigned",
  MOVED_IN: "Moved in",
  MOVED_OUT: "Moved out",
  SPLIT_REMAINDER: "Remaining nights kept",
  CANCELLED: "Cancelled",
  TRANSFERRED_IN: "Transferred in",
  TRANSFERRED_OUT: "Transferred out",
  LATE_ARRIVAL: "Late arrival",
  EARLY_DEPARTURE: "Early departure",
  LINKED: "Linked to a registration",
};

/** Registrations whose attendees may be placed. */
export const assignableRegistrationStatuses = ["SUBMITTED", "CONFIRMED"] as const;

export const MAX_BATCH_PLACEMENTS = 300;
export const MAX_IMPORT_ROWS = 600;
export const MAX_IMPORT_BYTES = 200_000;

// ---------------------------------------------------------------------------
// Segments and night arithmetic
// ---------------------------------------------------------------------------

export type Segment = {
  id: string;
  /** The database's occupant key: the attendee id, or the placeholder id while it is not linked. */
  occupantKey: string;
  unitId: string | null;
  bucketId: string | null;
  people: number;
  firstNight: string;
  lastNight: string;
  /**
   * The registration the occupant belongs to (a linked attendee), or null/absent for an expected guest not yet linked. Two
   * segments of one group are one party: a party may be placed above a room's beds (with a warning), two parties may not.
   */
  groupKey?: string | null;
};

export type NightRange = { firstNight: string; lastNight: string };

export function rangesOverlap(a: NightRange, b: NightRange) {
  return a.firstNight <= b.lastNight && b.firstNight <= a.lastNight;
}

/** What is left of `range` after taking `cut` out of it: nothing, one range, or two (a split). */
export function subtractRange(range: NightRange, cut: NightRange): NightRange[] {
  if (!rangesOverlap(range, cut)) return [{ ...range }];
  const pieces: NightRange[] = [];
  if (cut.firstNight > range.firstNight) pieces.push({ firstNight: range.firstNight, lastNight: addDays(cut.firstNight, -1) });
  if (cut.lastNight < range.lastNight) pieces.push({ firstNight: addDays(cut.lastNight, 1), lastNight: range.lastNight });
  return pieces;
}

export function placeKey(segment: Pick<Segment, "unitId" | "bucketId">) {
  return segment.unitId ? `unit:${segment.unitId}` : `bucket:${segment.bucketId}`;
}

/** People placed per unit and night (alternate-housing buckets use no inventory and are not counted). */
export function occupancyOf(segments: readonly Segment[]) {
  const result = new Map<string, Map<string, number>>();
  for (const segment of segments) {
    if (!segment.unitId) continue;
    const byNight = result.get(segment.unitId) ?? new Map<string, number>();
    for (const night of nightsInclusive(segment.firstNight, segment.lastNight)) byNight.set(night, (byNight.get(night) ?? 0) + segment.people);
    result.set(segment.unitId, byNight);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Placement checks
// ---------------------------------------------------------------------------

export type PlanUnit = UnitNightState & {
  name: string;
  specialUse: boolean;
  /** A numbered room (not a site, a tent or a counted area): the only kind a party may be placed in above its beds. */
  roomLike?: boolean;
};

/** A party placed in a room above the room's beds (it is bringing extra bedding): a warning, never a refusal (#803). */
export type PlacementWarning = { kind: "OVER_BEDS"; unitId: string; unitName: string; beds: number; people: number; night: string };

export type PlacementProblemCode =
  | "DATES_OUTSIDE_EVENT"
  | "ALREADY_ASSIGNED"
  | "UNIT_OUT_OF_SERVICE"
  | "UNIT_FULL"
  | "SPECIAL_USE_UNCONFIRMED"
  | "UNKNOWN_PLACE";

export type PlacementProblem = { code: PlacementProblemCode; message: string; night?: string };

const statusWords: Record<string, string> = {
  UNAVAILABLE: "unavailable",
  HELD: "held",
  NOT_ASSIGNABLE: "not assignable",
  INACTIVE: "not in service",
};

/**
 * Whether `people` more fit one unit on every night, given who is already there. A held, unavailable, retired or
 * not-assignable unit blocks assignment; a special-use unit needs the staff member's confirmation.
 */
export function checkUnitPlacement(input: {
  unit: PlanUnit;
  occupancy: ReadonlyMap<string, number> | undefined;
  nights: readonly string[];
  people: number;
  confirmSpecialUse: boolean;
  /**
   * A party above the beds is a warning, not a refusal, but only when the room holds nobody from another party on those
   * nights (the caller works that out). When it applies, `onOverBeds` is told the first night it did.
   */
  overBeds?: { allowed: boolean; onOverBeds: (warning: PlacementWarning) => void };
}): PlacementProblem | null {
  let warned = false;
  for (const night of input.nights) {
    const row = unitNight(input.unit, night, input.occupancy?.get(night) ?? 0);
    if (row.status !== "AVAILABLE") {
      return { code: "UNIT_OUT_OF_SERVICE", night, message: `${input.unit.name} is ${statusWords[row.status] ?? "out of service"} on ${night}.` };
    }
    if (row.available !== null && row.available < input.people && input.overBeds?.allowed && row.capacity !== null) {
      if (!warned) {
        warned = true;
        input.overBeds.onOverBeds({ kind: "OVER_BEDS", unitId: input.unit.unitId, unitName: input.unit.name, beds: row.capacity, people: row.occupied + input.people, night });
      }
      continue;
    }
    if (row.available !== null && row.available < input.people) {
      return { code: "UNIT_FULL", night, message: `${input.unit.name} has ${row.available} place${row.available === 1 ? "" : "s"} left on ${night}, and ${input.people} ${input.people === 1 ? "is" : "are"} needed.` };
    }
  }
  if (input.unit.specialUse && !input.confirmSpecialUse) {
    return { code: "SPECIAL_USE_UNCONFIRMED", message: `${input.unit.name} is a special-use room. Confirm to place someone there.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The planner: placements, moves, cancellations, stay changes and transfers
// ---------------------------------------------------------------------------

export type PlanPlace = { unitId: string } | { bucketId: string };

export type PlanPlacement = {
  occupantKey: string;
  occupant: { attendeeId: string | null; placeholderId: string | null };
  people: number;
  place: PlanPlace;
  firstNight: string;
  lastNight: string;
  /** ASSIGN refuses an occupant who is already placed on any of those nights; MOVE takes those nights over. */
  mode: "ASSIGN" | "MOVE";
  confirmSpecialUse: boolean;
  source: AssignmentSource;
  /** The occupant's registration (null for an expected guest not yet linked): a party stays within its own registration. */
  groupKey?: string | null;
};

/** A segment that stops covering some of its nights, or is cancelled outright. */
export type ReleaseOp = {
  kind: "RELEASE";
  id: string;
  type: "MOVED_OUT" | "CANCELLED" | "TRANSFERRED_OUT" | "LATE_ARRIVAL" | "EARLY_DEPARTURE";
  before: Segment;
  /** Null cancels the whole segment; otherwise the segment keeps this range. */
  after: NightRange | null;
  /** The key of the create that this release pairs with (a move or a transfer). */
  relatedKey?: string;
};

export type CreateOp = {
  kind: "CREATE";
  /** Unique within the plan; created rows are linked by it. */
  key: string;
  type: "ASSIGNED" | "MOVED_IN" | "SPLIT_REMAINDER" | "TRANSFERRED_IN";
  segment: Omit<Segment, "id">;
  occupant: { attendeeId: string | null; placeholderId: string | null };
  source: AssignmentSource;
  /** The segment this one came from (a split remainder or the target of a move). */
  relatedId?: string;
  previous?: { unitId: string | null; bucketId: string | null; firstNight: string; lastNight: string };
};

/** A late arrival or early departure that deliberately keeps the nights: history only, capacity stays held. */
export type NoteOp = { kind: "NOTE"; id: string; type: "LATE_ARRIVAL" | "EARLY_DEPARTURE"; before: Segment };

export type Plan = {
  releases: ReleaseOp[];
  creates: CreateOp[];
  notes: NoteOp[];
  /** Placements that matched what was already there and changed nothing. */
  unchanged: number;
  /** The segments as they will be once the plan is written (created segments carry their key as id). */
  after: Segment[];
  /** Placements that were allowed but deserve a look: a party above a room's beds (#803). */
  warnings?: PlacementWarning[];
};

export type PlanResult = { ok: true; plan: Plan } | { ok: false; index: number; problem: PlacementProblem };

type PlanContext = {
  units: ReadonlyMap<string, PlanUnit>;
  buckets: ReadonlySet<string>;
  eventNights: readonly string[];
};

class Planner {
  releases: ReleaseOp[] = [];
  creates: CreateOp[] = [];
  notes: NoteOp[] = [];
  warnings = new Map<string, PlacementWarning>();
  unchanged = 0;
  private counter = 0;
  working: Segment[];

  constructor(segments: readonly Segment[]) {
    this.working = segments.map((segment) => ({ ...segment }));
  }

  nextKey() {
    this.counter += 1;
    return `new:${this.counter}`;
  }

  /**
   * Takes `cut` out of `segment` (the whole segment when `cut` is null). One piece left: the segment keeps it. Two
   * pieces: the segment keeps the first and a remainder row is created for the second, in the same place.
   */
  release(segment: Segment, cut: NightRange | null, type: ReleaseOp["type"], relatedKey?: string): CreateOp | undefined {
    const pieces = cut ? subtractRange(segment, cut) : [];
    const index = this.working.findIndex((candidate) => candidate.id === segment.id);
    // A segment this plan created (an earlier placement of the same batch) is not a row yet: edit its create instead of
    // releasing it, so a batch can move two separate nights out of one stay.
    const createdIndex = this.creates.findIndex((candidate) => candidate.key === segment.id);
    if (createdIndex >= 0) {
      const created = this.creates[createdIndex]!;
      // What the create was before this edit: the replacement placement inherits its provenance (its type, where it came from).
      const original: CreateOp = { ...created, segment: { ...created.segment } };
      if (pieces.length === 0) {
        this.creates.splice(createdIndex, 1);
        if (index >= 0) this.working.splice(index, 1);
        return original;
      }
      const [keptPiece, remainderPiece] = pieces;
      created.segment = { ...created.segment, ...keptPiece! };
      if (index >= 0) this.working[index] = { ...segment, ...keptPiece! };
      if (remainderPiece) {
        const key = this.nextKey();
        // The remainder takes the edited create's provenance, never its `new:` key: a remainder of a remainder still
        // comes from the real row (the writer resolves its occupant and source from it), and the rest of a placement this
        // plan made is that same placement (ASSIGNED stays ASSIGNED; MOVED_IN keeps the real row it moved from).
        this.creates.push({
          kind: "CREATE", key, type: created.type,
          segment: { occupantKey: segment.occupantKey, unitId: segment.unitId, bucketId: segment.bucketId, people: segment.people, groupKey: segment.groupKey ?? null, ...remainderPiece },
          occupant: created.occupant, source: created.source, relatedId: created.relatedId, previous: created.previous,
        });
        this.working.push({ ...segment, id: key, ...remainderPiece });
      }
      return original;
    }
    if (pieces.length === 0) {
      this.releases.push({ kind: "RELEASE", id: segment.id, type, before: { ...segment }, after: null, relatedKey });
      if (index >= 0) this.working.splice(index, 1);
      return;
    }
    const [kept, remainder] = pieces;
    this.releases.push({ kind: "RELEASE", id: segment.id, type, before: { ...segment }, after: kept!, relatedKey });
    if (index >= 0) this.working[index] = { ...segment, ...kept! };
    if (remainder) {
      const key = this.nextKey();
      this.creates.push({
        kind: "CREATE",
        key,
        type: "SPLIT_REMAINDER",
        segment: { occupantKey: segment.occupantKey, unitId: segment.unitId, bucketId: segment.bucketId, people: segment.people, groupKey: segment.groupKey ?? null, ...remainder },
        occupant: { attendeeId: null, placeholderId: null },
        source: "STAFF",
        relatedId: segment.id,
      });
      this.working.push({ ...segment, id: key, ...remainder });
    }
  }

  /** Tries one placement. On a problem nothing is changed and the problem is returned. */
  tryPlace(placement: PlanPlacement, context: PlanContext): PlacementProblem | null {
    const snapshot = {
      working: this.working.map((segment) => ({ ...segment })),
      releases: this.releases.length,
      creates: this.creates.map((create) => ({ ...create, segment: { ...create.segment } })),
      notes: this.notes.length,
      unchanged: this.unchanged,
    };
    const problem = this.place(placement, context);
    if (problem) {
      this.working = snapshot.working;
      this.releases.length = snapshot.releases;
      this.creates = snapshot.creates;
      this.notes.length = snapshot.notes;
      this.unchanged = snapshot.unchanged;
    }
    return problem;
  }

  private place(placement: PlanPlacement, context: PlanContext): PlacementProblem | null {
    const firstEventNight = context.eventNights[0];
    const lastEventNight = context.eventNights[context.eventNights.length - 1];
    if (!firstEventNight || !lastEventNight || placement.firstNight < firstEventNight || placement.lastNight > lastEventNight || placement.lastNight < placement.firstNight) {
      return { code: "DATES_OUTSIDE_EVENT", message: firstEventNight ? `Choose nights between ${firstEventNight} and ${lastEventNight}.` : "This event has no bookable nights." };
    }
    const range = { firstNight: placement.firstNight, lastNight: placement.lastNight };
    const unit = "unitId" in placement.place ? context.units.get(placement.place.unitId) : undefined;
    if (("unitId" in placement.place && !unit) || ("bucketId" in placement.place && !context.buckets.has(placement.place.bucketId))) {
      return { code: "UNKNOWN_PLACE", message: "That room or housing choice is not part of this event." };
    }
    const existing = this.working.filter((segment) => segment.occupantKey === placement.occupantKey && rangesOverlap(segment, range));
    if (existing.length === 1 && samePlace(existing[0]!, placement.place) && existing[0]!.firstNight === range.firstNight && existing[0]!.lastNight === range.lastNight && existing[0]!.people === placement.people) {
      this.unchanged += 1;
      return null;
    }
    if (placement.mode === "ASSIGN" && existing.length > 0) {
      const overlap = existing[0]!;
      const night = overlap.firstNight > range.firstNight ? overlap.firstNight : range.firstNight;
      return { code: "ALREADY_ASSIGNED", night, message: `Already placed on ${night}. Move them instead.` };
    }
    const key = this.nextKey();
    let inherited: CreateOp | undefined;
    const editedCreates: CreateOp[] = [];
    for (const segment of existing) {
      const edited = this.release(segment, range, "MOVED_OUT", key);
      if (edited) editedCreates.push(edited);
      if (edited && !inherited) inherited = edited;
    }
    if (unit) {
      // A party is one registration: above the room's beds it is a warning, but only while nobody from another party is in
      // the room on those nights, so unit capacity still stops two separate parties from overfilling a room.
      const inRoom = this.working.filter((segment) => segment.unitId === unit.unitId && rangesOverlap(segment, range));
      const sameParty = Boolean(unit.roomLike && placement.groupKey && inRoom.every((segment) => segment.groupKey === placement.groupKey));
      const problem = checkUnitPlacement({
        unit,
        occupancy: occupancyOf(this.working).get(unit.unitId),
        nights: nightsInclusive(range.firstNight, range.lastNight),
        people: placement.people,
        confirmSpecialUse: placement.confirmSpecialUse,
        overBeds: { allowed: sameParty, onOverBeds: (warning) => this.warn(warning) },
      });
      if (problem) return problem;
    }
    // Where this placement came from: a row that existed before the plan, else what the plan's own earlier placement of
    // these nights was ("assign A to X, then move A to Y" in one batch is an assignment to Y, not a move in from X).
    const first = existing.find((segment) => !segment.id.startsWith("new:"));
    let type: CreateOp["type"] = first ? "MOVED_IN" : "ASSIGNED";
    let relatedId: string | undefined = first?.id;
    let previous: CreateOp["previous"] = first ? { unitId: first.unitId, bucketId: first.bucketId, firstNight: first.firstNight, lastNight: first.lastNight } : undefined;
    if (!first && inherited) {
      if (inherited.type === "SPLIT_REMAINDER") {
        type = "MOVED_IN";
        relatedId = inherited.relatedId;
        previous = { unitId: inherited.segment.unitId, bucketId: inherited.segment.bucketId, firstNight: inherited.segment.firstNight, lastNight: inherited.segment.lastNight };
      } else {
        type = inherited.type;
        relatedId = inherited.relatedId;
        previous = inherited.previous;
      }
    }
    const unitId = "unitId" in placement.place ? placement.place.unitId : null;
    const bucketId = "bucketId" in placement.place ? placement.place.bucketId : null;
    this.creates.push({
      kind: "CREATE",
      key,
      type,
      segment: { occupantKey: placement.occupantKey, unitId, bucketId, people: placement.people, groupKey: placement.groupKey ?? null, ...range },
      occupant: placement.occupant,
      source: placement.source,
      relatedId,
      previous,
    });
    // A create this placement replaced entirely is gone: releases that pointed at it now point at its replacement.
    for (const edited of editedCreates) {
      if (this.creates.some((candidate) => candidate.key === edited.key)) continue;
      for (const release of this.releases) if (release.relatedKey === edited.key) release.relatedKey = key;
    }
    this.working.push({ id: key, occupantKey: placement.occupantKey, unitId, bucketId, people: placement.people, groupKey: placement.groupKey ?? null, ...range });
    return null;
  }

  /** One warning per room: the largest party it ends up holding above its beds. */
  warn(warning: PlacementWarning) {
    const before = this.warnings.get(warning.unitId);
    this.warnings.set(warning.unitId, before && before.people > warning.people ? before : warning);
  }

  plan(): Plan {
    return { releases: this.releases, creates: this.creates, notes: this.notes, unchanged: this.unchanged, after: this.working, warnings: [...this.warnings.values()] };
  }
}

function samePlace(segment: Pick<Segment, "unitId" | "bucketId">, place: PlanPlace) {
  return "unitId" in place ? segment.unitId === place.unitId : segment.bucketId === place.bucketId;
}

/**
 * Plans a batch of placements in order, each seeing the effect of the ones before it, so a batch cannot overbook a
 * unit with itself. Pure: nothing is written. The first problem stops the plan and names the placement.
 */
export function planPlacements(input: {
  segments: readonly Segment[];
  units: ReadonlyMap<string, PlanUnit>;
  buckets: ReadonlySet<string>;
  eventNights: readonly string[];
  placements: readonly PlanPlacement[];
}): PlanResult {
  const planner = new Planner(input.segments);
  for (const [index, placement] of input.placements.entries()) {
    const problem = planner.tryPlace(placement, input);
    if (problem) return { ok: false, index, problem };
  }
  return { ok: true, plan: planner.plan() };
}

/**
 * The same plan, but a placement that cannot be made is recorded and skipped instead of stopping the batch. The
 * preview of a proposal or a CSV import uses it so staff see every row's outcome.
 */
export function planPlacementsLenient(input: {
  segments: readonly Segment[];
  units: ReadonlyMap<string, PlanUnit>;
  buckets: ReadonlySet<string>;
  eventNights: readonly string[];
  placements: readonly PlanPlacement[];
}): { plan: Plan; problems: Array<{ index: number; problem: PlacementProblem }> } {
  const planner = new Planner(input.segments);
  const problems: Array<{ index: number; problem: PlacementProblem }> = [];
  for (const [index, placement] of input.placements.entries()) {
    const problem = planner.tryPlace(placement, input);
    if (problem) problems.push({ index, problem });
  }
  return { plan: planner.plan(), problems };
}

/** Cancelling a segment, or only some of its nights. */
export function planCancellation(segments: readonly Segment[], segmentId: string, cut: NightRange | null): Plan | null {
  const segment = segments.find((candidate) => candidate.id === segmentId);
  if (!segment) return null;
  const planner = new Planner(segments);
  planner.release(segment, cut && rangesOverlap(segment, cut) ? cut : null, "CANCELLED");
  return { releases: planner.releases, creates: planner.creates, notes: planner.notes, unchanged: 0, after: planner.working };
}

/**
 * A late arrival (the occupant's first night becomes `night`) or an early departure (their last night becomes `night`).
 * The nights given up are released unless the staff member chose to keep them held, in which case only history records it.
 */
export function planStayChange(segments: readonly Segment[], kind: "LATE_ARRIVAL" | "EARLY_DEPARTURE", night: string, keepCapacity: boolean): Plan {
  const planner = new Planner(segments);
  for (const segment of segments) {
    const cut = kind === "LATE_ARRIVAL"
      ? segment.firstNight < night ? { firstNight: segment.firstNight, lastNight: addDays(night, -1) } : null
      : segment.lastNight > night ? { firstNight: addDays(night, 1), lastNight: segment.lastNight } : null;
    if (!cut || !rangesOverlap(segment, cut)) continue;
    if (keepCapacity) planner.notes.push({ kind: "NOTE", id: segment.id, type: kind, before: { ...segment } });
    else planner.release(segment, cut, kind);
  }
  return { releases: planner.releases, creates: planner.creates, notes: planner.notes, unchanged: 0, after: planner.working };
}

/**
 * A transfer gives a segment to another occupant (a replacement attendee, or a placeholder that became a registration):
 * the old segment ends, a new one starts in the same place, and the capacity effect is checked as a new placement.
 */
export function planTransfer(input: {
  segments: readonly Segment[];
  segmentId: string;
  to: { occupantKey: string; attendeeId: string | null; placeholderId: string | null; people: number; groupKey?: string | null };
  units: ReadonlyMap<string, PlanUnit>;
  buckets: ReadonlySet<string>;
  eventNights: readonly string[];
  confirmSpecialUse: boolean;
}): PlanResult {
  const segment = input.segments.find((candidate) => candidate.id === input.segmentId);
  if (!segment) return { ok: false, index: 0, problem: { code: "UNKNOWN_PLACE", message: "That assignment was not found." } };
  if (segment.occupantKey === input.to.occupantKey) {
    return { ok: false, index: 0, problem: { code: "ALREADY_ASSIGNED", message: "That assignment already belongs to them." } };
  }
  const released: Segment[] = input.segments.filter((candidate) => candidate.id !== segment.id);
  const result = planPlacements({
    segments: released,
    units: input.units,
    buckets: input.buckets,
    eventNights: input.eventNights.length > 0 ? [segment.firstNight < input.eventNights[0]! ? segment.firstNight : input.eventNights[0]!, input.eventNights[input.eventNights.length - 1]! > segment.lastNight ? input.eventNights[input.eventNights.length - 1]! : segment.lastNight] : [],
    placements: [{
      occupantKey: input.to.occupantKey,
      occupant: { attendeeId: input.to.attendeeId, placeholderId: input.to.placeholderId },
      people: input.to.people,
      place: segment.unitId ? { unitId: segment.unitId } : { bucketId: segment.bucketId! },
      firstNight: segment.firstNight,
      lastNight: segment.lastNight,
      mode: "ASSIGN",
      confirmSpecialUse: true,
      source: "STAFF",
      groupKey: input.to.groupKey ?? null,
    }],
  });
  if (!result.ok) return result;
  const create = result.plan.creates[0]!;
  create.type = "TRANSFERRED_IN";
  create.relatedId = segment.id;
  return {
    ok: true,
    plan: {
      ...result.plan,
      releases: [{ kind: "RELEASE", id: segment.id, type: "TRANSFERRED_OUT", before: { ...segment }, after: null, relatedKey: create.key }, ...result.plan.releases],
      after: [...released.map((candidate) => ({ ...candidate })), { id: create.key, ...create.segment }],
    },
  };
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const nightSchema = z.string().refine(isNight, "Use a calendar date such as 2027-06-15.");
const reasonSchema = z.string().trim().min(1, "Give a reason.").max(300);
const idSchema = z.string().trim().min(1).max(100);

export const occupantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ATTENDEE"), id: idSchema }).strict(),
  z.object({ kind: z.literal("PLACEHOLDER"), id: idSchema }).strict(),
]);
export type OccupantInput = z.infer<typeof occupantSchema>;

export const placeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("UNIT"), eventUnitId: idSchema }).strict(),
  z.object({ kind: z.literal("BUCKET"), bucketId: idSchema }).strict(),
]);

export const placementSchema = z.object({
  occupant: occupantSchema,
  place: placeSchema,
  firstNight: nightSchema,
  lastNight: nightSchema,
  mode: z.enum(["ASSIGN", "MOVE"]).default("ASSIGN"),
  /** The staff member saw the special-use warning and wants the room anyway. */
  confirmSpecialUse: z.boolean().default(false),
}).strict().refine((value) => value.lastNight >= value.firstNight, { message: "The last night cannot be before the first night.", path: ["lastNight"] });
export type PlacementInput = z.infer<typeof placementSchema>;

export const assignmentActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("place"),
    placements: z.array(placementSchema).min(1).max(MAX_BATCH_PLACEMENTS),
    /** Required for a move; an initial assignment may omit it. */
    reason: z.string().trim().max(300).optional(),
  }).strict(),
  z.object({
    action: z.literal("cancel"),
    assignmentId: idSchema,
    reason: reasonSchema,
    firstNight: nightSchema.optional(),
    lastNight: nightSchema.optional(),
  }).strict(),
  z.object({
    action: z.literal("stay_change"),
    occupant: occupantSchema,
    kind: z.enum(["LATE_ARRIVAL", "EARLY_DEPARTURE"]),
    /** The new first night (late arrival) or the new last night (early departure). */
    night: nightSchema,
    /** Keep the nights held (capacity stays used) instead of releasing them. */
    keepCapacity: z.boolean().default(false),
    reason: reasonSchema,
  }).strict(),
  z.object({
    action: z.literal("transfer"),
    assignmentId: idSchema,
    to: occupantSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({ action: z.literal("release_inactive"), reason: reasonSchema }).strict(),
]);
export type AssignmentAction = z.infer<typeof assignmentActionSchema>;

export const placeholderActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    displayName: z.string().trim().min(1, "Give a name.").max(120),
    headcount: z.number().int().min(1).max(500).default(1),
    note: z.string().trim().max(300).optional(),
  }).strict(),
  z.object({ action: z.literal("link"), placeholderId: idSchema, attendeeId: idSchema, reason: reasonSchema }).strict(),
  z.object({ action: z.literal("archive"), placeholderId: idSchema }).strict(),
]);

export const bucketRenameSchema = z.object({
  bucketId: idSchema,
  label: z.string().trim().min(1, "Give a name.").max(60),
}).strict();

export const assignmentSettingsSchema = z.object({
  showAssignmentsToAttendees: z.boolean().optional(),
  showRoommateFirstNames: z.boolean().optional(),
  attendeeInstructions: z.string().trim().max(1000).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Nothing to change.");

export const planRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("preview"), source: z.enum(["PROPOSAL", "CSV_IMPORT"]), csv: z.string().max(MAX_IMPORT_BYTES).optional() }).strict(),
  z.object({
    mode: z.literal("apply"),
    source: z.enum(["PROPOSAL", "CSV_IMPORT"]),
    csv: z.string().max(MAX_IMPORT_BYTES).optional(),
    /** The fingerprint the preview returned: apply refuses if what would happen has changed since. */
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().max(300).optional(),
  }).strict(),
]);

// ---------------------------------------------------------------------------
// Households: colours, warnings and suggestions
// ---------------------------------------------------------------------------

export type PersonFact = {
  occupantKey: string;
  /** The registration (the household); null for a placeholder. */
  registrationId: string | null;
  personId: string | null;
  name: string;
};

/** A stable colour per household (an index into a fixed palette the workspace defines). */
export function householdColorIndex(registrationId: string, paletteSize: number) {
  let hash = 0;
  for (const character of registrationId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % paletteSize;
}

export type AssignmentWarning =
  | { kind: "SPLIT_HOUSEHOLD"; night: string; members: string[] }
  | { kind: "KEEP_APART"; night: string; ruleId: string; members: [string, string]; unitId: string };

/**
 * Keep-together groups that are split across different places (or partly unassigned) on a night, and keep-apart
 * people who share a unit. Warnings only: staff may still go ahead. `personByKey` maps an occupant key to a person id.
 */
export function assignmentWarnings(input: {
  nights: readonly string[];
  segments: readonly Segment[];
  together: TogetherInput;
  /** Occupant key by person id (attendees only: a placeholder has no household). */
  occupantKeyByPerson: ReadonlyMap<string, string>;
}): AssignmentWarning[] {
  const warnings: AssignmentWarning[] = [];
  const placeOn = (occupantKey: string, night: string) => {
    const segment = input.segments.find((candidate) => candidate.occupantKey === occupantKey && candidate.firstNight <= night && night <= candidate.lastNight);
    return segment ? placeKey(segment) : null;
  };
  const seenSplit = new Set<string>();
  const seenApart = new Set<string>();
  for (const night of input.nights) {
    for (const group of togetherGroupsOn(night, input.together)) {
      const places = group.map((personId) => placeOn(input.occupantKeyByPerson.get(personId) ?? personId, night));
      const placed = places.filter((place): place is string => place !== null);
      // Nobody placed yet is not a split; some placed apart, or some placed and some not, is.
      if (placed.length === 0) continue;
      if (new Set(placed).size > 1 || placed.length < group.length) {
        const fingerprint = [...group].sort().join(",");
        if (!seenSplit.has(fingerprint)) {
          seenSplit.add(fingerprint);
          warnings.push({ kind: "SPLIT_HOUSEHOLD", night, members: group });
        }
      }
    }
    for (const rule of input.together.rules) {
      if (rule.kind !== "SEPARATE" || !rule.personBId || !ruleActiveOn(rule, night) || seenApart.has(rule.id)) continue;
      const a = placeOn(input.occupantKeyByPerson.get(rule.personAId) ?? rule.personAId, night);
      const b = placeOn(input.occupantKeyByPerson.get(rule.personBId) ?? rule.personBId, night);
      if (a && a === b && a.startsWith("unit:")) {
        seenApart.add(rule.id);
        warnings.push({ kind: "KEEP_APART", night, ruleId: rule.id, members: [rule.personAId, rule.personBId], unitId: a.slice("unit:".length) });
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Rule-assisted proposal (preview only; never applied by itself)
// ---------------------------------------------------------------------------

export type ProposalPerson = {
  occupantKey: string;
  occupant: { attendeeId: string | null; placeholderId: string | null };
  people: number;
  registrationId: string | null;
  personId: string | null;
  /** The nights the person wants (a request's nights, or the whole event). Never empty. */
  nights: string[];
  category: LodgingCategory | null;
  /** Read only when the caller may see accessibility flags (VIEW_SENSITIVE_DATA); false otherwise. */
  needsGroundFloor: boolean;
};

export type ProposalUnit = PlanUnit & {
  category: LodgingCategory | null;
  kind: "ROOM" | "RV_SITE" | "TENT";
  isArea: boolean;
  groundLevel: boolean;
  sortOrder: number;
};

export type ProposalResult = {
  placements: PlanPlacement[];
  unplaced: Array<{ occupantKey: string; reason: string }>;
};

/**
 * A deterministic, rule-assisted proposal for the people who are not placed yet:
 * - households first (the together groups, then each registration), largest and accessibility-needing first;
 * - the requested category is honoured (no request: a room, never a site or a tent);
 * - a household that needs the ground floor gets a ground-level unit;
 * - keep-apart people never share a unit; held, unavailable and special-use rooms are never proposed;
 * - the smallest unit that fits is used, so large rooms stay free for large households.
 * It returns placements for staff to preview. Nothing is applied here.
 */
export function proposeAssignments(input: {
  people: readonly ProposalPerson[];
  units: readonly ProposalUnit[];
  segments: readonly Segment[];
  together: TogetherInput;
  eventNights: readonly string[];
}): ProposalResult {
  const unplaced: ProposalResult["unplaced"] = [];
  const placements: PlanPlacement[] = [];
  const placedKeys = new Set(input.segments.map((segment) => segment.occupantKey));
  const waiting = input.people.filter((person) => !placedKeys.has(person.occupantKey));
  const byPerson = new Map(waiting.filter((person) => person.personId).map((person) => [person.personId!, person]));
  // Households: together groups first (they may span registrations), then what is left of each registration.
  const householdOf = new Map<string, string>();
  const firstNight = input.eventNights[0];
  if (firstNight) {
    for (const group of togetherGroupsOn(firstNight, input.together)) {
      const members = group.filter((personId) => byPerson.has(personId));
      if (members.length === 0) continue;
      const id = `group:${[...members].sort()[0]}`;
      for (const personId of members) householdOf.set(byPerson.get(personId)!.occupantKey, id);
    }
  }
  const households = new Map<string, ProposalPerson[]>();
  for (const person of waiting) {
    const id = householdOf.get(person.occupantKey) ?? `solo:${person.occupantKey}`;
    households.set(id, [...(households.get(id) ?? []), person]);
  }
  const apart = new Map<string, Set<string>>();
  for (const rule of input.together.rules) {
    if (rule.kind !== "SEPARATE" || !rule.personBId || rule.ended) continue;
    apart.set(rule.personAId, new Set([...(apart.get(rule.personAId) ?? []), rule.personBId]));
    apart.set(rule.personBId, new Set([...(apart.get(rule.personBId) ?? []), rule.personAId]));
  }
  const ordered = [...households.entries()].sort(([idA, a], [idB, b]) => {
    const needA = a.some((person) => person.needsGroundFloor) ? 0 : 1;
    const needB = b.some((person) => person.needsGroundFloor) ? 0 : 1;
    if (needA !== needB) return needA - needB;
    const sizeA = a.reduce((total, person) => total + person.people, 0);
    const sizeB = b.reduce((total, person) => total + person.people, 0);
    if (sizeA !== sizeB) return sizeB - sizeA;
    return idA.localeCompare(idB);
  });
  const units = new Map(input.units.map((unit) => [unit.unitId, unit]));
  let working = [...input.segments].map((segment) => ({ ...segment }));
  const personIdOfKey = new Map(input.people.filter((person) => person.personId).map((person) => [person.occupantKey, person.personId!]));
  const unitPeople = (unitId: string) => working.filter((segment) => segment.unitId === unitId).map((segment) => personIdOfKey.get(segment.occupantKey)).filter((id): id is string => Boolean(id));

  for (const [, members] of ordered) {
    const categories = new Set(members.map((person) => person.category ?? "ROOM_ANY"));
    const needsGround = members.some((person) => person.needsGroundFloor);
    const candidates = input.units
      .filter((unit) => !unit.specialUse)
      .filter((unit) => {
        if (categories.size === 1) {
          const [wanted] = [...categories];
          return wanted === "ROOM_ANY" ? unit.kind === "ROOM" && !unit.isArea : unit.category === wanted;
        }
        // Mixed requests in one household: any unit that fits every member's category is unlikely; use rooms.
        return unit.kind === "ROOM" && !unit.isArea;
      })
      .filter((unit) => !needsGround || unit.groundLevel || unit.kind !== "ROOM")
      .sort((a, b) => {
        const slackA = a.capacityOverride ?? a.defaultCapacity ?? Number.MAX_SAFE_INTEGER;
        const slackB = b.capacityOverride ?? b.defaultCapacity ?? Number.MAX_SAFE_INTEGER;
        return slackA - slackB || a.sortOrder - b.sortOrder || a.unitId.localeCompare(b.unitId);
      });
    let placed = false;
    for (const unit of candidates) {
      // Keep-apart: nobody already in the unit, or in this household, may be kept apart from another.
      const present = new Set([...unitPeople(unit.unitId), ...members.flatMap((person) => (person.personId ? [person.personId] : []))]);
      const clash = [...present].some((personId) => [...(apart.get(personId) ?? [])].some((other) => present.has(other)));
      if (clash) continue;
      const trial = planPlacements({
        segments: working,
        units,
        buckets: new Set(),
        eventNights: input.eventNights,
        placements: members.map((person) => ({
          occupantKey: person.occupantKey,
          occupant: person.occupant,
          people: person.people,
          place: { unitId: unit.unitId },
          firstNight: person.nights[0]!,
          lastNight: person.nights[person.nights.length - 1]!,
          mode: "ASSIGN" as const,
          confirmSpecialUse: false,
          source: "PROPOSAL" as const,
        })),
      });
      if (!trial.ok) continue;
      working = trial.plan.after.map((segment) => ({ ...segment }));
      for (const create of trial.plan.creates) {
        const person = members.find((candidate) => candidate.occupantKey === create.segment.occupantKey)!;
        placements.push({
          occupantKey: create.segment.occupantKey,
          occupant: person.occupant,
          people: create.segment.people,
          place: { unitId: unit.unitId },
          firstNight: create.segment.firstNight,
          lastNight: create.segment.lastNight,
          mode: "ASSIGN",
          confirmSpecialUse: false,
          source: "PROPOSAL",
        });
      }
      placed = true;
      break;
    }
    if (!placed) {
      const reason = members.length > 1 ? "No single room fits this household for all its nights." : "No suitable room is free for all their nights.";
      for (const person of members) unplaced.push({ occupantKey: person.occupantKey, reason });
    }
  }
  return { placements, unplaced };
}

// ---------------------------------------------------------------------------
// Conflicts and exceptions
// ---------------------------------------------------------------------------

export const exceptionKinds = [
  "OVER_CAPACITY",
  "UNIT_OUT_OF_SERVICE",
  "INACTIVE_REGISTRATION",
  "UNASSIGNED",
  "ACCESSIBILITY_UNMET",
  "SPLIT_HOUSEHOLD",
  "KEEP_APART",
  "OPEN_WAITLIST",
  "OBSOLETE_NOTICE",
  "UNLINKED_PLACEHOLDER",
  "REQUEST_CATEGORY_DIFFERS",
  "EXTRA_BEDDING",
] as const;
export type ExceptionKind = (typeof exceptionKinds)[number];

export const exceptionKindLabels: Record<ExceptionKind, string> = {
  OVER_CAPACITY: "Over capacity",
  UNIT_OUT_OF_SERVICE: "Room closed or held after assignment",
  INACTIVE_REGISTRATION: "Assigned, but the registration is no longer active",
  UNASSIGNED: "Not placed yet",
  ACCESSIBILITY_UNMET: "Ground floor needed, placed upstairs",
  SPLIT_HOUSEHOLD: "Household split across rooms",
  KEEP_APART: "Keep-apart people share a room",
  OPEN_WAITLIST: "Still on the lodging waitlist",
  OBSOLETE_NOTICE: "Room notice is out of date",
  UNLINKED_PLACEHOLDER: "Expected guest not linked to a registration",
  REQUEST_CATEGORY_DIFFERS: "Placed in a different type than requested",
  EXTRA_BEDDING: "Party above the room's beds (extra bedding)",
};

/** Restricted: only staff holding VIEW_SENSITIVE_DATA see these. */
export const sensitiveExceptionKinds: ReadonlySet<ExceptionKind> = new Set<ExceptionKind>(["ACCESSIBILITY_UNMET"]);

export type ExceptionSection = "CONFLICT" | "CLOSEOUT";
export const exceptionSection: Record<ExceptionKind, ExceptionSection> = {
  OVER_CAPACITY: "CONFLICT",
  UNIT_OUT_OF_SERVICE: "CONFLICT",
  INACTIVE_REGISTRATION: "CLOSEOUT",
  UNASSIGNED: "CONFLICT",
  ACCESSIBILITY_UNMET: "CONFLICT",
  SPLIT_HOUSEHOLD: "CONFLICT",
  KEEP_APART: "CONFLICT",
  OPEN_WAITLIST: "CLOSEOUT",
  OBSOLETE_NOTICE: "CLOSEOUT",
  UNLINKED_PLACEHOLDER: "CLOSEOUT",
  REQUEST_CATEGORY_DIFFERS: "CONFLICT",
  EXTRA_BEDDING: "CLOSEOUT",
};

export type ExceptionRow = {
  kind: ExceptionKind;
  /** A stable key for the row (the unit, assignment or person it is about). */
  key: string;
  title: string;
  detail: string;
  /** Drill-down: the assignments behind the row. */
  assignmentIds: string[];
  unitId?: string;
  night?: string;
};

/**
 * The nights a unit holds more people than it takes, each classified: `oneParty` when a numbered room holds people of a single
 * registration only (that party is bringing sleeping bags or air mattresses: a warning, #803), otherwise an overfill. The one
 * rule the closeout report and the workspace share, night by night, so they cannot disagree.
 */
export function overBedsByNight(unit: PlanUnit, segments: readonly Segment[], nights: readonly string[]) {
  const result: Array<{ night: string; people: number; beds: number; oneParty: boolean; present: Segment[] }> = [];
  for (const night of nights) {
    const present = segments.filter((segment) => segment.unitId === unit.unitId && segment.firstNight <= night && night <= segment.lastNight);
    if (present.length === 0) continue;
    const people = present.reduce((sum, segment) => sum + segment.people, 0);
    const row = unitNight(unit, night, people);
    if (row.status !== "AVAILABLE" || row.capacity === null || people <= row.capacity) continue;
    const oneParty = Boolean(unit.roomLike && present[0]?.groupKey && present.every((segment) => segment.groupKey === present[0]!.groupKey));
    result.push({ night, people, beds: row.capacity, oneParty, present });
  }
  return result;
}

/** Unit-nights over capacity, and assignments on nights when the unit is closed, held or retired. Night by night. */
export function unitConflicts(input: {
  nights: readonly string[];
  units: ReadonlyMap<string, PlanUnit>;
  segments: readonly (Segment & { assignmentId: string })[];
}): ExceptionRow[] {
  const rows: ExceptionRow[] = [];
  const bySegmentUnit = new Map<string, Array<Segment & { assignmentId: string }>>();
  for (const segment of input.segments) {
    if (!segment.unitId) continue;
    bySegmentUnit.set(segment.unitId, [...(bySegmentUnit.get(segment.unitId) ?? []), segment]);
  }
  for (const [unitId, segments] of bySegmentUnit) {
    const unit = input.units.get(unitId);
    if (!unit) continue;
    let overNight: string | null = null;
    let closedNight: string | null = null;
    let beddingNight: string | null = null;
    let overAssignments = new Set<string>();
    const beddingAssignments = new Set<string>();
    const closedAssignments = new Set<string>();
    for (const night of input.nights) {
      const present = segments.filter((segment) => segment.firstNight <= night && night <= segment.lastNight);
      if (present.length === 0) continue;
      const total = present.reduce((sum, segment) => sum + segment.people, 0);
      if (unitNight(unit, night, total).status !== "AVAILABLE") {
        closedNight ??= night;
        for (const segment of present) closedAssignments.add(segment.assignmentId);
      }
    }
    for (const over of overBedsByNight(unit, segments, input.nights)) {
      const ids = over.present.map((segment) => (segment as Segment & { assignmentId: string }).assignmentId);
      if (over.oneParty) {
        beddingNight ??= over.night;
        for (const id of ids) beddingAssignments.add(id);
      } else {
        overNight ??= over.night;
        overAssignments = new Set([...overAssignments, ...ids]);
      }
    }
    if (overNight) rows.push({ kind: "OVER_CAPACITY", key: `over:${unitId}`, title: `${unit.name} is over capacity`, detail: `More people are placed than the room takes, first on ${overNight}.`, assignmentIds: [...overAssignments], unitId, night: overNight });
    if (beddingNight) rows.push({ kind: "EXTRA_BEDDING", key: `bedding:${unitId}`, title: `${unit.name} holds a party above its beds`, detail: `One party is placed above the room's beds, first on ${beddingNight}. The registrant brings extra bedding; check the room can take it.`, assignmentIds: [...beddingAssignments], unitId, night: beddingNight });
    if (closedNight) rows.push({ kind: "UNIT_OUT_OF_SERVICE", key: `closed:${unitId}`, title: `${unit.name} is out of service`, detail: `People are placed on nights when the room is unavailable or held, first on ${closedNight}. Move them or restore the room.`, assignmentIds: [...closedAssignments], unitId, night: closedNight });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type OccupancyNight = {
  night: string;
  capacity: number;
  occupied: number;
  available: number;
  unitsInService: number;
  /** An in-service unit with no fixed limit is present (its places are not in `capacity`). */
  unlimited: boolean;
  /** People in alternate housing this night (they use no on-site inventory). */
  offsite: number;
  /** Of `occupied`, people in a room that is closed, held or retired this night (a conflict: it has no places to count against). */
  inClosedRooms: number;
};

/** Occupancy night by night for every in-service unit, reproduced from the current assignments. */
export function occupancyByNight(input: {
  nights: readonly string[];
  units: readonly PlanUnit[];
  segments: readonly Segment[];
}): OccupancyNight[] {
  const occupancy = occupancyOf(input.segments);
  return input.nights.map((night) => {
    const row: OccupancyNight = { night, capacity: 0, occupied: 0, available: 0, unitsInService: 0, unlimited: false, offsite: 0, inClosedRooms: 0 };
    for (const unit of input.units) {
      const unitRow = unitNight(unit, night, occupancy.get(unit.unitId)?.get(night) ?? 0);
      // People placed in a room that closed after they were placed still count as placed, and are flagged.
      if (unitRow.status !== "AVAILABLE") {
        row.occupied += unitRow.occupied;
        row.inClosedRooms += unitRow.occupied;
        continue;
      }
      row.unitsInService += 1;
      row.occupied += unitRow.occupied;
      if (unitRow.capacity === null) row.unlimited = true;
      else {
        row.capacity += unitRow.capacity;
        row.available += unitRow.available ?? 0;
      }
    }
    for (const segment of input.segments) {
      if (segment.bucketId && segment.firstNight <= night && night <= segment.lastNight) row.offsite += segment.people;
    }
    return row;
  });
}

export const ASSIGNMENT_CSV_HEADERS = [
  "Occupant ID",
  "Kind",
  "Registration code",
  "Name",
  "Building",
  "Place",
  "Place key",
  "First night",
  "Last night",
  "People",
] as const;
export const ASSIGNMENT_ACCESSIBILITY_HEADERS = ["Ground floor needed", "Accessible room needed"] as const;

export type AssignmentCsvRow = {
  occupantId: string;
  kind: "Attendee" | "Placeholder";
  registrationCode: string;
  name: string;
  building: string;
  place: string;
  placeKey: string;
  firstNight: string;
  lastNight: string;
  people: number;
  groundFloorNeeded?: boolean;
  accessibleRoomNeeded?: boolean;
};

export function assignmentCsvCells(row: AssignmentCsvRow, includeAccessibility: boolean): Array<string | number> {
  return [
    row.occupantId,
    row.kind,
    row.registrationCode,
    row.name,
    row.building,
    row.place,
    row.placeKey,
    row.firstNight,
    row.lastNight,
    row.people,
    ...(includeAccessibility ? [row.groundFloorNeeded ? "Yes" : "No", row.accessibleRoomNeeded ? "Yes" : "No"] : []),
  ];
}

export type ImportRow = {
  line: number;
  occupantId: string;
  placeKey: string;
  firstNight: string;
  lastNight: string;
};

export type ImportParseResult = { rows: ImportRow[]; problems: Array<{ line: number; message: string }> };

function normalizeCsvHeader(value: string) {
  return value.replace(/^﻿/, "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** A cell that the export's formula guard prefixed with an apostrophe comes back without it. */
function cleanCell(value: string | undefined) {
  const text = (value ?? "").trim();
  return text.startsWith("'") ? text.slice(1).trim() : text;
}

/**
 * Reads a CSV of assignments (the export's own columns): the occupant id, the place key and the nights. Names are
 * ignored on purpose so a spreadsheet edit of a name can never reassign anyone. Reports every problem with its line.
 */
export function parseAssignmentCsv(matrix: readonly (readonly string[])[]): ImportParseResult {
  const problems: ImportParseResult["problems"] = [];
  const header = (matrix[0] ?? []).map(normalizeCsvHeader);
  const column = (name: string) => header.indexOf(name);
  const idIndex = column("occupant id");
  const placeIndex = column("place key");
  const firstIndex = column("first night");
  const lastIndex = column("last night");
  const missing = [["Occupant ID", idIndex], ["Place key", placeIndex], ["First night", firstIndex], ["Last night", lastIndex]].filter(([, index]) => index === -1).map(([name]) => name);
  if (missing.length > 0) {
    return { rows: [], problems: [{ line: 1, message: `The CSV needs the columns: ${missing.join(", ")}.` }] };
  }
  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  for (const [offset, cells] of matrix.slice(1).entries()) {
    const line = offset + 2;
    const occupantId = cleanCell(cells[idIndex]);
    const placeKeyValue = cleanCell(cells[placeIndex]);
    const first = cleanCell(cells[firstIndex]);
    const last = cleanCell(cells[lastIndex]);
    if (!occupantId) { problems.push({ line, message: "The occupant id is empty." }); continue; }
    if (!placeKeyValue) { problems.push({ line, message: "The place key is empty (leave a person out to leave them unplaced)." }); continue; }
    if (!isNight(first) || !isNight(last)) { problems.push({ line, message: "The nights must be calendar dates such as 2027-06-15." }); continue; }
    if (last < first) { problems.push({ line, message: "The last night is before the first night." }); continue; }
    const duplicate = `${occupantId}|${first}|${last}`;
    if (seen.has(duplicate)) { problems.push({ line, message: "This row repeats an earlier one." }); continue; }
    seen.add(duplicate);
    rows.push({ line, occupantId, placeKey: placeKeyValue, firstNight: first, lastNight: last });
  }
  return { rows, problems };
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export const waitlistStatuses = ["JOINED", "OFFERED", "ACCEPTED", "DECLINED", "EXPIRED", "REMOVED", "PROMOTED"] as const;
export type WaitlistStatus = (typeof waitlistStatuses)[number];
export const waitlistStatusLabels: Record<WaitlistStatus, string> = {
  JOINED: "Waiting",
  OFFERED: "Offered",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  EXPIRED: "Offer expired",
  REMOVED: "Removed",
  PROMOTED: "Placed",
};

/** The same moves the database enforces. */
export const waitlistTransitions: Record<WaitlistStatus, readonly WaitlistStatus[]> = {
  JOINED: ["OFFERED", "REMOVED"],
  OFFERED: ["ACCEPTED", "DECLINED", "EXPIRED", "REMOVED"],
  EXPIRED: ["OFFERED", "REMOVED"],
  ACCEPTED: ["PROMOTED", "REMOVED"],
  DECLINED: [],
  REMOVED: [],
  PROMOTED: [],
};

export function canMoveWaitlist(from: WaitlistStatus, to: WaitlistStatus) {
  return waitlistTransitions[from].includes(to);
}

export const OPEN_WAITLIST_STATUSES: readonly WaitlistStatus[] = ["JOINED", "OFFERED", "ACCEPTED"];
export const DEFAULT_OFFER_HOURS = 48;
export const MAX_OFFER_HOURS = 24 * 14;
export const MAX_OFFER_BATCH = 25;

export function offerExpiry(now: Date, hours: number) {
  return new Date(now.getTime() + hours * 3_600_000);
}

/** An offer that has passed its expiry can no longer be accepted, whether or not anyone has recorded the expiry yet. */
export function isOfferLapsed(entry: { status: WaitlistStatus; offerExpiresAt: Date | string | null }, now: Date) {
  return entry.status === "OFFERED" && entry.offerExpiresAt !== null && new Date(entry.offerExpiresAt).getTime() <= now.getTime();
}

export const waitlistStaffActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("join"),
    registrationId: idSchema,
    category: z.enum(lodgingCategories),
    firstNight: nightSchema.nullish(),
    lastNight: nightSchema.nullish(),
    partySize: z.number().int().min(1).max(50),
    /** Rooms wanted (room-type categories); when omitted, what the registration's request asked for, else 1 (#803). */
    roomCount: z.number().int().min(1).max(50).optional(),
    reason: z.string().trim().max(300).optional(),
  }).strict().refine((value) => (value.firstNight == null) === (value.lastNight == null), { message: "Give both nights or neither.", path: ["lastNight"] })
    .refine((value) => !value.firstNight || !value.lastNight || value.lastNight >= value.firstNight, { message: "The last night cannot be before the first night.", path: ["lastNight"] }),
  z.object({
    action: z.literal("offer"),
    entryIds: z.array(idSchema).min(1).max(MAX_OFFER_BATCH),
    expiresInHours: z.number().int().min(1).max(MAX_OFFER_HOURS).default(DEFAULT_OFFER_HOURS),
    /** Without it the call only previews who would be emailed: nothing is queued. */
    confirm: z.boolean().default(false),
  }).strict(),
  z.object({ action: z.literal("expire_lapsed") }).strict(),
  z.object({ action: z.literal("accept"), entryId: idSchema, reason: reasonSchema }).strict(),
  z.object({ action: z.literal("decline"), entryId: idSchema, reason: reasonSchema }).strict(),
  z.object({ action: z.literal("remove"), entryId: idSchema, reason: reasonSchema }).strict(),
  z.object({
    action: z.literal("promote"),
    entryId: idSchema,
    /** The unit to place the party in: each registration attendee in the party is placed there for the entry's nights. */
    eventUnitId: idSchema,
    attendeeIds: z.array(idSchema).min(1).max(50),
    confirmSpecialUse: z.boolean().default(false),
  }).strict(),
]);

export const waitlistRegistrantActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("join"),
    category: z.enum(lodgingCategories),
    firstNight: nightSchema.nullish(),
    lastNight: nightSchema.nullish(),
    partySize: z.number().int().min(1).max(50),
    roomCount: z.number().int().min(1).max(50).optional(),
  }).strict().refine((value) => (value.firstNight == null) === (value.lastNight == null), { message: "Give both nights or neither.", path: ["lastNight"] }),
  z.object({ action: z.literal("accept") }).strict(),
  z.object({ action: z.literal("decline") }).strict(),
]);

// ---------------------------------------------------------------------------
// Notices (room notices and their versions)
// ---------------------------------------------------------------------------

/** A room notice describes the assignments as they were at its version; any later change makes it obsolete. */
export function noticeIsObsolete(noticeVersion: number, currentVersion: number) {
  return currentVersion > noticeVersion;
}

// ---------------------------------------------------------------------------
// Attendee display
// ---------------------------------------------------------------------------

/** The first name only, from a display name: never a surname, never a contact detail. */
export function firstNameOf(name: string) {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.length > 40 ? first.slice(0, 40) : first;
}
