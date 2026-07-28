/**
 * Prints the reviewed audience for a shirt-size request.
 *
 * Read-only, and deliberately stops short of sending. The reviewed-batch
 * machinery — per-batch idempotency, the no-send enqueue boundary, the audit
 * row keyed on the audience fingerprint — is roughly 250 lines in
 * `enqueueBalanceReminderBatch`, and a shirt-size batch deserves the same
 * guarantees rather than a shortcut. Until that path exists, this answers the
 * question staff actually have now: who is still missing a size, and what
 * would the audience be.
 *
 * The fingerprint printed here is the same one a future batch would key on, so
 * a run of this script is a legitimate preview of that batch.
 *
 * Usage:
 *   npm run event:shirt-sizes -- --event womens-retreat-2026
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import {
  computeShirtSizeRequestPreview,
  shirtSizeAttendeeSummary,
  type ShirtSizeCandidate,
} from "@/modules/communications/shirt-size-audience";
import {
  eventCollectsShirtSizes,
  shirtSizeFromResponses,
} from "@/modules/registrations/shirt-sizes";

loadEnvConfig(process.cwd());

function usage(message: string): never {
  console.error(`${message}

Usage:
  npm run event:shirt-sizes -- --event <slug> [--verbose]

  --verbose  List the attendees still missing a size on each registration.`);
  process.exit(1);
}

function readFlag(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) usage(`--${name} needs a value.`);
  return value;
}

async function main() {
  const slug = readFlag("event");
  if (!slug) usage("--event is required.");
  const verbose = process.argv.includes("--verbose");

  const prisma = new PrismaClient();
  try {
    const event = await prisma.event.findUnique({ where: { slug } });
    if (!event) usage(`No event has the slug "${slug}".`);

    const [settings, allTemplates, registrations] = await Promise.all([
      prisma.eventMessageSettings.findFirst({ where: { eventId: event.id } }),
      // Filtered in memory rather than by `key` so the script still runs
      // against a client generated before the SHIRT_SIZE_REQUEST migration —
      // it then reports the template as unavailable, which is the truth.
      prisma.eventMessageTemplate.findMany({
        where: { eventId: event.id },
        select: {
          key: true,
          isEnabled: true,
          versions: {
            where: { status: "PUBLISHED" },
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: { id: true, versionNumber: true },
          },
        },
      }),
      prisma.registration.findMany({
        where: { eventId: event.id },
        select: {
          id: true,
          confirmationCode: true,
          status: true,
          accountHolderPerson: { select: { firstName: true, lastName: true, normalizedEmail: true } },
          attendees: {
            orderBy: { position: "asc" },
            select: { id: true, formResponses: true, person: { select: { firstName: true, lastName: true } } },
          },
        },
      }),
    ]);

    const template = allTemplates.find((row) => row.key === "SHIRT_SIZE_REQUEST") ?? null;
    const publishedVersion = template?.versions[0] ?? null;
    const candidates: ShirtSizeCandidate[] = registrations.map((registration) => ({
      registrationId: registration.id,
      confirmationCode: registration.confirmationCode,
      status: registration.status,
      recipientName: [
        registration.accountHolderPerson.firstName,
        registration.accountHolderPerson.lastName,
      ].join(" ").trim(),
      recipientEmail: registration.accountHolderPerson.normalizedEmail ?? "",
      attendees: registration.attendees.map((attendee) => ({
        attendeeId: attendee.id,
        fullName: [attendee.person?.firstName, attendee.person?.lastName].filter(Boolean).join(" "),
        shirtSize: shirtSizeFromResponses(attendee.formResponses),
      })),
    }));

    const preview = computeShirtSizeRequestPreview(candidates, {
      eventId: event.id,
      eventSupportsShirtSizes: eventCollectsShirtSizes(event),
      deliveryMode: settings?.deliveryMode ?? "DISABLED",
      senderName: settings?.senderName ?? "",
      senderEmail: settings?.senderEmail ?? null,
      replyToEmail: settings?.replyToEmail ?? null,
      templateEnabled: Boolean(template?.isEnabled && publishedVersion),
      templateVersionId: publishedVersion?.id ?? null,
      templateVersionNumber: publishedVersion?.versionNumber ?? null,
      eventSnapshot: {
        name: event.name,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt.toISOString(),
        timezone: event.timezone,
        location: event.location,
      },
    });

    console.log(`${event.name} (${event.slug})`);
    console.log(`Audience fingerprint ${preview.fingerprint.slice(0, 16)}…\n`);
    console.log(`  ${preview.includedCount} registrations would be contacted`);
    console.log(`  ${preview.missingAttendeeCount} attendees still have no shirt size`);
    console.log(`  ${preview.skippedCount} registrations skipped`);
    for (const reason of preview.skipReasons.filter((entry) => entry.count > 0)) {
      console.log(`      ${String(reason.count).padStart(4)}  ${reason.label}`);
    }

    if (!preview.templateEnabled) {
      console.log("\n  ! The SHIRT_SIZE_REQUEST template is missing, disabled, or unpublished.");
    }
    if (preview.deliveryMode !== "EXTERNAL_EMAIL") {
      console.log(`  ! Delivery mode is ${preview.deliveryMode}; nothing would reach a registrant.`);
    }

    if (verbose) {
      console.log("\nAudience:");
      for (const recipient of preview.recipients) {
        console.log(`  ${recipient.confirmationCode.padEnd(28)} ${recipient.recipientEmail}`);
        console.log(shirtSizeAttendeeSummary(recipient).split("\n").map((line) => `      ${line}`).join("\n"));
      }
    } else if (preview.includedCount > 0) {
      console.log("\nRe-run with --verbose to list who is missing a size.");
    }

    console.log("\nThis is a preview. Sending a reviewed shirt-size batch is not wired up yet.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
