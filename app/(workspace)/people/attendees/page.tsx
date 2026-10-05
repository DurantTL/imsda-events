import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { staffPageTitles } from "@/components/staff-navigation";
import { resolveEventContext } from "@/modules/events/selection";
import { isClubAudienceEvent } from "@/modules/events/repository";
import { listRegistrations } from "@/modules/registrations/repository";
import {
  LISTING_COLUMNS,
  LISTING_STATUSES,
  MEAL_CATEGORIES,
  attendeeListingParams,
  canViewDietaryDetails,
  buildAttendeeListingRows,
  filterAttendeeListing,
  mealTotals,
  parseAttendeeListingQuery,
  type AttendeeListingQuery,
} from "@/modules/registrations/attendee-listing";

export const metadata: Metadata = { title: staffPageTitles.attendeeList };

const STATUS_LABELS: Record<string, string> = { CONFIRMED: "Confirmed", SUBMITTED: "Submitted", CANCELLED: "Cancelled" };

export default async function AttendeeListingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const requestedEvent = Array.isArray(params.event) ? params.event[0] : params.event;
  const { event, permissions } = await resolveEventContext(requestedEvent);
  // Same gate as the registrations list.
  if (!permissions.includes("VIEW_SENSITIVE_DATA")) {
    return <AccessRestricted title="The attendee list is restricted" detail="Your event role does not include access to attendee names, meal and dietary answers, or contact details." />;
  }
  const query = parseAttendeeListingQuery(params);
  const registrations = await listRegistrations(event.id, { statuses: query.statuses });
  // Free-text dietary answers are health-type: the same function gates the CSV.
  const showDietaryDetails = canViewDietaryDetails({ permissions, clubEvent: await isClubAudienceEvent(event.id) });
  const rows = filterAttendeeListing(buildAttendeeListingRows(registrations, { showDietaryDetails }), query);
  const totals = mealTotals(rows);
  const canExport = permissions.includes("VIEW_REPORTS");

  const href = (next: Partial<AttendeeListingQuery>) => {
    const urlParams = attendeeListingParams({ ...query, ...next });
    urlParams.set("event", event.id);
    return `/people/attendees?${urlParams.toString()}`;
  };
  const exportParams = attendeeListingParams(query).toString();
  const exportHref = `/api/events/${encodeURIComponent(event.id)}/exports/attendees${exportParams ? `?${exportParams}` : ""}`;

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">{event.name}</p>
          <h2>{staffPageTitles.attendeeList}</h2>
          <p>One row per attendee, with meal, dietary, childcare and volunteer answers. {rows.length} {rows.length === 1 ? "attendee" : "attendees"} shown.</p>
        </div>
        <div className="intro-actions">
          {canExport && <a className="secondary-button" href={exportHref}><Download aria-hidden="true" size={16} /> Download CSV</a>}
          <Link className="secondary-button" href={`/people?event=${encodeURIComponent(event.id)}`}>Back to Registrations</Link>
        </div>
      </div>

      {!showDietaryDetails && <p className="choice-filter-note" role="note">Dietary details are limited to staff with health access. This list shows only whether an attendee has dietary needs.</p>}

      <section className="panel" aria-label="Meal totals">
        <ul className="choice-filter-counts">
          {totals.filter((total) => (total.value !== "other" && total.value !== "none") || total.count > 0).map((total) => (
            <li key={total.value}><span className="choice-chip muted"><span>{total.label}</span><strong>{total.count}</strong></span></li>
          ))}
        </ul>
      </section>

      <form action="/people/attendees" method="get" className="panel choice-filter-form" aria-label="Filter attendees">
        <input type="hidden" name="event" value={event.id} />
        {query.sort && <input type="hidden" name="sort" value={query.sort} />}
        {query.sort && query.direction === "desc" && <input type="hidden" name="dir" value="desc" />}
        <label>Search<input type="search" name="q" defaultValue={query.search} placeholder="Name or confirmation code" /></label>
        <label>Meal preference
          <select name="meal" defaultValue={query.meal ?? ""}>
            <option value="">All meals</option>
            {MEAL_CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
          </select>
        </label>
        <label><input type="checkbox" name="dietary" value="1" defaultChecked={query.dietaryOnly} /> Has dietary needs</label>
        <fieldset>
          <legend>Registration status</legend>
          {LISTING_STATUSES.map((status) => (
            <label key={status}><input type="checkbox" name="statuses" value={status} defaultChecked={query.statuses.includes(status)} /> {STATUS_LABELS[status]}</label>
          ))}
        </fieldset>
        <button className="secondary-button" type="submit">Apply</button>
        <Link className="text-button" href={`/people/attendees?event=${encodeURIComponent(event.id)}`}>Reset</Link>
      </form>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {LISTING_COLUMNS.map((column) => {
                const active = query.sort === column.key;
                const nextDirection = active && query.direction === "asc" ? "desc" : "asc";
                return (
                  <th key={column.key} scope="col" aria-sort={active ? (query.direction === "asc" ? "ascending" : "descending") : undefined}>
                    <Link href={href({ sort: column.key, direction: nextDirection })}>{column.label}{active ? (query.direction === "asc" ? " ▲" : " ▼") : ""}</Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={LISTING_COLUMNS.length}>No attendees match these filters.</td></tr>}
            {rows.map((row) => (
              <tr key={row.attendeeId}>
                {LISTING_COLUMNS.map((column) => (
                  <td key={column.key}>
                    {column.key === "confirmationCode"
                      ? <Link href={`/people?event=${encodeURIComponent(event.id)}&registration=${encodeURIComponent(row.registrationId)}`}>{row.confirmationCode}</Link>
                      : row[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
