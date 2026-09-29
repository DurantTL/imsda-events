import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { CheckInBookSheets } from "@/components/check-in-book";
import { PrintReportButton } from "@/components/print-report-button";
import { checkInBookStatuses, parseCheckInBookStatuses } from "@/modules/reporting/check-in-book";
import { getCheckInBookData } from "@/modules/reporting/check-in-book-repository";
import { resolveClubReportsAccess } from "@/modules/reporting/club-reports-access";

export const metadata: Metadata = { title: "Check-in book" };
export const dynamic = "force-dynamic";

const statusLabels: Record<(typeof checkInBookStatuses)[number], string> = {
  SUBMITTED: "Submitted",
  CONFIRMED: "Confirmed",
  WAITLISTED: "Waitlisted",
  CANCELLED: "Cancelled",
};

/** Staff's paper check-in book (#600): every club (or registration) on its own printed page. */
export default async function CheckInBookPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; status?: string | string[]; extra?: string }>;
}) {
  const { event: requested, status, extra } = await searchParams;
  const { event, allowed } = await resolveClubReportsAccess(requested);
  if (!allowed) {
    return (
      <AccessRestricted
        title="The check-in book is restricted"
        detail="Ask an event administrator for report access, or for Pathfinder event-manager oversight of this club event."
      />
    );
  }
  const statuses = parseCheckInBookStatuses(status);
  const data = await getCheckInBookData(event.id, { statuses, extraFieldKey: extra });
  if (!data) return <AccessRestricted title="Event not found" detail="This event could not be loaded." />;

  const eventQuery = `event=${encodeURIComponent(event.id)}`;
  const downloadParams = new URLSearchParams();
  for (const value of statuses) downloadParams.append("status", value);
  if (data.book.extraColumn) downloadParams.set("extra", data.book.extraColumn.key);

  return (
    <section className="page-stack reports-workspace check-in-book-workspace">
      <div className="page-intro report-page-intro check-in-book-intro">
        <div>
          <p className="eyebrow">Event-day check-in</p>
          <h2>Check-in book</h2>
          <p>One printed page per {data.book.mode === "CLUB" ? "club" : "registration"} for {event.name}, with a box to tick at check-in and the campsite needs on top.</p>
        </div>
        <div className="intro-actions report-actions">
          <Link className="secondary-button" href={`/more/reports/clubs?${eventQuery}`}>Back to club reports</Link>
          <a className="secondary-button report-download" href={`/api/events/${encodeURIComponent(event.id)}/check-in-book?${downloadParams.toString()}`}><Download aria-hidden="true" size={15} /> Download CSV</a>
          <PrintReportButton label="Print the book" />
        </div>
      </div>

      <form className="panel check-in-book-filters" method="get">
        <input type="hidden" name="event" value={event.id} />
        <fieldset>
          <legend>Registration status</legend>
          {checkInBookStatuses.map((value) => (
            <label key={value}>
              <input type="checkbox" name="status" value={value} defaultChecked={statuses.includes(value)} /> {statusLabels[value]}
            </label>
          ))}
        </fieldset>
        <label>
          Extra column
          <select name="extra" defaultValue={data.book.extraColumn?.key ?? ""}>
            <option value="">None</option>
            {data.extraOptions.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
          <small>Medical, dietary, insurance and birth-date answers can&apos;t be chosen.</small>
        </label>
        <button className="secondary-button" type="submit">Apply</button>
      </form>

      <CheckInBookSheets book={data.book} />
    </section>
  );
}
