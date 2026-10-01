import { UserRoundCog } from "lucide-react";
import { StopActingButton } from "@/components/stop-acting-button";
import { getPrisma } from "@/lib/prisma";
import { CONFERENCE_TIME_ZONE } from "@/modules/calendar/domain";
import type { StaffActingContext } from "@/modules/organizations/staff-act-as";

/** The act-as end time, in the conference's time zone (never the server's). */
export function actAsEndTime(expiresAt: Date) {
  return expiresAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: CONFERENCE_TIME_ZONE, timeZoneName: "short" });
}

/**
 * The banner's classes: beside the staff workspace's sidebar (#700), in the
 * account portal's 1180px content column (#722), or the plain default.
 */
export function actAsBannerClassName({ inShell = false, inAccount = false }: { inShell?: boolean; inAccount?: boolean }) {
  if (inShell) return "inline-notice act-as-banner act-as-banner-shell";
  if (inAccount) return "inline-notice act-as-banner act-as-banner-account";
  return "inline-notice act-as-banner";
}

/**
 * Shown on every page while a system administrator is "acting as" a club
 * role (#442), in the staff workspace and the /account portal alike, naming
 * the role and offering "Stop acting" for both roles.
 */
export async function ActAsBanner({ acting, inShell = false, inAccount = false }: { acting: StaffActingContext | null; inShell?: boolean; inAccount?: boolean }) {
  if (!acting) return null;
  const until = actAsEndTime(acting.expiresAt);

  let label: string;
  if (acting.role === "CLUB_DIRECTOR" && acting.organizationId) {
    const club = await getPrisma().organization.findUnique({
      where: { id: acting.organizationId },
      select: { name: true },
    });
    label = `Acting as director of ${club?.name ?? "a club"} until ${until}.`;
  } else {
    label = `Acting as an Area Coordinator (view only) until ${until}.`;
  }

  return (
    <div className={actAsBannerClassName({ inShell, inAccount })} role="status">
      <UserRoundCog aria-hidden="true" size={14} />
      <span>{label}</span>
      <StopActingButton />
    </div>
  );
}
