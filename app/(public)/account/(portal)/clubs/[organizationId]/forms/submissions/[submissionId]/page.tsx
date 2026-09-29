import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubFormFillIn } from "@/components/club-form-fill-in";
import { ClubFormSubmissionView } from "@/components/club-form-submission-view";
import { PrintFormButton } from "@/components/club-forms-actions";
import { clubLeaderViewerFromAccess } from "@/modules/club-forms/access";
import { isClubFormsRole } from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { getSubmissionForViewer, listRosterChoices } from "@/modules/club-forms/submissions";
import { withLiveDirectory } from "@/modules/club-forms/templates";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";

export const metadata: Metadata = { title: "Club form", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * One filled form of the club (#610): a clean page for the paper files, with a
 * print button. A draft can be reopened for editing with `?edit=1`. Opening a
 * form with sensitive answers writes an audit row (who, what, when; no
 * answers) before anything is read.
 */
export default async function ClubFormSubmissionPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; submissionId: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const [{ organizationId, submissionId }, { edit }] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  if (!isClubFormsRole(access.club.role)) notFound();
  const viewer = clubLeaderViewerFromAccess(access);
  const submission = await getSubmissionForViewer(viewer, submissionId, edit ? "EDIT" : "VIEW").catch((error: unknown) => {
    if (error instanceof ClubFormError && error.code === "SUBMISSION_NOT_FOUND") return null;
    throw error;
  });
  if (!submission) notFound();
  const base = `/account/clubs/${organizationId}/forms`;

  if (edit && submission.status === "DRAFT") {
    const [definition, rosterMembers] = await Promise.all([withLiveDirectory(submission.template.definition), listRosterChoices(organizationId)]);
    return (
      <>
        <BackLink href={`${base}/submissions/${submissionId}`}>Back to this form</BackLink>
        <ClubFormFillIn
          definition={definition}
          doneHref={base}
          initialAnswers={submission.answers}
          initialRosterMemberId={submission.rosterMemberId}
          initialSubjectName={submission.subjectName}
          mode="club"
          organizationId={organizationId}
          rosterMembers={rosterMembers}
          sectionNotes={submission.template.sectionNotes}
          sensitiveFieldKeys={submission.template.sensitiveFieldKeys}
          submissionId={submission.id}
          templateKey={submission.template.key}
        />
      </>
    );
  }

  return (
    <div className="club-form-page">
      <div className="club-form-page-actions intro-actions">
        <BackLink href={base}>Back to club forms</BackLink>
        <PrintFormButton />
        {submission.status === "DRAFT" && <Link className="primary-button" href={`${base}/submissions/${submissionId}?edit=1`}>Continue editing</Link>}
      </div>
      <ClubFormSubmissionView submission={submission} />
    </div>
  );
}
