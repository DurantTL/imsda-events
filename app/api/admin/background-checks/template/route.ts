import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { rosterBackgroundCsvTemplate, sterlingCsvTemplate } from "@/modules/background-checks/domain";
import { withRequestContext } from "@/lib/request-context";

/**
 * The background check CSV template (#388, #427): the real roster export by
 * default, or the older Sterling Volunteers layout with `?format=sterling`.
 */
async function getHandler(request: Request) {
  try {
    await requireSystemAdministrator();
    const sterling = new URL(request.url).searchParams.get("format") === "sterling";
    return new Response(sterling ? sterlingCsvTemplate() : rosterBackgroundCsvTemplate(), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="background-checks-${sterling ? "sterling" : "roster"}-template.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return backgroundCheckApiError(error, "Downloading the background check template");
  }
}

export const GET = withRequestContext(getHandler);
