/**
 * Private links inside copied free text (#157). A clone copies configuration
 * text verbatim, and that text can hold links that only make sense for the
 * source event or that carry a secret: a registrant's `/manage/<token>` link,
 * the source's own staff API, its uploaded-file URLs, a signed or tokened
 * query string, or an app link naming the source event's slug or id. These
 * are found at preview time, listed as "needs review", and stripped from the
 * copy.
 *
 * Scope, so ordinary outside links survive:
 * - A token or signature parameter (`token=`, `*_token=`, `sig=`,
 *   `signature=`) is private on any host.
 * - The source's staff API (`/api/events/<sourceId>/`) and asset URLs
 *   (`/api/public/events/<sourceSlug>/assets/`) are private on any host:
 *   those exact path shapes name the source itself.
 * - `/manage/` and the source slug or id are private only in a relative path
 *   or on the app's own origin, and the slug or id only as a whole path
 *   segment or query value, so `https://imsda.org/camp-meeting-2027/photos`
 *   or `https://www.adventistgiving.org/manage/recurring` are kept.
 *
 * Pure: no database, no clock, no environment. The caller passes the app's
 * origin(s).
 */

export type PrivateLinkContext = {
  sourceEventId: string;
  sourceSlug: string;
  /** The app's own origins (from `APP_BASE_URL`), e.g. `https://events.imsda.org`. */
  appOrigins: readonly string[];
};

export type PrivateLinkReason = "manageLink" | "sourceAdminApi" | "sourceAsset" | "tokenParameter" | "sourceReference";

export const privateLinkReasonLabels: Record<PrivateLinkReason, string> = {
  manageLink: "a registrant's private manage link",
  sourceAdminApi: "the source event's staff API",
  sourceAsset: "an uploaded file of the source event",
  tokenParameter: "a token or signature in the address",
  sourceReference: "the source event's own address or id",
};

const urlChars = "[^\\s<>\"'`()\\[\\]]";
/** Absolute http(s) URLs, and relative paths that start a word with `/`. */
const urlSource = `https?:\\/\\/${urlChars}+|(?<![\\w/.:\\-])\\/[a-z0-9_~%-]${urlChars}*`;
const urlPattern = new RegExp(urlSource, "gi");
/** A markdown link whose target is a URL or relative path. */
const markdownLinkPattern = new RegExp(`\\[([^\\]\\n]*)\\]\\(\\s*(${urlSource})\\s*\\)`, "gi");
const tokenParameterPattern = /[?&#](?:[a-z0-9_-]*token|sig|signature)=/i;
const trailingPunctuation = /[.,;:!?]+$/;

type ParsedLink = { relative: boolean; origin: string; segments: string[]; queryValues: string[] };

function decode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseLink(url: string): ParsedLink | null {
  const relative = url.startsWith("/");
  try {
    const parsed = new URL(url, "http://relative.invalid");
    return {
      relative,
      origin: parsed.origin.toLowerCase(),
      segments: parsed.pathname.split("/").filter(Boolean).map((segment) => decode(segment).toLowerCase()),
      queryValues: [...parsed.searchParams.values()].map((value) => value.toLowerCase()),
    };
  } catch {
    return null;
  }
}

function normalizedOrigins(origins: readonly string[]) {
  return origins.flatMap((origin) => {
    try {
      return [new URL(origin).origin.toLowerCase()];
    } catch {
      return [];
    }
  });
}

/** Why `url` is private for this source, or an empty list when it is not. */
export function privateLinkReasons(url: string, context: PrivateLinkContext): PrivateLinkReason[] {
  const parsed = parseLink(url);
  const lower = url.toLowerCase();
  const reasons: PrivateLinkReason[] = [];
  const id = context.sourceEventId.toLowerCase();
  const slug = context.sourceSlug.toLowerCase();
  if (tokenParameterPattern.test(url)) reasons.push("tokenParameter");
  if (lower.includes(`/api/events/${id}/`)) reasons.push("sourceAdminApi");
  if (lower.includes(`/api/public/events/${slug}/assets/`)) reasons.push("sourceAsset");
  if (parsed && (parsed.relative || normalizedOrigins(context.appOrigins).includes(parsed.origin))) {
    if (parsed.segments.includes("manage")) reasons.push("manageLink");
    const names = [...parsed.segments, ...parsed.queryValues];
    if (reasons.length === 0 && (names.includes(slug) || names.includes(id))) reasons.push("sourceReference");
  }
  return reasons;
}

/**
 * The URL as the preview may show it: token and signature values and the
 * segment after `/manage/` are masked, so the plan never repeats a secret.
 */
export function redactPrivateLink(url: string) {
  return url
    .replace(/(\/manage\/)[^/?#\s]+/gi, "$1…")
    .replace(/([?&#](?:[a-z0-9_-]*token|sig|signature)=)[^&#\s]*/gi, "$1…");
}

export type PrivateLinkMatch = { redacted: string; reasons: PrivateLinkReason[] };

/** Splits trailing sentence punctuation off a matched URL. */
function splitPunctuation(match: string) {
  const punctuation = match.match(trailingPunctuation)?.[0] ?? "";
  return { url: punctuation ? match.slice(0, -punctuation.length) : match, punctuation };
}

/**
 * Every private URL inside `text`, and the text with each one removed. A
 * markdown link to a private URL keeps its label as plain text; a bare URL is
 * removed; runs of spaces left behind are collapsed.
 */
export function stripPrivateLinks(text: string, context: PrivateLinkContext): { text: string; matches: PrivateLinkMatch[] } {
  const matches: PrivateLinkMatch[] = [];
  const record = (url: string) => {
    const reasons = privateLinkReasons(url, context);
    if (reasons.length > 0) matches.push({ redacted: redactPrivateLink(url), reasons });
    return reasons.length > 0;
  };
  let stripped = text.replace(markdownLinkPattern, (whole, label: string, target: string) => (record(target) ? label : whole));
  stripped = stripped.replace(urlPattern, (match) => {
    const { url, punctuation } = splitPunctuation(match);
    return record(url) ? punctuation : match;
  });
  if (matches.length === 0) return { text, matches };
  stripped = stripped
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "");
  return { text: stripped, matches };
}

/** Whether a whole link value (a content link or a settings URL) is private. */
export function privateLinkValue(url: string, context: PrivateLinkContext): PrivateLinkMatch | null {
  const inText = stripPrivateLinks(url, context).matches;
  const whole = privateLinkReasons(url.trim(), context);
  const reasons = [...new Set([...whole, ...inText.flatMap((match) => match.reasons)])];
  return reasons.length > 0 ? { redacted: redactPrivateLink(url), reasons } : null;
}
