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

/**
 * A link inside a NOTICE card may also be a mailto: address, so "email the
 * office" works without a separate page. Nothing else is accepted: no
 * `javascript:`, `data:`, or protocol-relative value.
 */
const mailtoSchema = z.string().max(500).refine((value) => {
  if (!/^mailto:/i.test(value)) return false;
  const address = value.slice("mailto:".length).split("?")[0];
  return z.email().safeParse(address).success && !/[\s<>"']/.test(value);
}, "Enter a complete mailto: address such as mailto:office@example.org.");

const linkUrlSchema = z.union([externalUrlSchema, mailtoSchema]);

const httpsOnlySchema = z.string().refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
});

/**
 * The only way a stored link becomes an href. Anything that is not http(s) or
 * a well-formed mailto: address yields null, so a bad value that somehow
 * reached the database still cannot render as a clickable `javascript:` link.
 */
export function safeContentHref(value: string | null | undefined): string | null {
  if (!value) return null;
  return linkUrlSchema.safeParse(value).success ? value : null;
}

export const eventContentLinkInputSchema = z.object({
  label: z.string().trim().min(1, "Give the link a label.").max(80),
  description: z.string().trim().max(120).default(""),
  url: z.union([z.literal(""), linkUrlSchema]).nullable().optional()
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

export const eventContentKinds = ["RICH_TEXT", "RESOURCE_LINKS", "NOTICE", "STEPS", "CHECKLIST"] as const;
export const eventContentTones = ["INFO", "DEADLINE", "REQUIREMENT", "SUCCESS", "HELP"] as const;
export const eventContentPlacements = ["PUBLIC_PAGE", "REGISTRATION_FORM", "BOTH"] as const;

export type EventContentKind = (typeof eventContentKinds)[number];
export type EventContentTone = (typeof eventContentTones)[number];
export type EventContentPlacement = (typeof eventContentPlacements)[number];

/** The kinds that render as info cards rather than page prose or tiles. */
export function isInfoCardKind(kind: EventContentKind) {
  return kind === "NOTICE" || kind === "STEPS" || kind === "CHECKLIST";
}

/** One step or checklist entry. Plain text, like everything else here. */
export const eventContentItemSchema = z.object({
  title: z.string().trim().min(1, "Give each entry a short title.").max(120),
  text: z.string().trim().max(600).default(""),
}).strict();

export type EventContentItem = z.infer<typeof eventContentItemSchema>;

/**
 * Reads the stored JSON back into items. Lenient on purpose: a malformed row
 * shows nothing rather than failing the whole public page.
 */
export function parseEventContentItems(value: unknown): EventContentItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = eventContentItemSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export const eventContentSectionInputSchema = z.object({
  kind: z.enum(eventContentKinds),
  title: z.string().trim().min(2, "Give the section a heading.").max(120),
  body: z.string().trim().max(8000).default(""),
  tone: z.enum(eventContentTones).nullable().optional(),
  placement: z.enum(eventContentPlacements).default("PUBLIC_PAGE"),
  items: z.array(eventContentItemSchema).max(20).default([]),
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
  if (value.kind === "NOTICE" && !value.body && value.links.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["body"],
      message: "Add some text or a link, or the notice would publish an empty card.",
    });
  }
  if (value.kind === "NOTICE" && !value.tone) {
    context.addIssue({
      code: "custom",
      path: ["tone"],
      message: "Choose what kind of notice this is.",
    });
  }
  if ((value.kind === "STEPS" || value.kind === "CHECKLIST") && value.items.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: value.kind === "STEPS"
        ? "Add at least one step, or the card would publish empty."
        : "Add at least one item, or the card would publish empty.",
    });
  }
  // Notices are https or mailto only; plain http is refused there.
  if (value.kind === "NOTICE" && value.links.some((link) => (
    link.url && !/^mailto:/i.test(link.url) && !httpsOnlySchema.safeParse(link.url).success
  ))) {
    context.addIssue({
      code: "custom",
      path: ["links"],
      message: "Notice links must start with https:// or mailto:.",
    });
  }
  // mailto: belongs to notices only; resource tiles stay http(s) or a file.
  if (value.kind !== "NOTICE" && value.links.some((link) => link.url && /^mailto:/i.test(link.url))) {
    context.addIssue({
      code: "custom",
      path: ["links"],
      message: "Email links are only available on notices. Use a web address here.",
    });
  }
  // Only the public page has a place for the two older kinds.
  if (!isInfoCardKind(value.kind) && value.placement !== "PUBLIC_PAGE") {
    context.addIssue({
      code: "custom",
      path: ["placement"],
      message: "Only info cards can be placed on the registration form.",
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

export type EventContentBlock =
  | { kind: "PARAGRAPH"; text: string }
  | { kind: "UNORDERED_LIST"; items: string[] }
  | { kind: "ORDERED_LIST"; items: Array<{ value: number; text: string }> };

/**
 * Segments stored plain text into readable blocks without accepting markup.
 *
 * Each non-empty authored line remains visually distinct. Consecutive bullet
 * or numbered lines become semantic lists, while React still escapes every
 * string at render time.
 */
export function contentBlocks(body: string): EventContentBlock[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: EventContentBlock[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    const unorderedItem = line.match(/^[-*•]\s+(.+)$/);
    if (unorderedItem) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^[-*•]\s+(.+)$/);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ kind: "UNORDERED_LIST", items });
      continue;
    }

    const orderedItem = line.match(/^(\d+)[.)]\s+(.+)$/);
    if (orderedItem) {
      const items: Array<{ value: number; text: string }> = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^(\d+)[.)]\s+(.+)$/);
        if (!match) break;
        items.push({ value: Number(match[1]), text: match[2].trim() });
        index += 1;
      }
      blocks.push({ kind: "ORDERED_LIST", items });
      continue;
    }

    blocks.push({ kind: "PARAGRAPH", text: line });
    index += 1;
  }

  return blocks;
}
