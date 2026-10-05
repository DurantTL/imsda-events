import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubFormRosterAdd } from "@/components/club-form-roster-add";
import { clubLeaderViewerFromAccess } from "@/modules/club-forms/access";
import { isClubFormsRole } from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { getRosterAddReview } from "@/modules/club-forms/roster-add";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";

export const metadata: Metadata = { title: "Add to roster", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * The review step of "Add to roster" (#721): the form's mapped answers
 * pre-fill a new roster member, the director checks and edits them, and only
 * then confirms. This page writes nothing to the roster. Only the club's
 * director and deputy reach it; a registrar gets "not found". Opening it
 * writes the same audit row as opening the form (who and what, never an
 * answer).
 */
export default async function AddToRosterPage({ params }: { params: Promise<{ organizationId: string; submissionId: string }> }) {
  const { organizationId, submissionId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  if (!isClubFormsRole(access.club.role)) notFound();
  const viewer = clubLeaderViewerFromAccess(access);
  const formHref = `/account/clubs/${organizationId}/forms/submissions/${submissionId}`;
  const outcome = await getRosterAddReview(viewer, { organizationId, submissionId })
    .then((review) => ({ review, message: "" }))
    .catch((error: unknown) => {
      if (error instanceof ClubFormError && error.code === "SUBMISSION_NOT_FOUND") return null;
      if (error instanceof ClubFormError && (error.code === "ROSTER_ADD_UNAVAILABLE" || error.code === "ALREADY_ON_ROSTER")) {
        return { review: null, message: error.message };
      }
      throw error;
    });
  if (!outcome) notFound();

  return (
    <div className="club-form-page">
      <div className="club-form-page-actions intro-actions">
        <BackLink href={formHref}>Back to this form</BackLink>
      </div>
      {outcome.review
        ? <ClubFormRosterAdd formHref={formHref} review={outcome.review} />
        : <div className="inline-notice" role="status">{outcome.message}</div>}
    </div>
  );
}
