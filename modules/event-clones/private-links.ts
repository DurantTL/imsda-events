/**
 * Private links inside copied free text (#157). A clone copies configuration
 * text verbatim, and that text can hold links that only make sense for the
 * source event or that carry a secret: a registrant's `/manage/<token>` link,
 * the source's own admin API, its uploaded-file URLs, a signed or tokened
 * query string, or any URL naming the source event's id or slug. These are
 * found at preview time, listed as "needs review", and stripped from the copy.
 *
 * Pure: no database, no clock.
 */

export type PrivateLinkContext = { sourceEventId: string; sourceSlug: string };

export type PrivateLinkReason = "manageLink" | "sourceAdminApi" | "sourceAsset" | "tokenParameter" | "sourceReference";

export const privateLinkReasonLabels: Record<PrivateLinkReason, string> = {
  manageLink: "a registrant's private manage link",
  sourceAdminApi: "the source event's staff API",
  sourceAsset: "an uploaded file of the source event",
  tokenParameter: "a token or signature in the address",
  sourceReference: "the source event's own address or id",
};

/** Absolute URLs, plus the app's own relative `/manage/` and `/api/` paths. */
const urlPattern = /https?:\/\/[^\s<>"'`)\]]+|(?<![\w/.:-])\/(?:manage|api)\/[^\s<>"'`)\]]*/gi;
const tokenParameterPattern = /[?&#](?:[a-z_]*token|sig|signature)=/i;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedPattern(value: string) {
  return new RegExp(`(?:^|[^a-z0-9_-])${escapeRegExp(value.toLowerCase())}(?:$|[^a-z0-9_-])`);
}

/** Why `url` is private for this source, or an empty list when it is not. */
export function privateLinkReasons(url: string, context: PrivateLinkContext): PrivateLinkReason[] {
  const lower = url.toLowerCase();
  const reasons: PrivateLinkReason[] = [];
  if (lower.includes("/manage/")) reasons.push("manageLink");
  if (lower.includes(`/api/events/${context.sourceEventId.toLowerCase()}/`)) reasons.push("sourceAdminApi");
  if (lower.includes(`/api/public/events/${context.sourceSlug.toLowerCase()}/assets/`)) reasons.push("sourceAsset");
  if (tokenParameterPattern.test(url)) reasons.push("tokenParameter");
  if (reasons.length === 0 && (boundedPattern(context.sourceEventId).test(lower) || boundedPattern(context.sourceSlug).test(lower))) {
    reasons.push("sourceReference");
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
    .replace(/([?&#](?:[a-z_]*token|sig|signature)=)[^&#\s]*/gi, "$1…");
}

export type PrivateLinkMatch = { redacted: string; reasons: PrivateLinkReason[] };

/** Every private URL inside `text`, and the text with each one removed. */
export function stripPrivateLinks(text: string, context: PrivateLinkContext): { text: string; matches: PrivateLinkMatch[] } {
  const matches: PrivateLinkMatch[] = [];
  const stripped = text.replace(urlPattern, (url) => {
    const reasons = privateLinkReasons(url, context);
    if (reasons.length === 0) return url;
    matches.push({ redacted: redactPrivateLink(url), reasons });
    return "";
  });
  return { text: matches.length > 0 ? stripped : text, matches };
}

/** Whether a whole link value (a content link or a settings URL) is private. */
export function privateLinkValue(url: string, context: PrivateLinkContext): PrivateLinkMatch | null {
  const inText = stripPrivateLinks(url, context).matches;
  const whole = privateLinkReasons(url, context);
  const reasons = [...new Set([...whole, ...inText.flatMap((match) => match.reasons)])];
  return reasons.length > 0 ? { redacted: redactPrivateLink(url), reasons } : null;
}
