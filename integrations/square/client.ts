import "server-only";

const SQUARE_HOSTS = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
} as const;

type SquareEnvironment = keyof typeof SQUARE_HOSTS;

export type SquarePaymentInput = {
  sourceId: string;
  idempotencyKey: string;
  amountCents: number;
  note?: string;
  referenceId?: string;
};

export type SquarePaymentResult = {
  payment?: {
    id?: string;
    status?: string;
    receipt_url?: string;
    amount_money?: { amount?: number; currency?: string };
  };
  errors?: Array<{ category?: string; code?: string; detail?: string }>;
};

export class SquareConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SquareConfigurationError";
  }
}

export function getSquareConfiguration() {
  const environment = (process.env.SQUARE_ENVIRONMENT ?? "sandbox") as SquareEnvironment;
  if (!(environment in SQUARE_HOSTS)) throw new SquareConfigurationError("SQUARE_ENVIRONMENT must be sandbox or production.");
  if (environment === "production" && process.env.SQUARE_ENABLE_PRODUCTION !== "true") {
    throw new SquareConfigurationError("Production Square payments are locked. Set SQUARE_ENABLE_PRODUCTION=true only after launch approval.");
  }

  const accessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();
  const locationId = process.env.SQUARE_LOCATION_ID?.trim();
  if (!accessToken || !locationId) throw new SquareConfigurationError("Square is not configured. Add SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID.");

  return {
    accessToken,
    locationId,
    environment,
    host: SQUARE_HOSTS[environment],
    apiVersion: process.env.SQUARE_API_VERSION?.trim() || "2026-07-15",
  };
}

export async function createSquarePayment(input: SquarePaymentInput): Promise<SquarePaymentResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1) throw new Error("Square payment amount must be a positive whole number of cents.");
  if (!input.sourceId.trim()) throw new Error("A tokenized Square payment source is required.");
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 45) throw new Error("Square idempotency keys must contain 1 to 45 characters.");

  const configuration = getSquareConfiguration();
  const response = await fetch(`${configuration.host}/v2/payments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${configuration.accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": configuration.apiVersion,
    },
    body: JSON.stringify({
      source_id: input.sourceId,
      idempotency_key: input.idempotencyKey,
      amount_money: { amount: input.amountCents, currency: "USD" },
      location_id: configuration.locationId,
      autocomplete: true,
      ...(input.note ? { note: input.note.slice(0, 500) } : {}),
      ...(input.referenceId ? { reference_id: input.referenceId.slice(0, 40) } : {}),
    }),
    cache: "no-store",
  });
  const result = await response.json() as SquarePaymentResult;
  if (!response.ok) {
    const detail = result.errors?.map((error) => error.detail || error.code).filter(Boolean).join("; ");
    throw new Error(detail || `Square payment failed with status ${response.status}.`);
  }
  return result;
}
