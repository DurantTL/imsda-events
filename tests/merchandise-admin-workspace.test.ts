import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MerchandiseAdminWorkspace } from "@/components/merchandise-admin-workspace";

const root = process.cwd();
const workspaceSource = readFileSync(path.join(root, "components/merchandise-admin-workspace.tsx"), "utf8");
const workspaceCss = readFileSync(path.join(root, "components/merchandise-admin-workspace.module.css"), "utf8");

describe("merchandise admin workspace accessibility", () => {
  it("announces the initial catalog load to assistive technology, not just visually", () => {
    // The component fetches on mount via an effect, which never runs during a
    // static render, so this frame is the real first paint every staff
    // member's screen reader sees while the catalog request is in flight.
    const markup = renderToStaticMarkup(createElement(MerchandiseAdminWorkspace, { eventId: "event_1" }));

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading merchandise catalog");
  });

  it("labels every reorder control with the specific item it moves, not a generic 'up'/'down'", () => {
    expect(workspaceSource).toContain("aria-label={`Move ${product.name} up`}");
    expect(workspaceSource).toContain("aria-label={`Move ${product.name} down`}");
    expect(workspaceSource).toContain("aria-label={`Move ${variant.label} up`}");
    expect(workspaceSource).toContain("aria-label={`Move ${variant.label} down`}");
    expect(workspaceSource).toContain("aria-label={`Edit ${product.name}`}");
    expect(workspaceSource).toContain("aria-label={`Archive ${product.name}`}");
  });

  it("disables reorder controls at the visible edges instead of only hiding them, so keyboard/switch focus never lands on a dead move button", () => {
    expect(workspaceSource).toMatch(/aria-label=\{`Move \$\{product\.name\} up`\}[^>]*disabled=\{saving \|\| index === 0\}/);
    expect(workspaceSource).toMatch(/aria-label=\{`Move \$\{product\.name\} down`\}[^>]*disabled=\{saving \|\| index === ordered\.length - 1\}/);
  });

  it("exposes stateful toggle buttons (catalog enabled, item selected, preview audience) through aria-pressed, not color alone", () => {
    expect(workspaceSource).toMatch(/Disable catalog[\s\S]{0,40}aria-pressed=\{catalog\.isEnabled\}|aria-pressed=\{catalog\.isEnabled\}[\s\S]{0,80}Disable catalog/);
    expect(workspaceSource).toContain("aria-pressed={selectedId === product.id}");
    expect(workspaceSource).toContain('aria-pressed={previewAudience === audience.value}');
  });

  it("gives every modal dialog a role, an aria-modal flag, and an aria-labelledby that resolves to a heading in the same dialog", () => {
    expect(workspaceSource).toContain('role="dialog"');
    expect(workspaceSource).toContain('aria-modal="true"');

    expect(workspaceSource).toContain('aria-labelledby="variant-editor-title"');
    expect(workspaceSource).toContain('id="variant-editor-title"');
    expect(workspaceSource).toContain('aria-labelledby="merchandise-editor-title"');
    expect(workspaceSource).toContain('id="merchandise-editor-title"');

    expect(workspaceSource).toContain('aria-label="Close variant editor"');
    expect(workspaceSource).toContain('aria-label="Close product editor"');
  });

  it("keeps every landmark section's heading connected via aria-labelledby so assistive tech can name each region", () => {
    expect(workspaceSource).toContain('aria-labelledby="catalog-products-heading"');
    expect(workspaceSource).toContain('id="catalog-products-heading"');
    expect(workspaceSource).toContain('aria-labelledby="preview-heading"');
    expect(workspaceSource).toContain('id="preview-heading"');
  });

  it("groups the preview audience switcher as a labeled control group rather than loose buttons", () => {
    expect(workspaceSource).toContain('role="group"');
    expect(workspaceSource).toContain('aria-label="Preview as attendee context"');
  });

  it("marks purely decorative icons aria-hidden so they are not announced redundantly next to their text labels", () => {
    const iconUses = workspaceSource.match(/<(?:Archive|ChevronDown|ChevronUp|ImagePlus|PackageOpen|Pencil|Plus|Save|ShoppingBag|X) [^>]*\/>/g) ?? [];
    expect(iconUses.length).toBeGreaterThan(5);
    for (const use of iconUses) {
      expect(use).toContain('aria-hidden="true"');
    }
  });

  it("associates every catalog-item form field with a visible label element, not a bare input", () => {
    expect(workspaceSource).toMatch(/<label>Product name<input name="name"/);
    expect(workspaceSource).toMatch(/<label>Variant label<input name="label"/);
    expect(workspaceSource).toMatch(/<label>Price /);
    expect(workspaceSource).toContain('<label className="public-registration-check"><input name="isEnabled" type="checkbox"');
  });
});

describe("merchandise admin workspace responsive layout", () => {
  it("collapses the two-column product/preview layout to one column on narrow viewports", () => {
    expect(workspaceCss).toContain(".layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr);");
    expect(workspaceCss).toMatch(/@media \(max-width: 850px\)\s*\{\s*\.layout \{ grid-template-columns: 1fr; \}\s*\}/);
  });

  it("stacks per-item reorder/edit/archive controls vertically and lets header actions fill the width on phone-sized viewports", () => {
    const smallBreakpoint = workspaceCss.match(/@media \(max-width: 520px\)\s*\{([\s\S]*?)\n\}/);
    expect(smallBreakpoint).not.toBeNull();
    const body = smallBreakpoint![1];
    expect(body).toContain(".actions { justify-content: stretch; }");
    expect(body).toContain(".actions > button { flex: 1; }");
    expect(body).toContain(".cardActions { flex-direction: column; }");
  });

  it("shrinks preview artwork thumbnails on phone-sized viewports so the card still fits without horizontal scrolling", () => {
    const smallBreakpoint = workspaceCss.match(/@media \(max-width: 520px\)\s*\{([\s\S]*?)\n\}/);
    const body = smallBreakpoint![1];
    expect(body).toContain(".previewCard { grid-template-columns: 48px minmax(0, 1fr); }");
    expect(body).toContain(".previewCard > img { width: 48px; height: 48px; }");
  });
});
