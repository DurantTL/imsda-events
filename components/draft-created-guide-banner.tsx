"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PartyPopper, X } from "lucide-react";
import {
  readDismissedDraftCreatedGuideEventIds,
  shouldShowDraftCreatedGuide,
  urlWithoutCreatedParam,
  withDraftCreatedGuideDismissed,
  writeDismissedDraftCreatedGuideEventIds,
} from "@/components/draft-created-guide";

type DraftCreatedGuideBannerProps = {
  eventId: string;
};

function readLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    // Private browsing or a policy that blocks storage access entirely.
    return undefined;
  }
}

/**
 * One-time "Draft created" handoff shown right after `/more/event-settings`
 * loads with `created=1` (set by the create-event redirect). It points into
 * the existing publish-readiness checklist instead of repeating it, and it
 * never reappears for this event once dismissed (#473).
 */
export function DraftCreatedGuideBanner({ eventId }: DraftCreatedGuideBannerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const createdParam = searchParams.get("created");
  const [dismissedEventIds, setDismissedEventIds] = useState<string[]>(
    () => readDismissedDraftCreatedGuideEventIds(readLocalStorage()),
  );

  const visible = useMemo(
    () => shouldShowDraftCreatedGuide(createdParam, eventId, dismissedEventIds),
    [createdParam, eventId, dismissedEventIds],
  );

  if (!visible) return null;

  function dismiss() {
    const next = withDraftCreatedGuideDismissed(dismissedEventIds, eventId);
    setDismissedEventIds(next);
    writeDismissedDraftCreatedGuideEventIds(readLocalStorage(), next);
    router.replace(
      urlWithoutCreatedParam("/more/event-settings", searchParams.toString()),
    );
  }

  return (
    <div className="draft-created-guide-banner" role="status" data-testid="draft-created-guide-banner">
      <div className="draft-created-guide-banner-head">
        <PartyPopper size={22} aria-hidden="true" />
        <div>
          <p className="eyebrow">Draft created</p>
          <h2>The event is saved as a private draft. Here’s what’s next.</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={dismiss}
          aria-label="Dismiss the draft created guide"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <ol className="draft-created-guide-steps">
        <li>
          <strong>Complete public details.</strong> Fill in the location, dates,
          and public information in the sections below.
        </li>
        <li>
          <strong>Build and test the registration form.</strong>{" "}
          <a href={`/registration-builder?event=${encodeURIComponent(eventId)}`}>
            Open the registration form
          </a>.
        </li>
        <li>
          <strong>Review readiness and publish.</strong>{" "}
          <a href="#event-readiness-panel">Jump to the publish checklist</a>.
        </li>
      </ol>
      <p className="draft-created-guide-footnote">
        New to running an event here? The staff guide at{" "}
        <code>docs/STAFF-EVENT-WORKFLOW.md</code> in the repository walks
        through all seven steps, start to close-out.
      </p>
    </div>
  );
}
