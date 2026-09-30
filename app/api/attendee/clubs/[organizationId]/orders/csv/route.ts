import { withRequestContext } from "@/lib/request-context";
import { orderListCsv, pickListCsv } from "@/modules/club-orders/domain";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { listHelperLines, listPickList, loadOrderExportHeader } from "@/modules/club-orders/repository";
import { requireClubSupplyAccess } from "@/modules/club-supplies/access";
import { syncHonorOrderNeeds } from "@/modules/honors/order-source";

type RouteContext = { params: Promise<{ organizationId: string }> };

function csvResponse(body: string, filename: string) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * The order screen's exports (#487, #654): `view=list` is the helper list
 * (club, church, director contact, date, then every line grouped by section
 * with item name, size, item number and quantity); `view=picklist` is the
 * per-member pick list. The list is read from what's saved, so the file
 * matches the screen. Only an editor's download syncs new needs first; a
 * view-only role exports what's on file.
 */
async function getHandler(request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubSupplyAccess(organizationId);
    const view = new URL(request.url).searchParams.get("view");
    if (view !== "list" && view !== "picklist") {
      return Response.json({ error: "INVALID_VIEW", message: "Choose list or picklist." }, { status: 400 });
    }
    if (access.mode === "EDIT") await syncHonorOrderNeeds(organizationId);
    if (view === "picklist") {
      return csvResponse(pickListCsv(await listPickList(organizationId)), "pick-list.csv");
    }
    const [header, lines] = await Promise.all([loadOrderExportHeader(organizationId), listHelperLines(organizationId)]);
    return csvResponse(orderListCsv(header, lines), "order-list.csv");
  } catch (error) {
    return clubOrderApiError(error, "Exporting the order list");
  }
}

export const GET = withRequestContext(getHandler);
