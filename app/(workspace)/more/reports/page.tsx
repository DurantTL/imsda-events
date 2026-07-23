import type { Metadata } from "next";
import Link from "next/link";
import {
  BedDouble,
  Download,
  ListOrdered,
  ShieldCheck,
  UsersRound,
  Utensils,
} from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { PrintReportButton } from "@/components/print-report-button";
import { resolveEventContext } from "@/modules/events/selection";
import type {
  OperationalCountField,
  OperationalReportKind,
  OperationalSeminarField,
} from "@/modules/reporting/operational-reports";
import { getOperationalReport } from "@/modules/reporting/repository";

export const metadata: Metadata = { title: "Operational reports" };

function reportDownloadHref(eventId: string, kind: OperationalReportKind) {
  return `/api/events/${encodeURIComponent(eventId)}/reports?report=${kind}`;
}

function scopeLabel(scope: "REGISTRATION" | "ATTENDEE") {
  return scope === "ATTENDEE" ? "Counted for each attendee" : "Counted once per registration";
}

function displayCount(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function EmptyReport({ children }: { children: React.ReactNode }) {
  return <p className="report-empty">{children}</p>;
}

function CountFields({
  fields,
  emptyCopy,
}: {
  fields: OperationalCountField[];
  emptyCopy: string;
}) {
  if (fields.length === 0) return <EmptyReport>{emptyCopy}</EmptyReport>;
  return (
    <div className="report-field-list">
      {fields.map((field) => (
        <article className="report-field" key={field.id}>
          <div className="report-field-heading">
            <div>
              <h3>{field.label}</h3>
              <p>{scopeLabel(field.scope)}</p>
            </div>
            <span>{displayCount(field.total)} total</span>
          </div>
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">{field.label} counts</caption>
              <thead><tr><th scope="col">Choice or quantity</th><th scope="col">Count</th></tr></thead>
              <tbody>
                {field.counts.map((row) => (
                  <tr key={row.label}><th scope="row">{row.label}</th><td>{displayCount(row.count)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ))}
    </div>
  );
}

function SeminarFields({ fields }: { fields: OperationalSeminarField[] }) {
  if (fields.length === 0) {
    return <EmptyReport>No ranked-choice fields are configured on an active registration form yet.</EmptyReport>;
  }
  return (
    <div className="report-field-list">
      {fields.map((field) => (
        <article className="report-field" key={field.id}>
          <div className="report-field-heading">
            <div>
              <h3>{field.label}</h3>
              <p>{scopeLabel(field.scope)} · highest total interest first</p>
            </div>
            <span>{displayCount(field.totalInterest)} choices</span>
          </div>
          <div className="report-table-wrap">
            <table className="report-table seminar-table">
              <caption className="sr-only">{field.label} ranked interest</caption>
              <thead>
                <tr><th scope="col">Option</th><th scope="col">1st</th><th scope="col">2nd</th><th scope="col">Total interest</th></tr>
              </thead>
              <tbody>
                {field.choices.map((choice) => (
                  <tr key={choice.label}>
                    <th scope="row">{choice.label}</th>
                    <td>{choice.firstChoice}</td>
                    <td>{choice.secondChoice}</td>
                    <td><strong>{choice.totalInterest}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ))}
    </div>
  );
}

export default async function OperationalReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const requested = (await searchParams).event;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("VIEW_REPORTS")) {
    return (
      <AccessRestricted
        title="Reports are restricted"
        detail="Ask an event administrator for report access before viewing attendee or event-choice totals."
      />
    );
  }

  const report = await getOperationalReport(event.id);
  const peopleQuery = `?event=${encodeURIComponent(event.id)}`;
  const summaryCards = [
    {
      label: "Active registrations",
      value: report.summary.activeRegistrations,
      detail: `${report.summary.rosterGroups} named ${report.summary.rosterGroups === 1 ? "group" : "groups"}`,
      tone: "navy",
    },
    {
      label: "Expected people",
      value: report.summary.attendees,
      detail: "Submitted and confirmed only",
      tone: "purple",
    },
    {
      label: "Meal selections",
      value: displayCount(report.summary.mealSelections),
      detail: `${report.meals.length} structured ${report.meals.length === 1 ? "field" : "fields"}`,
      tone: "gold",
    },
    {
      label: "Housing selections",
      value: displayCount(report.summary.housingSelections),
      detail: `${report.housing.length} structured ${report.housing.length === 1 ? "field" : "fields"}`,
      tone: "green",
    },
    {
      label: "Ranked interests",
      value: report.summary.seminarInterests,
      detail: `${report.seminars.length} ranked ${report.seminars.length === 1 ? "field" : "fields"}`,
      tone: "purple",
    },
  ];

  return (
    <section className="page-stack reports-workspace">
      <div className="page-intro report-page-intro">
        <div>
          <p className="eyebrow">Event-day planning</p>
          <h2>Operational reports</h2>
          <p>Live planning totals for {event.name}, organized so a staff member can print them or open each CSV in a spreadsheet.</p>
        </div>
        <div className="intro-actions report-actions">
          <Link className="secondary-button" href={`/more${peopleQuery}`}>Back to More</Link>
          <PrintReportButton />
        </div>
      </div>

      <div className="report-safety-note">
        <ShieldCheck aria-hidden="true" size={19} />
        <p><strong>Safe operational view.</strong> Draft, waitlisted, and cancelled registrations are excluded. Only configured choices and quantities are counted; medical, allergy, accessibility, and special-needs free text is never included.</p>
      </div>

      <section className="report-summary-grid" aria-label="Report summary">
        {summaryCards.map((card) => (
          <article className={`metric-card report-summary-card accent-${card.tone}`} key={card.label}>
            <strong>{card.value}</strong><p>{card.label}</p><small>{card.detail}</small>
          </article>
        ))}
      </section>

      <section className="panel report-panel" id="attendee-roster">
        <div className="section-heading report-section-heading">
          <div className="report-title">
            <span className="report-icon navy"><UsersRound aria-hidden="true" size={19} /></span>
            <div><p className="eyebrow">People</p><h2>Attendee roster by group</h2><p>Uses a club, group, church, congregation, organization, household, or family answer when the form has one.</p></div>
          </div>
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "roster")}><Download aria-hidden="true" size={15} /> Download roster CSV</a>
        </div>
        {report.rosterGroups.length === 0
          ? <EmptyReport>No active attendees are available yet.</EmptyReport>
          : <div className="roster-report-groups">
              {report.rosterGroups.map((group) => (
                <article className="roster-report-group" key={group.id}>
                  <header>
                    <div><h3>{group.label}</h3><p>{group.fieldLabel ? `Grouped by ${group.fieldLabel}` : "No group answer found"}</p></div>
                    <span>{group.attendees.length} {group.attendees.length === 1 ? "person" : "people"}</span>
                  </header>
                  <div className="report-table-wrap">
                    <table className="report-table roster-table">
                      <caption className="sr-only">Attendees in {group.label}</caption>
                      <thead><tr><th scope="col">Attendee</th><th scope="col">Type</th><th scope="col">Registration</th><th scope="col">Account holder</th></tr></thead>
                      <tbody>
                        {group.attendees.map((attendee) => (
                          <tr key={attendee.attendeeId}>
                            <th scope="row">{attendee.lastName}, {attendee.firstName}</th>
                            <td>{attendee.attendeeType}</td>
                            <td><Link className="report-record-link" href={`/people${peopleQuery}&registration=${encodeURIComponent(attendee.registrationId)}`}>{attendee.confirmationCode}</Link></td>
                            <td>{attendee.accountHolderName}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </article>
              ))}
            </div>}
      </section>

      <section className="panel report-panel" id="meal-counts">
        <div className="section-heading report-section-heading">
          <div className="report-title">
            <span className="report-icon gold"><Utensils aria-hidden="true" size={19} /></span>
            <div><p className="eyebrow">Food service</p><h2>Meal and dietary-choice counts</h2><p>Counts structured meal choices and ticket quantities. Free-text dietary and allergy notes stay private.</p></div>
          </div>
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "meals")}><Download aria-hidden="true" size={15} /> Download meal CSV</a>
        </div>
        <CountFields fields={report.meals} emptyCopy="No structured meal or dietary-choice fields are configured on an active registration form yet." />
      </section>

      <section className="panel report-panel" id="housing-counts">
        <div className="section-heading report-section-heading">
          <div className="report-title">
            <span className="report-icon green"><BedDouble aria-hidden="true" size={19} /></span>
            <div><p className="eyebrow">Lodging</p><h2>Housing and lodging counts</h2><p>Shows configured room, cabin, campsite, overnight, and housing selections without exposing private notes.</p></div>
          </div>
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "housing")}><Download aria-hidden="true" size={15} /> Download housing CSV</a>
        </div>
        <CountFields fields={report.housing} emptyCopy="No structured housing or lodging fields are configured on an active registration form yet." />
      </section>

      <section className="panel report-panel" id="seminar-ranking">
        <div className="section-heading report-section-heading">
          <div className="report-title">
            <span className="report-icon purple"><ListOrdered aria-hidden="true" size={19} /></span>
            <div><p className="eyebrow">Program planning</p><h2>Ranked seminar interest</h2><p>Compares first choices, second choices, and total interest for every ranked-choice field.</p></div>
          </div>
          <a className="secondary-button report-download" href={reportDownloadHref(event.id, "seminars")}><Download aria-hidden="true" size={15} /> Download ranking CSV</a>
        </div>
        <SeminarFields fields={report.seminars} />
      </section>
    </section>
  );
}
