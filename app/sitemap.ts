import type { MetadataRoute } from "next";
import { listPublicEventSitemapEntries } from "@/modules/events/public-repository";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const events = await listPublicEventSitemapEntries();
  return events.map((event) => ({
    url: `${baseUrl}/events/${encodeURIComponent(event.slug)}`,
    lastModified: event.updatedAt,
    changeFrequency: "weekly",
    priority: 0.8,
  }));
}
