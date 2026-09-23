import { requireSystemAdministrator } from "@/modules/organizations/access";
import { honorApiError } from "@/modules/honors/api-errors";
import { honorCsvTemplate } from "@/modules/honors/catalog-csv";
import { withRequestContext } from "@/lib/request-context";

/** The honor catalog CSV template (#385). */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    return new Response(honorCsvTemplate(), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="honor-catalog-template.csv"',
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return honorApiError(error, "Downloading the honor template");
  }
}

export const GET = withRequestContext(getHandler);
