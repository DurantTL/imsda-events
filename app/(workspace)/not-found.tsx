import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";

export const metadata: Metadata = { title: "Not found" };

/**
 * Staff workspace not-found (#470). A `notFound()` call in any staff page
 * (a club, organization, or report that doesn't exist or isn't this
 * event's) renders here, inside the workspace layout and its shell, instead
 * of falling through to the public site's branded 404 (`app/not-found.tsx`).
 *
 * Only `notFound()` calls reach this boundary: an unmatched URL under a staff
 * prefix (for example `/more/nonexistent`) still gets the root not-found
 * page, since Next.js resolves unmatched routes before any route group.
 */
export default function WorkspaceNotFound() {
  return (
    <section className="page-stack">
      <div className="forbidden-state panel">
        <span><SearchX size={26} aria-hidden="true" /></span>
        <p className="eyebrow">Not found</p>
        <h2>We couldn&apos;t find that record</h2>
        <p>It may have been removed, or it may belong to an event your account can&apos;t see. Check the link, or pick the event again from the staff workspace.</p>
        <Link className="secondary-button forbidden-state-action" href="/overview">
          <ArrowLeft size={16} aria-hidden="true" /> Back to staff workspace
        </Link>
      </div>
    </section>
  );
}
