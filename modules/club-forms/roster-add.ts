import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { refreshBackgroundCheckMatchesSafely } from "@/modules/background-checks/refresh-after-write";
import {
  parseClubFormTemplate,
  viewerAuditFields,
  viewerCanWriteForClub,
  type ClubFormsViewer,
} from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { rosterPrefillFromAnswers, usableRosterMapping, type RosterPrefill } from "@/modules/club-forms/roster-mapping";
import { getSubmissionForViewer } from "@/modules/club-forms/submissions";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { addRosterMemberInTransaction, listRosterDuplicates, RosterOperationError } from "@/modules/club-rosters/repository";
import type { RosterMemberInput } from "@/modules/club-rosters/schemas";

/**
 * "Add to roster" from a submitted club form (#721). Only a club's director or
 * deputy (or a system administrator acting as that director) may use it, for
 * their own club: a registrar, an Area Coordinator and conference staff never
 * can. It is two steps, and nothing is written by the first:
 *
 * Only the current club year can be added to (#541: only the current year is
 * editable), and a member who was removed from the roster counts as not added,
 * so the form can be added again.
 *
 * 1. `getRosterAddReview` opens the form (audited like any other open of a form
 *    with sensitive answers) and pre-fills a roster member from the answers the
 *    template's mapping names. The birth date comes only from a birth-date
 *    field and stays sealed in the roster; sensitive and health answers are
 *    never read here (see `roster-mapping.ts`).
 * 2. `confirmAddToRoster` adds the person the director checked, or links the
 *    form to an existing member. People are never merged: linking only records
 *    which member the form belongs to and changes nothing on the member.
 *
 * Either way the submission records the member (never its answers), and the
 * audit row names ids and the template only, never an answer or a name. The
 * encrypted Health Record (#611) is never touched.
 */

type Leader = Extract<ClubFormsViewer, { kind: "CLUB_LEADER" }>;

function requireLeader(viewer: ClubFormsViewer, organizationId: string): Leader {
  if (!viewerCanWriteForClub(viewer, organizationId) || viewer.kind !== "CLUB_LEADER") {
    // The same answer for another club and for a role without access.
    throw new ClubFormError("FORBIDDEN", "Adding to the roster is for the club's director and deputy.");
  }
  return viewer;
}

/** Who did it, in the shape the roster repository records. */
function rosterActor(viewer: Leader) {
  return viewer.actor.kind === "ATTENDEE"
    ? { accountId: viewer.actor.accountId }
    : { userId: viewer.actor.userId, actAsId: viewer.actor.actAsId };
}

const templateSelect = {
  id: true, key: true, name: true, description: true, version: true, definition: true, sectionNotes: true,
  sensitiveFieldKeys: true, birthDateFieldKeys: true, staffOnlyFieldKeys: true, hiddenFieldKeys: true,
  printLayout: true, rosterMapping: true, enabled: true, customizedAt: true,
} as const;

/** A removed member is erased from the roster: a form that pointed at one is as good as not added. */
const stillOnRoster = (member: { status: string } | null | undefined) => Boolean(member) && member!.status !== "REMOVED";

/** The submission, once it is checked to be this club's, submitted, not yet on the roster, and from a template that allows it. */
async function loadAddable(organizationId: string, submissionId: string) {
  const row = await getPrisma().clubFormSubmission.findFirst({
    where: { id: submissionId, organizationId },
    select: {
      id: true,
      organizationId: true,
      clubYear: true,
      status: true,
      rosterAction: true,
      rosterActionMemberId: true,
      rosterActionMember: { select: { status: true } },
      // A form the director filed against an existing member when filling it in.
      rosterMemberId: true,
      rosterMember: { select: { id: true, status: true, person: { select: { firstName: true, lastName: true } } } },
      template: { select: templateSelect },
    },
  });
  if (!row) throw new ClubFormError("SUBMISSION_NOT_FOUND", "That form could not be found.");
  if (row.status !== "SUBMITTED") {
    throw new ClubFormError("ROSTER_ADD_UNAVAILABLE", "Only a submitted form can be added to the roster.");
  }
  if (row.rosterActionMemberId && stillOnRoster(row.rosterActionMember)) {
    throw new ClubFormError("ALREADY_ON_ROSTER", "This form has already been added to the roster.");
  }
  const template = parseClubFormTemplate(row.template);
  const mapping = usableRosterMapping(template.rosterMapping, template);
  if (!mapping) {
    throw new ClubFormError("ROSTER_ADD_UNAVAILABLE", "This form isn't set up to add people to the roster.");
  }
  const filedMember = row.rosterMemberId && row.rosterMember && stillOnRoster(row.rosterMember)
    ? { id: row.rosterMember.id, firstName: row.rosterMember.person?.firstName ?? "", lastName: row.rosterMember.person?.lastName ?? "" }
    : null;
  return { row, template, mapping, filedMember };
}

type MemberChoice = { id: string; firstName: string; lastName: string; attendeeType: string; status: string };

export type RosterAddReview = {
  submissionId: string;
  organizationId: string;
  formName: string;
  prefill: RosterPrefill;
  /** Always the current club year: only it is editable (#541). */
  clubYear: string;
  /**
   * Roster members offered as "Link to existing member": those of the current year with the same name and birth
   * date, or, for a form already filed against a member, only that member.
   */
  duplicates: MemberChoice[];
  /** False when the form is already filed against a roster member: it can only be linked to them, never add a new person. */
  canAdd: boolean;
};

/**
 * Step one: the review screen's data. Writes nothing to the roster. Opening
 * the form is audited as for any form with sensitive answers.
 */
export async function getRosterAddReview(
  viewer: ClubFormsViewer,
  input: { organizationId: string; submissionId: string },
  now = new Date(),
): Promise<RosterAddReview> {
  requireLeader(viewer, input.organizationId);
  const { row, template, mapping, filedMember } = await loadAddable(input.organizationId, input.submissionId);
  const clubYear = clubYearFor(now);
  const base = { submissionId: row.id, organizationId: row.organizationId, formName: template.name, clubYear };
  if (filedMember) {
    // Already filed against a member: only a link to them is offered, so nothing is read from the answers.
    const empty = { name: "", relationship: "", email: "", phone: "" };
    return {
      ...base,
      prefill: { firstName: "", lastName: "", birthDate: "", attendeeType: mapping.rosterType, role: "", classLevel: null, gender: null, guardians: [empty, empty] },
      duplicates: [{ ...filedMember, attendeeType: "", status: "" }],
      canAdd: false,
    };
  }
  // The audited, permission-checked read of the answers: a director's own club only.
  const submission = await getSubmissionForViewer(viewer, input.submissionId, "ROSTER_ADD", input.organizationId);
  const prefill = rosterPrefillFromAnswers(mapping, submission.answers, template);
  const duplicates = await listRosterDuplicates(input.organizationId, clubYear, prefill.firstName, prefill.lastName, prefill.birthDate);
  return { ...base, prefill, duplicates, canAdd: true };
}

export type RosterAddInput =
  | { action: "ADD"; organizationId: string; submissionId: string; member: RosterMemberInput }
  | { action: "LINK"; organizationId: string; submissionId: string; memberId: string };

export type RosterAddResult = { action: "ADDED" | "LINKED"; rosterMemberId: string; clubYear: string };

/**
 * Step two: the director has checked the details and confirmed. Adds the
 * person (or links an existing member) and records it on the submission in one
 * transaction, so a failure to record leaves no stray roster member. The
 * submission's answers are never changed. The submission also files itself
 * against the member (`rosterMemberId`), so the form shows in the member's own
 * list of forms, where staff can open it (the address stays on the form).
 */
export async function confirmAddToRoster(viewer: ClubFormsViewer, input: RosterAddInput, now = new Date()): Promise<RosterAddResult> {
  const leader = requireLeader(viewer, input.organizationId);
  const { row, template, filedMember } = await loadAddable(input.organizationId, input.submissionId);
  const who = viewerAuditFields(leader);
  const actor = rosterActor(leader);
  const prisma = getPrisma();
  const clubYear = clubYearFor(now);
  if (filedMember && (input.action === "ADD" || input.memberId !== filedMember.id)) {
    // Never a new person for a form that already belongs to a member.
    throw new ClubFormError("ROSTER_ADD_UNAVAILABLE", "This form is already filed against a roster member. Link it to them instead of adding a new person.");
  }
  // The submission is claimed last, guarded on "not yet on the roster" (or its member since removed): of two confirms that race, the loser's whole transaction rolls back.
  const claim = (tx: Prisma.TransactionClient, action: "ADDED" | "LINKED", memberId: string) =>
    tx.clubFormSubmission.updateMany({
      where: {
        id: row.id,
        organizationId: row.organizationId,
        status: "SUBMITTED",
        OR: [{ rosterActionMemberId: null }, { rosterActionMember: { status: "REMOVED" } }],
      },
      data: { rosterAction: action, rosterActionMemberId: memberId, rosterActionAt: now, rosterMemberId: memberId },
    });

  try {
    if (input.action === "LINK") {
      return await prisma.$transaction(async (tx) => {
        // Only a member of this club who is still on its roster: another club's member is "not found".
        const member = await tx.clubRosterMember.findFirst({
          where: { id: input.memberId, organizationId: input.organizationId, status: { not: "REMOVED" } },
          select: { id: true, clubYear: true },
        });
        if (!member) throw new ClubFormError("MEMBER_NOT_FOUND", "That person isn't on your club's roster.");
        if ((await claim(tx, "LINKED", member.id)).count === 0) {
          throw new ClubFormError("ALREADY_ON_ROSTER", "This form has already been added to the roster.");
        }
        await writeAuditLog({
          actorUserId: who.actorUserId,
          action: "CLUB_FORM_SUBMISSION_LINKED_TO_ROSTER",
          entityType: "ClubFormSubmission",
          entityId: row.id,
          summary: "Linked a club form to an existing roster member.",
          metadata: { ...who.metadata, organizationId: row.organizationId, templateKey: template.key, rosterMemberId: member.id, clubYear: member.clubYear },
        }, tx);
        return { action: "LINKED" as const, rosterMemberId: member.id, clubYear: member.clubYear };
      });
    }

    const member = input.member;
    const result = await prisma.$transaction(async (tx) => {
      const added = await addRosterMemberInTransaction(tx, input.organizationId, clubYear, member, actor, { source: "DIRECTOR", now });
      if ((await claim(tx, "ADDED", added.memberId)).count === 0) {
        throw new ClubFormError("ALREADY_ON_ROSTER", "This form has already been added to the roster.");
      }
      await writeAuditLog({
        actorUserId: who.actorUserId,
        action: "CLUB_FORM_SUBMISSION_ADDED_TO_ROSTER",
        entityType: "ClubFormSubmission",
        entityId: row.id,
        summary: "Added a person to the club roster from a club form.",
        // Ids and the template only: no name, birth date or answer.
        metadata: {
          ...who.metadata,
          organizationId: row.organizationId,
          templateKey: template.key,
          rosterMemberId: added.memberId,
          clubYear,
          attendeeType: member.attendeeType,
        },
      }, tx);
      return added;
    });
    // Same as a person added on the roster screen (#527): matched against the background check list right away.
    await refreshBackgroundCheckMatchesSafely([result.personId]);
    return { action: "ADDED", rosterMemberId: result.memberId, clubYear };
  } catch (error) {
    if (error instanceof RosterOperationError) {
      if (error.code === "DUPLICATE_MEMBER" && input.action === "ADD") {
        const duplicates = await listRosterDuplicates(input.organizationId, clubYear, input.member.firstName, input.member.lastName, input.member.birthDate);
        throw new ClubFormError(
          "DUPLICATE_ON_ROSTER",
          "Someone with this name and birth date is already on the roster. Link this form to them instead of adding a duplicate.",
          // Member ids and display names, so the review screen can offer "Link to existing member".
          duplicates.map((member) => ({ key: `duplicate:${member.id}`, message: `${member.firstName} ${member.lastName}`.trim() })),
        );
      }
      throw new ClubFormError("VALIDATION_FAILED", error.message);
    }
    throw error;
  }
}
