import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubFormSubmissionView } from "@/components/club-form-submission-view";
import { PrintFormButton } from "@/components/club-forms-actions";
import { resolveAreaCoordinatorViewer } from "@/modules/club-forms/access";
import { ClubFormError } from "@/modules/club-forms/errors";
import { getSubmissionForViewer } from "@/modules/club-forms/submissions";

export const metadata: Metadata = { title: "Club form", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/** One submitted form of any club, view only, for an Area Coordinator (#610). The view is audited; sensitive answers are Restricted. */
export default async function AreaClubFormPage({ params }: { params: Promise<{ organizationId: string; submissionId: string }> }) {
  const viewer = await resolveAreaCoordinatorViewer();
  if (!viewer) notFound();
  const { organizationId, submissionId } = await params;
  const submission = await getSubmissionForViewer(viewer, submissionId).catch((error: unknown) => {
    if (error instanceof ClubFormError && error.code === "SUBMISSION_NOT_FOUND") return null;
    throw error;
  });
  // The URL's club must be the form's club: a form is never reachable through another club's path.
  if (!submission || submission.organization.id !== organizationId) notFound();

  return (
    <div className="club-form-page">
      <div className="club-form-page-actions intro-actions">
        <BackLink href={`/account/area/${organizationId}/forms`}>Back to forms</BackLink>
        <PrintFormButton />
      </div>
      <ClubFormSubmissionView submission={submission} />
    </div>
  );
}
