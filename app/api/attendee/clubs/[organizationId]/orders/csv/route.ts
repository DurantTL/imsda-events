import { withRequestContext } from "@/lib/request-context";
import { adventSourceOrderCsv, pickListCsv, readableOrderCsv } from "@/modules/club-orders/domain";
import { clubOrderApiError } from "@/modules/club-orders/api-errors";
import { getOrderBatch, listOrderList, listPickList } from "@/modules/club-orders/repository";
import { parseExtrasQuery } from "@/modules/club-orders/schemas";
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
 * The order screen's exports (#487): the AdventSource quick-order CSV, a
 * readable order list, or the per-member pick list. `batch` scopes an export
 * to one placed order (what was actually ordered). Without it, the current
 * list is exported with the extras typed on screen applied — passed as
 * `extra=<itemId>:<count>` and checked with the same schema placing the
 * order uses — so the files match the screen exactly. Only an editor's
 * download syncs new needs first; a view-only role exports what's on file.
 */
async function getHandler(request: Request, context: RouteContext) {
  try {
    const { organizationId } = await context.params;
    const access = await requireClubSupplyAccess(organizationId);
    const url = new URL(request.url);
    const view = url.searchParams.get("view");
    const batchId = url.searchParams.get("batch") ?? undefined;
    if (view !== "adventsource" && view !== "readable" && view !== "picklist") {
      return Response.json({ error: "INVALID_VIEW", message: "Choose adventsource, readable, or picklist." }, { status: 400 });
    }
    const extras = parseExtrasQuery(url.searchParams);
    if (!batchId && access.mode === "EDIT") await syncHonorOrderNeeds(organizationId);
    if (view === "picklist") {
      return csvResponse(pickListCsv(await listPickList(organizationId, batchId)), "pick-list.csv");
    }
    const { lines } = batchId
      ? await getOrderBatch(organizationId, batchId)
      : await listOrderList(organizationId, new Map(Object.entries(extras)));
    return view === "adventsource"
      ? csvResponse(adventSourceOrderCsv(lines), "adventsource-order.csv")
      : csvResponse(readableOrderCsv(lines), "order-list.csv");
  } catch (error) {
    return clubOrderApiError(error, "Exporting the order");
  }
}

export const GET = withRequestContext(getHandler);
