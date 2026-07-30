import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
const buildTsconfig = JSON.parse(
  readFileSync(path.join(root, "tsconfig.build.json"), "utf8"),
) as {
  include?: string[];
  exclude?: string[];
};

describe("portable Docker deployment contract", () => {
  it("persists both relational data and uploaded event files", () => {
    expect(compose).toContain(
      "imsda_events_postgres:/var/lib/postgresql/data",
    );
    expect(compose).toContain(
      "imsda_events_assets:/app/storage/event-assets",
    );
    expect(compose).toContain(
      "ASSET_STORAGE_DIR: /app/storage/event-assets",
    );
  });

  it("passes URL-sensitive public configuration at build and runtime", () => {
    for (const key of [
      "APP_BASE_URL",
      "EMBED_ALLOWED_ORIGINS",
      "SQUARE_ENVIRONMENT",
      "SQUARE_ENABLE_PRODUCTION",
      "APP_RELEASE_SHA",
    ]) {
      expect(dockerfile).toContain(`ARG ${key}`);
      expect(compose).toContain(`${key}: \${`);
    }
  });

  it("passes both halves of optional attendee Google sign-in", () => {
    expect(compose).toContain(
      "GOOGLE_OAUTH_CLIENT_ID: ${GOOGLE_OAUTH_CLIENT_ID:-}",
    );
    expect(compose).toContain(
      "GOOGLE_OAUTH_CLIENT_SECRET: ${GOOGLE_OAUTH_CLIENT_SECRET:-}",
    );
  });

  it("keeps Next's constrained image build separate from full CI typechecking", () => {
    expect(dockerfile).toContain(
      "ENV NEXT_BUILD_TSCONFIG=tsconfig.build.json",
    );
    expect(buildTsconfig.include).toContain("app/**/*.ts");
    expect(buildTsconfig.include).toContain("modules/**/*.ts");
    expect(buildTsconfig.exclude).toEqual(
      expect.arrayContaining(["tests", "scripts", "prisma"]),
    );
  });

  it("backs up the upload volume alongside PostgreSQL", () => {
    expect(compose).toContain("imsda_events_assets:/assets");
    expect(compose).toContain("ASSET_DIR: /assets");
    expect(compose).toContain("./scripts/backup:/usr/local/bin:ro");
  });
});
