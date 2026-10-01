/**
 * Real-browser check of the printable name badge page (#717).
 *
 * Renders /check-in/badges in headless Chromium with print media emulation,
 * saves it with page.pdf({ format: "Letter", preferCSSPageSize: true }), and
 * asserts that what comes out of the printer is only label sheets:
 *
 *  - the PDF has ceil(labels / perSheet) pages (no blank first or last page);
 *  - no page chrome text ("Skip to main content", "Badge artwork", ...);
 *  - every PDF page is a US Letter page, in the chosen orientation of the
 *    sheet (the sheet itself is always 8.5 x 11 in);
 *  - the first label sits where the Avery template says (Presta 94237 is
 *    1 in from the top and 0.85 in from the left, +/- 0.02 in), and the whole
 *    2 x 4 grid lands on the measured pitch.
 *
 * Needs a running app (`npm run build && npm run start`, or `npm run dev`), a
 * migrated and seeded LOCAL database, and Chromium. It adds synthetic
 * attendees named "Badgecheck NNN" to the seeded Women's Retreat event.
 *
 *   BADGE_PRINT_BASE_URL=http://localhost:3717 \
 *   BADGE_PRINT_OUT_DIR=/tmp/badge-print npm run test:badge-print
 *
 * Environment:
 *   BADGE_PRINT_BASE_URL   default http://localhost:3000
 *   BADGE_PRINT_OUT_DIR    PDFs and page-1 PNGs are saved here (default: a temp dir)
 *   BADGE_PRINT_ATTENDEES  total synthetic attendees to have on the event (default 30)
 *   BADGE_PRINT_STAFF_EMAIL seeded staff account to sign in as (default the administrator;
 *                          use checkin@imsda-events.test to render without the artwork panel)
 *   BADGE_PRINT_ONLY       run only the variants whose name contains this text
 *   BADGE_PRINT_BROWSER    path to a Chromium executable (default: Playwright's)
 *   DATABASE_URL           the local database the app uses
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Page } from "playwright-core";
import { badgeTemplates, type BadgeTemplateId } from "../modules/checkin/badge-labels";

const baseUrl = (process.env.BADGE_PRINT_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const outDir = process.env.BADGE_PRINT_OUT_DIR
  ?? mkdtempSync(path.join(tmpdir(), "badge-print-"));
const targetAttendees = Number(process.env.BADGE_PRINT_ATTENDEES ?? 30);
const eventId = "evt_wr26";
const staffEmail = process.env.BADGE_PRINT_STAFF_EMAIL ?? "admin@imsda-events.test";
const toleranceIn = 0.02;
const forbiddenText = ["Skip to main content", "Badge artwork", "Upload artwork", "No background selected"];

/** First-label offsets and pitch, in inches, from each template's sheet layout. */
const expectedGrid: Record<BadgeTemplateId, {
  top: number; left: number; columns: number; rows: number;
  columnPitch: number; rowPitch: number;
}> = {
  "avery-5395": { top: 0.833334, left: 0.875, columns: 2, rows: 4, columnPitch: 3.375, rowPitch: 2.333333 },
  "avery-5392": { top: 1, left: 0.25, columns: 2, rows: 3, columnPitch: 4, rowPitch: 3 },
  // Avery's Presta 94237 template: 0.85 in side margins, 1 in top and bottom,
  // 0.8 in between columns and 0.3333 in between rows.
  "avery-presta-94237": { top: 1, left: 0.85, columns: 2, rows: 4, columnPitch: 3.8, rowPitch: 2.333333 },
};

type Variant = {
  name: string;
  template: BadgeTemplateId;
  orientation: "portrait" | "landscape";
  query?: Record<string, string>;
};

const variants: Variant[] = [];
for (const template of Object.keys(badgeTemplates) as BadgeTemplateId[]) {
  for (const orientation of ["landscape", "portrait"] as const) {
    variants.push({ name: `${template}-${orientation}`, template, orientation });
  }
}
variants.push(
  {
    name: "avery-presta-94237-landscape-size130-no-title-no-type",
    template: "avery-presta-94237",
    orientation: "landscape",
    query: { size: "130", title: "0", type: "0", positionField: "" },
  },
  {
    name: "avery-presta-94237-portrait-size80",
    template: "avery-presta-94237",
    orientation: "portrait",
    query: { size: "80", title: "1", type: "1" },
  },
  {
    name: "avery-presta-94237-landscape-start5",
    template: "avery-presta-94237",
    orientation: "landscape",
    query: { start: "5" },
  },
);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (!condition) failures.push(message);
  console.log(`${condition ? "  ok  " : " FAIL "} ${message}`);
}

async function seedSyntheticAttendees(prisma: PrismaClient) {
  const types = ["ATTENDEE", "TEEN", "WORKER"];
  const active = await prisma.registrationAttendee.count({
    where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
  });
  for (let index = active; index < targetAttendees; index += 1) {
    const n = String(index + 1).padStart(3, "0");
    const person = await prisma.person.upsert({
      where: { normalizedEmail: `badgecheck.${n}@example.test` },
      update: {},
      create: { firstName: "Badgecheck", lastName: `Sample${n}`, normalizedEmail: `badgecheck.${n}@example.test` },
    });
    const registration = await prisma.registration.upsert({
      where: { eventId_confirmationCode: { eventId, confirmationCode: `BADGE-${n}` } },
      update: {},
      create: {
        eventId,
        accountHolderPersonId: person.id,
        confirmationCode: `BADGE-${n}`,
        status: "CONFIRMED",
        totalAmount: 0,
        submittedAt: new Date("2026-08-01T15:00:00.000Z"),
      },
    });
    const existing = await prisma.registrationAttendee.findFirst({
      where: { registrationId: registration.id, personId: person.id },
    });
    if (!existing) {
      await prisma.registrationAttendee.create({
        data: {
          eventId,
          registrationId: registration.id,
          personId: person.id,
          attendeeType: types[index % types.length],
          profileSnapshot: { firstName: "Badgecheck", lastName: `Sample${n}` },
        },
      });
    }
  }
  return prisma.registrationAttendee.count({
    where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } },
  });
}

type PdfInfo = { pages: number; text: string; pageSizesIn: Array<[number, number]>; textPerPage: string[] };

async function readPdf(data: Uint8Array): Promise<PdfInfo> {
  // The legacy build runs under Node without a canvas.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const textPerPage: string[] = [];
  const pageSizesIn: Array<[number, number]> = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const [x0, y0, x1, y1] = page.view;
    pageSizesIn.push([(x1 - x0) / 72, (y1 - y0) / 72]);
    const content = await page.getTextContent();
    textPerPage.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return { pages: document.numPages, text: textPerPage.join("\n"), pageSizesIn, textPerPage };
}

/**
 * Staff sign-in needs a second factor, so the check mints a session for the
 * seeded administrator directly in the local database and sets its cookie.
 */
async function signIn(page: Page, prisma: PrismaClient) {
  const { createDatabaseSession, SESSION_COOKIE_NAME } = await import("../modules/access/session-store");
  const user = await prisma.user.findUnique({ where: { email: staffEmail } });
  if (!user) throw new Error("The seeded administrator is missing. Run `npm run db:seed` first.");
  const session = await createDatabaseSession(user.id, null);
  await page.context().addCookies([{
    name: SESSION_COOKIE_NAME,
    value: session.token,
    url: baseUrl,
    httpOnly: true,
    expires: Math.floor(session.expiresAt.getTime() / 1000),
  }]);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const prisma = new PrismaClient();
  const total = await seedSyntheticAttendees(prisma);
  console.log(`Event has ${total} active synthetic attendees; output in ${outDir}`);

  const browser = await chromium.launch({
    executablePath: process.env.BADGE_PRINT_BROWSER || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await signIn(page, prisma);

    const only = process.env.BADGE_PRINT_ONLY;
    for (const variant of variants.filter((candidate) => !only || candidate.name.includes(only))) {
      const template = badgeTemplates[variant.template];
      const grid = expectedGrid[variant.template];
      const start = Number(variant.query?.start ?? 1);
      const params = new URLSearchParams({
        event: eventId,
        template: variant.template,
        orientation: variant.orientation,
        ...variant.query,
      });
      console.log(`\n${variant.name}`);
      await page.emulateMedia({ media: "screen" });
      await page.goto(`${baseUrl}/check-in/badges?${params}`, { waitUntil: "networkidle" });
      const labelCount = await page.locator(".badge-label-card:not(.is-empty)").count();
      check(labelCount === total, `page lists ${labelCount} of ${total} labels`);

      await page.emulateMedia({ media: "print" });
      const sheetCount = Math.ceil((labelCount + start - 1) / template.perSheet);

      // Chrome elements must not take part in print layout at all.
      const hidden = await page.evaluate(() => {
        const selectors = [".skip-link", ".sidebar", ".workspace-header", ".mobile-nav",
          ".badge-print-intro", ".badge-print-controls", ".badge-background-picker",
          ".badge-print-summary"];
        return selectors
          .map((selector) => [selector, [...document.querySelectorAll(selector)]
            .every((element) => getComputedStyle(element).display === "none")] as const)
          .filter(([, isHidden]) => !isHidden)
          .map(([selector]) => selector);
      });
      check(hidden.length === 0, `chrome is display:none in print (${hidden.join(", ") || "all hidden"})`);

      // Label geometry at 96 dpi, in inches from the paper's top-left corner.
      const boxes = await page.evaluate(() => [...document.querySelectorAll(".badge-sheet:first-child .badge-label-card")]
        .map((element) => {
          const box = element.getBoundingClientRect();
          return [box.left / 96, box.top / 96 + window.scrollY / 96, box.width / 96, box.height / 96];
        }));
      const first = boxes[0] ?? [Number.NaN, Number.NaN, 0, 0];
      check(
        Math.abs(first[1] - grid.top) <= toleranceIn && Math.abs(first[0] - grid.left) <= toleranceIn,
        `first label at ${first[1].toFixed(3)} in from top, ${first[0].toFixed(3)} in from left (want ${grid.top} / ${grid.left})`,
      );
      let gridOk = boxes.length === grid.columns * grid.rows;
      boxes.forEach(([x, y], index) => {
        const column = index % grid.columns;
        const row = Math.floor(index / grid.columns);
        if (Math.abs(x - (grid.left + column * grid.columnPitch)) > toleranceIn
          || Math.abs(y - (grid.top + row * grid.rowPitch)) > toleranceIn) gridOk = false;
      });
      check(gridOk, `all ${boxes.length} labels on the ${grid.columns} x ${grid.rows} grid`);

      const pdf = await page.pdf({ format: "Letter", preferCSSPageSize: true, printBackground: true });
      const stem = path.join(outDir, variant.name);
      writeFileSync(`${stem}.pdf`, pdf);
      const info = await readPdf(new Uint8Array(pdf));
      check(info.pages === sheetCount, `PDF has ${info.pages} pages (want ceil(${labelCount + start - 1}/${template.perSheet}) = ${sheetCount})`);
      const leaked = forbiddenText.filter((text) => info.text.includes(text));
      check(leaked.length === 0, `no page chrome text in the PDF${leaked.length ? ` (found: ${leaked.join(", ")})` : ""}`);
      const blank = info.textPerPage.map((text, index) => (text.trim() ? 0 : index + 1)).filter(Boolean);
      check(blank.length === 0, `no blank pages${blank.length ? ` (blank: ${blank.join(", ")})` : ""}`);
      const oddSize = info.pageSizesIn.filter(([w, h]) => Math.abs(w - 8.5) > 0.02 || Math.abs(h - 11) > 0.02);
      check(oddSize.length === 0, `every page is 8.5 x 11 in (${info.pageSizesIn[0]?.map((n) => n.toFixed(2)).join(" x ")})`);
      // A PNG of the page-1 render for the eye (print emulation, one sheet wide).
      await page.setViewportSize({ width: 816, height: 1056 });
      await page.screenshot({ path: `${stem}-page1.png`, clip: { x: 0, y: 0, width: 816, height: 1056 } });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nAll badge print checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
