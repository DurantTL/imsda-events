import { beforeEach, describe, expect, it, vi } from "vitest";

/** Synthetic data only. Opens a submitted Membership Application as different viewers and checks what "Add to roster" shows. */

const mocks = vi.hoisted(() => ({ writeAuditLog: vi.fn(), submissionFindFirst: vi.fn() }));

const client = {
  clubFormTemplateVersion: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  clubFormSubmission: { findFirst: mocks.submissionFindFirst },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-club-form-tests" }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import type { ClubFormsViewer } from "@/modules/club-forms/domain";
import { sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import { getSubmissionForViewer } from "@/modules/club-forms/submissions";

const membership = clubFormTemplateSeeds.find((seed) => seed.key === "pathfinder_membership_application")!;
const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
const areaCoordinator: ClubFormsViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "acct-2" } };
const staff: ClubFormsViewer = { kind: "STAFF", userId: "staff-1", systemAdmin: true };

function row(overrides: Record<string, unknown> = {}, mapping: unknown = { ...membership.rosterMapping!, enabled: true }) {
  return {
    id: "sub-1",
    organizationId: "club-a",
    clubYear: "2026-27",
    rosterMemberId: null,
    subjectName: "Jordan Sample",
    status: "SUBMITTED",
    submittedAt: new Date("2026-10-04T15:00:00Z"),
    enteredVia: "LINK",
    answers: { full_name: "Jordan Sample" },
    sealedSensitiveAnswers: sealSensitiveAnswers("sub-1", { birth_date: "2013-04-09" }),
    hasSensitiveAnswers: true,
    templateVersion: membership.version,
    rosterAction: null,
    rosterActionMemberId: null,
    rosterActionMember: null,
    organization: { name: "Example Pathfinders" },
    template: {
      id: "tpl-1", key: membership.key, name: membership.name, description: membership.description, version: membership.version,
      definition: membership.definition, sectionNotes: membership.sectionNotes, sensitiveFieldKeys: membership.sensitiveFieldKeys,
      birthDateFieldKeys: membership.birthDateFieldKeys, staffOnlyFieldKeys: membership.staffOnlyFieldKeys, hiddenFieldKeys: [],
      printLayout: "STANDARD", rosterMapping: mapping, enabled: true, customizedAt: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
});

describe("the Add to roster action on a submitted form (#721)", () => {
  it("is available to the club's director when the template's setting is on", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row());
    expect((await getSubmissionForViewer(director, "sub-1")).rosterAdd).toEqual({ available: true, done: null });
  });

  it("is not offered while the template's setting is off (the seeded mapping ships off)", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row({}, null));
    expect((await getSubmissionForViewer(director, "sub-1")).rosterAdd).toEqual({ available: false, done: null });
    mocks.submissionFindFirst.mockResolvedValue(row({}, { ...membership.rosterMapping!, enabled: false }));
    expect((await getSubmissionForViewer(director, "sub-1")).rosterAdd).toEqual({ available: false, done: null });
  });

  it("is not offered for a mapping the protection rules refuse", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row({}, { ...membership.rosterMapping!, enabled: true, fields: { ...membership.rosterMapping!.fields, role: "birth_date" } }));
    expect((await getSubmissionForViewer(director, "sub-1")).rosterAdd?.available).toBe(false);
  });

  it("is not offered on a draft", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row({ status: "DRAFT" }));
    expect((await getSubmissionForViewer(director, "sub-1")).rosterAdd?.available).toBe(false);
  });

  it("reads 'Added to roster' with the member once the form is recorded, and is no longer offered", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row({ rosterAction: "ADDED", rosterActionMemberId: "member-1", rosterActionMember: { clubYear: "2026-27", status: "ACTIVE" } }));
    expect((await getSubmissionForViewer(director, "sub-1")).rosterAdd).toEqual({
      available: false,
      done: { action: "ADDED", memberId: "member-1", clubYear: "2026-27" },
    });
    mocks.submissionFindFirst.mockResolvedValue(row({ rosterAction: "LINKED", rosterActionMemberId: "member-2", rosterActionMember: { clubYear: "2025-26", status: "INACTIVE" } }));
    expect((await getSubmissionForViewer(director, "sub-1")).rosterAdd?.done).toEqual({ action: "LINKED", memberId: "member-2", clubYear: "2025-26" });
  });

  it("reads as not added, and is offered again, when the member was removed from the roster", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row({ rosterAction: "ADDED", rosterActionMemberId: "member-1", rosterActionMember: { clubYear: "2026-27", status: "REMOVED" } }));
    expect((await getSubmissionForViewer(director, "sub-1")).rosterAdd).toEqual({ available: true, done: null });
  });

  it("is offered to nobody but the club's director or deputy", async () => {
    for (const viewer of [areaCoordinator, staff]) {
      mocks.submissionFindFirst.mockResolvedValue(row());
      expect((await getSubmissionForViewer(viewer, "sub-1")).rosterAdd).toBeNull();
    }
  });

  it("leaves the submission's answers exactly as they were", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row({ rosterAction: "ADDED", rosterActionMemberId: "member-1", rosterActionMember: { clubYear: "2026-27", status: "ACTIVE" } }));
    const view = await getSubmissionForViewer(director, "sub-1");
    expect(view.answers).toEqual({ full_name: "Jordan Sample", birth_date: "2013-04-09" });
  });
});
