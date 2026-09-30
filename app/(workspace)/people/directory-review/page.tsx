import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck, Users } from "lucide-react";
import { AccessRestricted } from "@/components/access-restricted";
import { resolveEventContext } from "@/modules/events/selection";
import { listDirectoryReviewEntries } from "@/modules/forms/directory-review";

export const metadata: Metadata = { title: "Directory review" };

const sourceLabel = { CLUBS_DIRECTORY: "Club", CHURCHES_DIRECTORY: "Church", SCHOOLS_DIRECTORY: "School" } as const;

export default async function DirectoryReviewPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_REGISTRATION")) {
    return (
      <AccessRestricted
        title="Directory review is restricted"
        detail="Only event administrators and registration managers can review clubs and churches that weren't found in the directory."
      />
    );
  }

  const entries = await listDirectoryReviewEntries(event.id);

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Registration integrity</p>
          <h2>Directory review</h2>
          <p>
            Clubs and churches a director couldn&rsquo;t find in the live directory for {event.name}, so they picked
            &ldquo;Not listed&rdquo; and typed the name instead. Nothing here was blocked from registering — this is
            only to help you add the organization or fix a typo.
          </p>
        </div>
        <div className="page-intro-actions">
          <Link className="secondary-button" href={`/people?event=${encodeURIComponent(event.id)}`}>Back to people</Link>
        </div>
      </div>
      {entries.length === 0 ? (
        <section className="panel empty-state">
          <ShieldCheck aria-hidden="true" size={24} />
          <h3>Nothing to review</h3>
          <p>Every club and church answer for this event matched the live directory.</p>
        </section>
      ) : (
        <section className="panel finance-list" aria-label="Not listed club and church answers">
          <div className="finance-row finance-head"><span>Confirmation</span><span>Field</span><span>Typed name</span><span /></div>
          {entries.map((entry, index) => (
            <div className="finance-row" key={`${entry.registrationId}-${entry.fieldLabel}-${index}`}>
              <span><strong>{entry.confirmationCode}</strong></span>
              <span>{sourceLabel[entry.source]} · {entry.fieldLabel}</span>
              <span>{entry.freeText || <em>No name entered</em>}</span>
              <span>
                <Link className="text-button" href={`/people?event=${encodeURIComponent(event.id)}&registration=${encodeURIComponent(entry.registrationId)}`}>
                  <Users aria-hidden="true" size={14} /> Open registration
                </Link>
              </span>
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
