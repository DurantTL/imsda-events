import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ErrorBoundaryView } from "@/components/error-boundary-view";
import { DEFAULT_CLUB_HELP_EMAIL } from "@/modules/event-info-cards/domain";

/** Branded error boundaries (#688, audit F23). Synthetic error text only. */

// Lets the component be called as a plain function to inspect its button handler.
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useEffect: () => undefined }));

type Variant = "public" | "portal" | "workspace";
const secretError = Object.assign(new Error("synthetic internal failure detail"), { digest: "abc123digest" });
const render = (variant: Variant) =>
  renderToStaticMarkup(createElement(ErrorBoundaryView, { error: secretError, retry: vi.fn(), variant }));

const BOUNDARIES: Array<[string, Variant]> = [
  ["app/error.tsx", "public"],
  ["app/(public)/error.tsx", "public"],
  ["app/(public)/account/(portal)/error.tsx", "portal"],
  ["app/(workspace)/error.tsx", "workspace"],
];

function findButton(node: unknown): ReactElement<{ onClick?: () => void }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ onClick?: () => void; children?: unknown }>;
  if (element.type === "button") return element;
  return findButton(element.props.children);
}

describe("ErrorBoundaryView", () => {
  for (const variant of ["public", "portal", "workspace"] as const) {
    it(`shows Try again and the youth office link, and no error details (${variant})`, () => {
      const markup = render(variant);
      expect(markup).toContain("Try again");
      expect(markup).toContain(`mailto:${DEFAULT_CLUB_HELP_EMAIL}`);
      expect(markup).toContain("IMSDA youth office");
      expect(markup).not.toContain("event team");
      expect(markup).not.toContain("synthetic internal failure detail");
      expect(markup).not.toContain("abc123digest");
    });
  }

  it("adds the site header only for the public variant", () => {
    expect(render("public")).toContain("public-registration-header");
    expect(render("portal")).not.toContain("public-registration-header");
  });

  it("uses one h1, except inside the staff shell which already has one", () => {
    expect(render("public")).toContain("<h1>");
    expect(render("portal")).toContain("<h1>");
    expect(render("workspace")).not.toContain("<h1>");
    expect(render("workspace")).toContain("<h2>");
  });

  it("calls retry when Try again is clicked", () => {
    const retry = vi.fn();
    // The hook is skipped by calling the component as a plain function only after stubbing useEffect.
    const tree = ErrorBoundaryView({ error: secretError, retry, variant: "portal" });
    findButton(tree)?.props.onClick?.();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps the action and support link at least 44px tall", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(/\.app-error-action \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.app-error-support \{[^}]*min-height: 44px/);
  });

  for (const [file, variant] of BOUNDARIES) {
    it(`${file} passes retry through with the ${variant} variant`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("{ error, retry }");
      expect(source).toContain("retry={retry}");
      expect(source).toContain(`variant="${variant}"`);
    });
  }
});
