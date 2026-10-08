import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { RegistrationFormDefinition } from "@/modules/forms/definition";
import { getPrisma } from "@/lib/prisma";
import { isSecretEncryptionConfigured, SecretBoxError } from "@/lib/secret-box";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clubYearFor } from "@/modules/club-rosters/domain";
import {
  CLUB_FORM_MAX_ANSWERS_BYTES,
  deriveSubjectName,
  sanitizeClubFormAnswers,
  splitAnswers,
  validateClubFormAnswers,
  viewerAuditFields,
  restrictedFieldKeys,
  viewerCanRevealBirthDates,
  viewerCanRevealSensitive,
  viewerCanSeeClub,
  viewerCanWriteForClub,
  viewerSeesDrafts,
  parseClubFormTemplate,
  fillDefinition,
  allFields,
  type ClubFormActor,
  type ClubFormsViewer,
} from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { openSensitiveAnswers, sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import { assertClubFormTemplateCurrent, lockClubFormTemplateForWrite } from "@/modules/club-forms/template-lock";
import { getEnabledClubFormTemplate, withLiveDirectory } from "@/modules/club-forms/templates";
import { usableRosterMapping } from "@/modules/club-forms/roster-mapping";
import { getClubFormTemplateAtVersion } from "@/modules/club-forms/versions";

/**
 * Club form submissions (#610). Every function takes a resolved viewer and
 * checks it again, so a caller that forgot a role check still cannot read or
 * write another club's files. Sensitive answers are sealed before they reach
 * Prisma and are opened only in `getSubmissionForViewer`, after the audit row
 * for the view has been written.
 */

function attribution(actor: ClubFormActor) {
  return actor.kind === "ATTENDEE"
    ? { enteredVia: "ATTENDEE" as const, enteredByAccountId: actor.accountId, enteredByUserId: null }
    : { enteredVia: "STAFF_ACTING" as const, enteredByAccountId: null, enteredByUserId: actor.userId };
}

function requireLeaderFor(viewer: ClubFormsViewer, organizationId: string) {
  if (!viewerCanWriteForClub(viewer, organizationId) || viewer.kind !== "CLUB_LEADER") {
    // The same answer for another club and for a role without access.
    throw new ClubFormError("FORBIDDEN", "Your club role doesn't include club forms.");
  }
  return viewer;
}

export function assertAnswersSize(raw: unknown) {
  if (Buffer.byteLength(JSON.stringify(raw ?? {}), "utf8") > CLUB_FORM_MAX_ANSWERS_BYTES) {
    throw new ClubFormError("VALIDATION_FAILED", "The answers are too large.");
  }
}

/** Active roster members a form can be filled in for (names only). */
export async function listRosterChoices(organizationId: string, clubYear = clubYearFor(new Date())) {
  const members = await getPrisma().clubRosterMember.findMany({
    where: { organizationId, clubYear, status: "ACTIVE", personId: { not: null } },
    select: { id: true, person: { select: { firstName: true, lastName: true } } },
  });
  return members
    .flatMap((member) => member.person ? [{ id: member.id, name: `${member.person.firstName} ${member.person.lastName}`.trim() }] : [])
    .sort((left, right) => left.name.localeCompare(right.name, "en-US"));
}

/** Roster member of this club, for a form or link: another club's member is "not found". */
export async function resolveRosterMemberName(client: Pick<Prisma.TransactionClient, "clubRosterMember">, organizationId: string, rosterMemberId: string) {
  const member = await client.clubRosterMember.findFirst({
    where: { id: rosterMemberId, organizationId, status: "ACTIVE" },
    select: { id: true, person: { select: { firstName: true, lastName: true } } },
  });
  if (!member) throw new ClubFormError("MEMBER_NOT_FOUND", "That person isn't on your club's roster.");
  return member.person ? `${member.person.firstName} ${member.person.lastName}`.trim().slice(0, 120) : "";
}

/**
 * The stored answers (plain and sealed) of a draft whose keys are not in the
 * definition being filled in, because the field was hidden or removed since.
 */
function carriedForwardAnswers(
  existing: { id: string; answers: unknown; sealedSensitiveAnswers: string | null },
  fillable: RegistrationFormDefinition,
  submissionId: string,
): { plain: Record<string, unknown>; sealed: Record<string, unknown> } {
  const offered = new Set(allFields(fillable).map((field) => field.key));
  const notOffered = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).filter(([key]) => !offered.has(key)));
  let opened: Record<string, unknown> = {};
  if (existing.sealedSensitiveAnswers) {
    try {
      opened = openSensitiveAnswers(submissionId, existing.sealedSensitiveAnswers);
    } catch (error) {
      if (error instanceof SecretBoxError) {
        throw new ClubFormError("SENSITIVE_UNREADABLE", "The sensitive answers already saved on this draft can't be read on this server, so it can't be saved right now.");
      }
      throw error;
    }
  }
  // Whatever came out of the sealed value goes back in it, whatever the current sensitive key list says.
  return { plain: notOffered((existing.answers ?? {}) as Record<string, unknown>), sealed: notOffered(opened) };
}

export type SaveClubFormInput = {
  organizationId: string;
  templateKey: string;
  submissionId?: string;
  rosterMemberId?: string | null;
  subjectName?: string;
  answers: Record<string, unknown>;
  submit: boolean;
};

/**
 * A director or deputy fills a form in for a member (or for no one, as for a
 * staff applicant), saving a draft or submitting. A submitted form is never
 * edited; a mistake is a new form.
 */
export async function saveClubFormSubmission(viewer: ClubFormsViewer, input: SaveClubFormInput, now = new Date()) {
  const leader = requireLeaderFor(viewer, input.organizationId);
  assertAnswersSize(input.answers);
  const prisma = getPrisma();
  const club = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { type: true, isActive: true },
  });
  if (!club || club.type !== "CLUB" || !club.isActive) throw new ClubFormError("CLUB_NOT_FOUND", "That club could not be found.");

  const template = await getEnabledClubFormTemplate(input.templateKey, prisma);
  assertClubFormTemplateCurrent(template);
  // Fields hidden from new versions (#712) are not offered, so they cannot be written either.
  const definition = await withLiveDirectory(fillDefinition(template), prisma);
  const memberName = input.rosterMemberId
    ? await resolveRosterMemberName(prisma, input.organizationId, input.rosterMemberId)
    : "";

  const answers = sanitizeClubFormAnswers(definition, input.answers);
  let issues = validateClubFormAnswers(definition, answers, { draft: !input.submit });
  if (issues.length > 0 && input.submissionId) {
    // Editing a draft (#855): an old answer that fails today's checks is flagged on the form but does not block
    // the save when it was not changed. The stored values are read only to compare, and never put in a message.
    const stored = await prisma.clubFormSubmission.findFirst({
      where: { id: input.submissionId, organizationId: input.organizationId, templateId: template.id, status: "DRAFT" },
      select: { answers: true, sealedSensitiveAnswers: true },
    });
    if (stored) {
      let sealedAnswers: Record<string, unknown> = {};
      if (stored.sealedSensitiveAnswers) {
        try {
          sealedAnswers = openSensitiveAnswers(input.submissionId, stored.sealedSensitiveAnswers);
        } catch {
          sealedAnswers = {};
        }
      }
      issues = validateClubFormAnswers(definition, answers, {
        draft: !input.submit,
        previousAnswers: { ...((stored.answers ?? {}) as Record<string, unknown>), ...sealedAnswers },
      });
    }
  }
  if (issues.length > 0) throw new ClubFormError("VALIDATION_FAILED", issues[0].message, issues);
  const subjectName = memberName || input.subjectName?.trim().slice(0, 120) || deriveSubjectName(answers);
  const who = attribution(leader.actor);

  return prisma.$transaction(async (tx) => {
    // Which answers are sensitive is decided under a share lock on the template row, so a concurrent re-seal cannot leave this save in plaintext.
    const keys = await lockClubFormTemplateForWrite(tx, template);
    let id = input.submissionId ?? randomUUID();
    const existing = input.submissionId
      ? await tx.clubFormSubmission.findFirst({
        where: { id: input.submissionId, organizationId: input.organizationId, templateId: template.id },
        select: { id: true, status: true, answers: true, sealedSensitiveAnswers: true },
      })
      : null;
    if (input.submissionId) {
      if (!existing) throw new ClubFormError("SUBMISSION_NOT_FOUND", "That form could not be found.");
      if (existing.status !== "DRAFT") throw new ClubFormError("ALREADY_SUBMITTED", "A submitted form can't be changed. Start a new one instead.");
    }
    // A draft started on an earlier version may hold answers to a field since hidden or removed. The form no
    // longer shows them, so this save carries them forward untouched (sealed ones are re-opened here, server-side
    // only, and sealed again) rather than silently erasing them.
    const carried = existing ? carriedForwardAnswers(existing, definition, id) : { plain: {}, sealed: {} };
    const split = splitAnswers({ sensitiveFieldKeys: keys.sensitiveFieldKeys }, { ...carried.plain, ...answers });
    const plain = split.plain;
    const sensitive = { ...split.sensitive, ...carried.sealed };
    const hasSensitive = Object.keys(sensitive).length > 0;
    if (hasSensitive && !isSecretEncryptionConfigured()) {
      throw new ClubFormError("ENCRYPTION_NOT_CONFIGURED", "Encryption isn't set up on this server, so this form can't be saved yet.");
    }
    const sealed = hasSensitive ? sealSensitiveAnswers(id, sensitive) : null;
    const data = {
      rosterMemberId: input.rosterMemberId ?? null,
      subjectName,
      answers: plain as Prisma.InputJsonValue,
      sealedSensitiveAnswers: sealed,
      hasSensitiveAnswers: hasSensitive,
      templateVersion: template.version,
      status: input.submit ? ("SUBMITTED" as const) : ("DRAFT" as const),
      submittedAt: input.submit ? now : null,
    };
    if (existing) {
      // Guarded on still being a draft: a second save racing a submit cannot rewrite a submitted form.
      const updated = await tx.clubFormSubmission.updateMany({
        where: { id: existing.id, status: "DRAFT" },
        data,
      });
      if (updated.count === 0) throw new ClubFormError("ALREADY_SUBMITTED", "A submitted form can't be changed. Start a new one instead.");
      id = existing.id;
    } else {
      await tx.clubFormSubmission.create({
        data: {
          id,
          templateId: template.id,
          organizationId: input.organizationId,
          clubYear: clubYearFor(now),
          ...data,
          ...who,
        },
      });
    }
    await writeAuditLog({
      ...viewerAuditFields(leader),
      action: input.submit ? "CLUB_FORM_SUBMISSION_SUBMITTED" : "CLUB_FORM_SUBMISSION_SAVED",
      entityType: "ClubFormSubmission",
      entityId: id,
      summary: input.submit ? "A club form was submitted." : "A club form draft was saved.",
      metadata: {
        ...viewerAuditFields(leader).metadata,
        organizationId: input.organizationId,
        templateKey: template.key,
        hasSensitiveAnswers: hasSensitive,
      },
    }, tx);
    return { id, status: data.status };
  });
}

export type ClubFormListFilter = {
  organizationId?: string;
  templateKey?: string;
  rosterMemberId?: string;
};

function visibleWhere(viewer: ClubFormsViewer, filter: ClubFormListFilter): Prisma.ClubFormSubmissionWhereInput {
  if (filter.organizationId && !viewerCanSeeClub(viewer, filter.organizationId)) {
    throw new ClubFormError("CLUB_NOT_FOUND", "That club could not be found.");
  }
  const organizationId = viewer.kind === "CLUB_LEADER" ? viewer.organizationId : filter.organizationId;
  return {
    ...(organizationId ? { organizationId } : {}),
    ...(filter.rosterMemberId ? { rosterMemberId: filter.rosterMemberId } : {}),
    // A form that has been switched off blocks new fills and links only: past submissions stay readable.
    ...(filter.templateKey ? { template: { key: filter.templateKey } } : {}),
    ...(viewerSeesDrafts(viewer) ? {} : { status: "SUBMITTED" as const }),
  };
}

/** Submissions a viewer may list. Never reads answers, sealed or plain. */
export async function listSubmissionsForViewer(viewer: ClubFormsViewer, filter: ClubFormListFilter = {}) {
  const rows = await getPrisma().clubFormSubmission.findMany({
    where: visibleWhere(viewer, filter),
    orderBy: [{ organization: { name: "asc" } }, { template: { sortOrder: "asc" } }, { updatedAt: "desc" }],
    take: 500,
    select: {
      id: true,
      clubYear: true,
      rosterMemberId: true,
      subjectName: true,
      status: true,
      submittedAt: true,
      updatedAt: true,
      enteredVia: true,
      hasSensitiveAnswers: true,
      template: { select: { key: true, name: true } },
      organization: { select: { id: true, name: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    templateKey: row.template.key,
    templateName: row.template.name,
    organizationId: row.organization.id,
    organizationName: row.organization.name,
    clubYear: row.clubYear,
    rosterMemberId: row.rosterMemberId,
    subjectName: row.subjectName,
    status: row.status,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    enteredVia: row.enteredVia,
    hasSensitiveAnswers: row.hasSensitiveAnswers,
  }));
}

export type ClubFormSubmissionListRow = Awaited<ReturnType<typeof listSubmissionsForViewer>>[number];

export type SubmissionViewPurpose = "VIEW" | "EDIT" | "PRINT" | "ROSTER_ADD";

/**
 * One submission for a viewer. When it holds sensitive answers, the audit row
 * (who, what, when, and whether the answers were revealed, never the answers)
 * is written first; if that write fails nothing is returned. A viewer who may
 * not reveal sensitive answers gets `restrictedKeys` and no values for them.
 */
export async function getSubmissionForViewer(
  viewer: ClubFormsViewer,
  submissionId: string,
  purpose: SubmissionViewPurpose = "VIEW",
  /** The club named in the page's URL. A form of any other club is "not found", before anything is audited. */
  expectedOrganizationId?: string,
) {
  const prisma = getPrisma();
  const row = await prisma.clubFormSubmission.findFirst({
    where: { id: submissionId, ...visibleWhere(viewer, { organizationId: expectedOrganizationId }) },
    select: {
      id: true,
      organizationId: true,
      clubYear: true,
      rosterMemberId: true,
      subjectName: true,
      status: true,
      submittedAt: true,
      enteredVia: true,
      answers: true,
      sealedSensitiveAnswers: true,
      hasSensitiveAnswers: true,
      templateVersion: true,
      rosterAction: true,
      rosterActionMemberId: true,
      rosterActionMember: { select: { clubYear: true, status: true } },
      organization: { select: { name: true } },
      template: {
        select: {
          id: true, key: true, name: true, description: true, version: true, definition: true, sectionNotes: true,
          sensitiveFieldKeys: true, birthDateFieldKeys: true, staffOnlyFieldKeys: true, hiddenFieldKeys: true, printLayout: true, rosterMapping: true, enabled: true, customizedAt: true,
        },
      },
    },
  });
  if (!row) throw new ClubFormError("SUBMISSION_NOT_FOUND", "That form could not be found.");
  const current = parseClubFormTemplate(row.template);
  // A submission is shown against the version it was filled in against (#712). A draft being edited moves to
  // the latest published version, which is what its next save is validated against.
  const editingDraft = purpose === "EDIT" && row.status === "DRAFT";
  const template = editingDraft ? current : await getClubFormTemplateAtVersion(current, row.templateVersion, prisma);
  const restricted = new Set(restrictedFieldKeys(viewer, row.organizationId, template));
  const reveal = viewerCanRevealSensitive(viewer, row.organizationId);
  const revealBirthDates = viewerCanRevealBirthDates(viewer, row.organizationId);

  // A plain answer under a sensitive key (stored before that key became sensitive) counts too: never an unaudited view.
  const sensitiveKeys = new Set(template.sensitiveFieldKeys);
  const holdsSensitive = row.hasSensitiveAnswers
    || Object.keys(row.answers as Record<string, unknown>).some((key) => sensitiveKeys.has(key));
  if (holdsSensitive) {
    const who = viewerAuditFields(viewer);
    await writeAuditLog({
      actorUserId: who.actorUserId,
      action: "CLUB_FORM_SUBMISSION_VIEWED",
      entityType: "ClubFormSubmission",
      entityId: row.id,
      summary: "Opened a club form that has sensitive answers.",
      metadata: {
        ...who.metadata,
        organizationId: row.organizationId,
        templateKey: template.key,
        purpose,
        sensitiveRevealed: reveal,
        birthDatesRevealed: revealBirthDates,
      },
    });
  }

  const answers: Record<string, unknown> = { ...(row.answers as Record<string, unknown>) };
  // Defense in depth: a restricted key never leaves here, even if it was stored in the plain column.
  for (const key of restricted) delete answers[key];
  if ((reveal || revealBirthDates) && row.sealedSensitiveAnswers) {
    try {
      const opened = openSensitiveAnswers(row.id, row.sealedSensitiveAnswers);
      // Only the keys this viewer may read leave this function.
      for (const [key, value] of Object.entries(opened)) {
        if (!restricted.has(key)) answers[key] = value;
      }
    } catch (error) {
      if (error instanceof SecretBoxError) {
        throw new ClubFormError("SENSITIVE_UNREADABLE", "The sensitive answers on this form can't be read on this server.");
      }
      throw error;
    }
  }
  // Editing a draft: the form offers only the fields it still shows. Answers to a hidden or removed field stay on
  // the server (the save carries them forward); they are never returned to the client.
  if (editingDraft) {
    const offered = new Set(allFields(fillDefinition(template)).map((field) => field.key));
    for (const key of Object.keys(answers)) {
      if (!offered.has(key)) delete answers[key];
    }
  }
  return {
    id: row.id,
    template: {
      key: template.key,
      name: template.name,
      description: template.description,
      printLayout: template.printLayout,
      definition: editingDraft ? fillDefinition(template) : template.definition,
      sectionNotes: template.sectionNotes,
      sensitiveFieldKeys: template.sensitiveFieldKeys,
      staffOnlyFieldKeys: template.staffOnlyFieldKeys,
      version: template.version,
      hiddenFieldKeys: template.hiddenFieldKeys,
      enabled: template.enabled,
    },
    organization: { id: row.organizationId, name: row.organization.name },
    clubYear: row.clubYear,
    rosterMemberId: row.rosterMemberId,
    subjectName: row.subjectName,
    status: row.status,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    enteredVia: row.enteredVia,
    hasSensitiveAnswers: row.hasSensitiveAnswers,
    answers,
    /**
     * "Add to roster" (#721), for a club's director or deputy only: whether the form can be added (its template's
     * setting is on and passes every check, and the form is submitted and not yet added), or what was done with it.
     * Holds no answer.
     */
    rosterAdd: viewer.kind !== "CLUB_LEADER" ? null : (() => {
      // A member who was removed from the roster is gone: the form counts as not added, so it can be added again.
      const done = row.rosterAction && row.rosterActionMemberId && row.rosterActionMember?.status !== "REMOVED"
        ? { action: row.rosterAction, memberId: row.rosterActionMemberId, clubYear: row.rosterActionMember?.clubYear ?? row.clubYear }
        : null;
      return {
        available: !done && row.status === "SUBMITTED" && usableRosterMapping(current.rosterMapping, current) !== null,
        done,
      };
    })(),
    sensitiveRevealed: reveal,
    /** Fields shown as "Restricted": every sensitive field this viewer may not read, answered or not, so a blank does not tell. */
    restrictedKeys: [...restricted],
  };
}

export type ClubFormSubmissionView = Awaited<ReturnType<typeof getSubmissionForViewer>>;
