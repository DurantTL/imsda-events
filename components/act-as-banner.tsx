import { UserRoundCog } from "lucide-react";
import { StopActingButton } from "@/components/stop-acting-button";
import { getPrisma } from "@/lib/prisma";
import type { StaffActingContext } from "@/modules/organizations/staff-act-as";

/**
 * Shown on every page while a system administrator is "acting as" a club
 * role (#442), in the staff workspace and the /account portal alike, naming
 * the role and offering "Stop acting" for both roles.
 */
export async function ActAsBanner({ acting }: { acting: StaffActingContext | null }) {
  if (!acting) return null;
  const until = acting.expiresAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

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
    <div className="inline-notice act-as-banner" role="status">
      <UserRoundCog aria-hidden="true" size={14} />
      <span>{label}</span>
      <StopActingButton />
    </div>
  );
}
