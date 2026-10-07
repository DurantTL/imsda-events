/**
 * One transaction enqueues every recipient of a batch send, so Prisma's 5-second default would roll back a large
 * one. Sized from the timed check in scripts/verify-announcement-email.ts, with wide headroom, and shared by every
 * batch that renders a message per recipient (the announcement broadcast and the staff-selected audience send).
 */
export const BATCH_TRANSACTION_TIMEOUT_MS = 120_000;
export const BATCH_TRANSACTION_MAX_WAIT_MS = 15_000;
