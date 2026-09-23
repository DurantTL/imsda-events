import type { Metadata } from "next";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";

export const metadata: Metadata = { title: "Club roster" };
export const dynamic = "force-dynamic";

export default async function ClubRosterPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state !== "OPEN") return null;
  const clubYear = clubYearFor(new Date());
  const members = await listRoster(organizationId, clubYear);
  return <ClubRosterWorkspace clubYear={clubYear} initialMembers={members} organizationId={organizationId} />;
}
