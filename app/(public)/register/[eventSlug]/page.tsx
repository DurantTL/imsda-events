import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PublicEventSlugNotFound } from "@/components/public-event-slug-not-found";
import { getPublicEventLanding } from "@/modules/events/public-repository";

export const dynamic = "force-dynamic";

type RegisterEventPageProps = { params: Promise<{ eventSlug: string }> };

export const metadata: Metadata = {
  title: "Event registration",
  robots: { index: false, follow: false },
};

/**
 * /register/<eventSlug> (#569). A real event goes on to its public event page,
 * which lists its open forms; an unknown slug gets a branded page that names
 * it, instead of the generic site 404. The unknown-slug response is
 * deliberately 200 + noindex, not `notFound()`: Next's `not-found.tsx` receives
 * no params, so it cannot show the slug.
 */
export default async function RegisterEventPage({ params }: RegisterEventPageProps) {
  const { eventSlug } = await params;
  const landing = await getPublicEventLanding(eventSlug);
  if (landing) redirect(`/events/${encodeURIComponent(landing.event.slug)}`);
  return <PublicEventSlugNotFound slug={eventSlug} />;
}
