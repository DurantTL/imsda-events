import { requireSystemAdministrator } from "@/modules/organizations/access";
import { backgroundCheckApiError } from "@/modules/background-checks/api-errors";
import { listUnmatchedBackgroundCheckEntries } from "@/modules/background-checks/repository";
import { withRequestContext } from "@/lib/request-context";

/**
 * List entries with no one matched to them yet (#527): still on the current
 * list, visible to staff, matched automatically once that person exists —
 * never guessed. Staff-only.
 */
async function getHandler() {
  try {
    await requireSystemAdministrator();
    const entries = await listUnmatchedBackgroundCheckEntries();
    return Response.json({
      entries: entries.map((entry) => ({
        id: entry.id,
        name: `${entry.firstName} ${entry.lastName}`.trim(),
        site: entry.site,
        complianceStatus: entry.complianceStatus,
        checkedOn: entry.checkedOn,
        expiresOn: entry.expiresOn,
      })),
    });
  } catch (error) {
    return backgroundCheckApiError(error, "Loading unmatched background check entries");
  }
}

export const GET = withRequestContext(getHandler);
