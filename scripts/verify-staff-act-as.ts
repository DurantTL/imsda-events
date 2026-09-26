/**
 * Proves the staff "act as" guarantees (#442) against a real PostgreSQL
 * database: the partial unique index keeps at most one active act-as per
 * staff session, racing starts on one session never leave two active rows
 * and never fail with anything but a clear conflict, and sign-out never
 * overwrites a Stop acting that already ended the row. Uses fictitious rows
 * it creates and removes itself.
 *
 *   npm run test:staff-act-as
 */
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  actAsAreaCoordinator,
  actAsClubDirector,
  endActiveActAsOnSignOut,
  StaffActAsError,
  stopActingAs,
} from "../modules/organizations/staff-act-as";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "staffactas";
const userId = `${P}_admin`;
const sessionId = `${P}_session`;
const clubId = `${P}_club`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorUserId: userId } });
  await prisma.staffActAs.deleteMany({ where: { userId } });
  await prisma.userSession.deleteMany({ where: { userId } });
  await prisma.organization.deleteMany({ where: { id: clubId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

const activeRows = () => prisma.staffActAs.count({ where: { staffSessionId: sessionId, endedAt: null } });

async function main() {
  await cleanup();
  await prisma.user.create({ data: { id: userId, email: `${P}@example.test`, displayName: "Test Admin", globalRole: "SYSTEM_ADMIN" } });
  await prisma.userSession.create({
    data: { id: sessionId, userId, tokenHash: `${P}_token_hash`, expiresAt: new Date(Date.now() + 8 * 3_600_000) },
  });
  await prisma.organization.create({ data: { id: clubId, type: "CLUB", name: "Staff Act As Test Club", normalizedName: "staff act as test club" } });
  const staff = { id: userId };

  // 1. The index itself: a second active row for the same session is refused.
  await prisma.staffActAs.create({ data: { userId, staffSessionId: sessionId, role: "AREA_COORDINATOR", expiresAt: new Date(Date.now() + 3_600_000) } });
  const duplicate = await prisma.staffActAs.create({
    data: { userId, staffSessionId: sessionId, role: "AREA_COORDINATOR", expiresAt: new Date(Date.now() + 3_600_000) },
  }).then(() => null, (error: unknown) => error);
  assert(duplicate instanceof Prisma.PrismaClientKnownRequestError && duplicate.code === "P2002", `second active row should hit P2002, got ${String(duplicate)}`);
  // An ended row doesn't count against the index.
  await prisma.staffActAs.updateMany({ where: { staffSessionId: sessionId, endedAt: null }, data: { endedAt: new Date(), endedReason: "STOPPED" } });
  await prisma.staffActAs.create({ data: { userId, staffSessionId: sessionId, role: "AREA_COORDINATOR", expiresAt: new Date(Date.now() + 3_600_000) } });
  assert((await activeRows()) === 1, "exactly one active row after ending the first");
  console.log("ok  partial unique index allows one active act-as per staff session");

  // 2. Racing starts on one session: always exactly one active row, and any
  //    loser gets the clear ACT_AS_CONFLICT (409), never a raw database error.
  let conflicts = 0;
  for (let round = 0; round < 15; round += 1) {
    const results = await Promise.allSettled([
      actAsAreaCoordinator(staff, sessionId),
      actAsClubDirector(staff, sessionId, clubId),
      actAsAreaCoordinator(staff, sessionId),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        assert(result.reason instanceof StaffActAsError && result.reason.code === "ACT_AS_CONFLICT", `unexpected start failure: ${String(result.reason)}`);
        conflicts += 1;
      }
    }
    assert(results.some((result) => result.status === "fulfilled"), "at least one racing start should win");
    const active = await activeRows();
    assert(active === 1, `round ${round}: expected exactly one active act-as, found ${active}`);
  }
  console.log(`ok  racing starts always leave exactly one active act-as (${conflicts} reported as ACT_AS_CONFLICT)`);

  // 3. Stop acting, then a late sign-out: the STOPPED reason stands.
  const stopped = await stopActingAs(staff, sessionId);
  assert(stopped, "stop should end the active act-as");
  await endActiveActAsOnSignOut(sessionId);
  const row = await prisma.staffActAs.findUniqueOrThrow({ where: { id: stopped.id }, select: { endedReason: true } });
  assert(row.endedReason === "STOPPED", `sign-out must not overwrite STOPPED, found ${row.endedReason}`);
  assert((await activeRows()) === 0, "nothing active after stop");
  console.log("ok  sign-out never overwrites a Stop acting");

  // 4. Sign-out ends an active act-as.
  await actAsClubDirector(staff, sessionId, clubId);
  await endActiveActAsOnSignOut(sessionId);
  const ended = await prisma.staffActAs.findFirstOrThrow({ where: { staffSessionId: sessionId }, orderBy: { createdAt: "desc" }, select: { endedReason: true } });
  assert(ended.endedReason === "SIGNED_OUT", `sign-out should end the act-as, found ${ended.endedReason}`);
  console.log("ok  sign-out ends the active act-as");
}

main()
  .then(() => console.log("Staff act-as verification passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
