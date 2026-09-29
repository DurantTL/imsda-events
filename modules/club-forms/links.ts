import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { isSecretEncryptionConfigured } from "@/lib/secret-box";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clubYearFor } from "@/modules/club-rosters/domain";
import {
  clampLinkDays,
  clubFormLinkState,
  definitionForLink,
  deriveSubjectName,
  parseClubFormTemplate,
  sanitizeClubFormAnswers,
  splitAnswers,
  validateClubFormAnswers,
  viewerAuditFields,
  viewerCanWriteForClub,
  type ClubFormsViewer,
} from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { CLUB_FORM_LINK_TEMPLATE_KEY, clubFormLinkEmailContent } from "@/modules/club-forms/link-email";
import { sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import { assertAnswersSize, resolveRosterMemberName } from "@/modules/club-forms/submissions";
import { getEnabledClubFormTemplate, withLiveDirectory } from "@/modules/club-forms/templates";
import { getAccountEmailSender, isAccountEmailConfigured } from "@/modules/communications/account-email";

/**
 * Single-use private links to a club form (#610). A director or deputy types
 * one address; the link goes there in one transactional email queued in the
 * same transaction as the link and delivered after it commits. Anyone with
 * the link fills in and submits once, with no account; it is tied to one club
 * and one form, and the page it opens shows nothing else about the club.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The one answer for every link that cannot be used, so nothing says why. */
const UNAVAILABLE_MESSAGE = "This private link is invalid or no longer active.";

function unavailable() {
  return new ClubFormError("LINK_UNAVAILABLE", UNAVAILABLE_MESSAGE);
}

function leaderOnly(viewer: ClubFormsViewer, organizationId: string) {
  if (!viewerCanWriteForClub(viewer, organizationId) || viewer.kind !== "CLUB_LEADER") {
    throw new ClubFormError("FORBIDDEN", "Your club role doesn't include club forms.");
  }
  return viewer;
}

export type CreateClubFormLinkInput = {
  organizationId: string;
  templateKey: string;
  recipientEmail: string;
  subjectName?: string;
  rosterMemberId?: string | null;
  expiresInDays?: number;
};

export async function createClubFormLink(viewer: ClubFormsViewer, input: CreateClubFormLinkInput, now = new Date()) {
  const leader = leaderOnly(viewer, input.organizationId);
  if (!isAccountEmailConfigured()) {
    throw new ClubFormError("EMAIL_NOT_CONFIGURED", "Email isn't set up on this server, so a link can't be sent yet.");
  }
  const prisma = getPrisma();
  const club = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { type: true, isActive: true, name: true },
  });
  if (!club || club.type !== "CLUB" || !club.isActive) throw new ClubFormError("CLUB_NOT_FOUND", "That club could not be found.");
  const template = await getEnabledClubFormTemplate(input.templateKey, prisma);
  const memberName = input.rosterMemberId
    ? await resolveRosterMemberName(prisma, input.organizationId, input.rosterMemberId)
    : "";

  const days = clampLinkDays(input.expiresInDays);
  const expiresAt = new Date(now.getTime() + days * DAY_MS);
  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  const sender = getAccountEmailSender();
  const content = clubFormLinkEmailContent({
    clubName: club.name,
    formName: template.name,
    days,
    expiresOn: expiresAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" }),
  });
  const actor = leader.actor;
  const creator = actor.kind === "ATTENDEE"
    ? { createdByAccountId: actor.accountId }
    : { createdByUserId: actor.userId };

  return prisma.$transaction(async (tx) => {
    const link = await tx.clubFormLink.create({
      data: {
        templateId: template.id,
        organizationId: input.organizationId,
        clubYear: clubYearFor(now),
        rosterMemberId: input.rosterMemberId ?? null,
        subjectName: memberName || input.subjectName?.trim().slice(0, 120) || "",
        recipientEmail,
        expiresAt,
        ...creator,
      },
      select: { id: true },
    });
    const message = await tx.messageOutbox.create({
      data: {
        eventId: null,
        templateKey: CLUB_FORM_LINK_TEMPLATE_KEY,
        recipientKind: "ACCOUNT",
        recipientEmail,
        recipientName: null,
        senderNameSnapshot: sender.name,
        senderEmailSnapshot: sender.address,
        replyToEmailSnapshot: sender.replyTo,
        subjectSnapshot: content.subject,
        bodyTextSnapshot: content.bodyText,
        metadata: { trigger: "CLUB_FORM_LINK", accountEmail: true, realDelivery: true, clubFormLinkId: link.id },
        idempotencyKey: `club-form-link:${link.id}`,
        correlationId: randomUUID(),
        status: "PENDING",
      },
      select: { id: true },
    });
    await tx.clubFormLink.update({ where: { id: link.id }, data: { messageId: message.id } });
    const who = viewerAuditFields(leader);
    await writeAuditLog({
      actorUserId: who.actorUserId,
      action: "CLUB_FORM_LINK_CREATED",
      entityType: "ClubFormLink",
      entityId: link.id,
      summary: "Sent a private link to fill in a club form.",
      // No address and no token: who sent it, for which club and form, and when it expires.
      metadata: { ...who.metadata, organizationId: input.organizationId, templateKey: template.key, expiresAt: expiresAt.toISOString() },
    }, tx);
    return { linkId: link.id, messageId: message.id, expiresAt };
  });
}

/** A club's own recent links: never a token, and never another club's. */
export async function listClubFormLinks(viewer: ClubFormsViewer, organizationId: string, now = new Date()) {
  leaderOnly(viewer, organizationId);
  const links = await getPrisma().clubFormLink.findMany({
    where: { organizationId, template: { enabled: true } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      recipientEmail: true,
      subjectName: true,
      status: true,
      expiresAt: true,
      usedAt: true,
      createdAt: true,
      template: { select: { key: true, name: true } },
      submission: { select: { id: true } },
    },
  });
  return links.map((link) => ({
    id: link.id,
    templateKey: link.template.key,
    templateName: link.template.name,
    recipientEmail: link.recipientEmail,
    subjectName: link.subjectName,
    state: clubFormLinkState(link, now),
    expiresAt: link.expiresAt.toISOString(),
    usedAt: link.usedAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
    submissionId: link.submission?.id ?? null,
  }));
}

export type ClubFormLinkRow = Awaited<ReturnType<typeof listClubFormLinks>>[number];

/** Withdraws an open link of this club. Another club's link is "not found". */
export async function revokeClubFormLink(viewer: ClubFormsViewer, organizationId: string, linkId: string, now = new Date()) {
  const leader = leaderOnly(viewer, organizationId);
  return getPrisma().$transaction(async (tx) => {
    const link = await tx.clubFormLink.findFirst({
      where: { id: linkId, organizationId },
      select: { id: true, status: true, template: { select: { key: true } } },
    });
    if (!link) throw new ClubFormError("LINK_NOT_FOUND", "That link could not be found.");
    const revoked = await tx.clubFormLink.updateMany({
      where: { id: link.id, status: "OPEN" },
      data: { status: "REVOKED", revokedAt: now },
    });
    if (revoked.count === 0) throw new ClubFormError("LINK_UNAVAILABLE", "That link was already used or withdrawn.");
    const who = viewerAuditFields(leader);
    await writeAuditLog({
      actorUserId: who.actorUserId,
      action: "CLUB_FORM_LINK_REVOKED",
      entityType: "ClubFormLink",
      entityId: link.id,
      summary: "Withdrew a private link to a club form.",
      metadata: { ...who.metadata, organizationId, templateKey: link.template.key },
    }, tx);
  });
}

// ---------------------------------------------------------------------------
// The public side: no account, only the token.

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

const linkSelect = {
  id: true,
  status: true,
  expiresAt: true,
  tokenHash: true,
  organizationId: true,
  rosterMemberId: true,
  subjectName: true,
  clubYear: true,
  organization: { select: { name: true, isActive: true, type: true } },
  template: {
    select: {
      id: true, key: true, name: true, description: true, version: true, definition: true, sectionNotes: true,
      sensitiveFieldKeys: true, staffOnlyFieldKeys: true, printLayout: true, enabled: true,
    },
  },
} satisfies Prisma.ClubFormLinkSelect;

async function findUsableLink(token: string, now: Date) {
  if (!TOKEN_PATTERN.test(token)) throw unavailable();
  const link = await getPrisma().clubFormLink.findUnique({ where: { tokenHash: hashOpaqueToken(token) }, select: linkSelect });
  if (
    !link
    || link.status !== "OPEN"
    || link.expiresAt <= now
    || !link.template.enabled
    || !link.organization.isActive
    || link.organization.type !== "CLUB"
  ) {
    throw unavailable();
  }
  return link;
}

/**
 * What the link's page shows: the club's name, the form, and nothing else. No
 * roster member, no label the director typed, no other form or submission.
 */
export async function resolveClubFormLinkForFill(token: string, now = new Date()) {
  const link = await findUsableLink(token, now);
  const template = parseClubFormTemplate(link.template);
  const definition = await withLiveDirectory(definitionForLink(template));
  const sectionIds = new Set(definition.sections.map((section) => section.id));
  return {
    clubName: link.organization.name,
    form: {
      key: template.key,
      name: template.name,
      definition,
      sectionNotes: Object.fromEntries(Object.entries(template.sectionNotes).filter(([id]) => sectionIds.has(id))),
      sensitiveFieldKeys: template.sensitiveFieldKeys,
    },
  };
}

export type PublicClubForm = Awaited<ReturnType<typeof resolveClubFormLinkForFill>>;

/**
 * Submits the form behind a link, exactly once. The link is spent by a
 * guarded update inside the same transaction that creates the submission, so
 * two requests racing with the same link cannot both succeed: the second one
 * waits on the row, then finds it spent and rolls its submission back.
 */
export async function submitClubFormViaLink(token: string, rawAnswers: Record<string, unknown>, now = new Date()) {
  assertAnswersSize(rawAnswers);
  const link = await findUsableLink(token, now);
  const template = parseClubFormTemplate(link.template);
  const definition = await withLiveDirectory(template.definition);
  // Office-use fields are not the filler's to write, even by hand-crafted request.
  const answers = sanitizeClubFormAnswers(definition, rawAnswers, template.staffOnlyFieldKeys);
  const issues = validateClubFormAnswers(definition, answers, { excludeKeys: template.staffOnlyFieldKeys });
  if (issues.length > 0) throw new ClubFormError("VALIDATION_FAILED", issues[0].message, issues);
  const { plain, sensitive } = splitAnswers(template, answers);
  const hasSensitive = Object.keys(sensitive).length > 0;
  if (hasSensitive && !isSecretEncryptionConfigured()) {
    throw new ClubFormError("ENCRYPTION_NOT_CONFIGURED", "This form can't be saved right now. Please try again later.");
  }
  const submissionId = randomUUID();
  const sealed = hasSensitive ? sealSensitiveAnswers(submissionId, sensitive) : null;
  const tokenHash = hashOpaqueToken(token);

  return getPrisma().$transaction(async (tx) => {
    const spent = await tx.clubFormLink.updateMany({
      where: { id: link.id, tokenHash, status: "OPEN", expiresAt: { gt: now } },
      data: { status: "USED", usedAt: now },
    });
    if (spent.count === 0) throw unavailable();
    await tx.clubFormSubmission.create({
      data: {
        id: submissionId,
        templateId: link.template.id,
        organizationId: link.organizationId,
        clubYear: link.clubYear,
        rosterMemberId: link.rosterMemberId,
        subjectName: link.subjectName || deriveSubjectName(answers),
        status: "SUBMITTED",
        answers: plain as Prisma.InputJsonValue,
        sealedSensitiveAnswers: sealed,
        hasSensitiveAnswers: hasSensitive,
        templateVersion: template.version,
        enteredVia: "LINK",
        linkId: link.id,
        submittedAt: now,
      },
    });
    await writeAuditLog({
      action: "CLUB_FORM_LINK_SUBMITTED",
      entityType: "ClubFormSubmission",
      entityId: submissionId,
      summary: "A club form was submitted through a private link.",
      metadata: { organizationId: link.organizationId, templateKey: template.key, hasSensitiveAnswers: hasSensitive, linkId: link.id },
    }, tx);
    return { submissionId, confirmationMessage: template.definition.confirmationMessage };
  });
}
