/**
 * Proves event module requests (#741 slice 3) against a real PostgreSQL
 * database, where the unit tests' fake database can't:
 *
 * - the partial unique index allows one pending request per event and module
 *   and any number of decided ones;
 * - six concurrent submits leave one pending request, one audit entry and one
 *   office email (the losers' transactions roll back whole);
 * - approving enables the module in the same transaction, audits it with ids and
 *   keys only, and queues the requester's email;
 * - two concurrent decisions leave one winner;
 * - declining keeps the module off, keeps the reason out of audit, and allows a
 *   new request;
 * - turning a module on directly answers a pending request;
 * - free text holding `{{account_action_link}}` is queued with its braces
 *   broken up, and delivery sends it without minting a token.
 *
 * Uses fictitious rows it creates and removes itself. Nothing is sent: delivery
 * uses an injected sender.
 *
 *   npm run test:module-requests
 */
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import type { AuthenticatedUser } from "@/modules/access/authorization";
import { processAccountEmailQueue } from "@/modules/communications/email-delivery";
import { createModuleRequest, decideModuleRequest } from "@/modules/event-modules/requests";
import { enableModule } from "@/modules/event-modules/service";

loadEnvConfig(process.cwd());
// Local-only, before any Prisma client or connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-module-requests-synthetic-key-not-a-secret");
fillBlankSyntheticEnv("ACCOUNT_EMAIL_SENDER_ADDRESS", "events@modulerequests.example.test");
fillBlankSyntheticEnv("APP_BASE_URL", "https://events.modulerequests.example.test");
// Never deliver for real: the service's best-effort delivery is off without a key,
// and the one delivery below injects its own sender.
delete process.env.RESEND_API_KEY;

const prisma = new PrismaClient();
const tag = randomUUID().slice(0, 8);
const P = `mr741_${tag}`;
const ids = { event: `${P}_ev`, club: `${P}_club`, admin: `${P}_admin`, requester: `${P}_req` };
const OFFICE = `office-${tag}@modulerequests.example.test`;
const admin = { id: ids.admin, email: `${P}_admin@modulerequests.example.test`, displayName: "Alex Admin", globalRole: "SYSTEM_ADMIN" } as AuthenticatedUser;
const requester = { id: ids.requester, email: `${P}_req@modulerequests.example.test`, displayName: "Eli EventAdmin", globalRole: null } as AuthenticatedUser;
let previousSupportContact: string | null | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function cleanup() {
  await prisma.messageOutbox.deleteMany({ where: { OR: [{ accountUserId: ids.requester }, { recipientEmail: OFFICE }] } });
  await prisma.auditLog.deleteMany({ where: { eventId: { in: [ids.event, ids.club] } } });
  await prisma.event.deleteMany({ where: { id: { in: [ids.event, ids.club] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.admin, ids.requester] } } });
  if (previousSupportContact !== undefined) {
    await prisma.platformSettings.update({ where: { id: "platform" }, data: { supportContact: previousSupportContact } });
  }
}

async function main() {
  const settings = await prisma.platformSettings.upsert({ where: { id: "platform" }, update: {}, create: { id: "platform" } });
  previousSupportContact = settings.supportContact;
  await prisma.platformSettings.update({ where: { id: "platform" }, data: { supportContact: OFFICE } });

  await prisma.user.createMany({ data: [
    { id: ids.admin, email: admin.email, displayName: admin.displayName, globalRole: "SYSTEM_ADMIN" },
    { id: ids.requester, email: requester.email, displayName: requester.displayName },
  ] });
  const when = { startsAt: new Date("2027-07-01T00:00:00Z"), endsAt: new Date("2027-07-03T00:00:00Z") };
  await prisma.event.create({ data: { id: ids.event, slug: `${P}-slug`, name: "Synthetic Congress", audience: "GENERAL", ...when } });
  await prisma.event.create({ data: { id: ids.club, slug: `${P}-club-slug`, name: "Synthetic Camporee", audience: "CLUB", ...when } });
  await prisma.eventMembership.createMany({ data: [
    { eventId: ids.event, userId: ids.requester, role: "EVENT_ADMIN" },
    { eventId: ids.club, userId: ids.requester, role: "EVENT_ADMIN" },
  ] });

  // 1. The partial unique index.
  const base = { eventId: ids.event, moduleKey: "attendee-community", reason: "Because." };
  const first = await prisma.moduleRequest.create({ data: base });
  const duplicate = await prisma.moduleRequest.create({ data: base }).then(() => null, (error: { code?: string }) => error);
  assert(duplicate?.code === "P2002", "a second pending request for the same event and module is refused by the database");
  await prisma.moduleRequest.create({ data: { ...base, moduleKey: "merchandise" } });
  await prisma.moduleRequest.create({ data: { ...base, eventId: ids.club } });
  await prisma.moduleRequest.update({ where: { id: first.id }, data: { status: "DECLINED", declineReason: "No." } });
  const second = await prisma.moduleRequest.create({ data: base });
  await prisma.moduleRequest.update({ where: { id: second.id }, data: { status: "DECLINED", declineReason: "No." } });
  await prisma.moduleRequest.create({ data: base });
  const statuses = (await prisma.moduleRequest.findMany({ where: base })).map((row) => row.status).sort();
  assert(statuses.join() === "DECLINED,DECLINED,PENDING", "decided requests do not count against the one-pending rule");
  await prisma.moduleRequest.deleteMany({ where: { eventId: { in: [ids.event, ids.club] } } });

  // 2. Concurrent double submit, with placeholder text in the reason.
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, index) => createModuleRequest(requester, ids.event, "merchandise", `Shirts {{account_action_link}} ${index}.`)),
  );
  assert(results.filter((result) => result.status === "fulfilled").length === 1, "exactly one concurrent submit succeeds");
  for (const result of results) {
    if (result.status === "rejected") assert((result.reason as { code?: string }).code === "ALREADY_PENDING", "the losers are told a request is pending");
  }
  const pending = await prisma.moduleRequest.findMany({ where: { eventId: ids.event, moduleKey: "merchandise", status: "PENDING" } });
  assert(pending.length === 1, "one pending request remains");
  assert((await prisma.auditLog.count({ where: { eventId: ids.event, action: "MODULE_REQUEST_CREATED" } })) === 1, "one audit entry: the losers rolled back");
  const queued = await prisma.messageOutbox.findMany({ where: { templateKey: "MODULE_REQUEST_SUBMITTED", idempotencyKey: { contains: pending[0].id } } });
  assert(queued.length === 1 && queued[0].recipientEmail === OFFICE, "one office email, to the configured address only");
  assert(!queued[0].bodyTextSnapshot.includes("{{"), "braces in free text are broken up");

  // 3. Delivery of that message sends it and mints no token.
  const tokensBefore = await prisma.passwordResetToken.count();
  let sentBody = "";
  const delivered = await processAccountEmailQueue({
    messageIds: [queued[0].id],
    dependencies: {
      configuration: { apiKey: "synthetic-never-used", apiUrl: "https://resend.invalid" },
      sendEmail: (async (input: { bodyText: string }) => { sentBody = input.bodyText; return { provider: "RESEND", providerMessageId: `${P}_provider` }; }) as never,
    },
  });
  assert(delivered.sentIds.includes(queued[0].id), "the office email is delivered");
  assert(sentBody.includes("{ {account_action_link} }"), "the text arrives as typed, braces apart");
  assert((await prisma.passwordResetToken.count()) === tokensBefore, "delivery minted no account token");

  // 4. Approve enables in the same transaction.
  const approved = await decideModuleRequest(admin, pending[0].id, { decision: "approve" });
  assert(approved.status === "APPROVED", "the request is approved");
  assert((await prisma.eventModule.count({ where: { eventId: ids.event, moduleKey: "merchandise" } })) === 1, "approving turned the module on");
  const approveAudits = await prisma.auditLog.findMany({ where: { eventId: ids.event } });
  assert(["EVENT_MODULE_ENABLED", "MODULE_REQUEST_APPROVED"].every((action) => approveAudits.some((row) => row.action === action)), "both changes are audited");
  assert(!JSON.stringify(approveAudits).includes("Shirts"), "the reason is in no audit row");
  const decided = await prisma.messageOutbox.findUnique({ where: { idempotencyKey: `module-request:${pending[0].id}:decided` } });
  assert(decided?.recipientEmail === requester.email && decided.templateKey === "MODULE_REQUEST_DECIDED", "the requester is emailed");
  const again = await createModuleRequest(requester, ids.event, "merchandise", "Again.").then(() => null, (error: { code?: string }) => error);
  assert(again?.code === "ALREADY_ENABLED", "an approved module has nothing to request");

  // 5. Two administrators deciding at once.
  const { id: raceId } = await createModuleRequest(requester, ids.event, "attendee-community", "Discussion.");
  const race = await Promise.allSettled([
    decideModuleRequest(admin, raceId, { decision: "approve" }),
    decideModuleRequest(admin, raceId, { decision: "decline", declineReason: "No." }),
  ]);
  assert(race.filter((result) => result.status === "fulfilled").length === 1, "one of two concurrent decisions wins");
  assert((await prisma.messageOutbox.count({ where: { idempotencyKey: `module-request:${raceId}:decided` } })) === 1, "the requester is emailed once");

  // 6. Decline, then ask again.
  const { id: declineId } = await createModuleRequest(requester, ids.club, "club-assignments", "Campsites.");
  await decideModuleRequest(admin, declineId, { decision: "decline", declineReason: "Next year." });
  assert((await prisma.eventModule.count({ where: { eventId: ids.club, moduleKey: "club-assignments" } })) === 0, "declining keeps the module off");
  const declineAudit = await prisma.auditLog.findFirstOrThrow({ where: { eventId: ids.club, action: "MODULE_REQUEST_DECLINED" } });
  assert(!JSON.stringify(declineAudit.metadata).includes("Next year."), "the decline reason is not in audit metadata");
  const reasked = await createModuleRequest(requester, ids.club, "club-assignments", "Again.");
  assert(Boolean(reasked.id), "a declined request can be asked for again");

  // 7. Turning the module on directly answers the pending request.
  await enableModule(admin, ids.club, "club-assignments");
  const direct = await prisma.moduleRequest.findUniqueOrThrow({ where: { id: reasked.id } });
  assert(direct.status === "APPROVED" && direct.decidedByUserId === ids.admin, "a direct enable approves the pending request");
  assert((await prisma.messageOutbox.count({ where: { idempotencyKey: `module-request:${reasked.id}:decided` } })) === 1, "the requester is told");

  // 8. A system administrator cannot request.
  const refused = await createModuleRequest(admin, ids.event, "seminar-assignments", "Because.").then(() => null, (error: { code?: string }) => error);
  assert(refused?.code === "SYSTEM_ADMIN_ENABLES_DIRECTLY", "system administrators do not request");

  console.log("Module requests (#741 slice 3): all checks passed.");
}

main()
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
