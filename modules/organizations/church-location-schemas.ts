import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).default("");

// A 5-digit ZIP, or a ZIP+4 (12345-6789). Blank is allowed — not every
// church has one entered yet.
const zipPattern = /^\d{5}(-\d{4})?$/;

/**
 * A church's town and, optionally, hand-entered map coordinates (#437).
 * Coordinates are typed in by staff, never geocoded, so both must be given
 * together or both left blank — a lone latitude or longitude can't place a
 * pin. Latitude and longitude are validated to real-world ranges so a typo
 * can't plot a church off the map (or off the planet).
 */
export const churchLocationInputSchema = z.object({
  city: text(120),
  state: text(2),
  zip: z.union([z.literal(""), z.string().trim().regex(zipPattern, "Enter a 5-digit ZIP, or ZIP+4 (12345-6789).")]).default(""),
  latitude: z.number().min(-90, "Latitude must be between -90 and 90.").max(90, "Latitude must be between -90 and 90.").nullable().default(null),
  longitude: z.number().min(-180, "Longitude must be between -180 and 180.").max(180, "Longitude must be between -180 and 180.").nullable().default(null),
}).strict().refine(
  (value) => (value.latitude === null) === (value.longitude === null),
  { message: "Enter both latitude and longitude, or leave both blank.", path: ["latitude"] },
);

export type ChurchLocationInput = z.infer<typeof churchLocationInputSchema>;
