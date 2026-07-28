import { z } from "zod";

/**
 * A resource tile: a flyer, a schedule, a link back to a ministry page.
 *
 * `url` is restricted to http and https. A content field that accepted any
 * scheme would render `javascript:` as an anchor on a public page, which is a
 * cross-site scripting hole wearing a link's clothes.
 */
const externalUrlSchema = z.url().max(500).refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  },
  "Enter a complete http:// or https:// web address.",
);

export const eventContentLinkInputSchema = z.object({
  label: z.string().trim().min(1, "Give the link a label.").max(80),
  description: z.string().trim().max(120).default(""),
  url: z.union([z.literal(""), externalUrlSchema]).nullable().optional()
    .transform((value) => (value ? value : null)),
  assetId: z.union([z.literal(""), z.string().trim().max(40)]).nullable().optional()
    .transform((value) => (value ? value : null)),
}).strict().superRefine((value, context) => {
  // The database carries the same rule as a CHECK. Stating it here too means a
  // staff member gets a sentence rather than a constraint violation.
  if (!value.url && !value.assetId) {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "Point the tile at a web address, or choose an uploaded file.",
    });
  }
  if (value.url && value.assetId) {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "A tile points at one thing: an address or an uploaded file, not both.",
    });
  }
});

export const eventContentSectionInputSchema = z.object({
  kind: z.enum(["RICH_TEXT", "RESOURCE_LINKS"]),
  title: z.string().trim().min(2, "Give the section a heading.").max(120),
  body: z.string().trim().max(8000).default(""),
  isPublished: z.boolean().default(false),
  links: z.array(eventContentLinkInputSchema).max(12).default([]),
}).strict().superRefine((value, context) => {
  if (value.kind === "RICH_TEXT" && !value.body) {
    context.addIssue({
      code: "custom",
      path: ["body"],
      message: "Add some text, or the section would publish an empty heading.",
    });
  }
  if (value.kind === "RESOURCE_LINKS" && value.links.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["links"],
      message: "Add at least one link, or the section would publish an empty row.",
    });
  }
});

/**
 * Whole-page save. Order comes from the array rather than a per-section field,
 * so reordering cannot leave two sections claiming the same position.
 */
export const eventContentInputSchema = z.object({
  sections: z.array(eventContentSectionInputSchema).max(30),
}).strict();

export type EventContentLinkInput = z.infer<typeof eventContentLinkInputSchema>;
export type EventContentSectionInput = z.infer<typeof eventContentSectionInputSchema>;
export type EventContentInput = z.infer<typeof eventContentInputSchema>;

/**
 * Splits stored text into paragraphs for rendering.
 *
 * The body is plain text, never HTML — it reaches a public page, and accepting
 * markup from a form is how a content field becomes an injection point. React
 * escapes each paragraph on the way out.
 */
export function contentParagraphs(body: string) {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}
