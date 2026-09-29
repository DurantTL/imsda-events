import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { getPrisma } from "@/lib/prisma";
import { resolveAreaCoordinatorViewer } from "@/modules/club-forms/access";
import { listSubmissionsForViewer } from "@/modules/club-forms/submissions";

export const metadata: Metadata = { title: "Club forms", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

function formatDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}

/** Any club's submitted forms, view only, for an Area Coordinator (#610). Sensitive answers are "Restricted". */
export default async function AreaClubFormsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const viewer = await resolveAreaCoordinatorViewer();
  if (!viewer) notFound();
  const { organizationId } = await params;
  const club = await getPrisma().organization.findUnique({
    where: { id: organizationId },
    select: { type: true, name: true, isActive: true },
  });
  if (!club || club.type !== "CLUB" || !club.isActive) notFound();
  const submissions = await listSubmissionsForViewer(viewer, { organizationId });

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Area Coordinator · view only</p>
          <h1 translate="no">{club.name}</h1>
        </div>
      </section>
      <div className="account-page-body club-roster-stack">
        <BackLink href={`/account/area/${organizationId}`}>Back to {club.name}</BackLink>
        <p className="inline-notice" role="status">
          <Eye aria-hidden="true" size={14} /> View only. Health, conduct, physician, emergency-contact and birth-date
          answers show as Restricted.
        </p>
        {submissions.length === 0 ? (
          <p className="quiet-copy">This club has no submitted forms.</p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Submitted forms</caption>
              <thead><tr><th scope="col">Form</th><th scope="col">Member or subject</th><th scope="col">Submitted</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
              <tbody>
                {submissions.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.templateName}</th>
                    <td translate="no">{row.subjectName || "Not named"}</td>
                    <td>{formatDate(row.submittedAt)}</td>
                    <td><Link className="secondary-button" href={`/account/area/${organizationId}/forms/${row.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
