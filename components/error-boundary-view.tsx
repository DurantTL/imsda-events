"use client";

import Link from "next/link";
import { useEffect } from "react";
import { CircleAlert, RotateCw } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";

/** The existing support contact (same address as the club help card and report-change requests). */
const SUPPORT_EMAIL = "youth@imsda.org";

type ErrorBoundaryViewProps = {
  error: Error & { digest?: string };
  retry: () => void;
  /** "public" adds the site header, because the boundary replaces the page that would have shown it. */
  variant: "public" | "embedded";
};

/**
 * Branded error state for a route segment. It never shows the error's message or
 * digest: the error is only logged to the console for whoever has the browser open.
 */
export function ErrorBoundaryView({ error, retry, variant }: ErrorBoundaryViewProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const card = (
    <section className="app-error-card" role="alert">
      <span className="app-error-icon"><CircleAlert size={30} aria-hidden="true" /></span>
      <p className="eyebrow">Something went wrong</p>
      <h1>This page couldn&apos;t load</h1>
      <p>It&apos;s not your fault. Try again, and if it keeps happening, email the event team.</p>
      <div className="app-error-actions">
        <button className="primary-button app-error-action" onClick={() => retry()} type="button">
          <RotateCw size={16} aria-hidden="true" /> Try again
        </button>
        <a className="app-error-support" href={`mailto:${SUPPORT_EMAIL}`}>Email {SUPPORT_EMAIL}</a>
      </div>
    </section>
  );

  if (variant === "embedded") return card;

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
