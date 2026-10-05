import { beforeEach, describe, expect, it, vi } from "vitest";

/** Synthetic data only: every name, date and phone number here is made up. */

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  submissionFindFirst: vi.fn(),
  submissionUpdateMany: vi.fn(),
  memberFindFirst: vi.fn(),
  getSubmissionForViewer: vi.fn(),
  listRosterDuplicates: vi.fn(),
  addRosterMemberInTransaction: vi.fn(),
  refreshBackgroundCheckMatchesSafely: vi.fn(),
}));

const client = {
  clubFormSubmission: { findFirst: mocks.submissionFindFirst, updateMany: mocks.submissionUpdateMany },
  clubRosterMember: { findFirst: mocks.memberFindFirst },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/background-checks/refresh-after-write", () => ({ refreshBackgroundCheckMatchesSafely: mocks.refreshBackgroundCheckMatchesSafely }));
vi.mock("@/modules/club-forms/submissions", () => ({ getSubmissionForViewer: mocks.getSubmissionForViewer }));
vi.mock("@/modules/club-rosters/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/club-rosters/repository")>()),
  listRosterDuplicates: mocks.listRosterDuplicates,
  addRosterMemberInTransaction: mocks.addRosterMemberInTransaction,
}));

import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import type { ClubFormsViewer } from "@/modules/club-forms/domain";
import { confirmAddToRoster, getRosterAddReview, reviewClubYear } from "@/modules/club-forms/roster-add";
import { RosterOperationError } from "@/modules/club-rosters/repository";
import type { RosterMemberInput } from "@/modules/club-rosters/schemas";

const now = new Date("2026-10-05T15:00:00Z");
const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
const actingDirector: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1" } };
const otherClubDirector: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-b", actor: { kind: "ATTENDEE", accountId: "acct-9" } };
const areaCoordinator: ClubFormsViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "acct-2" } };
const staff: ClubFormsViewer = { kind: "STAFF", userId: "staff-1", systemAdmin: true };

const membership = clubFormTemplateSeeds.find((seed) => seed.key === "pathfinder_membership_application")!;

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl-membership",
    key: membership.key,
    name: membership.name,
    description: membership.description,
    version: membership.version,
    definition: membership.definition,
    sectionNotes: membership.sectionNotes,
    sensitiveFieldKeys: membership.sensitiveFieldKeys,
    birthDateFieldKeys: membership.birthDateFieldKeys,
    staffOnlyFieldKeys: membership.staffOnlyFieldKeys,
    hiddenFieldKeys: [],
    printLayout: "STANDARD",
    // Turned on in the builder (the seeded mapping ships off).
    rosterMapping: { ...membership.rosterMapping!, enabled: true },
    enabled: true,
    customizedAt: null,
    ...overrides,
  };
}

function submissionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    organizationId: "club-a",
    clubYear: "2026-27",
    status: "SUBMITTED",
    rosterAction: null,
    rosterActionMemberId: null,
    template: templateRow(),
    ...overrides,
  };
}

const answers = {
  full_name: "Jordan Sample",
  birth_date: "2013-04-09",
  ay_class: "Explorer",
  phone: "(555) 010-0100",
  father_guardian_signature: "Pat Sample",
  street: "1 Example Lane",
};

const memberInput: RosterMemberInput = {
  firstName: "Jordan",
  lastName: "Sample",
  birthDate: "2013-04-09",
  attendeeType: "YOUTH",
  role: "Pathfinder",
  classLevel: "EXPLORER",
  gender: "FEMALE",
  guardians: [{ name: "Pat Sample", relationship: "Father or guardian", email: "", phone: "(555) 010-0100" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
  mocks.submissionFindFirst.mockResolvedValue(submissionRow());
  mocks.submissionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.memberFindFirst.mockResolvedValue({ id: "member-9", clubYear: "2026-27" });
  mocks.getSubmissionForViewer.mockResolvedValue({ answers });
  mocks.listRosterDuplicates.mockResolvedValue([]);
  mocks.addRosterMemberInTransaction.mockResolvedValue({ memberId: "member-new", personId: "person-new" });
  mocks.refreshBackgroundCheckMatchesSafely.mockResolvedValue(undefined);
});

const review = (viewer: ClubFormsViewer = director, extra: { clubYear?: string } = {}) =>
  getRosterAddReview(viewer, { organizationId: "club-a", submissionId: "sub-1", ...extra }, now);
const add = (overrides: Partial<Extract<Parameters<typeof confirmAddToRoster>[1], { action: "ADD" }>> = {}, viewer: ClubFormsViewer = director) =>
  confirmAddToRoster(viewer, { action: "ADD", organizationId: "club-a", submissionId: "sub-1", clubYear: "2026-27", member: memberInput, ...overrides }, now);
const link = (memberId = "member-9", viewer: ClubFormsViewer = director) =>
  confirmAddToRoster(viewer, { action: "LINK", organizationId: "club-a", submissionId: "sub-1", memberId }, now);

describe("who may add a form to the roster (#721)", () => {
  it.each([["a director", director], ["a deputy or staff acting as the director", actingDirector]])("allows %s of the club", async (_name, viewer) => {
    await expect(review(viewer)).resolves.toMatchObject({ clubYear: "2026-27" });
    await expect(add({}, viewer)).resolves.toMatchObject({ action: "ADDED" });
  });

  it.each([
    ["another club's director", otherClubDirector],
    ["an Area Coordinator", areaCoordinator],
    ["conference staff", staff],
  ])("refuses %s before reading anything", async (_name, viewer) => {
    await expect(review(viewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(add({}, viewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(link("member-9", viewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.submissionFindFirst).not.toHaveBeenCalled();
    expect(mocks.getSubmissionForViewer).not.toHaveBeenCalled();
    expect(mocks.addRosterMemberInTransaction).not.toHaveBeenCalled();
    expect(mocks.submissionUpdateMany).not.toHaveBeenCalled();
  });

  it("scopes the form to the club in the URL (another club's form is not found)", async () => {
    mocks.submissionFindFirst.mockResolvedValue(null);
    await expect(review()).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
    expect(mocks.submissionFindFirst.mock.calls[0][0].where).toMatchObject({ id: "sub-1", organizationId: "club-a" });
  });
});

describe("only a template with the setting on offers it (#721)", () => {
  it.each([
    ["the seeded mapping, which ships off", { rosterMapping: null }],
    ["a mapping an administrator turned off", { rosterMapping: { ...membership.rosterMapping!, enabled: false } }],
    ["a mapping that points at a health field", { rosterMapping: { ...membership.rosterMapping!, enabled: true, fields: { ...membership.rosterMapping!.fields, role: "health_limitation" } } }],
    ["a mapping that sends the birth date to a plain field", { rosterMapping: { ...membership.rosterMapping!, enabled: true, fields: { ...membership.rosterMapping!.fields, role: "birth_date" } } }],
  ])("is unavailable for %s", async (_name, template) => {
    mocks.submissionFindFirst.mockResolvedValue(submissionRow({ template: templateRow(template) }));
    await expect(review()).rejects.toMatchObject({ code: "ROSTER_ADD_UNAVAILABLE" });
    await expect(add()).rejects.toMatchObject({ code: "ROSTER_ADD_UNAVAILABLE" });
    await expect(link()).rejects.toMatchObject({ code: "ROSTER_ADD_UNAVAILABLE" });
    expect(mocks.addRosterMemberInTransaction).not.toHaveBeenCalled();
    expect(mocks.submissionUpdateMany).not.toHaveBeenCalled();
  });

  it("is unavailable for a draft", async () => {
    mocks.submissionFindFirst.mockResolvedValue(submissionRow({ status: "DRAFT" }));
    await expect(review()).rejects.toMatchObject({ code: "ROSTER_ADD_UNAVAILABLE" });
  });
});

describe("the review step writes nothing (#721)", () => {
  it("pre-fills from the mapped answers and offers the club years", async () => {
    const result = await review();
    expect(result).toMatchObject({
      submissionId: "sub-1",
      clubYear: "2026-27",
      currentClubYear: "2026-27",
      clubYearChoices: ["2025-26", "2026-27", "2027-28"],
      duplicates: [],
      prefill: { firstName: "Jordan", lastName: "Sample", birthDate: "2013-04-09", attendeeType: "YOUTH", classLevel: "EXPLORER" },
    });
    expect(result.prefill.guardians[0]).toMatchObject({ name: "Pat Sample", relationship: "Father or guardian", phone: "(555) 010-0100" });
    // The audited, permission-checked read, for this club only.
    expect(mocks.getSubmissionForViewer).toHaveBeenCalledWith(director, "sub-1", "ROSTER_ADD", "club-a");
    // No roster member, no record on the submission, no audit row of its own.
    expect(mocks.addRosterMemberInTransaction).not.toHaveBeenCalled();
    expect(mocks.submissionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
    expect(mocks.refreshBackgroundCheckMatchesSafely).not.toHaveBeenCalled();
  });

  it("offers Link to existing member for a duplicate, in the chosen year", async () => {
    mocks.listRosterDuplicates.mockResolvedValue([{ id: "member-9", firstName: "Jordan", lastName: "Sample", attendeeType: "YOUTH", status: "ACTIVE" }]);
    const result = await review();
    expect(result.duplicates).toEqual([expect.objectContaining({ id: "member-9" })]);
    // Compared on the pre-filled name and birth date, in this club and year.
    expect(mocks.listRosterDuplicates).toHaveBeenCalledWith("club-a", "2026-27", "Jordan", "Sample", "2013-04-09");
    await review(director, { clubYear: "2025-26" });
    expect(mocks.listRosterDuplicates).toHaveBeenLastCalledWith("club-a", "2025-26", "Jordan", "Sample", "2013-04-09");
  });

  it("leaves guardians off a non-current year, where they are not kept", async () => {
    const result = await review(director, { clubYear: "2027-28" });
    expect(result.clubYear).toBe("2027-28");
    expect(result.prefill.guardians.every((guardian) => !guardian.name && !guardian.phone)).toBe(true);
  });

  it("falls back to a year it allows", () => {
    expect(reviewClubYear("1999-00", "2026-27", now).clubYear).toBe("2026-27");
    expect(reviewClubYear(undefined, "2019-20", now).clubYear).toBe("2026-27");
    expect(reviewClubYear("2025-26", "2026-27", now).clubYear).toBe("2025-26");
  });

  it("never carries a sensitive or health answer into the pre-fill, whatever the answers hold", async () => {
    mocks.getSubmissionForViewer.mockResolvedValue({ answers: { ...answers, health_limitation: "Yes", health_limitation_how: "Synthetic health detail", conduct_type: "Synthetic conduct" } });
    expect(JSON.stringify(await review())).not.toMatch(/Synthetic health detail|Synthetic conduct/);
  });
});

describe("confirming adds the person and records it (#721)", () => {
  it("adds the reviewed member, records the submission, and audits without answer text", async () => {
    const result = await add();
    expect(result).toEqual({ action: "ADDED", rosterMemberId: "member-new", clubYear: "2026-27" });
    const call = mocks.addRosterMemberInTransaction.mock.calls[0];
    expect(call[1]).toBe("club-a");
    expect(call[2]).toBe("2026-27");
    expect(call[3]).toMatchObject({ firstName: "Jordan", birthDate: "2013-04-09", attendeeType: "YOUTH" });
    // Attributed to the director's own account, never to the form.
    expect(call[4]).toEqual({ accountId: "acct-1" });
    expect(call[5]).toMatchObject({ source: "DIRECTOR", now });
    // The submission records the member; its answers are not part of the write.
    expect(mocks.submissionUpdateMany).toHaveBeenCalledWith({
      where: { id: "sub-1", organizationId: "club-a", status: "SUBMITTED", rosterActionMemberId: null },
      data: { rosterAction: "ADDED", rosterActionMemberId: "member-new", rosterActionAt: now },
    });
    expect(Object.keys(mocks.submissionUpdateMany.mock.calls[0][0].data)).not.toContain("answers");
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    const audit = mocks.writeAuditLog.mock.calls[0][0];
    expect(audit).toMatchObject({
      action: "CLUB_FORM_SUBMISSION_ADDED_TO_ROSTER",
      entityType: "ClubFormSubmission",
      entityId: "sub-1",
      metadata: { organizationId: "club-a", templateKey: membership.key, rosterMemberId: "member-new", clubYear: "2026-27", attendeeType: "YOUTH" },
    });
    // No name, birth date, guardian or other answer text in the audit row.
    expect(JSON.stringify(audit)).not.toMatch(/Jordan|Sample|2013|555|Example Lane/);
    expect(mocks.refreshBackgroundCheckMatchesSafely).toHaveBeenCalledWith(["person-new"]);
  });

  it("attributes staff acting as the director to the staff user", async () => {
    await add({}, actingDirector);
    expect(mocks.addRosterMemberInTransaction.mock.calls[0][4]).toEqual({ userId: "admin-1", actAsId: "act-1" });
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "admin-1", metadata: { actAsId: "act-1" } });
  });

  it("applies the roster's own validation (a bad birth date is refused and nothing is recorded)", async () => {
    mocks.addRosterMemberInTransaction.mockRejectedValue(new RosterOperationError("BIRTH_DATE_INVALID", "A birth date can't be in the future."));
    await expect(add()).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: "A birth date can't be in the future." });
    expect(mocks.submissionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("keeps guardians off a non-current year, and refuses a year outside the allowed three", async () => {
    await add({ clubYear: "2027-28" });
    expect(mocks.addRosterMemberInTransaction.mock.calls[0][3].guardians).toBeUndefined();
    await expect(add({ clubYear: "2031-32" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mocks.addRosterMemberInTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a duplicate and offers the existing member instead, recording nothing", async () => {
    mocks.addRosterMemberInTransaction.mockRejectedValue(new RosterOperationError("DUPLICATE_MEMBER", "Someone with this name and birth date is already on the roster."));
    mocks.listRosterDuplicates.mockResolvedValue([{ id: "member-9", firstName: "Jordan", lastName: "Sample", attendeeType: "YOUTH", status: "ACTIVE" }]);
    await expect(add()).rejects.toMatchObject({
      code: "DUPLICATE_ON_ROSTER",
      issues: [{ key: "duplicate:member-9", message: "Jordan Sample" }],
    });
    expect(mocks.submissionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
    expect(mocks.refreshBackgroundCheckMatchesSafely).not.toHaveBeenCalled();
  });

  it("rolls the new member back when the form was already added (a racing confirm)", async () => {
    mocks.submissionUpdateMany.mockResolvedValue({ count: 0 });
    await expect(add()).rejects.toMatchObject({ code: "ALREADY_ON_ROSTER" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
    expect(mocks.refreshBackgroundCheckMatchesSafely).not.toHaveBeenCalled();
  });

  it("refuses a form that is already on the roster", async () => {
    mocks.submissionFindFirst.mockResolvedValue(submissionRow({ rosterAction: "ADDED", rosterActionMemberId: "member-7" }));
    await expect(review()).rejects.toMatchObject({ code: "ALREADY_ON_ROSTER" });
    await expect(add()).rejects.toMatchObject({ code: "ALREADY_ON_ROSTER" });
    expect(mocks.addRosterMemberInTransaction).not.toHaveBeenCalled();
  });
});

describe("linking to an existing member (#721)", () => {
  it("records the member and audits, changing nothing on the member (no merge)", async () => {
    const result = await link("member-9");
    expect(result).toEqual({ action: "LINKED", rosterMemberId: "member-9", clubYear: "2026-27" });
    expect(mocks.addRosterMemberInTransaction).not.toHaveBeenCalled();
    expect(mocks.refreshBackgroundCheckMatchesSafely).not.toHaveBeenCalled();
    expect(mocks.submissionUpdateMany).toHaveBeenCalledWith({
      where: { id: "sub-1", organizationId: "club-a", status: "SUBMITTED", rosterActionMemberId: null },
      data: { rosterAction: "LINKED", rosterActionMemberId: "member-9", rosterActionAt: now },
    });
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({
      action: "CLUB_FORM_SUBMISSION_LINKED_TO_ROSTER",
      entityId: "sub-1",
      metadata: { organizationId: "club-a", templateKey: membership.key, rosterMemberId: "member-9" },
    });
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls[0][0])).not.toMatch(/Jordan|Sample|2013|555/);
  });

  it("only links a member of this club who is still on the roster", async () => {
    mocks.memberFindFirst.mockResolvedValue(null);
    await expect(link("member-elsewhere")).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    expect(mocks.memberFindFirst.mock.calls[0][0].where).toEqual({ id: "member-elsewhere", organizationId: "club-a", status: { not: "REMOVED" } });
    expect(mocks.submissionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a second link or add once the form is recorded", async () => {
    mocks.submissionUpdateMany.mockResolvedValue({ count: 0 });
    await expect(link()).rejects.toMatchObject({ code: "ALREADY_ON_ROSTER" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
