import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ErrorBoundaryView } from "@/components/error-boundary-view";

/** Branded error boundaries (#688, audit F23). Synthetic error text only. */

const secretError = Object.assign(new Error("synthetic internal failure detail"), { digest: "abc123digest" });

describe("ErrorBoundaryView", () => {
  for (const variant of ["public", "embedded"] as const) {
    it(`shows a Try again action and a support link, and no error details (${variant})`, () => {
      const markup = renderToStaticMarkup(createElement(ErrorBoundaryView, { error: secretError, retry: vi.fn(), variant }));
      expect(markup).toContain("Try again");
      expect(markup).toContain("mailto:youth@imsda.org");
      expect(markup).not.toContain("synthetic internal failure detail");
      expect(markup).not.toContain("abc123digest");
    });
  }

  it("adds the site header only for the public variant", () => {
    const render = (variant: "public" | "embedded") => renderToStaticMarkup(createElement(ErrorBoundaryView, { error: secretError, retry: vi.fn(), variant }));
    expect(render("public")).toContain("public-registration-header");
    expect(render("embedded")).not.toContain("public-registration-header");
  });

  it("keeps the action at least 44px tall", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(/\.app-error-action \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.app-error-support \{[^}]*min-height: 44px/);
  });

  it("has a boundary in the public, account and workspace segments", () => {
    for (const file of ["app/(public)/error.tsx", "app/(public)/account/(portal)/error.tsx", "app/(workspace)/error.tsx"]) {
      expect(readFileSync(file, "utf8")).toContain("ErrorBoundaryView");
    }
  });
});
