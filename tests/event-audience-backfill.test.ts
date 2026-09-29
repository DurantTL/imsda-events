import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { backfillEventAudience, hasClubRegistrationShape, resolveEventAudienceBackfillMode } from "@/modules/events/audience-backfill";
import { getFormTemplate } from "@/modules/forms/definition";

beforeEach(() => vi.clearAllMocks());

function fixture() {
  const events = [
    // Church-billed, still GENERAL: the classic candidate for the backfill.
    { id: "evt_camporee", name: "Spring Camporee", billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const, audience: "GENERAL" as const },
    // Attendee-paid, already GENERAL: nothing to do.
    { id: "evt_retreat", name: "Women's Retreat", billingMode: "ATTENDEE_PAY" as const, audience: "GENERAL" as const },
    // Already backfilled: idempotency should leave it untouched.
    { id: "evt_camporee_done", name: "Fall Camporee", billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const, audience: "CLUB" as const },
    // Attendee-paid CLUB event (e.g. Man Camp): audience is independent of
    // billing mode, so the backfill must never revert it to GENERAL.
    { id: "evt_man_camp", name: "Man Camp", billingMode: "ATTENDEE_PAY" as const, audience: "CLUB" as const },
  ];
  const event = {
    findMany: vi.fn(async ({ where }: { where: { billingMode: string; audience: { not: string } } }) =>
      events
        .filter((row) => row.billingMode === where.billingMode && row.audience !== where.audience.not)
        .map(({ id, name, billingMode, audience }) => ({ id, name, billingMode, audience })),
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string; audience: string }; data: { audience: "GENERAL" | "CLUB" } }) => {
      const target = events.find((row) => row.id === where.id);
      if (!target || target.audience !== where.audience) throw new Error("not found");
      target.audience = data.audience;
      return target;
    }),
  };
  const prisma = {
    event,
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  mocks.getPrisma.mockReturnValue(prisma);
  return { prisma, events, event };
}

describe("backfillEventAudience (#481)", () => {
  it("is a no-op report in dry-run mode", async () => {
    const { events } = fixture();
    const report = await backfillEventAudience(false);

    expect(report.dryRun).toBe(true);
    expect(report.totalCandidates).toBe(1);
    expect(report.updatedCount).toBe(0);
    expect(report.rows).toEqual([
      { id: "evt_camporee", name: "Spring Camporee", billingMode: "DEFERRED_ORGANIZATION_INVOICE", fromAudience: "GENERAL", toAudience: "CLUB" },
    ]);
    expect(events.find((row) => row.id === "evt_camporee")?.audience).toBe("GENERAL");
  });

  it("sets club-billed events to CLUB when applied, and leaves everything else alone", async () => {
    const { events } = fixture();
    const report = await backfillEventAudience(true);

    expect(report.dryRun).toBe(false);
    expect(report.updatedCount).toBe(1);
    expect(events.find((row) => row.id === "evt_camporee")?.audience).toBe("CLUB");
    // Attendee-paid GENERAL event: untouched.
    expect(events.find((row) => row.id === "evt_retreat")?.audience).toBe("GENERAL");
    // Already-CLUB church event: untouched.
    expect(events.find((row) => row.id === "evt_camporee_done")?.audience).toBe("CLUB");
    // Attendee-paid CLUB event: billing mode never pulls audience back to GENERAL.
    expect(events.find((row) => row.id === "evt_man_camp")?.audience).toBe("CLUB");
  });

  it("is idempotent: a repeated apply finds nothing left to backfill", async () => {
    const { event } = fixture();

    const first = await backfillEventAudience(true);
    expect(first.updatedCount).toBe(1);

    event.update.mockClear();
    const second = await backfillEventAudience(true);

    expect(second.totalCandidates).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(event.update).not.toHaveBeenCalled();
  });
});

describe("event audience backfill CLI mode (#481 review)", () => {
  it("only reports by default", () => {
    expect(resolveEventAudienceBackfillMode([])).toBe("report");
  });

  it("refuses --apply without --force, so it can't override a later human choice of GENERAL", () => {
    expect(resolveEventAudienceBackfillMode(["--apply"])).toBe("refuse");
  });

  it("writes only with --apply --force", () => {
    expect(resolveEventAudienceBackfillMode(["--apply", "--force"])).toBe("apply");
    expect(resolveEventAudienceBackfillMode(["--force"])).toBe("report");
  });
});

describe("GENERAL church-billed starter events (#606)", () => {
  function withForms(forms: Record<string, unknown[]>) {
    const events = Object.keys(forms).map((id) => ({ id, name: id, billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const, audience: "GENERAL" as const }));
    const update = vi.fn(async (args: { where: { id: string } }) => args);
    mocks.getPrisma.mockReturnValue({
      event: {
        findMany: vi.fn(async () => events.map((event) => ({ ...event, registrationForms: forms[event.id]!.map((definition) => ({ versions: [{ definition }] })) }))),
        update,
      },
      $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    });
    return update;
  }

  it("recognises the club shape only on a roster form with a club selector", () => {
    expect(hasClubRegistrationShape(getFormTemplate("spring_camporee_export")!.definition)).toBe(true);
    expect(hasClubRegistrationShape(getFormTemplate("honors_weekend")!.definition)).toBe(true);
    expect(hasClubRegistrationShape(getFormTemplate("leadership_weekend")!.definition)).toBe(false);
    expect(hasClubRegistrationShape(getFormTemplate("outdoor_school")!.definition)).toBe(false);
    expect(hasClubRegistrationShape(null)).toBe(false);
  });

  it("neither reports nor flips Leadership Weekend or Outdoor School, but still lists a club-shaped event and one with no forms", async () => {
    const update = withForms({
      leadership: [getFormTemplate("leadership_weekend")!.definition],
      school: [getFormTemplate("outdoor_school")!.definition],
      camporee: [getFormTemplate("spring_camporee_export")!.definition],
      unformed: [],
    });
    const report = await backfillEventAudience(true);
    expect(report.rows.map((row) => row.id)).toEqual(["camporee", "unformed"]);
    expect(update.mock.calls.map((call) => call[0].where.id)).toEqual(["camporee", "unformed"]);
    // The skipped events are reported, not silently dropped.
    expect(report.skipped.map((entry) => entry.id)).toEqual(["leadership", "school"]);
    expect(report.skipped[0]!.reason).toContain("deliberately GENERAL");
  });

  it("finds the club selector by its directory source, not its key, and reads the published version over a newer draft", async () => {
    const renamed = structuredClone(getFormTemplate("spring_camporee_export")!.definition);
    for (const section of renamed.sections) for (const field of section.fields) if (field.key === "club_name") field.key = "our_pathfinder_club";
    expect(hasClubRegistrationShape(renamed)).toBe(true);
    const noSelector = structuredClone(getFormTemplate("spring_camporee_export")!.definition);
    for (const section of noSelector.sections) for (const field of section.fields) if (field.optionSource === "CLUBS_DIRECTORY") delete field.optionSource;
    expect(hasClubRegistrationShape(noSelector)).toBe(false);
    const events = [{ id: "mixed", name: "mixed", billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const, audience: "GENERAL" as const }];
    mocks.getPrisma.mockReturnValue({
      event: {
        findMany: vi.fn(async () => events.map((event) => ({ ...event, registrationForms: [{ versions: [
          { status: "DRAFT", definition: getFormTemplate("leadership_weekend")!.definition },
          { status: "PUBLISHED", definition: getFormTemplate("spring_camporee_export")!.definition },
        ] }] }))),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    });
    const report = await backfillEventAudience(false);
    expect(report.rows.map((row) => row.id)).toEqual(["mixed"]);
    expect(report.skipped).toEqual([]);
  });
});
