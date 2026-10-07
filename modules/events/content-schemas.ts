import { z } from "zod";

import { embedProviders, isValidEmbedId } from "@/modules/events/content-embeds";

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
 * Notice cards use `safeNoticeHref`, which is stricter (https or mailto only).
 */
export function safeContentHref(value: string | null | undefined): string | null {
  if (!value) return null;
  return linkUrlSchema.safeParse(value).success ? value : null;
}

/** Notice cards accept https and well-formed mailto only, matching the save rule. */
export function safeNoticeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  return z.union([httpsOnlySchema, mailtoSchema]).safeParse(value).success ? value : null;
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

export const eventContentKinds = [
  "RICH_TEXT",
  "RESOURCE_LINKS",
  "NOTICE",
  "STEPS",
  "CHECKLIST",
  // #816: blocks for the public event page.
  "HERO",
  "IMAGE",
  "GALLERY",
  "FORMATTED_TEXT",
  "EMBED",
  "FAQ",
  "CUSTOM_HTML",
  "SCHEDULE",
  "SPEAKERS",
  "CONTACT",
  "COUNTDOWN",
] as const;
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

/**
 * The kinds that can also appear at the top of a registration form: the info
 * cards, plus text-only blocks. Everything else (images, embeds, schedules,
 * the countdown, custom HTML) is for the public page only.
 */
export const registrationFormKinds = [
  "NOTICE",
  "STEPS",
  "CHECKLIST",
  "FORMATTED_TEXT",
  "FAQ",
  "CONTACT",
] as const satisfies readonly EventContentKind[];

export function canPlaceOnRegistrationForm(kind: EventContentKind) {
  return (registrationFormKinds as readonly string[]).includes(kind);
}

/** Only a system administrator may create or edit these; enforced on the server. */
export const systemAdminOnlyKinds = ["CUSTOM_HTML"] as const satisfies readonly EventContentKind[];

export function isSystemAdminOnlyKind(kind: EventContentKind) {
  return (systemAdminOnlyKinds as readonly string[]).includes(kind);
}

// --- Per-kind block data (#816) -------------------------------------------
// Everything here is plain text, validated on save and again when read back.
// Images are always an uploaded event file (an asset id), never an address, so
// nothing on the page is hot-linked from another site.

const assetIdSchema = z.string().trim().min(1, "Choose an uploaded image.").max(40);
const altTextSchema = z.string().trim()
  .min(1, "Describe the image for people who cannot see it (alt text).")
  .max(200);
const plainText = (max: number) => z.string().trim().max(max).default("");
const requiredText = (max: number, message: string) => z.string().trim().min(1, message).max(max);

const httpsUrlSchema = externalUrlSchema.refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Use a web address that starts with https://.");

export const heroDataSchema = z.object({
  assetId: assetIdSchema,
  alt: altTextSchema,
  subtitle: plainText(200),
  button: z.object({
    label: requiredText(40, "Give the button a label."),
    target: z.enum(["REGISTER", "URL"]),
    url: z.union([z.literal(""), httpsUrlSchema]).nullable().optional()
      .transform((value) => (value ? value : null)),
  }).strict().superRefine((button, context) => {
    if (button.target === "URL" && !button.url) {
      context.addIssue({ code: "custom", path: ["url"], message: "Enter the web address the button opens." });
    }
  }).nullable().default(null),
  /** Where the photo stays centred when it is cropped, as a percentage. */
  focalX: z.number().int().min(0).max(100).default(50),
  focalY: z.number().int().min(0).max(100).default(50),
  /** How dark the overlay behind the title is, as a percentage. */
  overlay: z.number().int().min(0).max(80).default(40),
}).strict();

export const imageDataSchema = z.object({
  assetId: assetIdSchema,
  alt: altTextSchema,
  caption: plainText(300),
  /** Which side the image sits on when there is text beside it. */
  imageSide: z.enum(["LEFT", "RIGHT"]).default("LEFT"),
}).strict();

export const galleryImageSchema = z.object({
  assetId: assetIdSchema,
  alt: altTextSchema,
  caption: plainText(300),
}).strict();
export const galleryDataSchema = z.object({
  images: z.array(galleryImageSchema).min(1, "Add at least one image.").max(24),
}).strict();

export const embedDataSchema = z.object({
  provider: z.enum(embedProviders),
  id: z.string().trim().max(1600),
  /** Announced by screen readers for the frame. */
  title: requiredText(120, "Give the frame a short title for screen readers."),
}).strict().superRefine((value, context) => {
  if (!isValidEmbedId(value.provider, value.id)) {
    context.addIssue({
      code: "custom",
      path: ["id"],
      message: "That is not a valid id for this provider. Paste the video or map link again.",
    });
  }
});

export const faqDataSchema = z.object({
  entries: z.array(z.object({
    question: requiredText(200, "Write the question."),
    answer: requiredText(1500, "Write the answer."),
  }).strict()).min(1, "Add at least one question.").max(30),
}).strict();

export const scheduleDataSchema = z.object({
  rows: z.array(z.object({
    day: requiredText(40, "Give each row a day."),
    time: requiredText(40, "Give each row a time."),
    title: requiredText(150, "Give each row a title."),
    location: plainText(100),
    description: plainText(400),
  }).strict()).min(1, "Add at least one row.").max(80),
}).strict();

export const speakerSchema = z.object({
  name: requiredText(80, "Give each speaker a name."),
  role: plainText(100),
  bio: plainText(600),
  assetId: z.union([z.literal(""), assetIdSchema]).nullable().optional()
    .transform((value) => (value ? value : null)),
  alt: plainText(200),
}).strict().superRefine((speaker, context) => {
  if (speaker.assetId && !speaker.alt) {
    context.addIssue({
      code: "custom",
      path: ["alt"],
      message: "Describe the photo for people who cannot see it (alt text).",
    });
  }
});
export const speakersDataSchema = z.object({
  speakers: z.array(speakerSchema).min(1, "Add at least one speaker.").max(40),
}).strict();

const phoneSchema = z.string().trim().max(30)
  .refine((value) => value === "" || /^\+?[0-9][0-9 ().-]{5,24}[0-9]$/.test(value), "Enter a phone number such as (555) 010-0100.");
export const contactDataSchema = z.object({
  contacts: z.array(z.object({
    name: requiredText(80, "Give each contact a name."),
    role: plainText(100),
    email: z.union([z.literal(""), z.email().max(200)]).default(""),
    phone: phoneSchema.default(""),
  }).strict().superRefine((contact, context) => {
    if (!contact.email && !contact.phone) {
      context.addIssue({
        code: "custom",
        path: ["email"],
        message: "Add an email address or a phone number.",
      });
    }
  })).min(1, "Add at least one contact.").max(12),
}).strict();

export const countdownDataSchema = z.object({
  target: z.enum(["EVENT_START", "CUSTOM"]).default("EVENT_START"),
  /** Local date and time in the event's time zone: `YYYY-MM-DDTHH:mm`. */
  customAt: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Choose a date and time.")]).default(""),
  label: plainText(80),
}).strict().superRefine((value, context) => {
  if (value.target === "CUSTOM" && !value.customAt) {
    context.addIssue({ code: "custom", path: ["customAt"], message: "Choose the date and time to count down to." });
  }
});

export type HeroData = z.infer<typeof heroDataSchema>;
export type ImageData = z.infer<typeof imageDataSchema>;
export type GalleryData = z.infer<typeof galleryDataSchema>;
export type EmbedData = z.infer<typeof embedDataSchema>;
export type FaqData = z.infer<typeof faqDataSchema>;
export type ScheduleData = z.infer<typeof scheduleDataSchema>;
export type SpeakersData = z.infer<typeof speakersDataSchema>;
export type ContactData = z.infer<typeof contactDataSchema>;
export type CountdownData = z.infer<typeof countdownDataSchema>;

export type EventBlockDataByKind = {
  HERO: HeroData;
  IMAGE: ImageData;
  GALLERY: GalleryData;
  EMBED: EmbedData;
  FAQ: FaqData;
  SCHEDULE: ScheduleData;
  SPEAKERS: SpeakersData;
  CONTACT: ContactData;
  COUNTDOWN: CountdownData;
};
export type BlockKind = keyof EventBlockDataByKind;

export const blockDataSchemas = {
  HERO: heroDataSchema,
  IMAGE: imageDataSchema,
  GALLERY: galleryDataSchema,
  EMBED: embedDataSchema,
  FAQ: faqDataSchema,
  SCHEDULE: scheduleDataSchema,
  SPEAKERS: speakersDataSchema,
  CONTACT: contactDataSchema,
  COUNTDOWN: countdownDataSchema,
} as const satisfies Record<BlockKind, z.ZodType>;

export function hasBlockData(kind: EventContentKind): kind is BlockKind {
  return Object.prototype.hasOwnProperty.call(blockDataSchemas, kind);
}

/**
 * Reads stored `data` back for rendering. Lenient on purpose, like
 * `parseEventContentItems`: a malformed row yields null and the block is
 * skipped, rather than failing the whole public page.
 */
export function parseBlockData<K extends BlockKind>(kind: K, value: unknown): EventBlockDataByKind[K] | null {
  const parsed = (blockDataSchemas[kind] as z.ZodType).safeParse(value ?? {});
  return parsed.success ? (parsed.data as EventBlockDataByKind[K]) : null;
}

/** The uploaded images a block's data points at, de-duplicated, in order. */
export function blockAssetIds(kind: EventContentKind, data: unknown): string[] {
  if (!hasBlockData(kind)) return [];
  const parsed = parseBlockData(kind, data);
  if (!parsed) return [];
  const ids: string[] = [];
  if (kind === "HERO" || kind === "IMAGE") ids.push((parsed as HeroData | ImageData).assetId);
  if (kind === "GALLERY") ids.push(...(parsed as GalleryData).images.map((image) => image.assetId));
  if (kind === "SPEAKERS") {
    for (const speaker of (parsed as SpeakersData).speakers) if (speaker.assetId) ids.push(speaker.assetId);
  }
  return [...new Set(ids)];
}

export const eventContentSectionInputSchema = z.object({
  kind: z.enum(eventContentKinds),
  title: z.string().trim().min(2, "Give the section a heading.").max(120),
  body: z.string().trim().max(20000).default(""),
  tone: z.enum(eventContentTones).nullable().optional(),
  placement: z.enum(eventContentPlacements).default("PUBLIC_PAGE"),
  items: z.array(eventContentItemSchema).max(20).default([]),
  isPublished: z.boolean().default(false),
  links: z.array(eventContentLinkInputSchema).max(12).default([]),
  /** Per-kind content for the #816 blocks; checked against the kind's schema below. */
  data: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind !== "CUSTOM_HTML" && value.body.length > 8000) {
    context.addIssue({
      code: "custom",
      path: ["body"],
      message: "Keep the text under 8,000 characters.",
    });
  }
  if ((value.kind === "FORMATTED_TEXT" || value.kind === "CUSTOM_HTML") && !value.body) {
    context.addIssue({
      code: "custom",
      path: ["body"],
      message: value.kind === "CUSTOM_HTML"
        ? "Add some HTML, or the block would publish empty."
        : "Add some text, or the section would publish an empty heading.",
    });
  }
  if (hasBlockData(value.kind)) {
    const parsed = (blockDataSchemas[value.kind] as z.ZodType).safeParse(value.data ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: "custom", path: ["data", ...issue.path], message: issue.message });
      }
    }
  }
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
  // Only some kinds have a place on the registration form.
  if (!canPlaceOnRegistrationForm(value.kind) && value.placement !== "PUBLIC_PAGE") {
    context.addIssue({
      code: "custom",
      path: ["placement"],
      message: value.kind === "RICH_TEXT" || value.kind === "RESOURCE_LINKS"
        ? "Only info cards and text blocks can be placed on the registration form."
        : "This block can only be shown on the public event page.",
    });
  }
});

/**
 * Whole-page save. Order comes from the array rather than a per-section field,
 * so reordering cannot leave two sections claiming the same position.
 */
export const eventContentInputSchema = z.object({
  sections: z.array(eventContentSectionInputSchema).max(30),
}).strict().superRefine((value, context) => {
  if (value.sections.filter((section) => section.kind === "HERO").length > 1) {
    context.addIssue({
      code: "custom",
      path: ["sections"],
      message: "A page has one header banner. Remove the extra one.",
    });
  }
});

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
