/**
 * Housekeeping for hosted "Pay on Square" links (#327). Withdraws links that have expired or gone
 * stale (a cancellation, a payment staff recorded, a changed balance), then tells Square to delete
 * every withdrawn link it has not yet been told about. Square's payment link has no expiry of its
 * own, so this is what makes expiry real at the provider.
 *
 * It takes no money and moves none. It does write: it marks links INVALIDATED and calls Square's
 * delete-link endpoint, so it follows the same Square Production lock as the app
 * (SQUARE_ENVIRONMENT=production and SQUARE_ENABLE_PRODUCTION=true). The scheduled outbox sweep runs the
 * same housekeeping every few minutes; run this by hand to do it now.
 *
 *   npm run payments:hosted-sweep
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const { sweepHostedCheckouts } = await import(
    "@/modules/payments/square-hosted-invalidation"
  );
  const result = await sweepHostedCheckouts();
  console.log(
    `Hosted Square links: ${result.withdrawn} withdrawn, ${result.deleted} deleted at Square, ${result.failed} still to retry.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
