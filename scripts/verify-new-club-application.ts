/**
 * Proves new club applications (#817) against a real PostgreSQL database, a
 * local stub standing in for the email provider, and a temporary private
 * storage folder. Synthetic data only (every address is on a .test domain).
 *
 * - A public submission saves a waiting application, with a private attachment
 *   stored under a generated name, and creates no club and no invite.
 * - The conference notification goes to the address set in system settings (not
 *   one in code), carries the club, church and director names and a link, and
 *   nothing else: no phone, address, director email or attachment.
 * - System administrators and Area Coordinators see the queue and the
 *   attachment; an Area Coordinator, a signed-out visitor and other staff
 *   cannot decide.
 * - The director's Sterling Volunteers status is shown (Clear, No record), and
 *   possible duplicates are flagged (same name and church, a church that has a
 *   club). Neither blocks anything.
 * - Approving creates the club under its church and the director's club invite
 *   once: a second approval is refused, and two racing approvals make exactly
 *   one club and one invite. The invite is emailed and, accepted, gives the
 *   director the club.
 * - Declining emails the applicant with the reason and creates nothing.
 * - A private link is emailed with the token minted at delivery (only its hash
 *   is stored), opens the same application for the invited email, and works
 *   once.
 * - Every audit row carries ids only.
 *
 * Creates and removes its own rows. Needs a local database with a system
 * administrator (npm run db:seed).
 *
 *   npm run test:new-club-application
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const stamp = `nca817${Date.now().toString(36)}`;
const storageDir = mkdtempSync(path.join(tmpdir(), "new-club-verify-"));
const notifyAddress = `${stamp}-notify@imsda-events.test`;
const directorEmail = `${stamp}-dana@imsda-events.test`;
const directorPhone = "555-0117";
const directorAddress = `${stamp} 100 Example Road, Sampletown, ZZ 00000`;

type Sent = { to: string[]; subject: string; text: string };
const sent: Sent[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectRefused(work: () => Promise<unknown>, check: (error: unknown) => boolean, message: string) {
  try {
    await work();
  } catch (error) {
    assert(check(error), `${message} (refused with a different error: ${String(error)})`);
    return;
  }
  throw new Error(`FAILED: ${message} (it was allowed)`);
}

const pdf = () => new File([new TextEncoder().encode("%PDF-1.4 synthetic page")], `${stamp}-signed-page.pdf`, { type: "application/pdf" });

async function cleanup(originalNotify: string | null | undefined) {
  const applications = await prisma.newClubApplication.findMany({ where: { clubName: { startsWith: stamp } }, select: { id: true, createdOrganizationId: true } });
  const applicationIds = applications.map((row) => row.id);
  const clubs = await prisma.organization.findMany({ where: { name: { startsWith: stamp }, type: "CLUB" }, select: { id: true } });
  const clubIds = clubs.map((club) => club.id);
  const messages = await prisma.messageOutbox.findMany({
    where: { OR: [{ recipientEmail: { startsWith: stamp } }, { recipientEmail: notifyAddress }] },
    select: { id: true },
  });
  const inviteIds = [
    ...(await prisma.newClubApplicationInvite.findMany({ where: { email: { startsWith: stamp } }, select: { id: true } })).map((row) => row.id),
    ...(await prisma.clubInvite.findMany({ where: { organizationId: { in: clubIds } }, select: { id: true } })).map((row) => row.id),
  ];
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...applicationIds, ...clubIds, ...inviteIds] } } });
  await prisma.newClubApplication.deleteMany({ where: { id: { in: applicationIds } } });
  await prisma.newClubApplicationInvite.deleteMany({ where: { email: { startsWith: stamp } } });
  await prisma.clubDirectorGrant.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.clubInvite.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.messageOutbox.deleteMany({ where: { id: { in: messages.map((message) => message.id) } } });
  await prisma.organization.deleteMany({ where: { type: "CLUB", id: { in: clubIds } } });
  await prisma.person.deleteMany({ where: { normalizedEmail: { startsWith: stamp } } });
  await prisma.backgroundCheckUpload.deleteMany({ where: { format: `${stamp}-test` } });
  await prisma.attendeeAccount.deleteMany({ where: { email: { startsWith: stamp } } });
  await prisma.organization.deleteMany({ where: { type: "CHURCH", name: { startsWith: stamp } } });
  await prisma.platformSettings.updateMany({ where: { id: "platform" }, data: { newClubApplicationEmail: originalNotify ?? null } });
  rmSync(storageDir, { recursive: true, force: true });
}

async function main() {
  // A stand-in for the email provider: nothing leaves this machine, and every message is readable here.
  let stubSequence = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { to?: string[]; subject?: string; text?: string };
      sent.push({ to: parsed.to ?? [], subject: parsed.subject ?? "", text: parsed.text ?? "" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `${stamp}-stub-${++stubSequence}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  process.env.RESEND_API_URL = `http://127.0.0.1:${port}`;
  process.env.RESEND_API_KEY = "re_synthetic_stub_key";
  process.env.ACCOUNT_EMAIL_SENDER_ADDRESS = "events@imsda-events.test";
  process.env.ASSET_STORAGE_DIR = storageDir;
  process.env.APP_BASE_URL = "http://localhost:3000";

  const repo = await import("../modules/club-applications/repository");
  const { newClubApplicationInputSchema } = await import("../modules/club-applications/domain");
  const { acceptClubInvite } = await import("../modules/club-imports/invites");
  const { hashOpaqueToken } = await import("../modules/access/tokens");

  const admin = await prisma.user.findFirst({ where: { globalRole: "SYSTEM_ADMIN" }, select: { id: true, email: true, displayName: true, globalRole: true } });
  assert(admin, "needs a system administrator in the local database (npm run db:seed)");
  const otherStaff = { id: admin.id, email: admin.email, displayName: admin.displayName, globalRole: null } as const;
  const sysAdmin = { id: admin.id, email: admin.email, displayName: admin.displayName, globalRole: "SYSTEM_ADMIN" as const };

  const settingsBefore = await prisma.platformSettings.findUnique({ where: { id: "platform" }, select: { newClubApplicationEmail: true } });
  await prisma.platformSettings.upsert({ where: { id: "platform" }, update: { newClubApplicationEmail: notifyAddress }, create: { id: "platform", newClubApplicationEmail: notifyAddress } });

  try {
    const churchA = await prisma.organization.create({ data: { type: "CHURCH", name: `${stamp} Hills SDA Church`, normalizedName: `${stamp} hills sda church`, isActive: true }, select: { id: true } });
    const churchB = await prisma.organization.create({ data: { type: "CHURCH", name: `${stamp} Valley SDA Church`, normalizedName: `${stamp} valley sda church`, isActive: true }, select: { id: true } });
    const now = new Date();
    const opened = now.getTime() - 60_000;
    const application = (overrides: Record<string, unknown> = {}) => newClubApplicationInputSchema.parse({
      clubName: `${stamp} Trailblazers`,
      clubType: "PATHFINDER",
      sponsoringChurchId: churchA.id,
      pastorName: "Pat Pastor",
      directorName: "Dana Director",
      directorAddress,
      directorEmail,
      directorHomePhone: directorPhone,
      philosophyAgreed: true,
      pastorSignature: "Pat Pastor",
      headElderSignature: "Hal Elder",
      clerkSignature: "Cleo Clerk",
      directorSignature: "Dana Director",
      otherBoardMembers: ["Ben Board"],
      note: "Synthetic note",
      formOpenedAt: opened,
      ...overrides,
    });

    // 1. A public submission saves a waiting application and creates nothing else.
    const clubsBefore = await prisma.organization.count({ where: { type: "CLUB" } });
    const invitesBefore = await prisma.clubInvite.count();
    const first = await repo.submitNewClubApplication(application(), { attachment: pdf(), now });
    const saved = await prisma.newClubApplication.findUniqueOrThrow({ where: { id: first.id } });
    assert(saved.status === "PENDING" && saved.source === "PUBLIC", "a public submission waits as PENDING from the PUBLIC source");
    const storageKey = saved.attachmentStorageKey;
    assert(storageKey, "the attachment has a storage key");
    assert(storageKey.startsWith("new-club-applications") && existsSync(path.join(storageDir, storageKey)), "the attachment is stored privately under a generated name");
    assert(!storageKey.includes(stamp), "the stored name is not the uploaded name");
    assert(await prisma.organization.count({ where: { type: "CLUB" } }) === clubsBefore, "a submission creates no club");
    assert(await prisma.clubInvite.count() === invitesBefore, "a submission creates no invite");
    await expectRefused(() => repo.submitNewClubApplication(application({ formOpenedAt: now.getTime() - 100 }), { now }), (error) => (error as { code?: string }).code === "TOO_QUICK", "a form sent in a fraction of a second is refused");
    await expectRefused(() => repo.submitNewClubApplication(application(), { attachment: new File(["MZ not a pdf"], "x.pdf", { type: "application/pdf" }), now }), (error) => (error as { code?: string }).code === "ATTACHMENT_CONTENT", "a file that isn't what it says is refused");
    await expectRefused(() => repo.submitNewClubApplication(application({ sponsoringChurchId: "no-such-church" }), { now }), (error) => (error as { code?: string }).code === "INVALID_CHURCH", "a church outside the directory is refused");

    // 2. The notification: the configured address only, with the three names and a link, and nothing sensitive.
    const notice = sent.find((message) => message.to.includes(notifyAddress));
    assert(notice, "the configured notification address was emailed");
    assert(notice.text.includes(`${stamp} Trailblazers`) && notice.text.includes(`${stamp} Hills SDA Church`) && notice.text.includes("Dana Director"), "the notice names the club, church and director");
    assert(notice.text.includes("/admin/clubs/applications"), "the notice links to the queue");
    for (const secret of [directorPhone, directorAddress, directorEmail, "Synthetic note", "Hal Elder", "Ben Board", "signed-page", ".pdf"]) {
      assert(!notice.text.includes(secret) && !notice.subject.includes(secret), `the notice does not contain ${secret}`);
    }
    const noticeRow = await prisma.messageOutbox.findFirstOrThrow({ where: { recipientEmail: notifyAddress, templateKey: "NEW_CLUB_APPLICATION_SUBMITTED" }, select: { status: true } });
    assert(noticeRow.status !== "PENDING", "the notice left the outbox");

    // 3. Who can see and who can decide.
    for (const viewer of ["SYSTEM_ADMIN", "AREA_COORDINATOR"] as const) {
      const list = await repo.listNewClubApplications(viewer, now);
      const record = list.find((row) => row.id === first.id);
      assert(record && record.director.email === directorEmail && record.attachment, `${viewer} sees the application, the director and the attachment`);
      assert(await repo.getApplicationAttachment(viewer, first.id), `${viewer} can open the attachment`);
    }
    await expectRefused(() => repo.listNewClubApplications(null), (error) => (error as { status?: number }).status === 403, "an unknown viewer sees no applications");
    await expectRefused(() => repo.getApplicationAttachment(null, first.id), (error) => (error as { status?: number }).status === 403, "an unknown viewer can't open the attachment");
    await expectRefused(() => repo.decideNewClubApplication(otherStaff, first.id, { decision: "approve" }), (error) => (error as { status?: number }).status === 403, "staff who aren't system administrators can't decide");
    await expectRefused(() => repo.decideNewClubApplication(null, first.id, { decision: "decline" }), (error) => (error as { status?: number }).status === 401, "a signed-out visitor can't decide");
    assert((await prisma.newClubApplication.findUniqueOrThrow({ where: { id: first.id } })).status === "PENDING", "nothing was decided");

    // 4. Sterling Volunteers: No record, then Clear once the director matches a person with a current check. A flag only.
    const noRecord = (await repo.listNewClubApplications("SYSTEM_ADMIN", now)).find((row) => row.id === first.id);
    assert(noRecord?.sterling === "NO_RECORD", "a director with no person on file shows No record");
    const person = await prisma.person.create({ data: { firstName: "Dana", lastName: "Director", normalizedEmail: directorEmail }, select: { id: true } });
    const upload = await prisma.backgroundCheckUpload.create({ data: { format: `${stamp}-test`, rowCount: 1, added: 1, changed: 0, dropped: 0, uploadedByUserId: admin.id }, select: { id: true } });
    const entry = await prisma.backgroundCheckEntry.create({
      data: { uploadId: upload.id, line: 1, firstName: "Dana", lastName: "Director", identityKey: `${stamp}-entry`, checkedOn: "2026-01-02", expiresOn: "2030-01-02" },
      select: { id: true },
    });
    await prisma.backgroundCheckMatch.create({ data: { personId: person.id, entryId: entry.id, matchedBy: "MANUAL" } });
    const clear = (await repo.listNewClubApplications("AREA_COORDINATOR", now)).find((row) => row.id === first.id);
    assert(clear?.sterling === "CLEAR" && !clear.sterlingNameMismatch && !clear.sterlingAmbiguous, "a director with a current Sterling Volunteers check shows Clear, unambiguously, under the same name");
    const stranger = await repo.submitNewClubApplication(application({ clubName: `${stamp} Mismatch`, directorName: "Someone Else", directorSignature: "Someone Else" }), { now });
    const mismatch = (await repo.listNewClubApplications("SYSTEM_ADMIN", now)).find((row) => row.id === stranger.id);
    assert(mismatch?.sterlingNameMismatch && mismatch.sterling === "NO_RECORD", "an email matched only to a person with a different name shows No record, with the mismatch marked, never that person's Clear");
    await repo.decideNewClubApplication(sysAdmin, stranger.id, { decision: "decline" }, now);
    await prisma.backgroundCheckEntry.update({ where: { id: entry.id }, data: { expiresOn: "2020-01-02" } });
    const expired = (await repo.listNewClubApplications("SYSTEM_ADMIN", now)).find((row) => row.id === first.id);
    assert(expired?.sterling === "NOT_COMPLIANT", "an expired check shows Not in compliance");

    // 5. Possible duplicates are flagged: the same name at the same church, and a church that already has a club.
    const existing = await prisma.organization.create({ data: { type: "CLUB", name: `${stamp} Trailblazers`, normalizedName: `${stamp} trailblazers`, parentOrganizationId: churchA.id, isActive: true }, select: { id: true } });
    const sameName = (await repo.listNewClubApplications("SYSTEM_ADMIN", now)).find((row) => row.id === first.id);
    assert(sameName?.duplicates.some((flag) => flag.kind === "SAME_NAME_AND_CHURCH"), "the same name at the same church is flagged");
    const other = await repo.submitNewClubApplication(application({ clubName: `${stamp} Eagles` }), { now });
    const churchHasClub = (await repo.listNewClubApplications("SYSTEM_ADMIN", now)).find((row) => row.id === other.id);
    assert(churchHasClub?.duplicates.some((flag) => flag.kind === "CHURCH_HAS_CLUB"), "a church that already has a club is flagged");
    await prisma.organization.delete({ where: { id: existing.id } });
    await repo.decideNewClubApplication(sysAdmin, other.id, { decision: "decline" }, now);

    // 6. Approving creates the club and the director's invite, once.
    sent.length = 0;
    const approved = await repo.decideNewClubApplication(sysAdmin, first.id, { decision: "approve" }, now);
    assert(approved.status === "APPROVED" && approved.organizationId, "approving returns the new club");
    const club = await prisma.organization.findUniqueOrThrow({ where: { id: approved.organizationId } });
    assert(club.type === "CLUB" && club.parentOrganizationId === churchA.id && club.name === `${stamp} Trailblazers` && club.isActive, "the club is an active CLUB under the sponsoring church");
    assert(club.sourceOrgType === "Pathfinder Club", "a Pathfinder application makes a Pathfinder club");
    const invites = await prisma.clubInvite.findMany({ where: { organizationId: club.id } });
    assert(invites.length === 1 && invites[0]!.role === "DIRECTOR" && invites[0]!.email === directorEmail && invites[0]!.status === "SENT", "one director invite was sent to the director");
    const inviteEmailSent = sent.find((message) => message.to.includes(directorEmail));
    assert(inviteEmailSent?.text.includes("approved your application"), "the director was emailed the club invite");
    await expectRefused(() => repo.decideNewClubApplication(sysAdmin, first.id, { decision: "approve" }, now), (error) => (error as { code?: string }).code === "ALREADY_DECIDED", "a second approval is refused");
    await expectRefused(() => repo.decideNewClubApplication(sysAdmin, first.id, { decision: "decline" }, now), (error) => (error as { code?: string }).code === "ALREADY_DECIDED", "a decline after an approval is refused");
    assert(await prisma.organization.count({ where: { type: "CLUB", name: `${stamp} Trailblazers` } }) === 1 && await prisma.clubInvite.count({ where: { organizationId: club.id } }) === 1, "still exactly one club and one invite");

    // The director signs in and accepts: the ordinary invite flow lands them in the new club.
    const account = await prisma.attendeeAccount.create({ data: { email: directorEmail, displayName: "Dana Director", status: "ACTIVE", emailVerifiedAt: now }, select: { id: true } });
    await acceptClubInvite(invites[0]!.id, { id: account.id, verifiedEmail: directorEmail }, now);
    const grant = await prisma.clubDirectorGrant.findFirst({ where: { organizationId: club.id, attendeeAccountId: account.id, revokedAt: null } });
    assert(grant?.role === "DIRECTOR", "accepting the invite makes the applicant the new club's director");

    // 7. Two racing approvals make exactly one club and one invite.
    const racer = await repo.submitNewClubApplication(application({ clubName: `${stamp} Racers`, sponsoringChurchId: churchB.id, directorEmail: `${stamp}-racer@imsda-events.test` }), { now });
    const race = await Promise.allSettled([
      repo.decideNewClubApplication(sysAdmin, racer.id, { decision: "approve" }, now),
      repo.decideNewClubApplication(sysAdmin, racer.id, { decision: "approve" }, now),
      repo.decideNewClubApplication(sysAdmin, racer.id, { decision: "approve" }, now),
    ]);
    assert(race.filter((result) => result.status === "fulfilled").length === 1, "exactly one of three racing approvals succeeds");
    assert(await prisma.organization.count({ where: { type: "CLUB", name: `${stamp} Racers` } }) === 1, "racing approvals make one club");
    const racerClub = await prisma.organization.findFirstOrThrow({ where: { type: "CLUB", name: `${stamp} Racers` }, select: { id: true } });
    assert(await prisma.clubInvite.count({ where: { organizationId: racerClub.id } }) === 1, "racing approvals make one invite");

    // An application whose church was typed as "Other" needs one from the directory chosen first.
    const typed = await repo.submitNewClubApplication(application({ clubName: `${stamp} Fellowship`, sponsoringChurchId: null, sponsoringChurchOther: "Some Fellowship", directorEmail: `${stamp}-typed@imsda-events.test` }), { now });
    await expectRefused(() => repo.decideNewClubApplication(sysAdmin, typed.id, { decision: "approve" }, now), (error) => (error as { code?: string }).code === "CHURCH_REQUIRED", "an 'Other' church must be matched to the directory before approving");
    assert((await prisma.newClubApplication.findUniqueOrThrow({ where: { id: typed.id } })).status === "PENDING", "the refused approval changed nothing");
    await repo.decideNewClubApplication(sysAdmin, typed.id, { decision: "approve", sponsoringChurchId: churchB.id }, now);
    const typedClub = await prisma.organization.findFirstOrThrow({ where: { type: "CLUB", name: `${stamp} Fellowship` }, select: { parentOrganizationId: true } });
    assert(typedClub.parentOrganizationId === churchB.id, "the chosen church sponsors the club");

    // 8. Declining emails the applicant and creates nothing.
    const declined = await repo.submitNewClubApplication(application({ clubName: `${stamp} Declined`, sponsoringChurchId: churchB.id, directorEmail: `${stamp}-declined@imsda-events.test` }), { now });
    sent.length = 0;
    await repo.decideNewClubApplication(sysAdmin, declined.id, { decision: "decline", declineReason: "Please apply again in the spring." }, now);
    const declineEmail = sent.find((message) => message.to.includes(`${stamp}-declined@imsda-events.test`));
    assert(declineEmail?.text.includes("Please apply again in the spring."), "the applicant was emailed the reason");
    assert(await prisma.organization.count({ where: { type: "CLUB", name: `${stamp} Declined` } }) === 0, "a decline creates no club");
    assert((await prisma.newClubApplication.findUniqueOrThrow({ where: { id: declined.id } })).declineReason === "Please apply again in the spring.", "the reason is kept on the application");

    // 9. A private link: emailed with a token minted at delivery, opens the application for the invited email, works once.
    sent.length = 0;
    const invitedEmail = `${stamp}-invited@imsda-events.test`;
    await repo.createNewClubInvite(sysAdmin, { email: invitedEmail, name: "Ivy Invited" }, now);
    const linkEmail = sent.find((message) => message.to.includes(invitedEmail));
    assert(linkEmail, "the private link was emailed");
    const token = /\/clubs\/register\/([A-Za-z0-9_-]+)/.exec(linkEmail.text)?.[1];
    assert(token, "the email carries the private link");
    const inviteRow = await prisma.newClubApplicationInvite.findFirstOrThrow({ where: { email: invitedEmail } });
    assert(inviteRow.tokenHash === hashOpaqueToken(token) && !JSON.stringify(inviteRow).includes(token), "only the token's hash is stored");
    const queued = await prisma.messageOutbox.findFirstOrThrow({ where: { recipientEmail: invitedEmail }, select: { bodyTextSnapshot: true } });
    assert(!queued.bodyTextSnapshot.includes(token), "the queued message holds no token");
    const prefill = await repo.resolveNewClubInvite(token, now);
    assert(prefill?.email === invitedEmail, "the link opens the application with the invited email");
    const viaLink = await repo.submitNewClubApplication(application({ clubName: `${stamp} Invited Club`, sponsoringChurchId: churchB.id, directorEmail: invitedEmail }), { inviteToken: token, now });
    const viaLinkRow = await prisma.newClubApplication.findUniqueOrThrow({ where: { id: viaLink.id } });
    assert(viaLinkRow.source === "INVITE" && viaLinkRow.invitedEmail === invitedEmail, "an application from the link is marked INVITE and keeps the invited address");
    assert(await repo.resolveNewClubInvite(token, now) === null, "the link no longer opens once used");
    await expectRefused(() => repo.submitNewClubApplication(application({ clubName: `${stamp} Invited Again`, directorEmail: invitedEmail }), { inviteToken: token, now }), (error) => (error as { code?: string }).code === "INVITE_UNAVAILABLE", "a used link can't submit again");
    await expectRefused(() => repo.createNewClubInvite(otherStaff, { email: `${stamp}-x@imsda-events.test` }, now), (error) => (error as { status?: number }).status === 403, "only a system administrator can send a link");

    // 10. Every audit row carries ids only.
    const audits = await prisma.auditLog.findMany({ where: { action: { startsWith: "NEW_CLUB_APPLICATION_" }, createdAt: { gte: new Date(now.getTime() - 60_000) } } });
    assert(audits.length >= 6, "decisions and submissions were audited");
    const flat = JSON.stringify(audits.map((row) => ({ summary: row.summary, metadata: row.metadata })));
    for (const secret of [directorEmail, "Dana", directorPhone, directorAddress, "Synthetic note", "Please apply again", "Hal Elder", `${stamp} Trailblazers`]) {
      assert(!flat.includes(secret), `audit rows do not contain ${secret}`);
    }
    assert(audits.some((row) => row.action === "NEW_CLUB_APPLICATION_APPROVED" && row.actorUserId === admin.id), "an approval is audited with its actor");

    console.log("New club application checks passed.");
  } finally {
    await cleanup(settingsBefore?.newClubApplicationEmail);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
