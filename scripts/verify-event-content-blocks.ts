/**
 * Proves the public event page content blocks (#816) against a real PostgreSQL
 * database: every block kind saves and reads back through the real repository,
 * custom HTML is stored sanitized and only a system administrator may add,
 * change or remove it (an event administrator's refused save leaves the page
 * untouched), images must be this event's own uploaded images, a published
 * block's image is public while a draft's is not, an image a block shows
 * cannot be deleted, draft blocks stay off the public listing, the registration
 * form lists only the text-style kinds, and deleting a whole event removes its
 * blocks and their images. Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:event-content-blocks
 */
import { loadEnvConfig } from "@next/env";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());
process.env.ASSET_STORAGE_DIR ||= mkdtempSync(path.join(tmpdir(), "content-blocks-assets-"));
const assetDirectory = process.env.ASSET_STORAGE_DIR;

const databaseHost = (() => {
  try { return new URL(process.env.DATABASE_URL ?? "").hostname; } catch { return ""; }
})();
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(databaseHost)) {
  console.error(`Refusing to run: DATABASE_URL points at "${databaseHost || "nothing"}", not a local or CI database.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const P = "blk";
const staffUserId = `${P}_staff`;
const eventId = `${P}_event`;
const otherEventId = `${P}_other_event`;
const slug = `${P}-event`;

// A real 1x1 PNG, so the upload's bytes match the type it claims.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function caught(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await caught(promise);
  assert(
    error && typeof error === "object" && "code" in error && (error as { code: string }).code === code,
    `${message}: expected ${code}, got ${String(error)}`,
  );
}

async function cleanup() {
  const eventIds = [eventId, otherEventId];
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: eventIds } }, { actorUserId: staffUserId }] } });
  // Sections first, so the image references are gone before their files.
  await prisma.eventContentSection.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventAsset.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.user.deleteMany({ where: { id: staffUserId } });
}

async function main() {
  const { createEventAsset, removeEventAsset, findPublishedEventAsset } = await import("../modules/events/asset-repository");
  const {
    listEventContentSections,
    listPublishedEventContentSections,
    listPublishedRegistrationInfoCards,
    replaceEventContent,
  } = await import("../modules/events/content-repository");
  const { eventContentInputSchema } = await import("../modules/events/content-schemas");

  await cleanup();
  await prisma.user.create({ data: { id: staffUserId, email: `${P}-staff@example.test`, displayName: "Blocks Check Staff", globalRole: "SYSTEM_ADMIN" } });
  const eventData = {
    startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T22:00:00Z"), timezone: "America/Chicago", isPublished: true,
    registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30",
  };
  await prisma.event.create({ data: { id: eventId, slug, name: "Blocks check weekend", ...eventData } });
  await prisma.event.create({ data: { id: otherEventId, slug: `${P}-other-event`, name: "Blocks check other", ...eventData } });

  const image = await createEventAsset(eventId, new File([png], "chapel.png", { type: "image/png" }), staffUserId);
  const image2 = await createEventAsset(eventId, new File([png], "lake.png", { type: "image/png" }), staffUserId);
  const document = await createEventAsset(eventId, new File([pdf], "flyer.pdf", { type: "application/pdf" }), staffUserId);
  const foreignImage = await createEventAsset(otherEventId, new File([png], "elsewhere.png", { type: "image/png" }), staffUserId);

  const mapsId = "!1m18!1m12!1m3!1d3000.5!2d-93.6!3d41.6!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2sSynthetic!5e0!3m2!1sen!2sus!4v1700000000000";
  const page = (overrides: Record<string, unknown> = {}) => eventContentInputSchema.parse({
    sections: [
      { kind: "HERO", title: "Blocks check weekend", isPublished: true, data: { assetId: image.id, alt: "A chapel", subtitle: "Join us", button: { label: "Register", target: "REGISTER" }, overlay: 45 } },
      { kind: "IMAGE", title: "On site", body: "Beside the photo.", isPublished: true, data: { assetId: image.id, alt: "A chapel", caption: "Chapel", imageSide: "RIGHT" } },
      { kind: "GALLERY", title: "Photos", isPublished: true, data: { images: [{ assetId: image.id, alt: "A chapel", caption: "One" }, { assetId: image2.id, alt: "A lake", caption: "" }] } },
      { kind: "FORMATTED_TEXT", title: "Welcome", body: "## Hello\n\nSome **bold** text.", placement: "BOTH", isPublished: true },
      { kind: "EMBED", title: "Video", isPublished: true, data: { provider: "YOUTUBE", id: "dQw4w9WgXcQ", title: "Welcome video" } },
      { kind: "EMBED", title: "Map", isPublished: true, data: { provider: "GOOGLE_MAPS", id: mapsId, title: "Map of the camp" } },
      { kind: "FAQ", title: "Questions", placement: "BOTH", isPublished: true, data: { entries: [{ question: "Parking?", answer: "North lot." }] } },
      { kind: "SCHEDULE", title: "Agenda", isPublished: true, data: { rows: [{ day: "Friday", time: "7:00 PM", title: "Worship", location: "Chapel", description: "" }] } },
      { kind: "SPEAKERS", title: "Speakers", isPublished: true, data: { speakers: [{ name: "Pat Example", role: "Pastor", bio: "Synthetic.", assetId: image2.id, alt: "Pat" }, { name: "Sam Example" }] } },
      { kind: "CONTACT", title: "Contact", placement: "BOTH", isPublished: true, data: { contacts: [{ name: "Sam Example", email: "sam@example.org", phone: "(555) 010-0100" }] } },
      { kind: "COUNTDOWN", title: "Starts in", isPublished: true, data: { target: "EVENT_START" } },
      { kind: "CUSTOM_HTML", title: "Welcome banner", body: `<p onclick="x()">Hello</p><script>alert(1)</script><a href="javascript:alert(1)">go</a>`, isPublished: true },
      { kind: "FAQ", title: "Draft questions", isPublished: false, data: { entries: [{ question: "Draft?", answer: "Yes." }] } },
      { kind: "RICH_TEXT", title: "About", body: "Plain text.\n- One", isPublished: true },
    ],
    ...overrides,
  });

  // 1. A system administrator saves every kind; the page reads back as written.
  const saved = await replaceEventContent(eventId, page(), staffUserId, { isSystemAdmin: true });
  assert(saved.length === 14, `all fourteen sections saved (got ${saved.length})`);
  assert(saved.map((section) => section.kind).join() === "HERO,IMAGE,GALLERY,FORMATTED_TEXT,EMBED,EMBED,FAQ,SCHEDULE,SPEAKERS,CONTACT,COUNTDOWN,CUSTOM_HTML,FAQ,RICH_TEXT", "the order is the saved order");
  const hero = saved[0];
  assert((hero.data as { overlay?: number }).overlay === 45 && (hero.data as { focalX?: number }).focalX === 50, "block data round-trips with its defaults filled in");
  assert(saved[3].placement === "BOTH", "formatted text keeps its placement");

  // 2. Custom HTML is stored sanitized.
  const html = saved.find((section) => section.kind === "CUSTOM_HTML");
  assert(html && html.body.includes("<p>Hello</p>") && !/script|onclick|javascript:/i.test(html.body), `custom HTML stored sanitized (got ${html?.body})`);

  // 3. Image references are derived from the data.
  const refs = await prisma.eventContentSectionAsset.findMany({ where: { section: { eventId } }, select: { assetId: true } });
  assert(refs.length === 5, `five image references (hero, image, two gallery, speaker; got ${refs.length})`);

  // 4. An event administrator cannot add, change, retitle or remove custom HTML,
  //    and a refused save leaves the page exactly as it was.
  const before = JSON.stringify(await listEventContentSections(eventId));
  const withoutHtml = page();
  withoutHtml.sections = withoutHtml.sections.filter((section) => section.kind !== "CUSTOM_HTML");
  await expectCode(replaceEventContent(eventId, withoutHtml, staffUserId), "CUSTOM_HTML_FORBIDDEN", "an event administrator cannot remove custom HTML");
  const edited = page();
  const editedHtml = edited.sections.find((section) => section.kind === "CUSTOM_HTML");
  assert(editedHtml, "the fixture has an HTML block");
  editedHtml.body = "<p>Changed</p>";
  await expectCode(replaceEventContent(eventId, edited, staffUserId), "CUSTOM_HTML_FORBIDDEN", "an event administrator cannot edit custom HTML");
  const added = page();
  added.sections.push({ ...editedHtml, title: "A second block", body: "<p>New</p>" });
  await expectCode(replaceEventContent(eventId, added, staffUserId), "CUSTOM_HTML_FORBIDDEN", "an event administrator cannot add custom HTML");
  assert(JSON.stringify(await listEventContentSections(eventId)) === before, "a refused save changed nothing");

  // 5. ... but can save everything else, carrying the existing HTML back unchanged.
  const retitled = page();
  retitled.sections[0].title = "Blocks check weekend, renamed";
  const afterAdminSave = await replaceEventContent(eventId, retitled, staffUserId);
  assert(afterAdminSave[0].title === "Blocks check weekend, renamed", "an event administrator's save of other blocks goes through");
  assert(afterAdminSave.find((section) => section.kind === "CUSTOM_HTML")?.body === html.body, "the HTML block is unchanged");

  // 6. Images must be this event's own uploaded images.
  const foreign = page();
  foreign.sections[1].data = { assetId: foreignImage.id, alt: "Not ours", caption: "", imageSide: "LEFT" };
  await expectCode(replaceEventContent(eventId, foreign, staffUserId, { isSystemAdmin: true }), "ASSET_NOT_IN_EVENT", "another event's image is refused");
  const notImage = page();
  notImage.sections[1].data = { assetId: document.id, alt: "A flyer", caption: "", imageSide: "LEFT" };
  await expectCode(replaceEventContent(eventId, notImage, staffUserId, { isSystemAdmin: true }), "ASSET_NOT_AN_IMAGE", "a PDF is not a block image");
  assert(!eventContentInputSchema.safeParse({ sections: [{ kind: "IMAGE", title: "x", data: { assetId: image.id, alt: "" } }] }).success, "alt text is required");

  // 7. Drafts stay off the public listing; the registration form lists only text-style kinds.
  const published = await listPublishedEventContentSections(eventId);
  assert(published.length === 13 && !published.some((section) => section.title === "Draft questions"), "the public listing leaves out the draft");
  const formCards = await listPublishedRegistrationInfoCards(slug);
  assert(formCards.map((section) => section.kind).sort().join() === "CONTACT,FAQ,FORMATTED_TEXT", `the registration form lists the text-style kinds placed there (got ${formCards.map((section) => section.kind)})`);

  // 8. A published block's image is public; an unreferenced or draft one is not.
  assert(await findPublishedEventAsset(slug, image.id), "a published block's image is public");
  assert(await findPublishedEventAsset(slug, image2.id), "a published speaker or gallery image is public");
  assert(!(await findPublishedEventAsset(slug, document.id)), "an unreferenced file is not public");
  assert(!(await findPublishedEventAsset(`${P}-other-event`, image.id)), "another event's page cannot serve this image");

  // 9. An image a block shows cannot be deleted, published or not.
  await expectCode(removeEventAsset(eventId, image.id, staffUserId), "ASSET_IN_USE", "an image a block shows cannot be deleted");
  const draftOnly = page();
  draftOnly.sections.forEach((section) => { section.isPublished = false; });
  await replaceEventContent(eventId, draftOnly, staffUserId, { isSystemAdmin: true });
  assert(!(await findPublishedEventAsset(slug, image.id)), "unpublishing the blocks takes the image down");
  await expectCode(removeEventAsset(eventId, image.id, staffUserId), "ASSET_IN_USE", "a draft block's image cannot be deleted either");

  // 10. Once no block shows it, the image can be deleted.
  const textOnly = eventContentInputSchema.parse({ sections: [{ kind: "RICH_TEXT", title: "About", body: "Plain.", isPublished: true }] });
  await replaceEventContent(eventId, textOnly, staffUserId, { isSystemAdmin: true });
  assert(await prisma.eventContentSectionAsset.count({ where: { section: { eventId } } }) === 0, "no image references remain");
  await removeEventAsset(eventId, image.id, staffUserId);

  // 11. Deleting the whole event removes its blocks and their images.
  await replaceEventContent(eventId, page({ sections: [
    { kind: "IMAGE", title: "On site", isPublished: true, data: { assetId: image2.id, alt: "A lake", caption: "", imageSide: "LEFT" } },
  ] }), staffUserId, { isSystemAdmin: true });
  await prisma.auditLog.deleteMany({ where: { eventId } });
  await prisma.event.delete({ where: { id: eventId } });
  assert(await prisma.eventContentSection.count({ where: { eventId } }) === 0, "the event's sections are gone");
  assert(await prisma.eventAsset.count({ where: { eventId } }) === 0, "the event's files are gone");

  console.log("Event content blocks verified against a real database.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("Cleanup failed:", error));
    await prisma.$disconnect();
    rmSync(assetDirectory, { recursive: true, force: true });
  });
