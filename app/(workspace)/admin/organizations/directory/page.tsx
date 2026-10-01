import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { OrganizationListPager, OrganizationSearchControls } from "@/components/organization-search-controls";
import { cardCell } from "@/components/table-card-labels";
import { OrganizationStatusButton } from "@/components/organization-status-button";
import { getCurrentSession } from "@/modules/access/current-session";
import { disbandedNotice, organizationKindLabels, safeWebsiteHref } from "@/modules/organizations/eadventist-import";
import { listDirectoryOrganizations, type DirectoryStatusFilter } from "@/modules/organizations/eadventist-import-repository";
import { cleanSearchQuery, parsePageParam } from "@/modules/organizations/search";

export const metadata: Metadata = { title: "Organization directory" };

const kinds = Object.keys(organizationKindLabels).filter((kind) => kind !== "CLUB") as Array<keyof typeof organizationKindLabels>;
const statuses: Array<{ value: DirectoryStatusFilter; label: string }> = [
  { value: "ALL", label: "Any status" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "REVIEW", label: "Active, disbanded date on file" },
];

/** Staff list of churches, companies, groups, schools and the rest, by kind, status and search (#649, #723). */
export default async function OrganizationDirectoryPage({ searchParams }: { searchParams: Promise<{ kind?: string; status?: string; q?: string; page?: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const params = await searchParams;
  const kind = kinds.find((candidate) => candidate === params.kind) ?? null;
  const status = statuses.find((candidate) => candidate.value === params.status)?.value ?? "ALL";
  const query = cleanSearchQuery(params.q);
  const { organizations, total, page, pageSize } = await listDirectoryOrganizations({ kind, status, query, page: parsePageParam(params.page) });
  const state = { q: query, kind: kind ?? "", status };
  const searching = query.trim() !== "" || kind !== null || status !== "ALL";

  return (
    <>
      <div className="intro-actions club-admin-links">
        <BackLink href="/admin/organizations" variant="staff">Back to Clubs and churches</BackLink>
        <Link className="secondary-button" href="/admin/organizations/import">Import from eAdventist</Link>
      </div>
      <section className="page-stack org-directory-page" aria-labelledby="org-directory-title">
        <div className="page-intro">
          <div>
            <p className="eyebrow">Clubs and churches</p>
            <h2 id="org-directory-title">Organization directory</h2>
            <p>
              Churches, companies and groups that are active appear in registration form church lists; active schools appear in school lists.
            </p>
          </div>
        </div>
        <div className="panel org-directory-panel">
          <OrganizationSearchControls
            basePath="/admin/organizations/directory"
            kindOptions={[{ value: "", label: "All kinds" }, ...kinds.map((value) => ({ value, label: organizationKindLabels[value] }))]}
            placeholder="Name, city, code, district or parent"
            searchLabel="Search"
            state={state}
            statusOptions={statuses}
          />
          <p className="org-result-summary" role="status">
            {total} {total === 1 ? "organization" : "organizations"}{searching ? " match" : ""}.
          </p>
          <div className="report-table-wrap">
            <table className="report-table table-cards table-cards-wide org-directory-table" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">Name</th>
                  <th role="columnheader" scope="col">Kind</th>
                  <th role="columnheader" scope="col">Status</th>
                  <th role="columnheader" scope="col">Place</th>
                  <th role="columnheader" scope="col">Parent</th>
                  <th role="columnheader" scope="col">Contact</th>
                  <th role="columnheader" scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {organizations.length === 0 && (
                  <tr role="row"><td colSpan={7} role="cell">
                    {searching ? "No organizations match your search and filters. Try fewer words or clear the filters." : "No organizations yet."}
                  </td></tr>
                )}
                {organizations.map((organization) => {
                  const notice = disbandedNotice(organization.disbandedOn, organization.isActive);
                  const href = safeWebsiteHref(organization.website);
                  const place = [organization.city, organization.state].filter(Boolean).join(", ");
                  const kindLabel = organizationKindLabels[organization.type];
                  const subType = organization.sourceOrgType && organization.sourceOrgType !== kindLabel ? organization.sourceOrgType : null;
                  return (
                    <tr key={organization.id} role="row">
                      <th className="org-cell-name" role="rowheader" scope="row" translate="no">{organization.name}</th>
                      <td {...cardCell("Kind")}>
                        <span className="org-cell-main">{kindLabel}</span>
                        {subType && <span className="org-cell-sub">{subType}</span>}
                      </td>
                      <td {...cardCell("Status")}>
                        <span className={`status-chip ${organization.isActive ? "green" : "gold"}`}>{organization.isActive ? "Active" : "Inactive"}</span>
                        {notice && <span className="org-cell-sub">{notice}</span>}
                      </td>
                      <td {...cardCell("Place")}>
                        <span className="org-cell-main">{place || "—"}</span>
                        {organization.district && <span className="org-cell-sub">District: {organization.district}</span>}
                      </td>
                      <td {...cardCell("Parent")}>{organization.parentName ?? "—"}</td>
                      <td {...cardCell("Contact")}>
                        {organization.officePhone && <span className="org-cell-main">{organization.officePhone}</span>}
                        {href && <a className="org-cell-sub org-cell-link" href={href} rel="noopener noreferrer" target="_blank">Website</a>}
                        {!organization.officePhone && !href && <span className="org-cell-main">—</span>}
                      </td>
                      <td {...cardCell(null)} className="org-cell-actions">
                        <OrganizationStatusButton isActive={organization.isActive} name={organization.name} organizationId={organization.id} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <OrganizationListPager basePath="/admin/organizations/directory" page={page} pageCount={Math.max(1, Math.ceil(total / pageSize))} pageSize={pageSize} state={state} total={total} />
        </div>
      </section>
    </>
  );
}
