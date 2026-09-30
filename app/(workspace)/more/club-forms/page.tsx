import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { BackLink } from "@/components/back-link";
import { resolveStaffViewer } from "@/modules/club-forms/access";
import { listSubmissionsForViewer } from "@/modules/club-forms/submissions";
import { listClubFormTemplateNames } from "@/modules/club-forms/templates";
import { listClubsForArea } from "@/modules/organizations/area-coordinators";
import { staffPageTitles } from "@/components/staff-navigation";

export const metadata: Metadata = { title: staffPageTitles.clubForms };
export const dynamic = "force-dynamic";

function formatDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}

/**
 * Submitted club forms across clubs, for conference staff (#610), with a CSV
 * of the non-sensitive columns. Sensitive answers open only for staff with
 * VIEW_SENSITIVE_DATA, and every such view is audited.
 */
export default async function StaffClubFormsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; form?: string; club?: string }>;
}) {
  const { event, form, club } = await searchParams;
  const viewer = await resolveStaffViewer();
  if (!viewer) {
    return <AccessRestricted detail="Club forms are for system administrators and Event Admins of a current event." title="Club forms are restricted" />;
  }
  const [templates, clubs, submissions] = await Promise.all([
    listClubFormTemplateNames(),
    listClubsForArea(),
    listSubmissionsForViewer(viewer, { templateKey: form || undefined, organizationId: club || undefined }),
  ]);
  const eventQuery = event ? `?event=${encodeURIComponent(event)}` : "";
  const exportHref = form
    ? `/api/staff/club-forms/export?form=${encodeURIComponent(form)}${club ? `&club=${encodeURIComponent(club)}` : ""}`
    : null;

  return (
    <section className="page-stack">
      <BackLink href={`/more${eventQuery}`} variant="staff">Back to More</BackLink>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Conference staff</p>
          <h2 className="duplicate-page-title">{staffPageTitles.clubForms}</h2>
          <p>
            Submitted forms by club. You can read health, conduct, physician and emergency-contact answers; each time
            you open a form that has them, it is recorded.{" "}
            {viewer.systemAdmin
              ? "As a system administrator you can also read birth dates."
              : "Birth dates show as Restricted: only the club's own director and deputies and system administrators can read them."}
          </p>
        </div>
      </div>
      <section className="panel">
        <form action="/more/club-forms" className="club-form-filter" method="get">
          {event && <input name="event" type="hidden" value={event} />}
          <label>Form
            <select defaultValue={form ?? ""} name="form">
              <option value="">All forms</option>
              {templates.map((template) => <option key={template.key} value={template.key}>{template.name}{template.enabled ? "" : " (off)"}</option>)}
            </select>
          </label>
          <label>Club
            <select defaultValue={club ?? ""} name="club">
              <option value="">All clubs</option>
              {clubs.map((choice) => <option key={choice.organizationId} value={choice.organizationId}>{choice.name}</option>)}
            </select>
          </label>
          <button className="secondary-button" type="submit">Filter</button>
          {exportHref
            ? <a className="secondary-button" href={exportHref}><Download aria-hidden="true" size={14} /> Download CSV (non-sensitive columns)</a>
            : <small className="field-help">Choose one form to download its CSV.</small>}
        </form>
        {submissions.length === 0 ? (
          <p className="quiet-copy">No submitted forms match.</p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Submitted club forms</caption>
              <thead>
                <tr><th scope="col">Club</th><th scope="col">Form</th><th scope="col">Member or subject</th><th scope="col">Submitted</th><th scope="col">Entered</th><th scope="col"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody>
                {submissions.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" translate="no">{row.organizationName}</th>
                    <td>{row.templateName}</td>
                    <td translate="no">{row.subjectName || "Not named"}</td>
                    <td>{formatDate(row.submittedAt)}</td>
                    <td>{row.enteredVia === "LINK" ? "Private link" : "Club director"}</td>
                    <td><Link className="secondary-button" href={`/more/club-forms/${row.id}${eventQuery}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
