import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { ClubTransfersPanel, RequestTransferButton } from "@/components/club-transfers-panel";
import { clubPortalComplianceStatuses } from "@/modules/background-checks/repository";
import { COMPLIANCE_FILTER_VALUES, type ComplianceFilterValue } from "@/modules/background-checks/domain";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { registrationReturnTo } from "@/modules/club-registrations/roster-return";
import { rosterYearView } from "@/modules/club-rosters/domain";
import { rosterGuardiansForAccess } from "@/modules/club-rosters/guardians-access";
import { listRoster } from "@/modules/club-rosters/repository";
import { listTransferClubOptions } from "@/modules/club-transfers/repository";
import { honorSummaryByMemberId } from "@/modules/honors/member-honor-domain";
import { listClubHonorsPage } from "@/modules/honors/member-honor-repository";
import { requireHealthViewerForClub } from "@/modules/health-records/access";
import { healthRecordsEnabled } from "@/modules/health-records/flag";
import { healthRecordFlagsForRoster, healthSummariesForMembers } from "@/modules/health-records/repository";

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
  searchParams: Promise<{ compliance?: string; year?: string | string[]; returnTo?: string | string[] }>;
}) {
  const [{ organizationId }, { compliance: complianceParam, year: yearParam, returnTo: returnToParam }] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  // The previous or next club year can be opened with ?year= (#541), read-only:
  // every roster write, the birth-date reveal, and transfers work on the
  // current year, so none of them is offered for another year.
  const { clubYear, currentClubYear, readOnly } = rosterYearView(yearParam);
  // Status only, never the note, and only for a director or deputy: this is the club's own page (#427).
  // Transfers (#489) are the same leader-only capability that manages the club's team.
  const canTransfer = access.capabilities.manageTeam && !readOnly;
  const [members, complianceStatuses, honorRows, clubOptions, guardians] = await Promise.all([
    listRoster(organizationId, clubYear),
    clubPortalComplianceStatuses(organizationId, clubYear, access.capabilities),
    listClubHonorsPage(organizationId, clubYear),
    canTransfer ? listTransferClubOptions(organizationId) : Promise.resolve([]),
    // Guardian contacts (#510): the club's director and deputy only, and only on the current year, where they can be edited.
    readOnly ? Promise.resolve(undefined) : rosterGuardiansForAccess(access, organizationId, clubYear),
  ]);
  // The Health tab (#611): only with the feature on, for the current year, and
  // for the club's own director or deputy. Status and a plain flag, never text.
  const healthTab = healthRecordsEnabled() && !readOnly
    ? await requireHealthViewerForClub(organizationId)
      .then((viewer) => (viewer.kind === "CLUB_LEADER" ? healthSummariesForMembers(viewer, organizationId, members.map((member) => member.id)) : undefined))
      .catch(() => undefined)
    : undefined;
  // Anyone who can see these rows, with no health access, still sees a neutral
  // "Has a health record" marker: one boolean saying a record exists, no text (#611).
  const healthRecordFlags = readOnly ? undefined : await healthRecordFlagsForRoster(organizationId, members.map((member) => member.id)).catch(() => undefined);
  const registrationHref = registrationReturnTo(organizationId, returnToParam);
  return (
    <>
      {registrationHref && <BackLink href={registrationHref}>Back to registration</BackLink>}
      <p className="quiet-copy">
        <a href={`/account/clubs/${organizationId}/roster/export`}>Build a roster export</a> for an outside camporee.
      </p>
      {readOnly && (
        <p className="inline-notice" role="status">
          Showing the {clubYear} roster, read-only. <a href={`/account/clubs/${organizationId}/roster`}>Back to {currentClubYear}</a> to
          add, edit, or remove people.
        </p>
      )}
      {/* Keyed by year, so a client-side year change never keeps the other year's people in the table. */}
      <ClubRosterWorkspace
        key={clubYear}
        classHistoryBase={`/account/clubs/${organizationId}/class-tracking`}
        canSeeBirthDates={access.capabilities.seeBirthDates && !readOnly}
        clubYear={clubYear}
        complianceFilter={complianceFilterFrom(complianceParam)}
        complianceStatuses={complianceStatuses}
        headingActions={canTransfer ? <RequestTransferButton clubOptions={clubOptions} organizationId={organizationId} /> : undefined}
        honorSummaries={honorSummaryByMemberId(honorRows)}
        guardians={guardians}
        healthRecordFlags={healthRecordFlags}
        healthTab={healthTab}
        honorsPopup={{ canRecord: !readOnly }}
        initialMembers={members}
        organizationId={organizationId}
        readOnly={readOnly}
      />
      {canTransfer && <ClubTransfersPanel organizationId={organizationId} />}
    </>
  );
}
