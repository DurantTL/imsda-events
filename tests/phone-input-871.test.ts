import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PhoneInput, phoneBlocks } from "@/components/phone-input";

/** #871: the shared inline phone input. Synthetic data only. */
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(PhoneInput, { label: "Phone", ...props } as never));

describe("PhoneInput", () => {
  it("is a phone keypad input with autofill", () => {
    const html = render({ value: "" });
    expect(html).toContain('type="tel"');
    expect(html).toContain('inputMode="tel"');
    expect(html).toContain('autoComplete="tel"');
    expect(html).toContain('maxLength="40"');
    expect(html).not.toContain("phone-input-message");
  });

  it("keeps its name for a plain form post and shows nothing for a valid number", () => {
    const html = render({ name: "phone", defaultValue: "515-555-0134", showNow: true });
    expect(html).toContain('name="phone"');
    expect(html).not.toContain("phone-input-message");
  });

  it("shows a fixable message for a changed bad number once it is shown, and never repeats the number", () => {
    const hidden = render({ value: "idk 911" });
    expect(hidden).not.toContain("phone-input-message");
    expect(hidden).not.toContain("aria-invalid");
    const shown = render({ value: "idk 911", showNow: true });
    expect(shown).toContain("Phone must be a 10-digit US number");
    expect(shown).toContain('role="alert"');
    expect(shown).toContain('aria-invalid="true"');
    expect(shown.match(/idk 911/g)).toHaveLength(1);
  });

  it("only flags an old saved number as needing correction, and does not mark it invalid", () => {
    const html = render({ value: "555-0100", stored: "555-0100" });
    expect(html).toContain("This saved number needs correcting.");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("aria-invalid");
  });

  it("treats a legacy number copied somewhere new as a new value", () => {
    const html = render({ value: "555-0100", stored: undefined, showNow: true });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("needs correcting");
  });
});

describe("how the message looks", () => {
  it("styles a blocking problem as an error and a legacy notice differently", () => {
    const error = render({ value: "idk 911", showNow: true });
    expect(error).toContain("field-error-message");
    expect(error).toContain("is-error");
    expect(error).not.toContain("is-notice");
    const notice = render({ value: "555-0100", stored: "555-0100" });
    expect(notice).toContain("is-notice");
    expect(notice).not.toContain("is-error");
    expect(notice).not.toContain("field-error");
  });

  it("has rules that beat the generic label help-text rules, at 14px or more, before the builder markers", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    for (const state of ["is-error", "is-notice"]) {
      expect(css).toContain(`.public-registration-field > small.phone-input-message.${state}`);
      expect(css).toContain(`.app-shell .form-stack label > small.phone-input-message.${state}`);
    }
    const errorRule = css.slice(css.indexOf(".phone-input-message.is-error"));
    expect(errorRule.slice(0, errorRule.indexOf("}"))).toContain("var(--danger");
    const base = css.slice(css.indexOf(".phone-input-message,"));
    expect(base.slice(0, base.indexOf("}"))).toContain("0.875rem");
    expect(css.indexOf(".phone-input-message")).toBeLessThan(css.indexOf("/* Registration form builder editor shell (#1132)"));
    expect(css.indexOf(".phone-input-message")).toBeLessThan(css.indexOf("/* Form settings tab"));
  });
});

describe("phoneBlocks", () => {
  it("blocks only a changed number that is not a valid phone", () => {
    expect(phoneBlocks("Phone", "")).toBe(false);
    expect(phoneBlocks("Phone", "515-555-0134")).toBe(false);
    expect(phoneBlocks("Phone", "idk 911", "515-555-0134")).toBe(true);
    expect(phoneBlocks("Phone", "555-0100", "555-0100")).toBe(false);
    expect(phoneBlocks("Phone", "555 0100", "555-0100")).toBe(false);
    expect(phoneBlocks("Phone", "555-0100")).toBe(true);
  });
});
