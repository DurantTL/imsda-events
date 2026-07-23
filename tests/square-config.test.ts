import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getSquareConfiguration,
  publicSquareConfiguration,
} from "@/modules/payments/square-config";

const sandboxCredentials = {
  APP_BASE_URL: "https://events.imsda.test",
  SQUARE_APPLICATION_ID: "sandbox-sq0idb-example",
  SQUARE_LOCATION_ID: "sandbox-location",
  SQUARE_ACCESS_TOKEN: "sandbox-access-token",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "sandbox-signature-key",
};

describe("Square runtime configuration", () => {
  it("defaults payment traffic and the browser SDK to Sandbox", () => {
    const configuration = getSquareConfiguration(sandboxCredentials);

    expect(configuration).toMatchObject({
      environment: "sandbox",
      apiUrl: "https://connect.squareupsandbox.com",
      scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
      webhookNotificationUrl:
        "https://events.imsda.test/api/webhooks/square",
      paymentConfigured: true,
      webhookConfigured: true,
    });
    expect(publicSquareConfiguration(configuration)).toEqual({
      environment: "sandbox",
      applicationId: "sandbox-sq0idb-example",
      locationId: "sandbox-location",
      scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
    });
    expect(publicSquareConfiguration(configuration)).not.toHaveProperty(
      "accessToken",
    );
  });

  it("keeps production locked without an explicit second switch", () => {
    const configuration = getSquareConfiguration({
      ...sandboxCredentials,
      SQUARE_ENVIRONMENT: "production",
      SQUARE_APPLICATION_ID: "sq0idp-production-example",
      SQUARE_API_URL: "https://connect.squareup.com",
      SQUARE_ENABLE_PRODUCTION: "false",
    });

    expect(configuration.paymentConfigured).toBe(false);
    expect(configuration.webhookConfigured).toBe(false);
    expect(configuration.issue).toBe("PRODUCTION_DISABLED");
  });

  it("rejects a production API host while configured for Sandbox", () => {
    const configuration = getSquareConfiguration({
      ...sandboxCredentials,
      SQUARE_API_URL: "https://connect.squareup.com",
    });

    expect(configuration.paymentConfigured).toBe(false);
    expect(configuration.issue).toBe("INVALID_API_URL");
  });

  it("reports a friendly unconfigured state when credentials are absent", () => {
    const configuration = getSquareConfiguration({
      APP_BASE_URL: "http://localhost:3000",
    });

    expect(configuration.environment).toBe("sandbox");
    expect(configuration.paymentConfigured).toBe(false);
    expect(configuration.issue).toBe("MISSING_PAYMENT_CREDENTIALS");
  });

  it("does not enable charges without signed webhook reconciliation", () => {
    const configuration = getSquareConfiguration({
      ...sandboxCredentials,
      SQUARE_WEBHOOK_SIGNATURE_KEY: "",
    });

    expect(configuration.paymentConfigured).toBe(false);
    expect(configuration.webhookConfigured).toBe(false);
    expect(configuration.issue).toBe("MISSING_WEBHOOK_CONFIGURATION");
  });
});
