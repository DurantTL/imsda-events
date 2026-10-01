import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const moduleFiles = readdirSync(path.join(root, "modules/coordinator-health")).map((file) => `modules/coordinator-health/${file}`);

describe("coordinator health view privacy guards (#658)", () => {
  it("never names a physician or clinic field", () => {
    for (const file of [...moduleFiles, "components/event-health-sheet.tsx"]) {
      expect(read(file), file).not.toMatch(/physician|clinic/i);
    }
  });

  it("has no CSV or download path, and nothing logs", () => {
    for (const file of [...moduleFiles, "components/event-health-sheet.tsx", "app/(workspace)/more/event-health/page.tsx", "app/(public)/account/(portal)/area/health/page.tsx", "app/(public)/account/(portal)/clubs/[organizationId]/health/page.tsx"]) {
      const source = read(file);
      expect(source, file).not.toMatch(/text\/csv|\.csv|Content-Disposition|console\.|logError|logger/i);
    }
  });

  it("marks every page not indexable and dynamic (no caching)", () => {
    for (const file of ["app/(workspace)/more/event-health/page.tsx", "app/(public)/account/(portal)/area/health/page.tsx", "app/(public)/account/(portal)/clubs/[organizationId]/health/page.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("index: false");
      expect(source, file).toContain("nocache: true");
      expect(source, file).toContain('dynamic = "force-dynamic"');
    }
  });

  it("opens sealed answers only through the sealing module and keeps the health data out of the browser", () => {
    const repository = read("modules/coordinator-health/repository.ts");
    expect(repository).toContain("openSensitiveAnswers");
    expect(read("components/event-health-sheet.tsx")).not.toContain('"use client"');
  });

  it("is not reachable through the club forms or CSV paths", () => {
    expect(read("modules/club-forms/csv.ts")).not.toContain("coordinator-health");
  });
});
