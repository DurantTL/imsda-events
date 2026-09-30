import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { ClubFormSubmissionView } from "@/components/club-form-submission-view";
import { PrintFormButton } from "@/components/club-forms-actions";
import { resolveStaffViewer } from "@/modules/club-forms/access";
import { ClubFormError } from "@/modules/club-forms/errors";
import { getSubmissionForViewer } from "@/modules/club-forms/submissions";
import { staffPageTitles } from "@/components/staff-navigation";

export const metadata: Metadata = { title: staffPageTitles.clubForm };
export const dynamic = "force-dynamic";

/** One submitted club form for conference staff (#610). Opening one with sensitive answers is audited. */
export default async function StaffClubFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ submissionId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const [{ submissionId }, { event }] = await Promise.all([params, searchParams]);
  const viewer = await resolveStaffViewer();
  if (!viewer) {
    return <AccessRestricted detail="Club forms are for system administrators and Event Admins of a current event." title="Club forms are restricted" />;
  }
  const submission = await getSubmissionForViewer(viewer, submissionId).catch((error: unknown) => {
    if (error instanceof ClubFormError && error.code === "SUBMISSION_NOT_FOUND") return null;
    throw error;
  });
  if (!submission) notFound();

  return (
    <section className="page-stack club-form-page">
      <div className="club-form-page-actions intro-actions">
        <BackLink href={`/more/club-forms${event ? `?event=${encodeURIComponent(event)}` : ""}`} variant="staff">Back to club forms</BackLink>
        <PrintFormButton />
      </div>
      <ClubFormSubmissionView submission={submission} />
    </section>
  );
}
