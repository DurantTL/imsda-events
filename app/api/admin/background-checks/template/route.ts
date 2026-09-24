import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { sterlingCsvTemplate } from "@/modules/background-checks/domain";
import { withRequestContext } from "@/lib/request-context";

/** The Sterling Volunteers CSV template (#388). */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    return new Response(sterlingCsvTemplate(), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="background-checks-template.csv"',
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return backgroundCheckApiError(error, "Downloading the background check template");
  }
}

export const GET = withRequestContext(getHandler);
