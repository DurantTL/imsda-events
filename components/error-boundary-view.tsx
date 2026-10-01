"use client";

import Link from "next/link";
import { useEffect } from "react";
import { CircleAlert, RotateCw } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { DEFAULT_CLUB_HELP_EMAIL } from "@/modules/event-info-cards/help-email";

const SUPPORT_EMAIL = DEFAULT_CLUB_HELP_EMAIL;

type ErrorBoundaryViewProps = {
  error: Error & { digest?: string };
  retry: () => void;
  /**
   * "public" adds the site header, because the boundary replaces the page that would have shown it.
   * "portal" sits inside the account portal's header and is the page's only h1.
   * "workspace" sits inside the staff shell, which already has an h1, so it uses an h2.
   */
  variant: "public" | "portal" | "workspace";
};

/**
 * Branded error state for a route segment. It never shows the error's message or
 * digest: the error is only logged to the console for whoever has the browser open.
 */
export function ErrorBoundaryView({ error, retry, variant }: ErrorBoundaryViewProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const Heading = variant === "workspace" ? "h2" : "h1";
  const card = (
    <section className="app-error-card" role="alert">
      <span className="app-error-icon"><CircleAlert size={30} aria-hidden="true" /></span>
      <p className="eyebrow">Something went wrong</p>
      <Heading>This page couldn&apos;t load</Heading>
      <p>It&apos;s not your fault. Try again, and if it keeps happening, email the IMSDA youth office.</p>
      <div className="app-error-actions">
        <button className="primary-button app-error-action" onClick={() => retry()} type="button">
          <RotateCw size={16} aria-hidden="true" /> Try again
        </button>
        <a className="app-error-support" href={`mailto:${SUPPORT_EMAIL}`}>Email the IMSDA youth office at {SUPPORT_EMAIL}</a>
      </div>
    </section>
  );

  if (variant !== "public") return card;

  return (
    <main className="public-registration-page public-event-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
        </div>
      </header>
      {card}
    </main>
  );
}
