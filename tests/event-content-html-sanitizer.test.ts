import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  customHtmlAssetIds,
  sanitizeCustomHtml,
  sanitizedHtmlBySection,
} from "@/modules/events/content-html";

const ASSET = "/api/public/events/synthetic-event/assets/asset_1";

describe("custom HTML sanitizer (#816)", () => {
  const payloads: Array<[string, string]> = [
    ["script element", `<p>hi</p><script>alert(1)</script>`],
    ["script with a src", `<script src="https://evil.example/x.js"></script>`],
    ["img onerror", `<img src="x" onerror="alert(1)">`],
    ["img onerror on an allowed source", `<img src="${ASSET}" onerror="alert(1)" onload="alert(2)">`],
    ["javascript: href", `<a href="javascript:alert(1)">click</a>`],
    ["mixed-case javascript: href", `<a href="JaVaScRiPt:alert(1)">click</a>`],
    ["entity-encoded javascript: href", `<a href="&#106;avascript:alert(1)">click</a>`],
    ["tab-split javascript: href", `<a href="java\tscript:alert(1)">click</a>`],
    ["vbscript: href", `<a href="vbscript:msgbox(1)">click</a>`],
    ["data: href", `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>`],
    ["svg onload", `<svg onload="alert(1)"><circle r="5"/></svg>`],
    ["svg with script", `<svg><script>alert(1)</script></svg>`],
    ["math", `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`],
    ["style element", `<style>body{background:url(javascript:alert(1))}</style>`],
    ["style attribute", `<p style="background:url(javascript:alert(1))">x</p>`],
    ["iframe", `<iframe src="https://evil.example"></iframe>`],
    ["iframe srcdoc", `<iframe srcdoc="<script>alert(1)</script>"></iframe>`],
    ["form with input", `<form action="https://evil.example"><input name="card"><button>Pay</button></form>`],
    ["object", `<object data="https://evil.example/x.swf"></object>`],
    ["embed", `<embed src="https://evil.example/x.swf">`],
    ["meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.example">`],
    ["base", `<base href="https://evil.example/">`],
    ["link stylesheet", `<link rel="stylesheet" href="https://evil.example/x.css">`],
    ["onclick on a paragraph", `<p onclick="alert(1)">x</p>`],
    ["onmouseover on a link", `<a href="https://example.org" onmouseover="alert(1)">x</a>`],
    ["autofocus handler", `<div onfocus="alert(1)" tabindex="0" autofocus>x</div>`],
    ["broken-tag script", `<scr<script>ipt>alert(1)</scr</script>ipt>`],
    ["details ontoggle", `<details open ontoggle="alert(1)"><summary>x</summary></details>`],
    ["template", `<template><script>alert(1)</script></template>`],
    ["noscript trick", `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`],
  ];

  it.each(payloads)("neutralizes %s", (name, payload) => {
    const clean = sanitizeCustomHtml(payload);
    expect(clean).not.toMatch(/<script|<iframe|<form|<input|<object|<embed|<style|<svg|<math|<meta|<base|<link/i);
    expect(clean).not.toMatch(/\son[a-z]+\s*=/i);
    expect(clean).not.toMatch(/javascript:|vbscript:/i);
    expect(clean).not.toMatch(/href="data:/i);
    expect(clean).not.toMatch(/\sstyle\s*=/i);
    // Script bodies go with their element. (A broken tag leaves harmless,
    // escaped text behind, which is not markup.)
    if (name !== "broken-tag script") expect(clean).not.toMatch(/alert\(1\)/);
  });

  it("never lets any payload's output change when sanitized again", () => {
    for (const [, payload] of payloads) {
      const once = sanitizeCustomHtml(payload);
      expect(sanitizeCustomHtml(once)).toBe(once);
    }
  });

  it("keeps ordinary formatting", () => {
    const clean = sanitizeCustomHtml(
      `<h2>Welcome</h2><p>Hello <strong>friends</strong> and <em>family</em>.</p><ul><li>One</li></ul>` +
      `<table><tr><th>Day</th><td>Fri</td></tr></table>`,
    );
    expect(clean).toContain("<h2>Welcome</h2>");
    expect(clean).toContain("<strong>friends</strong>");
    expect(clean).toContain("<li>One</li>");
    expect(clean).toContain("<table>");
  });

  it("turns an h1 into an h2, because the page already has one", () => {
    expect(sanitizeCustomHtml("<h1>Big</h1>")).toBe("<h2>Big</h2>");
  });

  it("allows http, https, mailto and tel links, and opens web links safely", () => {
    const clean = sanitizeCustomHtml(
      `<a href="https://example.org">web</a><a href="mailto:a@example.org">mail</a><a href="tel:+15550100">call</a>`,
    );
    expect(clean).toContain(`href="https://example.org"`);
    expect(clean).toContain(`target="_blank"`);
    expect(clean).toContain(`rel="noopener noreferrer"`);
    expect(clean).toContain(`href="mailto:a@example.org"`);
    expect(clean).toContain(`href="tel:+15550100"`);
  });

  it("keeps an uploaded event image and a small inline raster image only", () => {
    const uploaded = sanitizeCustomHtml(`<img src="${ASSET}" alt="Chapel">`);
    expect(uploaded).toContain(`src="${ASSET}"`);
    expect(uploaded).toContain(`alt="Chapel"`);
    expect(uploaded).toContain(`loading="lazy"`);

    const inline = sanitizeCustomHtml(`<img src="data:image/png;base64,iVBORw0KGgo=" alt="">`);
    expect(inline).toContain("data:image/png;base64,iVBORw0KGgo=");
  });

  it("drops images from other sites, SVG images and data: documents", () => {
    for (const src of [
      "https://evil.example/pixel.gif",
      "//evil.example/pixel.gif",
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "/api/public/events/synthetic-event/assets/../../secret",
      "/some/other/path.png",
    ]) {
      expect(sanitizeCustomHtml(`<img src="${src}" alt="x">`), src).not.toContain("<img");
    }
  });

  it("lists the uploaded images the sanitized HTML shows", () => {
    const clean = sanitizeCustomHtml(`<img src="${ASSET}" alt=""><img src="${ASSET}" alt=""><p>x</p>`);
    expect(customHtmlAssetIds(clean)).toEqual(["asset_1"]);
  });

  it("re-sanitizes at render, whatever was stored", () => {
    const result = sanitizedHtmlBySection([
      { id: "a", kind: "CUSTOM_HTML", body: `<p>ok</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>` },
      { id: "b", kind: "RICH_TEXT", body: "<script>not custom html</script>" },
    ]);
    expect(Object.keys(result)).toEqual(["a"]);
    expect(result.a).toContain("<p>ok</p>");
    expect(result.a).not.toMatch(/script|javascript:/i);
  });
});
