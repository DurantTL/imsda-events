import "server-only";

/**
 * The server-only entry point for Square configuration. The rules themselves
 * live in `square-config-domain` so a readiness script can evaluate them
 * without pulling a server-only module into a plain Node process — and, more
 * importantly, without restating them and drifting from the payment path.
 */
export * from "@/modules/payments/square-config-domain";
