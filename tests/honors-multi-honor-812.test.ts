import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { HonorMultiSelect } from "@/components/honor-multi-select";
import { classSlotConflict, offeringPlacementPatch } from "@/modules/honors/domain";
import {
  honorSetChange,
  honorSetLockMessage,
  joinHonorNames,
  summarizeOfferingHonors,
} from "@/modules/honors/offering-honors";
import { honorOfferingInputSchema, honorOfferingUpdateSchema, MAX_HONORS_PER_CLASS } from "@/modules/honors/schemas";
import { classRostersCsv, buildClassRosters, type RosterAttendee, type RosterOffering } from "@/modules/honors/roster-domain";
import { writeBackHonorsWeekendCompletions } from "@/modules/honors/weekend-completion-repository";

const honor = (id: string, name = id, code = id.toUpperCase()) => ({ honor: { id, name, code, isActive: true } });

describe("naming the honors of a class", () => {
  it("lists them in order and joins names and codes", () => {
    const summary = summarizeOfferingHonors([honor("a", "Knots", "K-1"), honor("b", "Fire", "F-1")]);
    expect(summary).toMatchObject({ honorIds: ["a", "b"], honorName: "Knots + Fire", honorCode: "K-1 + F-1" });
    expect(joinHonorNames(["Only"])).toBe("Only");
  });
});

describe("how a class's set of honors changes", () => {
  it("separates added, removed and merely reordered", () => {
    expect(honorSetChange(["a", "b"], ["a", "b"])).toMatchObject({ changed: false, reordered: false });
    expect(honorSetChange(["a", "b"], ["b", "a"])).toMatchObject({ changed: false, reordered: true });
    expect(honorSetChange(["a", "b"], ["b", "c"])).toMatchObject({ added: ["c"], removed: ["a"], changed: true });
  });

  it("words the lock per honor, and says nothing for a reorder", () => {
    const names: Record<string, string> = { a: "Knots", b: "Fire", c: "Birds" };
    const nameOf = (id: string) => names[id]!;
    expect(honorSetLockMessage(honorSetChange(["a", "b"], ["b", "a"]), nameOf)).toBeNull();
    expect(honorSetLockMessage(honorSetChange(["a", "b"], ["a"]), nameOf)).toContain("Fire can't be removed");
    expect(honorSetLockMessage(honorSetChange(["a"], ["a", "c"]), nameOf)).toContain("Birds can't be added");
  });
});

describe("one honor, one slot, whichever class teaches it", () => {
  const single = (honorIds: string[], sessionId: string, locationId: string | null = null) => ({ honorIds, span: "SINGLE_SESSION" as const, sessionId, locationId });
  const all = (honorIds: string[], locationId: string | null = null) => ({ honorIds, span: "ALL_SESSIONS" as const, sessionId: null, locationId });

  it("allows different honors, or the same honor in different sessions", () => {
    expect(classSlotConflict(single(["a", "b"], "s1"), [single(["c"], "s1")])).toBeNull();
    expect(classSlotConflict(single(["a", "b"], "s2"), [single(["a", "b"], "s1")])).toBeNull();
  });

  it("refuses an honor already taught in the session, by any class", () => {
    expect(classSlotConflict(single(["a", "b"], "s1"), [single(["c", "b"], "s1")], (id) => id.toUpperCase())).toBe("B: This honor is already offered in that session.");
    expect(classSlotConflict(single(["a"], "s1"), [single(["a"], "s1")])).toBe("This honor is already offered in that session.");
  });

  it("keeps the all-sessions rules per honor and per site", () => {
    expect(classSlotConflict(all(["a", "b"]), [all(["b"])])).toMatch(/already offered across all sessions/);
    expect(classSlotConflict(all(["a", "b"]), [single(["b"], "s1")])).toMatch(/already offered in a single session/);
    expect(classSlotConflict(single(["a", "b"], "s1"), [all(["b"])])).toMatch(/can't also be in a single session/);
    // A second site may run the same honors.
    expect(classSlotConflict(all(["a", "b"], "loc-2"), [all(["a", "b"], "loc-1")])).toBeNull();
  });
});

describe("the class form's patch and the request schemas", () => {
  const current = { honorIds: ["a", "b"], span: "SINGLE_SESSION" as const, sessionId: "s1" };

  it("sends the honors only when the set or its order changed", () => {
    expect(offeringPlacementPatch(current, { ...current, honorIds: ["a", "b"] })).toEqual({});
    expect(offeringPlacementPatch(current, { ...current, honorIds: ["b", "a"] })).toEqual({ honorIds: ["b", "a"] });
    expect(offeringPlacementPatch(current, { ...current, honorIds: ["a"] })).toEqual({ honorIds: ["a"] });
  });

  const base = { span: "ALL_SESSIONS", sessionId: null, capacity: 10 };

  it("takes honorIds, and still reads the older single honorId as a list of one", () => {
    expect(honorOfferingInputSchema.parse({ ...base, honorIds: ["a", "b"] }).honorIds).toEqual(["a", "b"]);
    expect(honorOfferingInputSchema.parse({ ...base, honorId: "a" }).honorIds).toEqual(["a"]);
    expect(honorOfferingUpdateSchema.parse({ honorIds: ["b", "a"] })).toEqual({ honorIds: ["b", "a"] });
  });

  it("needs at least one honor, each once, and not more than the limit", () => {
    expect(honorOfferingInputSchema.safeParse({ ...base, honorIds: [] }).success).toBe(false);
    expect(honorOfferingInputSchema.safeParse({ ...base }).success).toBe(false);
    expect(honorOfferingInputSchema.safeParse({ ...base, honorIds: ["a", "a"] }).success).toBe(false);
    expect(honorOfferingInputSchema.safeParse({ ...base, honorIds: Array.from({ length: MAX_HONORS_PER_CLASS + 1 }, (_, index) => `h${index}`) }).success).toBe(false);
    expect(honorOfferingUpdateSchema.safeParse({ honorIds: [] }).success).toBe(false);
    expect(honorOfferingUpdateSchema.safeParse({ honorIds: [""] }).success).toBe(false);
  });
});

describe("rosters and exports for a multi-honor class", () => {
  const offering: RosterOffering = {
    id: "o1", honorName: "Knots + Fire", honorCode: "K-1 + F-1", span: "SINGLE_SESSION", sessionId: "s1",
    capacity: 5, teacherName: "A. Teacher", location: "Barn", isActive: true,
  };
  const person: RosterAttendee = {
    id: "p1", firstName: "Ada", lastName: "Demo", clubId: "c1", clubName: "Synthetic Club", ageOnEventDate: 11,
    attendeeType: "YOUTH", checkedIn: false, dietary: null,
  };

  it("lists one class row per person under all of its honors", () => {
    const rosters = buildClassRosters(
      [{ id: "s1", name: "Sabbath", sortOrder: 0 }],
      [offering],
      [{ offeringId: "o1", attendeeId: "p1", consumesSeat: true }],
      [person],
    );
    const csv = classRostersCsv(rosters);
    expect(csv).toContain("K-1 + F-1");
    expect(csv).toContain("Knots + Fire");
    expect(csv).toContain("Demo");
  });
});

describe("completing a class completes each honor it teaches", () => {
  type Row = Record<string, unknown>;
  let entries: Row[];
  let links: Row[];
  let sequence: number;

  function enrollment(id: string, honorIds: string[], linkedHonorIds: string[] = []) {
    return {
      id, organizationId: "club-1",
      weekendCompletions: linkedHonorIds.map((honorId) => ({ honorId })),
      offering: { honors: honorIds.map((honorId) => ({ honorId })) },
      registrationAttendee: { profileSnapshot: { clubRosterMemberId: "m1" }, checkIns: [{ id: "ci" }] },
    };
  }

  function install(enrollments: Row[]) {
    entries = [];
    links = [];
    sequence = 0;
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      honorEnrollment: { findMany: vi.fn(async () => enrollments) },
      clubRosterMember: { findMany: vi.fn(async () => [{ id: "m1", personId: "person-1", organizationId: "club-1" }]) },
      memberHonorEntry: {
        findFirst: vi.fn(async ({ where }: { where: { honorId: string } }) => entries.filter((entry) => entry.honorId === where.honorId).at(-1) ?? null),
        create: vi.fn(async ({ data }: { data: Row }) => {
          const row = { ...data, id: `entry-${++sequence}` };
          entries.push(row);
          return { id: row.id };
        }),
      },
      honorWeekendCompletionLink: { create: vi.fn(async ({ data }: { data: Row }) => { links.push(data); }) },
    };
    mocks.getPrisma.mockReturnValue({
      event: { findUnique: vi.fn(async () => ({ id: "e1", startsAt: new Date("2026-10-10T18:00:00Z") })) },
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeAuditLog.mockResolvedValue({});
  });

  it("writes one COMPLETED record and one link per honor of the class", async () => {
    install([enrollment("en1", ["honor-a", "honor-b", "honor-c"])]);
    const result = await writeBackHonorsWeekendCompletions("e1", "staff-1");
    expect(result).toEqual({ written: 3, alreadyRecorded: 0, skipped: 0 });
    expect(entries.map((entry) => entry.honorId).sort()).toEqual(["honor-a", "honor-b", "honor-c"]);
    expect(entries.every((entry) => entry.status === "COMPLETED" && entry.personId === "person-1")).toBe(true);
    expect(links.map((link) => [link.enrollmentId, link.honorId]).sort()).toEqual([["en1", "honor-a"], ["en1", "honor-b"], ["en1", "honor-c"]]);
  });

  it("writes only the honors not yet linked, so running twice writes nothing new", async () => {
    install([enrollment("en1", ["honor-a", "honor-b"], ["honor-a"])]);
    const result = await writeBackHonorsWeekendCompletions("e1", "staff-1");
    expect(result).toEqual({ written: 1, alreadyRecorded: 1, skipped: 0 });
    expect(entries.map((entry) => entry.honorId)).toEqual(["honor-b"]);
    install([enrollment("en1", ["honor-a", "honor-b"], ["honor-a", "honor-b"])]);
    expect(await writeBackHonorsWeekendCompletions("e1", "staff-1")).toEqual({ written: 0, alreadyRecorded: 2, skipped: 0 });
    expect(entries).toHaveLength(0);
  });

  it("links to a COMPLETED record the member already has instead of writing a second", async () => {
    install([enrollment("en1", ["honor-a", "honor-b"])]);
    entries.push({ id: "hand-1", honorId: "honor-a", status: "COMPLETED" });
    const result = await writeBackHonorsWeekendCompletions("e1", "staff-1");
    expect(result).toEqual({ written: 1, alreadyRecorded: 1, skipped: 0 });
    expect(links.find((link) => link.honorId === "honor-a")).toMatchObject({ memberHonorEntryId: "hand-1" });
  });
});

describe("the honor multi-select on the class form", () => {
  const options = [
    { id: "a", name: "Knot Tying", code: "AR-011" },
    { id: "b", name: "Fire Building", code: "RE-001" },
    { id: "c", name: "Birds", code: "NA-005" },
  ];
  const render = (props: Partial<Parameters<typeof HonorMultiSelect>[0]> = {}) => renderToStaticMarkup(createElement(HonorMultiSelect, {
    options, value: ["b", "a"], onChange: () => undefined, ...props,
  }));

  it("lists the chosen honors in order with the first as primary, and a checkbox per catalog honor", () => {
    const html = render();
    expect(html.indexOf("Fire Building (RE-001)")).toBeLessThan(html.indexOf("Knot Tying (AR-011)"));
    expect(html).toContain("primary");
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain('placeholder="Type to search honors"');
  });

  it("offers no way to change the set when it is locked, and still names the honors", () => {
    const html = render({ locked: true, lockedNote: "Clubs have picked this class." });
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('type="search"');
    expect(html).toContain("Fire Building (RE-001)");
    expect(html).toContain("Clubs have picked this class.");
  });

  it("says when nothing is chosen yet", () => {
    expect(render({ value: [] })).toContain("No honor chosen yet.");
  });
});
