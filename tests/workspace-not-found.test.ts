import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import WorkspaceNotFound from "@/app/(workspace)/not-found";

describe("staff workspace not-found (#470)", () => {
  it("renders a staff message with a way back to the staff workspace, not the public 404", () => {
    const html = renderToStaticMarkup(WorkspaceNotFound());

    expect(html).toContain("We couldn&#x27;t find that record");
    expect(html).toContain("Back to staff workspace");
    expect(html).toContain('href="/overview"');
    // No public-site chrome: the workspace layout supplies the shell.
    expect(html).not.toContain("public-registration-header");
    expect(html).not.toContain("See the calendar");
  });
});
