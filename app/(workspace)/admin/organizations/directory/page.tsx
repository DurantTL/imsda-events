import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { OrganizationStatusButton } from "@/components/organization-status-button";
import { getCurrentSession } from "@/modules/access/current-session";
import { disbandedNotice, organizationKindLabels, safeWebsiteHref } from "@/modules/organizations/eadventist-import";
import { DIRECTORY_LIST_LIMIT, listDirectoryOrganizations, type DirectoryStatusFilter } from "@/modules/organizations/eadventist-import-repository";

export const metadata: Metadata = { title: "Organization directory" };

const kinds = Object.keys(organizationKindLabels).filter((kind) => kind !== "CLUB") as Array<keyof typeof organizationKindLabels>;
const statuses: Array<{ value: DirectoryStatusFilter; label: string }> = [
  { value: "ALL", label: "Any status" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "REVIEW", label: "Active, disbanded date on file" },
];

/** Staff list of churches, companies, groups, schools and the rest, by kind and status (#649). */
export default async function OrganizationDirectoryPage({ searchParams }: { searchParams: Promise<{ kind?: string; status?: string; q?: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const params = await searchParams;
  const kind = kinds.find((candidate) => candidate === params.kind) ?? null;
  const status = statuses.find((candidate) => candidate.value === params.status)?.value ?? "ALL";
  const query = (params.q ?? "").slice(0, 80);
  const { organizations, total } = await listDirectoryOrganizations({ kind, status, query });

  return (
    <>
      <div className="intro-actions club-admin-links">
        <BackLink href="/admin/organizations" variant="staff">Back to Clubs and churches</BackLink>
        <Link className="secondary-button" href="/admin/organizations/import">Import from eAdventist</Link>
      </div>
      <section className="panel" aria-labelledby="org-directory-title">
        <p className="eyebrow">Clubs and churches</p>
        <h1 id="org-directory-title">Organization directory</h1>
        <form className="form-grid" method="get">
          <label>Kind
            <select defaultValue={kind ?? ""} name="kind">
              <option value="">All kinds</option>
              {kinds.map((value) => <option key={value} value={value}>{organizationKindLabels[value]}</option>)}
            </select>
          </label>
          <label>Status
            <select defaultValue={status} name="status">
              {statuses.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>Name
            <input defaultValue={query} maxLength={80} name="q" type="search" />
          </label>
          <div className="form-actions"><button className="secondary-button" type="submit">Filter</button></div>
        </form>
        <p className="field-help">
          {total} {total === 1 ? "organization" : "organizations"}{total > DIRECTORY_LIST_LIMIT ? `; showing the first ${DIRECTORY_LIST_LIMIT}. Narrow the filter to see the rest` : ""}.
          Churches, companies and groups that are active appear in registration form church lists; active schools appear in school lists.
        </p>
        <div className="report-table-wrap">
          <table className="report-table">
            <thead><tr><th>Name</th><th>Kind</th><th>Status</th><th>Place</th><th>Parent</th><th>Contact</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {organizations.length === 0 && <tr><td colSpan={7}>No organizations match.</td></tr>}
              {organizations.map((organization) => {
                const notice = disbandedNotice(organization.disbandedOn, organization.isActive);
                const href = safeWebsiteHref(organization.website);
                return (
                  <tr key={organization.id}>
                    <td translate="no">{organization.name}</td>
                    <td>{organizationKindLabels[organization.type]}{organization.sourceOrgType && organization.sourceOrgType !== organizationKindLabels[organization.type] ? <div className="field-help">{organization.sourceOrgType}</div> : null}</td>
                    <td>
                      <span className={`status-chip ${organization.isActive ? "green" : "gold"}`}>{organization.isActive ? "Active" : "Inactive"}</span>
                      {notice && <div className="field-help">{notice}</div>}
                    </td>
                    <td>{[organization.city, organization.state].filter(Boolean).join(", ") || "—"}{organization.district ? <div className="field-help">{organization.district}</div> : null}</td>
                    <td>{organization.parentName ?? "—"}</td>
                    <td>
                      {organization.officePhone ?? ""}
                      {href && <div><a href={href} rel="noopener noreferrer" target="_blank">Website</a></div>}
                    </td>
                    <td><OrganizationStatusButton isActive={organization.isActive} name={organization.name} organizationId={organization.id} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
