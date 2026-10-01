import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuilderPhoneNotice } from "@/components/builder-phone-notice";

describe("registration builder phone notice (#685)", () => {
  it("explains the builder is for larger screens and links back to the Dashboard", () => {
    const markup = renderToStaticMarkup(createElement(BuilderPhoneNotice, { eventId: "event_synthetic" }));
    expect(markup).toContain("builder-phone-notice");
    expect(markup).toContain("isn&#x27;t built for phones");
    expect(markup).toContain("computer or tablet");
    expect(markup).toContain('href="/overview?event=event_synthetic"');
    expect(markup).toContain("Back to Dashboard");
  });

  it("names the club form builder and links back to the club forms list (#712)", () => {
    const markup = renderToStaticMarkup(createElement(BuilderPhoneNotice, { backHref: "/admin/club-forms", backLabel: "Back to club forms", builderName: "club form builder" }));
    expect(markup).toContain("builder-phone-notice");
    expect(markup).toContain("The club form builder isn&#x27;t built for phones");
    expect(markup).toContain('href="/admin/club-forms"');
    expect(markup).toContain("Back to club forms");
  });
});
