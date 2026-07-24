import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The suite never opens a connection, but code under test validates the
    // whole server environment. Declaring it here keeps a clean checkout green
    // without a preconfigured shell; a real DATABASE_URL still wins.
    env: {
      DATABASE_URL: process.env.DATABASE_URL
        ?? "postgresql://imsda:imsda_test@localhost:5432/imsda_events_test?schema=public",
    },
    coverage: { reporter: ["text", "html"] },
  },
});
