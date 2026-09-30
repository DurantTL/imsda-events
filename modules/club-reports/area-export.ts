import "server-only";

import { areaPointsCsv, areaSummaryCsv } from "@/modules/club-reports/area-summary-domain";
import { getAreaClubsSummary } from "@/modules/club-reports/area-summary-repository";
import { clubYearFor } from "@/modules/club-rosters/domain";

/** `?year=` for the cross-club views: a club year like "2026-27", else the current one. */
export function resolveAreaClubYear(requested: string | undefined, now = new Date()) {
  return requested && /^\d{4}-\d{2}$/.test(requested) ? requested : clubYearFor(now);
}

/** The CSV download for the coordinator's and the office's cross-club views. Authorize before calling. */
export async function areaExportResponse(url: URL) {
  const clubYear = resolveAreaClubYear(url.searchParams.get("year") ?? undefined);
  const report = url.searchParams.get("report") === "points" ? "points" : "summary";
  const clubs = await getAreaClubsSummary(clubYear, new Date(), { backgroundChecks: false });
  const csv = report === "points" ? areaPointsCsv(clubYear, clubs) : areaSummaryCsv(clubYear, clubs);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="club-${report}-${clubYear}.csv"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
