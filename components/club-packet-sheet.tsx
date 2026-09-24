import { CheckSquare, QrCode } from "lucide-react";
import type { ClubPacket } from "@/modules/reporting/club-packet";

const moneyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
function money(cents: number) {
  return moneyFormatter.format(cents / 100);
}

function dateRange(startsOn: string, endsOn: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone }).formatRange(
    new Date(startsOn),
    new Date(endsOn),
  );
}

function calendarDate(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: timeZone === "" ? "UTC" : timeZone }).format(new Date(`${value}T00:00:00Z`));
}

function PacketHeader({ packet, side }: { packet: ClubPacket; side: 1 | 2 }) {
  return (
    <header className="club-packet-header">
      <div>
        <p>{packet.event.conferenceName}</p>
        <h2>{packet.event.name}</h2>
        <p className="club-packet-dates">{dateRange(packet.event.startsOn, packet.event.endsOn, packet.event.timezone)}</p>
      </div>
      <dl>
        {packet.event.earlyBirdDeadline && (
          <div>
            <dt>Early-bird deadline</dt>
            <dd>
              {calendarDate(packet.event.earlyBirdDeadline, packet.event.timezone)}
              {" — "}
              {packet.event.lateRateApplied ? "late rate applied" : "early rate applied"}
            </dd>
          </div>
        )}
        <div><dt>Confirmation</dt><dd translate="no">{packet.club.confirmationCode}</dd></div>
        <div><dt>Side</dt><dd>{side} of 2</dd></div>
      </dl>
    </header>
  );
}

/**
 * The printable club packet (Q1, #411): one letter sheet, printed
 * double-sided, generalizing the retreat group-packet pattern (#155) for a
 * single club. Front is the registration summary and check-in roster; back
 * is camping requirements, assignments, preferences, and the amount billed
 * to the church. No birth dates, no protected free text — flags only.
 */
export function ClubPacketSheet({ packet, qrSrc }: { packet: ClubPacket; qrSrc: string }) {
  const { headcounts } = packet;
  return (
    <article className="club-packet">
      <section className="club-packet-side club-packet-front">
        <PacketHeader packet={packet} side={1} />
        <section className="club-packet-summary">
          <h3>Registration summary</h3>
          <dl>
            <div><dt>Club</dt><dd translate="no">{packet.club.organizationName}</dd></div>
            <div><dt>Sponsoring church</dt><dd translate="no">{packet.club.sponsoringChurch ?? "—"}</dd></div>
            <div><dt>Director</dt><dd translate="no">{packet.club.directorName}</dd></div>
            <div><dt>Director email / phone</dt><dd translate="no">{packet.club.email} · {packet.club.phone}</dd></div>
            <div><dt>Submitted</dt><dd>{packet.club.submittedAt
                ? new Date(packet.club.submittedAt).toLocaleDateString("en-US", { timeZone: packet.event.timezone, month: "short", day: "numeric", year: "numeric" })
                : "—"}</dd></div>
          </dl>
          <div className="club-packet-headcounts">
            <article><strong>{headcounts.pathfinder}</strong><span>Pathfinders</span></article>
            <article><strong>{headcounts.tlt}</strong><span>TLTs</span></article>
            <article><strong>{headcounts.staff}</strong><span>Staff</span></article>
            <article><strong>{headcounts.child}</strong><span>Children</span></article>
            <article className="club-packet-total"><strong>{headcounts.total}</strong><span>Total</span></article>
          </div>
        </section>

        <section className="club-packet-roster">
          <div className="club-packet-roster-heading">
            <h3>Attendee roster · check-in list</h3>
            <p className="club-packet-key">
              <CheckSquare aria-hidden="true" size={12} /> Check in
              &nbsp;·&nbsp;[M] Medical personnel &nbsp;·&nbsp;[MG] Master Guide investiture &nbsp;·&nbsp;⚠ Dietary restriction
            </p>
          </div>
          <ul className="club-packet-roster-columns">
            {packet.attendees.map((attendee) => (
              <li key={attendee.id}>
                <span className="club-packet-check" aria-hidden="true" />
                <span className="club-packet-roster-name" translate="no">
                  {attendee.lastName}, {attendee.firstName}
                  {attendee.medicalPersonnel && " [M]"}
                  {attendee.masterGuideInvestiture && " [MG]"}
                  {attendee.hasDietaryNeed && " ⚠"}
                </span>
                <span className="club-packet-roster-meta">
                  {attendee.roleAbbreviation} · {attendee.ageOnEventDate ?? "—"} · {attendee.gender === "Female" ? "F" : attendee.gender === "Male" ? "M" : "—"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </section>

      <section className="club-packet-side club-packet-back">
        <PacketHeader packet={packet} side={2} />

        <div className="club-packet-back-grid">
          <section>
            <h3>Camping requirements</h3>
            <dl>
              <div><dt>Tents</dt><dd>{packet.camping.tents || "—"}</dd></div>
              <div><dt>Trailers</dt><dd>{packet.camping.trailers || "—"}</dd></div>
              <div><dt>Kitchen canopy</dt><dd>{packet.camping.kitchenCanopy || "—"}</dd></div>
              <div><dt>Total sq ft</dt><dd>{packet.camping.totalSqft || "—"}</dd></div>
              <div><dt>Camp next to</dt><dd translate="no">{packet.camping.campNextTo || "—"}</dd></div>
            </dl>

            <h3>Assignment</h3>
            {packet.assignment ? (
              <dl>
                <div><dt>Campsite</dt><dd translate="no">{[packet.assignment.campsiteLocation, packet.assignment.campsiteNotes].filter(Boolean).join(" · ") || "—"}</dd></div>
                <div><dt>Duty</dt><dd>{[packet.assignment.dutyLabel, packet.assignment.dutyDay, packet.assignment.dutyTime].filter(Boolean).join(" · ") || "—"}</dd></div>
                <div><dt>Activity</dt><dd>{packet.assignment.activityLabel || "—"}</dd></div>
                {packet.assignment.notes && <div><dt>Notes</dt><dd>{packet.assignment.notes}</dd></div>}
              </dl>
            ) : <p className="club-packet-empty">Not yet assigned by staff.</p>}
          </section>

          <section>
            <h3>Duty &amp; activity preferences</h3>
            <ul className="club-packet-checklist">
              {packet.dutyPreferences.dutyAreas.map((item) => <li key={item}><CheckSquare aria-hidden="true" size={12} /> {item}</li>)}
              {packet.dutyPreferences.flagSlots.map((item) => <li key={item}><CheckSquare aria-hidden="true" size={12} /> Flag: {item}</li>)}
              {packet.dutyPreferences.bathroomDays.map((item) => <li key={item}><CheckSquare aria-hidden="true" size={12} /> Bathroom clean-up: {item}</li>)}
              {packet.otherDetails.specialActivities.map((item) => <li key={item}><CheckSquare aria-hidden="true" size={12} /> {item}</li>)}
            </ul>

            <h3>Other details</h3>
            <dl>
              <div><dt>Meal sponsorship</dt><dd>{packet.otherDetails.sponsoringMeals ? `Yes — ${packet.otherDetails.mealSponsorshipCount || "?"} people` : "No"}</dd></div>
              {packet.otherDetails.mealTimes.length > 0 && <div><dt>Sponsored meal times</dt><dd>{packet.otherDetails.mealTimes.join(", ")}</dd></div>}
              <div><dt>Partner club</dt><dd translate="no">{packet.otherDetails.partnerClub || "—"}</dd></div>
              <div><dt>Ribbons</dt><dd>{packet.otherDetails.eventRibbons || "—"}</dd></div>
              <div><dt>Sabbath skit</dt><dd>{packet.otherDetails.sabbathSkit || "—"}</dd></div>
            </dl>
          </section>

          <section>
            <h3>Spiritual milestones</h3>
            <dl>
              <div><dt>Baptism interest</dt><dd>{packet.milestones.baptismNames || "—"}</dd></div>
              <div><dt>Bible read-through</dt><dd>{packet.milestones.bibleNames || "—"}</dd></div>
            </dl>

            <h3>Billing</h3>
            <p className="club-packet-owed">
              Estimated amount billed to the church: <strong translate="no">{money(packet.amountOwedCents)}</strong>
            </p>
          </section>

          <section className="club-packet-qr">
            <h3><QrCode aria-hidden="true" size={15} /> Club check-in QR</h3>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="Club check-in QR pass" height={150} src={qrSrc} width={150} />
          </section>
        </div>
      </section>
    </article>
  );
}
