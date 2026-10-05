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
import { clubYearChoices, clubYearFor } from "@/modules/club-rosters/domain";
import { addRosterMemberInTransaction, listRosterDuplicates, RosterOperationError } from "@/modules/club-rosters/repository";
import type { RosterMemberInput } from "@/modules/club-rosters/schemas";

/**
 * "Add to roster" from a submitted club form (#721). Only a club's director or
 * deputy (or a system administrator acting as that director) may use it, for
 * their own club: a registrar, an Area Coordinator and conference staff never
 * can. It is two steps, and nothing is written by the first:
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
      template: { select: templateSelect },
    },
  });
  if (!row) throw new ClubFormError("SUBMISSION_NOT_FOUND", "That form could not be found.");
  if (row.status !== "SUBMITTED") {
    throw new ClubFormError("ROSTER_ADD_UNAVAILABLE", "Only a submitted form can be added to the roster.");
  }
  if (row.rosterActionMemberId) {
    throw new ClubFormError("ALREADY_ON_ROSTER", "This form has already been added to the roster.");
  }
  const template = parseClubFormTemplate(row.template);
  const mapping = usableRosterMapping(template.rosterMapping, template);
  if (!mapping) {
    throw new ClubFormError("ROSTER_ADD_UNAVAILABLE", "This form isn't set up to add people to the roster.");
  }
  return { row, template, mapping };
}

export type RosterAddReview = {
  submissionId: string;
  organizationId: string;
  formName: string;
  prefill: RosterPrefill;
  /** The club year this review is for, and the years a director may choose. */
  clubYear: string;
  currentClubYear: string;
  clubYearChoices: string[];
  /** Roster members of that year with the same name and birth date: offered as "Link to existing member". */
  duplicates: Array<{ id: string; firstName: string; lastName: string; attendeeType: string; status: string }>;
};

/** Which year the review is for: the one asked for, if it is previous, current or next; else the form's own, else the current. */
export function reviewClubYear(requested: string | undefined, formClubYear: string, now: Date) {
  const choices = clubYearChoices(now);
  const current = clubYearFor(now);
  const clubYear = choices.find((year) => year === requested) ?? (choices.includes(formClubYear) ? formClubYear : current);
  return { clubYear, current, choices };
}

/**
 * Step one: the review screen's data. Writes nothing to the roster. Opening
 * the form is audited as for any form with sensitive answers.
 */
export async function getRosterAddReview(
  viewer: ClubFormsViewer,
  input: { organizationId: string; submissionId: string; clubYear?: string },
  now = new Date(),
): Promise<RosterAddReview> {
  requireLeader(viewer, input.organizationId);
  const { row, template, mapping } = await loadAddable(input.organizationId, input.submissionId);
  // The audited, permission-checked read of the answers: a director's own club only.
  const submission = await getSubmissionForViewer(viewer, input.submissionId, "ROSTER_ADD", input.organizationId);
  const prefill = rosterPrefillFromAnswers(mapping, submission.answers, template);
  const { clubYear, current, choices } = reviewClubYear(input.clubYear, row.clubYear, now);
  const duplicates = await listRosterDuplicates(input.organizationId, clubYear, prefill.firstName, prefill.lastName, prefill.birthDate);
  return {
    submissionId: row.id,
    organizationId: row.organizationId,
    formName: template.name,
    // Guardian contacts live only on the current club year's row (#510).
    prefill: clubYear === current ? prefill : { ...prefill, guardians: prefill.guardians.map(() => ({ name: "", relationship: "", email: "", phone: "" })) },
    clubYear,
    currentClubYear: current,
    clubYearChoices: choices,
    duplicates,
  };
}

export type RosterAddInput =
  | { action: "ADD"; organizationId: string; submissionId: string; clubYear: string; member: RosterMemberInput }
  | { action: "LINK"; organizationId: string; submissionId: string; memberId: string };

export type RosterAddResult = { action: "ADDED" | "LINKED"; rosterMemberId: string; clubYear: string };

/**
 * Step two: the director has checked the details and confirmed. Adds the
 * person (or links an existing member) and records it on the submission in one
 * transaction, so a failure to record leaves no stray roster member. The
 * submission's answers are never changed.
 */
export async function confirmAddToRoster(viewer: ClubFormsViewer, input: RosterAddInput, now = new Date()): Promise<RosterAddResult> {
  const leader = requireLeader(viewer, input.organizationId);
  const { row, template } = await loadAddable(input.organizationId, input.submissionId);
  const who = viewerAuditFields(leader);
  const actor = rosterActor(leader);
  const prisma = getPrisma();
  // The submission is claimed last, guarded on "not yet on the roster": of two confirms that race, the loser's whole transaction rolls back.
  const claim = (tx: Prisma.TransactionClient, action: "ADDED" | "LINKED", memberId: string) =>
    tx.clubFormSubmission.updateMany({
      where: { id: row.id, organizationId: row.organizationId, status: "SUBMITTED", rosterActionMemberId: null },
      data: { rosterAction: action, rosterActionMemberId: memberId, rosterActionAt: now },
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

    const choices = clubYearChoices(now);
    if (!choices.includes(input.clubYear)) {
      throw new ClubFormError("VALIDATION_FAILED", "Choose the previous, current or next club year.");
    }
    // Guardian contacts live only on the current club year's row (#510).
    const member = input.clubYear === clubYearFor(now) ? input.member : { ...input.member, guardians: undefined };
    const result = await prisma.$transaction(async (tx) => {
      const added = await addRosterMemberInTransaction(tx, input.organizationId, input.clubYear, member, actor, { source: "DIRECTOR", now });
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
          clubYear: input.clubYear,
          attendeeType: member.attendeeType,
        },
      }, tx);
      return { added, clubYear: input.clubYear };
    });
    // Same as a person added on the roster screen (#527): matched against the background check list right away.
    await refreshBackgroundCheckMatchesSafely([result.added.personId]);
    return { action: "ADDED", rosterMemberId: result.added.memberId, clubYear: result.clubYear };
  } catch (error) {
    if (error instanceof RosterOperationError) {
      if (error.code === "DUPLICATE_MEMBER") {
        const duplicates = input.action === "ADD"
          ? await listRosterDuplicates(input.organizationId, input.clubYear, input.member.firstName, input.member.lastName, input.member.birthDate)
          : [];
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
