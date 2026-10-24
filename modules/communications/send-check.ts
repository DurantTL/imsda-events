/**
 * The "send check" (#836): one function that reads an event email's subject, body and inbox preview line and reports
 * what is wrong with it, in three severities, each with a field anchor so staff can jump to the place to fix it.
 *
 * - **Errors** block the template publish and the announcement send. They are enforced on the server; the editor only
 *   shows them early.
 * - **Warnings** allow a send once staff acknowledge them (a template publish is not held up by them).
 * - **Suggestions** are shown and never block.
 *
 * It is pure (no database, no `server-only`), so the template editor, the announcement composer, template publish and
 * the announcement review all run the very same rules on the very same text. The one rule that already existed in the
 * body editor, a bare `{{checkin_qr_url}}` (#824), is imported rather than copied.
 */

import { hasStandaloneCheckinQrUrl } from "@/modules/communications/checkin-qr-rule";
import { MESSAGE_FILE_ID_PATTERN, MESSAGE_FILE_SCHEME } from "@/modules/communications/message-file-rules";
import {
  renderTemplateText,
  SAMPLE_MESSAGE_TEMPLATE_CONTEXT,
  unescapeTokenUnderscores,
  validateMessageTemplate,
  type MessageTemplateContext,
} from "@/modules/communications/templates";

export type SendCheckSeverity = "error" | "warning" | "suggestion";
export type SendCheckField = "subject" | "body" | "preheader";

export const SEND_CHECK_CODES = [
  "SUBJECT_EMPTY",
  "BODY_EMPTY",
  "SUBJECT_LINE_BREAK",
  "PREHEADER_LINE_BREAK",
  "UNKNOWN_TOKEN",
  "LINK_SCHEME",
  "IMAGE_SOURCE",
  "SUBJECT_LONG",
  "IMAGE_NO_ALT",
  "CHECKIN_QR_URL_BARE",
  "LINK_TEXT_IS_URL",
  "PREHEADER_MISSING",
  "BODY_SHORT",
] as const;
export type SendCheckCode = (typeof SEND_CHECK_CODES)[number];

export type SendCheckFinding = {
  /** Stable for one problem in one text (code plus its position among that code's findings); used to acknowledge warnings. */
  id: string;
  severity: SendCheckSeverity;
  code: SendCheckCode;
  field: SendCheckField;
  /** The id of the form field to focus, from the caller's `anchors`; null when the caller gave none. */
  anchor: string | null;
  message: string;
};

export type SendCheckResult = {
  errors: SendCheckFinding[];
  warnings: SendCheckFinding[];
  suggestions: SendCheckFinding[];
  hasErrors: boolean;
  hasWarnings: boolean;
};

export type SendCheckInput = {
  subject: string;
  /** The Markdown source, with its `{{tokens}}`. */
  body: string;
  /** The inbox preview line, or null/blank for none. */
  preheader?: string | null;
  /** The form field id each field maps to, so a finding can be jumped to. */
  anchors?: Partial<Record<SendCheckField, string>>;
  /** Values used only to measure the subject (a `{{event_name}}` is longer than its braces). Sample values by default. */
  context?: MessageTemplateContext;
  /** Passed to the token allow-list check, for a message type with a shorter list. */
  allowedTokens?: ReadonlySet<string>;
};

/** The template editor's field ids, which a finding's "Go to" jumps to. */
export const TEMPLATE_CHECK_ANCHORS = { subject: "template-subject", body: "template-body", preheader: "template-preheader" } as const;
/** The announcement composer's. The review dialog has no fields, so it shows the findings without jumps. */
export const ANNOUNCEMENT_CHECK_ANCHORS = { subject: "announcement-title", body: "announcement-body", preheader: "announcement-preheader" } as const;

/** A subject beyond this many characters is cut off by most inbox lists. "About 70" in the issue. */
export const SUBJECT_WARN_LENGTH = 70;
/** A body with less visible text than this is probably unfinished. */
export const BODY_SHORT_LENGTH = 40;
/** A token inside a body stands for a block of text of unknown size; it counts as this many characters. */
const TOKEN_TEXT_WEIGHT = 30;

/** Tokens that stand for a link, and the one that stands for a picture. Anything else in a link or image target is wrong. */
const LINK_TOKENS = new Set(["portal_url", "checkin_qr_url"]);
const IMAGE_TOKENS = new Set(["checkin_qr_image"]);
const LINK_SCHEMES = ["http://", "https://", "mailto:", "tel:"];

const IMAGE_PATTERN = /!\[([^\]\n]*)\]\(([^)\n]*)\)/g;
const LINK_PATTERN = /\[([^\]\n]*)\]\(([^)\n]*)\)(\{\.button\})?/g;
const TOKEN_ONLY_PATTERN = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/;
const URL_TEXT_PATTERN = /^(?:https?:\/\/|www\.)\S+$/i;

function wholeToken(target: string) {
  return TOKEN_ONLY_PATTERN.exec(target)?.[1] ?? null;
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (host.includes(":")) {
    // An IPv6 literal: loopback, unspecified, unique-local, link-local, or an IPv4-mapped address.
    return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  }
  // A single-label name ("intranet") is not a public host.
  return !host.includes(".");
}

/** An image source an email may carry: a public HTTPS address, an uploaded picture, or the check-in QR token. */
export function isApprovedImageSource(rawTarget: string) {
  const target = rawTarget.trim();
  if (!target || /\s/.test(target)) return false;
  const token = wholeToken(target);
  if (token) return IMAGE_TOKENS.has(token);
  if (target.startsWith(MESSAGE_FILE_SCHEME)) return MESSAGE_FILE_ID_PATTERN.test(target.slice(MESSAGE_FILE_SCHEME.length));
  if (!target.toLowerCase().startsWith("https://")) return false;
  try {
    const url = new URL(target);
    return url.protocol === "https:" && !url.username && !url.password && !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

/** A link target an email renders as a link (anything else renders as plain text). */
export function isApprovedLinkTarget(rawTarget: string) {
  const target = rawTarget.trim();
  if (!target || /[\s<>"']/.test(target)) return false;
  const token = wholeToken(target);
  if (token) return LINK_TOKENS.has(token);
  const lower = target.toLowerCase();
  return LINK_SCHEMES.some((scheme) => lower.startsWith(scheme) && lower.length > scheme.length);
}

function visibleBodyLength(body: string) {
  const withoutMarkup = body
    .replace(IMAGE_PATTERN, "")
    .replace(LINK_PATTERN, "$1")
    .replace(/\{\{[^{}]+\}\}/g, "\u0000")
    .replace(/^[ \t]*(?:#{1,6}|[-*]|\d+[.)])[ \t]+/gm, "")
    .replace(/[*_`>#\\]/g, "");
  const tokenCount = (withoutMarkup.match(/\u0000/g) ?? []).length;
  return withoutMarkup.replace(/\u0000/g, "").replace(/\s+/g, " ").trim().length + tokenCount * TOKEN_TEXT_WEIGHT;
}

export function runSendCheck(input: SendCheckInput): SendCheckResult {
  const findings: SendCheckFinding[] = [];
  const counts = new Map<SendCheckCode, number>();
  const add = (severity: SendCheckSeverity, code: SendCheckCode, field: SendCheckField, message: string) => {
    const index = counts.get(code) ?? 0;
    counts.set(code, index + 1);
    findings.push({
      id: `${code}:${index}`,
      severity,
      code,
      field,
      anchor: input.anchors?.[field] ?? null,
      message,
    });
  };

  const subject = input.subject;
  const body = unescapeTokenUnderscores(input.body);
  const preheader = input.preheader ?? "";

  // Errors.
  if (!subject.trim()) add("error", "SUBJECT_EMPTY", "subject", "Add a subject. An email with no subject is not sent.");
  if (!body.trim()) add("error", "BODY_EMPTY", "body", "Add a message body. An email with no body is not sent.");
  const validation = validateMessageTemplate({ subject, body, preheader, allowedTokens: input.allowedTokens });
  for (const issue of validation.issues) {
    if (issue.code === "SUBJECT_LINE_BREAK") add("error", "SUBJECT_LINE_BREAK", "subject", issue.message);
    else if (issue.code === "PREHEADER_LINE_BREAK") add("error", "PREHEADER_LINE_BREAK", "preheader", issue.message);
    else if (issue.code === "UNKNOWN_TOKEN") add("error", "UNKNOWN_TOKEN", issue.field, issue.message);
  }

  // A backslash-escaped bracket is literal text, not the start of a link or image.
  const source = body.replace(/\\[\s\S]/g, "  ");

  const images = [...source.matchAll(IMAGE_PATTERN)];
  for (const image of images) {
    const alt = image[1].trim();
    const target = image[2];
    if (!isApprovedImageSource(target)) {
      add(
        "error",
        "IMAGE_SOURCE",
        "body",
        `The picture${alt ? ` “${alt}”` : ""} must come from a public https:// address or an uploaded picture. It would not show in the email.`,
      );
    }
    if (!alt) add("warning", "IMAGE_NO_ALT", "body", "A picture has no description (alt text). Readers who cannot see it, and clients that block pictures, get nothing.");
  }

  const withoutImages = source.replace(IMAGE_PATTERN, "");
  for (const link of withoutImages.matchAll(LINK_PATTERN)) {
    const text = link[1].trim();
    const target = link[2];
    if (!isApprovedLinkTarget(target)) {
      add(
        "error",
        "LINK_SCHEME",
        "body",
        `The ${link[3] ? "button" : "link"}${text ? ` “${text}”` : ""} does not start with http://, https://, mailto: or tel:, so it would show as plain text.`,
      );
    }
    if (URL_TEXT_PATTERN.test(text) || LINK_TOKENS.has(wholeToken(text) ?? "")) {
      add("warning", "LINK_TEXT_IS_URL", "body", `The ${link[3] ? "button" : "link"} text “${text}” is a web address. Say what the link is for, such as “Open my check-in pass”.`);
    }
  }

  // Warnings.
  const measuredSubject = renderTemplateText(subject, { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, ...input.context }).text;
  const subjectLength = Array.from(measuredSubject.trim()).length;
  if (subjectLength > SUBJECT_WARN_LENGTH) {
    add("warning", "SUBJECT_LONG", "subject", `The subject is about ${subjectLength} characters. Most inboxes cut it off after ${SUBJECT_WARN_LENGTH}; put the important words first.`);
  }
  if (hasStandaloneCheckinQrUrl(body)) {
    add("warning", "CHECKIN_QR_URL_BARE", "body", "{{checkin_qr_url}} is a page link, not a QR code: on its own it prints a web address. Write it as [Open my check-in pass]({{checkin_qr_url}}), or use the Check-in QR code (image) token.");
  }

  // Suggestions.
  if (!preheader.trim()) {
    add("suggestion", "PREHEADER_MISSING", "preheader", "Add an inbox preview line. Without one, inboxes show “IMSDA Events” under the subject.");
  }
  if (body.trim() && visibleBodyLength(body) < BODY_SHORT_LENGTH) {
    add("suggestion", "BODY_SHORT", "body", "The message body is very short. Check that nothing is missing.");
  }

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const suggestions = findings.filter((finding) => finding.severity === "suggestion");
  return { errors, warnings, suggestions, hasErrors: errors.length > 0, hasWarnings: warnings.length > 0 };
}

/** Text that is printed as written: `{{` is split so no rule reads it as a token. */
function literalText(value: string) {
  return value.replaceAll("{{", "{\u200B{");
}

/**
 * The announcement's effective email: the template's subject with the announcement's title, the template's body with
 * the announcement's text where `{{announcement_body}}` stands, and the announcement's own preview line (the
 * template's when it has none). Checking this, rather than the announcement alone, is what finds a bad link in either.
 */
export function announcementSendCheckInput(input: {
  templateSubject: string;
  templateBody: string;
  templatePreheader?: string | null;
  announcement: { title: string; body: string; preheader?: string | null };
  anchors?: SendCheckInput["anchors"];
  /** The event's name, for measuring the subject; the sample name is used when none is given. */
  eventName?: string;
}): SendCheckInput {
  // The announcement's title and text are token *values* at send time: a `{{token}}` inside them is never expanded.
  // They are checked as that literal text, so the braces are broken up before they reach the token and link rules.
  const announcementBody = literalText(input.announcement.body);
  const body = unescapeTokenUnderscores(input.templateBody).replace(
    /\{\{\s*announcement_body\s*\}\}/g,
    () => announcementBody,
  );
  return {
    subject: unescapeTokenUnderscores(input.templateSubject),
    body,
    preheader: input.announcement.preheader?.trim() ? input.announcement.preheader : input.templatePreheader ?? null,
    anchors: input.anchors,
    context: {
      ...(input.eventName ? { event_name: input.eventName } : {}),
      announcement_title: input.announcement.title.trim() || "Event update",
      announcement_body: announcementBody,
    },
  };
}

/** Every finding, errors first, for a flat list. */
export function sendCheckFindings(result: SendCheckResult) {
  return [...result.errors, ...result.warnings, ...result.suggestions];
}

/** The warnings in `result` that are not in `acknowledgedIds`; sending needs this to be empty. */
export function unacknowledgedWarnings(result: SendCheckResult, acknowledgedIds: readonly string[] | undefined) {
  const acknowledged = new Set(acknowledgedIds ?? []);
  return result.warnings.filter((warning) => !acknowledged.has(warning.id));
}

/** One line for an API error: the first few error messages. */
export function describeSendCheckErrors(result: SendCheckResult) {
  return result.errors.slice(0, 3).map((finding) => finding.message).join(" ");
}
