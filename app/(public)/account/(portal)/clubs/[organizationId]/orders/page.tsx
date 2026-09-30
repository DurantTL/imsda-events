import type { Metadata } from "next";
import { ClubOrderWorkspace } from "@/components/club-order-workspace";
import { loadOrderWorkspace } from "@/modules/club-orders/repository";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";
import { listClubStock } from "@/modules/club-supplies/repository";
import { syncHonorOrderNeeds } from "@/modules/honors/order-source";
import { loadUniformWorkspace } from "@/modules/uniforms/order-source";

export const metadata: Metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

/**
 * A club's Orders screen (#487, #497, #654): the order helper list (honors,
 * uniforms, other supplies) and the club's supplies on hand. Opens on the
 * roster's own gate: a director or deputy edits the list, records uniform
 * needs, hands out and records stock; a registrar views.
 */
export default async function ClubOrdersPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  // An editor's visit records new completions as needs (ones on file are
  // skipped); a registrar's view-only visit reads what's on file and never writes.
  if (access.capabilities.manageTeam) await syncHonorOrderNeeds(organizationId);
  // Uniforms load first: an editor's load drops departed members' NEEDED uniform needs (#497).
  const uniforms = await loadUniformWorkspace(organizationId, { forEditing: access.capabilities.manageTeam });
  return (
    <>
      <ClubOrderWorkspace
        initial={await loadOrderWorkspace(organizationId)}
        initialUniforms={uniforms}
        stock={await listClubStock(organizationId)}
        organizationId={organizationId}
        printHref={`/account/clubs/${organizationId}/orders/print`}
        readOnly={!access.capabilities.manageTeam}
      />
    </>
  );
}
