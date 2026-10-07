import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { OrganizationDirectoryWorkspace } from "@/components/organization-directory-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { getOrganizationSummary, listChurchOptions, listOrganizationsPage } from "@/modules/organizations/repository";
import { cleanSearchQuery, parsePageParam } from "@/modules/organizations/search";

export const metadata: Metadata = { title: "Clubs and churches" };

const statuses = ["ACTIVE", "INACTIVE"] as const;

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<{ kind?: string; status?: string; q?: string; page?: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const params = await searchParams;
  const kind = params.kind === "CHURCH" || params.kind === "CLUB" ? params.kind : null;
  const status = statuses.find((candidate) => candidate === params.status) ?? "ALL";
  const query = cleanSearchQuery(params.q);
  const [list, summary, churchOptions] = await Promise.all([
    listOrganizationsPage({ query, kind, status, page: parsePageParam(params.page) }),
    getOrganizationSummary(),
    listChurchOptions(),
  ]);

  return (
    <>
      <div className="intro-actions club-admin-links">
        <BackLink href="/admin" variant="staff">Back to system administration</BackLink>
        <Link className="secondary-button" href="/admin/clubs/import">Import clubs</Link>
        <Link className="secondary-button" href="/admin/organizations/directory">Organization directory</Link>
        <Link className="secondary-button" href="/admin/organizations/import">Import from eAdventist</Link>
        <Link className="secondary-button" href="/admin/clubs/invites">Club invites</Link>
        <Link className="secondary-button" href="/admin/clubs/reports">Monthly reports</Link>
        <Link className="secondary-button" href="/admin/clubs/summary">Club summary</Link>
        <Link className="secondary-button" href="/admin/clubs/transfers">Member transfers</Link>
        <Link className="secondary-button" href="/admin/organizations/background-checks">Sterling Volunteers</Link>
      </div>
      <OrganizationDirectoryWorkspace
        churchOptions={churchOptions}
        filters={{ q: query, kind: kind ?? "", status }}
        organizations={list.organizations}
        page={list.page}
        pageSize={list.pageSize}
        summary={summary}
        total={list.total}
      />
    </>
  );
}
