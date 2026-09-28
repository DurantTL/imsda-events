import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { DriverVerificationQueue } from "@/components/driver-verification-queue";
import { clubPortalComplianceStatuses } from "@/modules/background-checks/repository";
import { COMPLIANCE_FILTER_VALUES, type ComplianceFilterValue } from "@/modules/background-checks/domain";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";
import { honorSummaryByMemberId } from "@/modules/honors/member-honor-domain";
import { listClubHonorsPage } from "@/modules/honors/member-honor-repository";

export const metadata: Metadata = { title: "Club roster" };
export const dynamic = "force-dynamic";

function complianceFilterFrom(value: string | undefined): ComplianceFilterValue | null {
  return COMPLIANCE_FILTER_VALUES.find((allowed) => allowed === value) ?? null;
}

export default async function ClubRosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ compliance?: string }>;
}) {
  const [{ organizationId }, { compliance: complianceParam }] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const clubYear = clubYearFor(new Date());
  // Status only, never the note, and only for a director or deputy: this is the club's own page (#427).
  const [members, complianceStatuses, honorRows] = await Promise.all([
    listRoster(organizationId, clubYear),
    clubPortalComplianceStatuses(organizationId, clubYear, access.capabilities),
    listClubHonorsPage(organizationId, clubYear),
  ]);
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>
      <p className="quiet-copy">
        <a href={`/account/clubs/${organizationId}/roster/export`}>Build a roster export</a> for an outside camporee.
      </p>
      <ClubRosterWorkspace
        canSeeBirthDates={access.capabilities.seeBirthDates}
        clubYear={clubYear}
        complianceFilter={complianceFilterFrom(complianceParam)}
        complianceStatuses={complianceStatuses}
        honorSummaries={honorSummaryByMemberId(honorRows)}
        honorsHref={`/account/clubs/${organizationId}/honors`}
        initialMembers={members}
        organizationId={organizationId}
      />
      {/* Willing drivers, for review (#491): the same leader-only capability that manages the club's team. */}
      {access.capabilities.manageTeam && (
        <DriverVerificationQueue
          clearEndpointBase={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/driver-verification`}
          listEndpoint={`/api/attendee/clubs/${encodeURIComponent(organizationId)}/driver-verification`}
        />
      )}
    </>
  );
}
