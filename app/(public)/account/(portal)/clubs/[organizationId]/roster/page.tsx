import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { ClubTransfersPanel, RequestTransferButton } from "@/components/club-transfers-panel";
import { DriverVerificationQueue } from "@/components/driver-verification-queue";
import { clubPortalComplianceStatuses } from "@/modules/background-checks/repository";
import { COMPLIANCE_FILTER_VALUES, type ComplianceFilterValue } from "@/modules/background-checks/domain";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { clubYearChoices } from "@/modules/club-imports/domain";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";
import { listTransferClubOptions } from "@/modules/club-transfers/repository";
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
  searchParams: Promise<{ compliance?: string; year?: string }>;
}) {
  const [{ organizationId }, { compliance: complianceParam, year: yearParam }] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const currentClubYear = clubYearFor(new Date());
  // The previous or next club year can be opened with ?year= (the club import links here, #541).
  const clubYear = clubYearChoices().find((year) => year === yearParam) ?? currentClubYear;
  // Status only, never the note, and only for a director or deputy: this is the club's own page (#427).
  // Transfers (#489) are the same leader-only capability that manages the club's team.
  const canTransfer = access.capabilities.manageTeam;
  const [members, complianceStatuses, honorRows, clubOptions] = await Promise.all([
    listRoster(organizationId, clubYear),
    clubPortalComplianceStatuses(organizationId, clubYear, access.capabilities),
    listClubHonorsPage(organizationId, clubYear),
    canTransfer ? listTransferClubOptions(organizationId) : Promise.resolve([]),
  ]);
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>
      <p className="quiet-copy">
        <a href={`/account/clubs/${organizationId}/roster/export`}>Build a roster export</a> for an outside camporee.
      </p>
      {clubYear !== currentClubYear && (
        <p className="inline-notice" role="status">
          Showing the {clubYear} roster. <a href={`/account/clubs/${organizationId}/roster`}>Back to {currentClubYear}</a>. New people are added to {currentClubYear}.
        </p>
      )}
      <ClubRosterWorkspace
        canSeeBirthDates={access.capabilities.seeBirthDates}
        clubYear={clubYear}
        complianceFilter={complianceFilterFrom(complianceParam)}
        complianceStatuses={complianceStatuses}
        headingActions={canTransfer ? <RequestTransferButton clubOptions={clubOptions} organizationId={organizationId} /> : undefined}
        honorSummaries={honorSummaryByMemberId(honorRows)}
        honorsHref={`/account/clubs/${organizationId}/honors`}
        initialMembers={members}
        organizationId={organizationId}
      />
      {canTransfer && <ClubTransfersPanel organizationId={organizationId} />}
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
