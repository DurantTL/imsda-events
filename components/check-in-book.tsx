import type { CheckInBook } from "@/modules/reporting/check-in-book";

function dateRange(startsOn: string, endsOn: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone }).formatRange(
    new Date(startsOn),
    new Date(endsOn),
  );
}

/**
 * The printable check-in book (#600): a cover page, then one page per club
 * (or registration group), each with the campsite needs on top and a
 * check / didn't-come column. Each page breaks after itself when printed.
 */
export function CheckInBookSheets({ book }: { book: CheckInBook }) {
  const unit = book.mode === "CLUB" ? "clubs" : "registrations";
  const extraLabel = book.extraColumn?.label ?? "";
  return (
    <div className="check-in-book">
      <section className="check-in-book-page check-in-book-cover">
        <p>Check-in book</p>
        <h2>{book.event.name}</h2>
        <p className="check-in-book-dates">{dateRange(book.event.startsOn, book.event.endsOn, book.event.timezone)}</p>
        <dl>
          <div><dt>{book.mode === "CLUB" ? "Clubs" : "Registrations"}</dt><dd>{book.cover.pageCount}</dd></div>
          <div><dt>People</dt><dd>{book.cover.peopleCount}</dd></div>
        </dl>
        <p className="check-in-book-key">✓ here · ✗ didn&apos;t come</p>
      </section>
      {book.pages.length === 0 && <p className="report-empty">No {unit} match these filters.</p>}
      {book.pages.map((page) => (
        <section className="check-in-book-page" key={page.id}>
          <header className="check-in-book-header">
            <h3 translate="no">{page.title}</h3>
            <p translate="no">
              {[page.church, page.contactName, page.phone, page.email].filter(Boolean).join(" · ") || "—"}
            </p>
            {page.camping && (
              <p className="check-in-book-camping">
                <span><strong>Kitchen:</strong> {page.camping.kitchen}</span>
                <span><strong>Tents:</strong> {page.camping.tents}</span>
              </p>
            )}
          </header>
          <table>
            <thead>
              <tr>
                <th scope="col" className="check-in-book-check">Check In</th>
                <th scope="col">Attendee</th>
                <th scope="col">Role</th>
                <th scope="col">Age</th>
                {book.extraColumn && <th scope="col">{extraLabel}</th>}
              </tr>
            </thead>
            <tbody>
              {page.attendees.map((attendee) => (
                <tr key={attendee.id}>
                  <td className="check-in-book-check"><span className="check-in-book-box" aria-hidden="true" /></td>
                  <th scope="row" translate="no">{attendee.name}</th>
                  <td>{attendee.role}</td>
                  <td>{attendee.age ?? ""}</td>
                  {book.extraColumn && <td>{attendee.extra}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <footer>✓ here · ✗ didn&apos;t come{book.mode === "CLUB" ? " · PF Pathfinder · Stf Staff · Ch Child" : ""}</footer>
        </section>
      ))}
    </div>
  );
}
