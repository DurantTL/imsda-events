import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
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
      <p className="field-help">
        Health, conduct, physician, emergency-contact and birth-date answers show as Restricted. Forms the conference has since switched off stay listed.
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
    </>
  );
}
