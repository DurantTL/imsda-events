import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
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
  viewerCanRevealSensitive,
  viewerCanSeeClub,
  viewerCanWriteForClub,
  viewerSeesDisabledTemplates,
  viewerSeesDrafts,
  parseClubFormTemplate,
  type ClubFormActor,
  type ClubFormsViewer,
} from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { openSensitiveAnswers, sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import { getEnabledClubFormTemplate, withLiveDirectory } from "@/modules/club-forms/templates";

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
  const definition = await withLiveDirectory(template.definition, prisma);
  const memberName = input.rosterMemberId
    ? await resolveRosterMemberName(prisma, input.organizationId, input.rosterMemberId)
    : "";

  const answers = sanitizeClubFormAnswers(definition, input.answers);
  const issues = validateClubFormAnswers(definition, answers, { draft: !input.submit });
  if (issues.length > 0) throw new ClubFormError("VALIDATION_FAILED", issues[0].message, issues);
  const { plain, sensitive } = splitAnswers(template, answers);

  const hasSensitive = Object.keys(sensitive).length > 0;
  if (hasSensitive && !isSecretEncryptionConfigured()) {
    throw new ClubFormError("ENCRYPTION_NOT_CONFIGURED", "Encryption isn't set up on this server, so this form can't be saved yet.");
  }
  const subjectName = memberName || input.subjectName?.trim().slice(0, 120) || deriveSubjectName(answers);
  const who = attribution(leader.actor);

  return prisma.$transaction(async (tx) => {
    let id = input.submissionId ?? randomUUID();
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
    if (input.submissionId) {
      const existing = await tx.clubFormSubmission.findFirst({
        where: { id: input.submissionId, organizationId: input.organizationId, templateId: template.id },
        select: { id: true, status: true },
      });
      if (!existing) throw new ClubFormError("SUBMISSION_NOT_FOUND", "That form could not be found.");
      if (existing.status !== "DRAFT") throw new ClubFormError("ALREADY_SUBMITTED", "A submitted form can't be changed. Start a new one instead.");
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
    template: {
      ...(viewerSeesDisabledTemplates(viewer) ? {} : { enabled: true }),
      ...(filter.templateKey ? { key: filter.templateKey } : {}),
    },
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

export type SubmissionViewPurpose = "VIEW" | "EDIT" | "PRINT";

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
) {
  const prisma = getPrisma();
  const row = await prisma.clubFormSubmission.findFirst({
    where: { id: submissionId, ...visibleWhere(viewer, {}) },
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
      organization: { select: { name: true } },
      template: {
        select: {
          id: true, key: true, name: true, description: true, version: true, definition: true, sectionNotes: true,
          sensitiveFieldKeys: true, staffOnlyFieldKeys: true, printLayout: true, enabled: true,
        },
      },
    },
  });
  if (!row) throw new ClubFormError("SUBMISSION_NOT_FOUND", "That form could not be found.");
  const template = parseClubFormTemplate(row.template);
  const reveal = viewerCanRevealSensitive(viewer, row.organizationId);

  if (row.hasSensitiveAnswers) {
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
      },
    });
  }

  const answers: Record<string, unknown> = { ...(row.answers as Record<string, unknown>) };
  if (reveal && row.sealedSensitiveAnswers) {
    try {
      Object.assign(answers, openSensitiveAnswers(row.id, row.sealedSensitiveAnswers));
    } catch (error) {
      if (error instanceof SecretBoxError) {
        throw new ClubFormError("SENSITIVE_UNREADABLE", "The sensitive answers on this form can't be read on this server.");
      }
      throw error;
    }
  }
  return {
    id: row.id,
    template: {
      key: template.key,
      name: template.name,
      description: template.description,
      printLayout: template.printLayout,
      definition: template.definition,
      sectionNotes: template.sectionNotes,
      sensitiveFieldKeys: template.sensitiveFieldKeys,
      staffOnlyFieldKeys: template.staffOnlyFieldKeys,
    },
    organization: { id: row.organizationId, name: row.organization.name },
    clubYear: row.clubYear,
    rosterMemberId: row.rosterMemberId,
    subjectName: row.subjectName,
    status: row.status,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    enteredVia: row.enteredVia,
    answers,
    sensitiveRevealed: reveal,
    /** Fields shown as "Restricted": every sensitive field, answered or not, so a blank does not tell. */
    restrictedKeys: reveal ? [] : template.sensitiveFieldKeys,
  };
}

export type ClubFormSubmissionView = Awaited<ReturnType<typeof getSubmissionForViewer>>;
