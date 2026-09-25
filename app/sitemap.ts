import type { MetadataRoute } from "next";
import { listPublicEventSitemapEntries } from "@/modules/events/public-repository";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const events = await listPublicEventSitemapEntries();
  return [{
    url: `${baseUrl}/`,
    changeFrequency: "daily" as const,
    priority: 1,
  }, {
    url: `${baseUrl}/calendar`,
    changeFrequency: "daily" as const,
    priority: 0.9,
  }, {
    url: `${baseUrl}/clubs`,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }, ...events.map((event) => ({
    url: `${baseUrl}/events/${encodeURIComponent(event.slug)}`,
    lastModified: event.updatedAt,
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }))];
}
