import { withRequestContext } from "@/lib/request-context";
import { clubSupplyApiError } from "@/modules/club-supplies/api-errors";
import { clubSupplyCsvTemplate } from "@/modules/club-supplies/catalog-csv";
import { requireSystemAdministrator } from "@/modules/organizations/access";

/** The club supply catalog CSV template (#531). */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    return new Response(clubSupplyCsvTemplate(), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="club-supply-catalog-template.csv"',
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return clubSupplyApiError(error, "Downloading the club supply template");
  }
}

export const GET = withRequestContext(getHandler);
