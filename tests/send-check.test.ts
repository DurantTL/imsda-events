import { describe, expect, it } from "vitest";
import { hasStandaloneCheckinQrUrl } from "@/components/message-body-editor";
import { hasStandaloneCheckinQrUrl as sharedRule } from "@/modules/communications/checkin-qr-rule";
import {
  ANNOUNCEMENT_CHECK_ANCHORS,
  TEMPLATE_CHECK_ANCHORS,
  announcementSendCheckInput,
  describeSendCheckErrors,
  isApprovedImageSource,
  isApprovedLinkTarget,
  runSendCheck,
  sendCheckFindings,
  unacknowledgedWarnings,
  type SendCheckCode,
} from "@/modules/communications/send-check";
import { DEFAULT_MESSAGE_TEMPLATE_LIST } from "@/modules/communications/templates";

const GOOD_BODY = "Hello {{recipient_name}}, your check-in opens at four on Friday afternoon at the main lodge.";

function check(overrides: Partial<Parameters<typeof runSendCheck>[0]> = {}) {
  return runSendCheck({ subject: "Friday arrival information", body: GOOD_BODY, preheader: "Where to park and when to arrive.", anchors: TEMPLATE_CHECK_ANCHORS, ...overrides });
}
function codes(result: ReturnType<typeof runSendCheck>) {
  return sendCheckFindings(result).map((finding) => finding.code);
}
function has(result: ReturnType<typeof runSendCheck>, code: SendCheckCode) {
  return codes(result).includes(code);
}

describe("send check (#836): a clean email", () => {
  it("has no findings", () => {
    const result = check();
    expect(sendCheckFindings(result)).toEqual([]);
    expect(result.hasErrors).toBe(false);
    expect(result.hasWarnings).toBe(false);
  });

  it("finds no error in any default template, so publishing an unchanged one always works", () => {
    for (const definition of DEFAULT_MESSAGE_TEMPLATE_LIST) {
      // The custom message starts blank on purpose: staff write it, and an empty one is the error.
      if (definition.key === "CUSTOM_MESSAGE") continue;
      const result = runSendCheck({ subject: definition.subject, body: definition.body });
      expect(result.errors, `${definition.key}: ${describeSendCheckErrors(result)}`).toEqual([]);
    }
  });
});

describe("send check (#836): errors", () => {
  it("rejects an empty or blank subject, anchored to the subject field", () => {
    for (const subject of ["", "   "]) {
      const result = check({ subject });
      expect(result.errors.map((finding) => finding.code)).toContain("SUBJECT_EMPTY");
      expect(result.errors.find((finding) => finding.code === "SUBJECT_EMPTY")).toMatchObject({ severity: "error", field: "subject", anchor: "template-subject" });
    }
  });

  it("rejects an empty or blank body, anchored to the body field", () => {
    for (const body of ["", " \n "]) {
      const result = check({ body });
      expect(result.errors.find((finding) => finding.code === "BODY_EMPTY")).toMatchObject({ field: "body", anchor: "template-body" });
    }
  });

  it("rejects a subject or preview line that runs over two lines", () => {
    expect(has(check({ subject: "One\nTwo" }), "SUBJECT_LINE_BREAK")).toBe(true);
    const result = check({ preheader: "One\nTwo" });
    expect(result.errors.find((finding) => finding.code === "PREHEADER_LINE_BREAK")).toMatchObject({ field: "preheader", anchor: "template-preheader" });
  });

  it("rejects a token that is not on the allow-list, in the subject, the body or the preview line", () => {
    expect(check({ subject: "Hi {{nope}}" }).errors).toEqual([expect.objectContaining({ code: "UNKNOWN_TOKEN", field: "subject" })]);
    expect(check({ body: `${GOOD_BODY} {{nope}}` }).errors).toEqual([expect.objectContaining({ code: "UNKNOWN_TOKEN", field: "body" })]);
    expect(check({ preheader: "Hi {{nope}}" }).errors).toEqual([expect.objectContaining({ code: "UNKNOWN_TOKEN", field: "preheader" })]);
    expect(check({ preheader: "Hi {{event_name}}" }).errors).toEqual([]);
  });

  it("honours a shorter allow-list when the message type has one", () => {
    expect(check({ body: `${GOOD_BODY} {{refund_amount}}`, allowedTokens: new Set(["recipient_name"]) }).errors).toHaveLength(1);
  });

  it.each([
    ["javascript:alert(1)"],
    ["/relative/path"],
    ["#anchor"],
    ["ftp://files.example.test/a"],
    ["www.example.test"],
    ["data:text/html,hi"],
    ["https://exa mple.test"],
    [""],
    ["{{event_name}}"],
  ])("rejects a link to %s, which would render as plain text", (target) => {
    const result = check({ body: `${GOOD_BODY}\n\n[Read more](${target})` });
    expect(result.errors.find((finding) => finding.code === "LINK_SCHEME")).toMatchObject({ field: "body", anchor: "template-body" });
  });

  it.each([
    ["https://example.test/page"],
    ["http://example.test/page"],
    ["mailto:team@example.test"],
    ["tel:+15555550100"],
    ["{{portal_url}}"],
    ["{{checkin_qr_url}}"],
    ["HTTPS://EXAMPLE.TEST/UPPER"],
  ])("accepts a link to %s", (target) => {
    expect(has(check({ body: `${GOOD_BODY}\n\n[Read more](${target})` }), "LINK_SCHEME")).toBe(false);
    expect(isApprovedLinkTarget(target)).toBe(true);
  });

  it("treats a button like a link", () => {
    const result = check({ body: `${GOOD_BODY}\n\n[Open it](javascript:void){.button}` });
    expect(result.errors.find((finding) => finding.code === "LINK_SCHEME")?.message).toContain("button");
  });

  it("does not read an escaped bracket or a picture as a link", () => {
    expect(has(check({ body: `${GOOD_BODY} \\[not a link\\](javascript:x)` }), "LINK_SCHEME")).toBe(false);
    expect(has(check({ body: `${GOOD_BODY}\n\n![Map](https://cdn.example.test/map.png)` }), "LINK_SCHEME")).toBe(false);
  });

  it.each([
    ["http://example.test/a.png", "not https"],
    ["https://localhost/a.png", "localhost"],
    ["https://10.0.0.5/a.png", "private address"],
    ["https://192.168.1.2/a.png", "private address"],
    ["https://127.0.0.1/a.png", "loopback"],
    ["https://169.254.169.254/latest", "link-local"],
    ["https://[::1]/a.png", "ipv6 loopback"],
    ["https://intranet/a.png", "single-label host"],
    ["https://user:pw@example.test/a.png", "credentials"],
    ["ftp://example.test/a.png", "other scheme"],
    ["data:image/png;base64,AAAA", "data uri"],
    ["msgfile:short", "malformed upload id"],
    ["{{event_name}}", "wrong token"],
    ["/images/a.png", "relative"],
  ])("rejects a picture from %s (%s)", (source) => {
    expect(isApprovedImageSource(source)).toBe(false);
    const result = check({ body: `${GOOD_BODY}\n\n![Map](${source})` });
    expect(result.errors.find((finding) => finding.code === "IMAGE_SOURCE")).toMatchObject({ field: "body" });
  });

  it.each([
    ["https://cdn.example.test/map.png"],
    ["msgfile:cm0abc123def456"],
    ["{{checkin_qr_image}}"],
  ])("accepts a picture from %s", (source) => {
    expect(isApprovedImageSource(source)).toBe(true);
    expect(has(check({ body: `${GOOD_BODY}\n\n![Map](${source})` }), "IMAGE_SOURCE")).toBe(false);
  });
});

describe("send check (#836): warnings", () => {
  it("warns about a subject over about 70 characters, and only past it", () => {
    expect(has(check({ subject: "x".repeat(70) }), "SUBJECT_LONG")).toBe(false);
    const long = check({ subject: "x".repeat(71) });
    expect(long.warnings.find((finding) => finding.code === "SUBJECT_LONG")).toMatchObject({ severity: "warning", field: "subject", anchor: "template-subject" });
    expect(long.hasErrors).toBe(false);
    expect(long.hasWarnings).toBe(true);
  });

  it("measures the subject as the reader will see it, with a token's value", () => {
    const subject = "{{announcement_title}}";
    expect(has(check({ subject }), "SUBJECT_LONG")).toBe(false);
    expect(has(check({ subject, context: { announcement_title: "y".repeat(90) } }), "SUBJECT_LONG")).toBe(true);
  });

  it("warns about a picture with no description, for a blank one and for whitespace", () => {
    expect(check({ body: `${GOOD_BODY}\n\n![](https://cdn.example.test/a.png)` }).warnings.map((finding) => finding.code)).toEqual(["IMAGE_NO_ALT"]);
    expect(has(check({ body: `${GOOD_BODY}\n\n![  ](https://cdn.example.test/a.png)` }), "IMAGE_NO_ALT")).toBe(true);
    expect(has(check({ body: `${GOOD_BODY}\n\n![Parking map](https://cdn.example.test/a.png)` }), "IMAGE_NO_ALT")).toBe(false);
  });

  it("warns about {{checkin_qr_url}} outside a link, using the editor's own rule", () => {
    const bare = `${GOOD_BODY}\n\n{{checkin_qr_url}}`;
    expect(check({ body: bare }).warnings.find((finding) => finding.code === "CHECKIN_QR_URL_BARE")).toMatchObject({ field: "body" });
    expect(has(check({ body: `${GOOD_BODY}\n\n[Open my check-in pass]({{checkin_qr_url}})` }), "CHECKIN_QR_URL_BARE")).toBe(false);
    // The editor and the check share one function (#824), so they cannot disagree.
    expect(hasStandaloneCheckinQrUrl).toBe(sharedRule);
    for (const source of [bare, "See [pass]({{checkin_qr_url}}) or {{checkin_qr_url}}", "[Open]({{checkin_qr_url}}){.button}"]) {
      expect(has(check({ body: source }), "CHECKIN_QR_URL_BARE")).toBe(sharedRule(source));
    }
  });

  it("warns when a link or button reads as a web address, or as a bare link token", () => {
    for (const text of ["https://example.test/page", "www.example.test", "{{portal_url}}", "{{checkin_qr_url}}"]) {
      const result = check({ body: `${GOOD_BODY}\n\n[${text}](https://example.test/page)` });
      expect(result.warnings.map((finding) => finding.code), text).toContain("LINK_TEXT_IS_URL");
    }
    expect(has(check({ body: `${GOOD_BODY}\n\n[https://example.test/page](https://example.test/page){.button}` }), "LINK_TEXT_IS_URL")).toBe(true);
    expect(has(check({ body: `${GOOD_BODY}\n\n[Open my check-in pass](https://example.test/page)` }), "LINK_TEXT_IS_URL")).toBe(false);
    expect(has(check({ body: `${GOOD_BODY}\n\n[Visit https://example.test now](https://example.test/page)` }), "LINK_TEXT_IS_URL")).toBe(false);
  });
});

describe("send check (#836): suggestions", () => {
  it("suggests a preview line when there is none, and not once there is", () => {
    for (const preheader of [undefined, null, "", "   "]) {
      const result = check({ preheader });
      expect(result.suggestions.find((finding) => finding.code === "PREHEADER_MISSING")).toMatchObject({ severity: "suggestion", field: "preheader", anchor: "template-preheader" });
      expect(result.hasErrors).toBe(false);
      expect(result.hasWarnings).toBe(false);
    }
    expect(has(check({ preheader: "Arrive after four." }), "PREHEADER_MISSING")).toBe(false);
  });

  it("suggests a longer body when there is hardly any text, and counts a token as text", () => {
    expect(check({ body: "See you soon." }).suggestions.map((finding) => finding.code)).toContain("BODY_SHORT");
    expect(has(check({ body: "{{payment_status_block}} {{checkin_block}}" }), "BODY_SHORT")).toBe(false);
    expect(has(check({ body: GOOD_BODY }), "BODY_SHORT")).toBe(false);
    // Link and picture markup is not text.
    expect(has(check({ body: "[Open my check-in pass](https://example.test/very/long/address/that/is/not/message/text)" }), "BODY_SHORT")).toBe(true);
    // An empty body is an error, not also a suggestion.
    expect(has(check({ body: "" }), "BODY_SHORT")).toBe(false);
  });
});

describe("send check (#836): shape", () => {
  it("orders errors, warnings and suggestions apart, with stable ids that number repeats", () => {
    const result = check({
      subject: "",
      preheader: "",
      body: "![](https://cdn.example.test/a.png)\n\n![](https://cdn.example.test/b.png)\n\n[x](javascript:a)",
    });
    expect(result.errors.map((finding) => finding.severity)).toEqual(Array(result.errors.length).fill("error"));
    expect(result.warnings.map((finding) => finding.id)).toEqual(["IMAGE_NO_ALT:0", "IMAGE_NO_ALT:1"]);
    expect(sendCheckFindings(result).map((finding) => finding.severity)).toEqual([
      ...result.errors.map(() => "error"),
      ...result.warnings.map(() => "warning"),
      ...result.suggestions.map(() => "suggestion"),
    ]);
  });

  it("gives every finding the anchor of its field, or null when the caller has none", () => {
    const withAnchors = check({ subject: "", preheader: "", body: "" });
    expect(sendCheckFindings(withAnchors).every((finding) => finding.anchor === TEMPLATE_CHECK_ANCHORS[finding.field])).toBe(true);
    const without = check({ subject: "", anchors: undefined });
    expect(sendCheckFindings(without).every((finding) => finding.anchor === null)).toBe(true);
  });

  it("lists the warnings still to acknowledge", () => {
    const result = check({ subject: "x".repeat(80), body: `${GOOD_BODY}\n\n![](https://cdn.example.test/a.png)` });
    expect(unacknowledgedWarnings(result, undefined).map((finding) => finding.id)).toEqual(["IMAGE_NO_ALT:0", "SUBJECT_LONG:0"]);
    expect(unacknowledgedWarnings(result, ["SUBJECT_LONG:0"]).map((finding) => finding.id)).toEqual(["IMAGE_NO_ALT:0"]);
    expect(unacknowledgedWarnings(result, ["SUBJECT_LONG:0", "IMAGE_NO_ALT:0", "extra"])).toEqual([]);
  });

  it("summarises the first errors for an API message", () => {
    expect(describeSendCheckErrors(check({ subject: "", body: "" }))).toBe("Add a subject. An email with no subject is not sent. Add a message body. An email with no body is not sent.");
  });
});

describe("send check (#836): an announcement as the reader will get it", () => {
  const template = { templateSubject: "{{announcement_title}}", templateBody: "{{announcement_body}}\n\n[Open my registration]({{portal_url}})" };

  it("checks the announcement's text where the template places it", () => {
    const bad = runSendCheck(announcementSendCheckInput({
      ...template,
      announcement: { title: "Friday arrival information", body: "Parking is by the lodge. [Map](javascript:alert(1)) Doors open at four on Friday afternoon." },
      anchors: ANNOUNCEMENT_CHECK_ANCHORS,
    }));
    expect(bad.errors).toEqual([expect.objectContaining({ code: "LINK_SCHEME", field: "body", anchor: "announcement-body" })]);
  });

  it("measures the subject with the announcement's title", () => {
    const long = runSendCheck(announcementSendCheckInput({ ...template, announcement: { title: "T".repeat(80), body: "Parking is by the lodge. Doors open at four on Friday afternoon." }, anchors: ANNOUNCEMENT_CHECK_ANCHORS }));
    expect(long.warnings).toEqual([expect.objectContaining({ code: "SUBJECT_LONG", anchor: "announcement-title" })]);
  });

  it("uses the announcement's own preview line, else the template's, else suggests one", () => {
    const base = { ...template, announcement: { title: "Hello there", body: "Parking is by the lodge. Doors open at four on Friday afternoon." } };
    const own = announcementSendCheckInput({ ...base, templatePreheader: "From the template", announcement: { ...base.announcement, preheader: "Own line" } });
    expect(own.preheader).toBe("Own line");
    expect(announcementSendCheckInput({ ...base, templatePreheader: "From the template", announcement: { ...base.announcement, preheader: "  " } }).preheader).toBe("From the template");
    const none = runSendCheck(announcementSendCheckInput({ ...base, anchors: ANNOUNCEMENT_CHECK_ANCHORS }));
    expect(none.suggestions).toEqual([expect.objectContaining({ code: "PREHEADER_MISSING", anchor: "announcement-preheader" })]);
  });

  it("treats a token typed in the announcement text as printed text, not as template source", () => {
    const base = { ...template, anchors: ANNOUNCEMENT_CHECK_ANCHORS };
    const link = runSendCheck(announcementSendCheckInput({ ...base, announcement: { title: "Arrival", body: "Doors open at four on Friday afternoon. [Open your pass]({{checkin_qr_url}})" } }));
    expect(link.errors).toEqual([expect.objectContaining({ code: "LINK_SCHEME", field: "body" })]);
    const unknown = runSendCheck(announcementSendCheckInput({ ...base, announcement: { title: "Arrival", body: "Bring your {{favorite}} snack to the lodge on Friday afternoon." } }));
    expect(unknown.errors).toEqual([]);
    const image = runSendCheck(announcementSendCheckInput({ ...base, announcement: { title: "Arrival", body: "Doors open at four on Friday afternoon. ![Pass]({{checkin_qr_image}})" } }));
    expect(image.errors.map((finding) => finding.code)).toEqual(["IMAGE_SOURCE"]);
    // The template's own token is still a token.
    expect(runSendCheck(announcementSendCheckInput({ ...base, templateBody: "{{announcement_body}} [Open]({{portal_url}})", announcement: { title: "Arrival", body: "Doors open at four on Friday afternoon." } })).errors).toEqual([]);
  });

  it("measures the subject with the event's name when given", () => {
    const input = { ...template, announcement: { title: "Hello", body: "Doors open at four on Friday afternoon." } };
    const long = runSendCheck(announcementSendCheckInput({ ...input, templateSubject: "{{event_name}}", eventName: "E".repeat(90) }));
    expect(long.warnings.map((finding) => finding.code)).toEqual(["SUBJECT_LONG"]);
  });

  it("is inert when the template has no announcement body token", () => {
    const input = announcementSendCheckInput({ templateSubject: "Update", templateBody: GOOD_BODY, announcement: { title: "A title", body: "[x](javascript:a)" } });
    expect(runSendCheck(input).errors).toEqual([]);
  });
});
