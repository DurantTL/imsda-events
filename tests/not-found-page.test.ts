import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import NotFound from "@/app/not-found";

describe("site-wide not-found page (#470)", () => {
  it("is branded and links to the events home and the calendar, never off-site", () => {
    const html = renderToStaticMarkup(NotFound());

    expect(html).toContain("IMSDA");
    expect(html).toContain("Events home");
    expect(html).toContain("See the calendar");
    expect(html).toContain('href="/calendar"');
    // The header logo and the "Events home" link both point at "/".
    expect(html.match(/href="\/"/g)?.length).toBe(2);
    expect(html).not.toContain("imsda.org");
  });
});
