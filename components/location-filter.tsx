import Link from "next/link";
import { MapPin } from "lucide-react";

/**
 * "All locations" plus each location of a multi-location event (#413), for
 * staff views. Plain links, so it works on server-rendered pages and keeps the
 * page's other search parameters. Renders nothing for an event with no
 * locations, which then looks exactly as it always did.
 */
export function LocationFilter({
  basePath,
  locations,
  params = {},
  selectedId,
}: {
  basePath: string;
  locations: Array<{ id: string; name: string; isActive?: boolean }>;
  params?: Record<string, string | undefined>;
  selectedId: string | null;
}) {
  if (locations.length === 0) return null;
  function href(locationId: string | null) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value && key !== "location") query.set(key, value);
    if (locationId) query.set("location", locationId);
    const text = query.toString();
    return text ? `${basePath}?${text}` : basePath;
  }
  return (
    <nav aria-label="Filter by location" className="location-filter">
      <span className="location-filter-label"><MapPin aria-hidden="true" size={14} /> Location</span>
      <Link aria-current={selectedId === null ? "true" : undefined} className={selectedId === null ? "primary-button" : "secondary-button"} href={href(null)}>
        All locations
      </Link>
      {locations.map((location) => (
        <Link
          aria-current={selectedId === location.id ? "true" : undefined}
          className={selectedId === location.id ? "primary-button" : "secondary-button"}
          href={href(location.id)}
          key={location.id}
        >
          {location.name}{location.isActive === false ? " (inactive)" : ""}
        </Link>
      ))}
    </nav>
  );
}
