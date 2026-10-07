import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NewClubApplicationsQueue } from "@/components/new-club-applications-queue";
import { listNewClubApplications } from "@/modules/club-applications/repository";
import { currentApplicationViewer } from "@/modules/club-applications/viewer";

export const metadata: Metadata = { title: "New club applications", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * New club applications for the Area Coordinator (#817): the same list a system
 * administrator reviews, view only. Deciding is the system administrator's.
 */
export default async function AreaNewClubApplicationsPage() {
  // Layouts do not re-run on navigation, so every page checks for itself (#657).
  const viewer = await currentApplicationViewer();
  if (!viewer) notFound();
  const applications = await listNewClubApplications(viewer);
  return (
    <section className="page-stack">
      <div className="public-manage-card">
        <h2>New club applications</h2>
        <p className="field-help">
          People who applied to start a new club. A system administrator approves or declines each one; this list is view only.
          Contact details and attachments are for your review and are not to be shared.
        </p>
      </div>
      <NewClubApplicationsQueue applications={applications} canDecide={false} churches={[]} />
    </section>
  );
}
