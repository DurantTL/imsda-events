import type { Metadata } from "next";
import Link from "next/link";
import { BackLink } from "@/components/back-link";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * The club portal's exports list (#655). Opens on the roster's own gate, the
 * same as Honors and Class tracking: a registrar reads, nothing here edits.
 */
export default async function ClubExportsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const base = `/account/clubs/${organizationId}/exports`;
  const api = `/api/attendee/clubs/${organizationId}/exports`;
  return (
    <>
      <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>
      <section className="panel" aria-labelledby="club-exports-heading">
        <h2 id="club-exports-heading">Reports</h2>
        <p className="muted">
          Printable reports and CSV downloads for {access.club.name}. They list names, classes, honors and earned items only:
          no birth dates and no health information.
        </p>
        <ul className="plain-list">
          <li>
            <strong>Honors</strong>: each member&apos;s honors with the date earned and the event, plus a count per honor.{" "}
            <Link href={`${base}/honors`}>Open and print</Link> or <a href={`${api}/honors`}>download CSV</a>.
          </li>
          <li>
            <strong>Class tracking</strong>: each member&apos;s class, insignia, event patches, Good Conduct and TLT items, and Master Award progress.{" "}
            <Link href={`${base}/class-tracking`}>Open and print</Link> or <a href={`${api}/class-tracking`}>download CSV</a>.
          </li>
        </ul>
      </section>
    </>
  );
}
