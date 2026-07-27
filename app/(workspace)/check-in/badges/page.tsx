import type { Metadata } from "next";
import Link from "next/link";
import { ContactRound, Shirt, Tags } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { PrintReportButton } from "@/components/print-report-button";
import {
  badgeTemplates,
  buildBadgeLabels,
  normalizeBadgeStartingPosition,
  normalizeBadgeTemplate,
  paginateBadgeLabels,
} from "@/modules/checkin/badge-labels";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";

export const metadata: Metadata = {
  title: "Printable name badges",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function PrintableNameBadgesPage({
  searchParams,
}: {
  searchParams: Promise<{
    event?: string;
    template?: string;
    start?: string;
  }>;
}) {
  const query = await searchParams;
  const { event, permissions } = await resolveEventContext(query.event);
  if (!permissions.includes("MANAGE_CHECK_IN")) {
    return (
      <AccessRestricted
        title="Name badge printing is restricted"
        detail="Only event administrators and check-in staff can print attendee name badges."
      />
    );
  }

  const templateId = normalizeBadgeTemplate(query.template);
  const template = badgeTemplates[templateId];
  const startingPosition = normalizeBadgeStartingPosition(
    query.start,
    template.perSheet,
  );
  const registrations = await listRegistrations(event.id, {
    statuses: activeRegistrationStatuses,
  });
  const labels = buildBadgeLabels(registrations);
  const sheets = paginateBadgeLabels(labels, templateId, startingPosition);
  const missingShirtSizes = labels.filter((label) => !label.shirtSize).length;

  return (
    <section className="page-stack badge-print-page">
      <style>{"@page { size: letter portrait; margin: 0; }"}</style>
      <div className="page-intro badge-print-intro">
        <div>
          <p className="eyebrow">Convention preparation</p>
          <h2>Printable attendee name badges</h2>
          <p>
            Print the active roster for {event.name} on the matching Avery
            product. Use “start at label” when part of the first sheet was
            already used.
          </p>
        </div>
        <div className="intro-actions badge-print-actions">
          <Link
            className="secondary-button"
            href={`/check-in?event=${encodeURIComponent(event.id)}`}
          >
            Back to check-in
          </Link>
          {labels.length > 0 && (
            <PrintReportButton label="Print name badges" />
          )}
        </div>
      </div>

      <form className="panel badge-print-controls" method="get">
        <input name="event" type="hidden" value={event.id} />
        <label>
          <span>Avery product</span>
          <select defaultValue={templateId} name="template">
            {Object.values(badgeTemplates).map((option) => (
              <option key={option.id} value={option.id}>
                {option.product} — {option.label}, {option.perSheet}/sheet
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Start at label</span>
          <select defaultValue={String(startingPosition)} name="start">
            {Array.from({ length: template.perSheet }, (_, index) => index + 1)
              .map((position) => (
                <option key={position} value={position}>
                  {position}{position === 1 ? " — new sheet" : ""}
                </option>
              ))}
          </select>
        </label>
        <button className="primary-button" type="submit">
          Apply layout
        </button>
      </form>

      <div className="badge-print-summary">
        <span><ContactRound aria-hidden="true" size={18} /><strong>{labels.length}</strong> badges</span>
        <span><Tags aria-hidden="true" size={18} /><strong>{sheets.length}</strong> sheets</span>
        <span className={missingShirtSizes > 0 ? "is-warning" : ""}>
          <Shirt aria-hidden="true" size={18} />
          <strong>{missingShirtSizes}</strong> missing shirt sizes
        </span>
        <small>
          {template.product} · {template.dimensions} · {template.perSheet} per sheet
        </small>
      </div>

      {labels.length === 0 ? (
        <div className="empty-state panel">
          <ContactRound aria-hidden="true" size={26} />
          <h3>No badges to print yet</h3>
          <p>Active submitted or confirmed attendees will appear here automatically.</p>
        </div>
      ) : (
        <div className="badge-sheet-stack">
          {sheets.map((sheet, sheetIndex) => (
            <section
              aria-label={`Badge sheet ${sheetIndex + 1}`}
              className={`badge-sheet badge-sheet-${templateId}`}
              key={`sheet-${sheetIndex + 1}`}
            >
              {sheet.map((label, slotIndex) => (
                label ? (
                  <article className="badge-label-card" key={label.attendeeId}>
                    <header>{event.name}</header>
                    <div className="badge-label-name">
                      <strong>{label.firstName}</strong>
                      <strong>{label.lastName}</strong>
                    </div>
                    <p>{label.groupLabel}</p>
                    <footer>
                      <span>{label.attendeeType.toLowerCase()}</span>
                      <span>{label.shirtSize ? `Shirt ${label.shirtSize}` : "Shirt size needed"}</span>
                    </footer>
                  </article>
                ) : (
                  <div
                    aria-hidden="true"
                    className="badge-label-card is-empty"
                    key={`empty-${sheetIndex + 1}-${slotIndex + 1}`}
                  />
                )
              ))}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
