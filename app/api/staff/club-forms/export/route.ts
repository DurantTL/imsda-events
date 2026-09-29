import { withRequestContext } from "@/lib/request-context";
import { requireStaffViewer } from "@/modules/club-forms/access";
import { clubFormApiError } from "@/modules/club-forms/api-errors";
import { buildClubFormsCsv } from "@/modules/club-forms/csv";

/** Conference staff export submitted forms of one template, non-sensitive columns only (#610). */
async function getHandler(request: Request) {
  try {
    const viewer = await requireStaffViewer();
    const params = new URL(request.url).searchParams;
    const templateKey = params.get("form") ?? "";
    const organizationId = params.get("club") ?? undefined;
    const { csv, filename } = await buildClubFormsCsv(viewer, { templateKey, organizationId });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return clubFormApiError(error, "Exporting club forms");
  }
}

export const GET = withRequestContext(getHandler);
