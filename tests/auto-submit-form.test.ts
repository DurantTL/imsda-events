import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutoSubmitForm } from "@/components/auto-submit-form";

/** Honors print report auto-submit (#851). Synthetic ids only. */
describe("AutoSubmitForm", () => {
  const html = renderToStaticMarkup(
    createElement(
      AutoSubmitForm,
      { className: "controls", method: "get" },
      createElement("select", { name: "member", defaultValue: "" }, createElement("option", { value: "" }, "Choose a member"), createElement("option", { value: "m1" }, "Fixture-Aaa, Pat")),
      createElement("button", { className: "auto-submit-go", type: "submit" }, "Show report"),
    ),
  );

  it("is still a GET form with a visible submit button before scripts run, so it works without JavaScript", () => {
    expect(html).toContain('method="get"');
    expect(html).toContain('class="controls"');
    expect(html).not.toContain("auto-submit-enhanced");
    expect(html).toContain("auto-submit-go");
    expect(html).toContain(">Show report</button>");
  });
});
