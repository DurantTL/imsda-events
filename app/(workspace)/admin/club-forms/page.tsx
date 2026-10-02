import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ClubFormCreate } from "@/components/club-form-create";
import { ClubFormSync } from "@/components/club-form-sync";
import { ClubFormTemplateToggle } from "@/components/club-forms-actions";
import { getCurrentSession } from "@/modules/access/current-session";
import { listClubFormTemplatesForAdmin } from "@/modules/club-forms/templates";

export const metadata: Metadata = { title: "Club forms" };
export const dynamic = "force-dynamic";

/**
 * Club forms (#610): each one is off until a system administrator turns it
 * on here. Turning one off hides it from clubs and Area Coordinators; nothing
 * that was filled in is deleted. Each form can be edited in the builder, and new
 * forms created there (#712).
 */
export default async function AdminClubFormsPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const templates = await listClubFormTemplatesForAdmin();

  return (
    <section className="page-stack">
      <Link className="secondary-button more-back-link" href="/admin">Back to system administration</Link>
      <div className="page-intro">
        <div>
          <p className="eyebrow">System administration</p>
          <h2>Club forms</h2>
          <p>
            Forms clubs fill in for their members or send by private link. Every form starts off. A form that is on shows
            in each club&apos;s Forms tab for its director and deputy. Wording that is drafted from the conference&apos;s
            summaries should be checked against the official forms before you turn a form on.
          </p>
          <Link className="secondary-button" href="/more/club-forms">See submitted forms</Link>
        </div>
      </div>
      <ClubFormSync pendingCount={templates.filter((template) => template.needsSync).length} />
      <section className="panel">
        <div className="report-table-wrap">
          <table className="report-table">
            <caption className="sr-only">Club forms</caption>
            <thead>
              <tr><th scope="col">Form</th><th scope="col">Status</th><th scope="col">Filled in</th><th scope="col">Version</th><th scope="col"><span className="sr-only">Change</span></th></tr>
            </thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.key}>
                  <th scope="row">{template.name}<small className="quiet-copy"> · {template.description}</small></th>
                  <td>{template.enabled ? "On" : "Off"}{template.needsSync && <small className="club-report-problem"> · Needs sync: use Sync templates above</small>}</td>
                  <td>{template.submissionCount}</td>
                  <td>
                    {template.version}
                    {template.customized && <small className="quiet-copy"> · Edited in the app; code updates no longer apply</small>}
                    {template.hasDraft && !template.draftStale && <small className="quiet-copy"> · Draft started on version {template.draftBaseVersion ?? template.version}</small>}
                    {template.draftStale && <small className="club-report-problem"> · Draft is stale (started on version {template.draftBaseVersion}); discard it</small>}
                  </td>
                  <td>
                    {template.version > 0 && <Link className="secondary-button" href={`/admin/club-forms/${encodeURIComponent(template.key)}`}>Edit</Link>}{" "}
                    <ClubFormTemplateToggle enabled={template.enabled} name={template.name} needsSync={template.needsSync} templateKey={template.key} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <ClubFormCreate templates={templates.filter((template) => template.version > 0).map((template) => ({ key: template.key, name: template.name }))} />
    </section>
  );
}
