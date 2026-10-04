import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #168: who may send an invoice, record AR and payments, download the PDF, read a statement and export the CSV.
 * MANAGE_FINANCE on the event in the URL is required for every one of them; another event's version, invoice, payment
 * or church is refused before it is shown; nothing serves the stored PDF without that permission. The services are
 * mocked (rules: invoice-delivery-domain.test.ts; real database: scripts/verify-invoice-delivery.ts). Synthetic data only.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirected"); }),
  notFound: vi.fn(() => { throw new Error("not-found"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  listEventsForUser: vi.fn(),
  delivery: { sendInvoiceVersion: vi.fn(), getInvoicePdfForDownload: vi.fn(), getInvoiceSendPreview: vi.fn(), getInvoiceDeliveryHistory: vi.fn() },
  ledger: {
    postInvoiceToAr: vi.fn(),
    correctArPosting: vi.fn(),
    recordInvoicePayment: vi.fn(),
    voidInvoicePayment: vi.fn(),
    setInvoicePaymentInstructions: vi.fn(),
    getTreasurerCsvInvoices: vi.fn(),
    listEventStatements: vi.fn(),
    getPartyStatement: vi.fn(),
    loadEventLedger: vi.fn(),
    getInvoiceFinanceReport: vi.fn(),
  },
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership, listEventsForUser: mocks.listEventsForUser }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }), isServerEnvironmentError: () => false }));
vi.mock("@/modules/invoices/repository", () => {
  class InvoiceError extends Error {
    constructor(message: string, public readonly code: string, public readonly blockers: unknown[] = []) { super(message); }
  }
  return { InvoiceError, getInvoicesView: vi.fn(), getInvoiceDetail: vi.fn() };
});
vi.mock("@/modules/invoices/delivery-repository", () => mocks.delivery);
vi.mock("@/modules/invoices/ledger-repository", () => mocks.ledger);

import { POST as sendPost } from "@/app/api/events/[eventId]/invoices/send/route";
import { POST as ledgerPost } from "@/app/api/events/[eventId]/invoices/ledger/route";
import { GET as pdfGet } from "@/app/api/events/[eventId]/invoices/versions/[versionId]/pdf/route";
import { GET as csvGet } from "@/app/api/events/[eventId]/exports/invoices/route";
import StatementsPage from "@/app/(workspace)/finance/invoices/statements/page";
import StatementPage from "@/app/(workspace)/finance/invoices/statements/[partyId]/page";
import SendPage from "@/app/(workspace)/finance/invoices/[invoiceId]/send/page";
import { InvoiceError } from "@/modules/invoices/repository";

const KEY = "request-key-0123456789abcdef";
const context = (eventId = "event-a") => ({ params: Promise.resolve({ eventId }) });
const pdfContext = (eventId = "event-a", versionId = "v1") => ({ params: Promise.resolve({ eventId, versionId }) });

function request(body: unknown, origin: string | null = "https://events.imsda.test") {
  return new Request("https://events.imsda.test/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}
const get = () => new Request("https://events.imsda.test/api/test");

const financeManager = { id: "user-finance", globalRole: null, email: "finance@example.test", displayName: "Finance" };
const readOnly = { id: "user-readonly", globalRole: null, email: "readonly@example.test", displayName: "Read Only" };
const outsider = { id: "user-outsider", globalRole: null, email: "outsider@example.test", displayName: "Outsider" };

/** Event A: a finance manager. Event C: a read-only member. Event B: the finance manager has no access. */
function memberships(userId: string, eventId: string) {
  if (eventId === "event-a" && userId === "user-finance") return { eventId, userId, role: "FINANCE_MANAGER", status: "ACTIVE", permissions: [] };
  if (eventId === "event-c" && userId === "user-finance") return { eventId, userId, role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] };
  if (eventId === "event-a" && userId === "user-readonly") return { eventId, userId, role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [] };
  return null;
}

let signedIn: Record<string, unknown> | null = financeManager;
beforeEach(() => {
  vi.clearAllMocks();
  signedIn = financeManager;
  mocks.getCurrentSession.mockImplementation(async () => ({ user: signedIn }));
  mocks.findActiveMembership.mockImplementation(async (userId: string, eventId: string) => memberships(userId, eventId));
  mocks.delivery.sendInvoiceVersion.mockResolvedValue({ deliveryId: "d1", sequence: 1, versionId: "v1", number: "SC27-0001", replayed: false, deliveryMode: "LOCAL_CAPTURE", recipientCount: 2, documentSha256: "a".repeat(64), outcome: { captured: 2, suppressed: 0, sent: 0, queued: 0, failed: 0 } });
  mocks.delivery.getInvoicePdfForDownload.mockResolvedValue({ bytes: Buffer.from("%PDF-1.7 synthetic"), sha256: "b".repeat(64), filename: "Invoice-SC27-0001.pdf", contentType: "application/pdf" });
  mocks.ledger.postInvoiceToAr.mockResolvedValue({ postingId: "a1", versionId: "v1", invoiceId: "i1" });
  mocks.ledger.correctArPosting.mockResolvedValue({ postingId: "a2", correctsPostingId: "a1", versionId: "v1", invoiceId: "i1" });
  mocks.ledger.recordInvoicePayment.mockResolvedValue({ paymentId: "p1", replayed: false, outstandingCents: 4000, paidCents: 6000, overpaidCents: 0, amountDueCents: 10000 });
  mocks.ledger.voidInvoicePayment.mockResolvedValue({ reversalId: "r1", replayed: false, outstandingCents: 10000, paidCents: 0, overpaidCents: 0, amountDueCents: 10000 });
  mocks.ledger.setInvoicePaymentInstructions.mockResolvedValue({ changed: true, instructions: "Pay the office." });
  mocks.ledger.getTreasurerCsvInvoices.mockResolvedValue([
    { number: "SC27-0001", supersedesNumber: null, organizationName: "=Church One", eventName: "Spring Camporee", totalCents: 10000, postedToArOn: "2027-04-20", arReference: "GL-1", paidCents: 6000, outstandingCents: 4000, overpaidCents: 0, lastSentAt: "2027-04-21T14:00:00.000Z" },
  ]);
});

const sendBody = { versionId: "v1", recipients: ["billing", "director:a1"], recipientsFingerprint: "fp", subject: "Invoice SC27-0001", body: "Hello", idempotencyKey: KEY, confirm: true };

describe("POST .../invoices/send", () => {
  it("sends as the signed-in finance manager, passing the ticked recipient keys and never an address", async () => {
    const response = await sendPost(request({ ...sendBody, actorUserId: "someone-else", recipientEmails: ["x@example.test"] }), context());
    expect(response.status).toBe(200);
    expect(mocks.delivery.sendInvoiceVersion).toHaveBeenCalledWith({
      eventId: "event-a",
      versionId: "v1",
      actorUserId: "user-finance",
      selectedKeys: ["billing", "director:a1"],
      recipientsFingerprint: "fp",
      subject: "Invoice SC27-0001",
      body: "Hello",
      idempotencyKey: KEY,
      confirm: true,
    });
    expect(await response.json()).toMatchObject({ sequence: 1, recipientCount: 2 });
  });

  it("refuses without MANAGE_FINANCE on the event in the URL, before the service", async () => {
    expect((await sendPost(request(sendBody), context("event-c"))).status).toBe(403);
    expect((await sendPost(request(sendBody), context("event-b"))).status).toBe(403);
    signedIn = readOnly;
    expect((await sendPost(request(sendBody), context("event-a"))).status).toBe(403);
    signedIn = outsider;
    expect((await sendPost(request(sendBody), context("event-a"))).status).toBe(403);
    expect(mocks.delivery.sendInvoiceVersion).not.toHaveBeenCalled();
  });

  it("requires a signed-in user and a same-origin request", async () => {
    signedIn = null;
    expect((await sendPost(request(sendBody), context())).status).toBe(401);
    signedIn = financeManager;
    expect((await sendPost(request(sendBody, "https://evil.example.test"), context())).status).toBe(403);
    expect(mocks.delivery.sendInvoiceVersion).not.toHaveBeenCalled();
  });

  it("validates the body: a confirmation, a key and a list are required", async () => {
    expect((await sendPost(request({ ...sendBody, confirm: false }), context())).status).toBe(400);
    expect((await sendPost(request({ ...sendBody, confirm: undefined }), context())).status).toBe(400);
    expect((await sendPost(request({ ...sendBody, idempotencyKey: "short" }), context())).status).toBe(400);
    expect((await sendPost(request({ ...sendBody, recipients: "billing" }), context())).status).toBe(400);
    expect((await sendPost(request({}), context())).status).toBe(400);
    expect(mocks.delivery.sendInvoiceVersion).not.toHaveBeenCalled();
  });

  it("maps refusals: none ticked 400, another event's version 404, a superseded version and a changed list 409", async () => {
    mocks.delivery.sendInvoiceVersion.mockRejectedValueOnce(new InvoiceError("Choose at least one recipient.", "NO_RECIPIENTS"));
    expect((await sendPost(request({ ...sendBody, recipients: [] }), context())).status).toBe(400);
    mocks.delivery.sendInvoiceVersion.mockRejectedValueOnce(new InvoiceError("Not on this event.", "VERSION_NOT_FOUND"));
    expect((await sendPost(request(sendBody), context())).status).toBe(404);
    mocks.delivery.sendInvoiceVersion.mockRejectedValueOnce(new InvoiceError("Replaced.", "NOT_SENDABLE"));
    const superseded = await sendPost(request(sendBody), context());
    expect(superseded.status).toBe(409);
    expect(await superseded.json()).toMatchObject({ error: "NOT_SENDABLE" });
    mocks.delivery.sendInvoiceVersion.mockRejectedValueOnce(new InvoiceError("Changed.", "PREVIEW_CHANGED"));
    expect((await sendPost(request(sendBody), context())).status).toBe(409);
    mocks.delivery.sendInvoiceVersion.mockRejectedValueOnce(new InvoiceError("Unknown.", "UNKNOWN_RECIPIENT"));
    expect((await sendPost(request(sendBody), context())).status).toBe(400);
  });
});

describe("POST .../invoices/ledger", () => {
  const bodies = [
    { action: "post-to-ar", versionId: "v1", postedOn: "2027-04-20", reference: "GL-1" },
    { action: "correct-ar", versionId: "v1", postedOn: "2027-04-21", reason: "Wrong period" },
    { action: "record-payment", invoiceId: "i1", amount: "60.00", receivedOn: "2027-05-01", checkNumber: "1042", requestKey: KEY },
    { action: "void-payment", paymentId: "p1", reason: "Entered twice", requestKey: KEY },
    { action: "set-payment-instructions", instructions: "Pay the office." },
  ];

  it("runs each action as the signed-in finance manager on the event in the URL", async () => {
    for (const body of bodies) expect((await ledgerPost(request({ ...body, actorUserId: "someone-else" }), context())).status).toBe(200);
    expect(mocks.ledger.postInvoiceToAr).toHaveBeenCalledWith({ eventId: "event-a", versionId: "v1", postedOn: "2027-04-20", reference: "GL-1", actorUserId: "user-finance" });
    expect(mocks.ledger.correctArPosting).toHaveBeenCalledWith({ eventId: "event-a", versionId: "v1", postedOn: "2027-04-21", reference: null, reason: "Wrong period", actorUserId: "user-finance" });
    expect(mocks.ledger.recordInvoicePayment).toHaveBeenCalledWith({ eventId: "event-a", invoiceId: "i1", amount: "60.00", checkNumber: "1042", receivedOn: "2027-05-01", note: null, requestKey: KEY, actorUserId: "user-finance" });
    expect(mocks.ledger.voidInvoicePayment).toHaveBeenCalledWith({ eventId: "event-a", paymentId: "p1", reason: "Entered twice", requestKey: KEY, actorUserId: "user-finance" });
    expect(mocks.ledger.setInvoicePaymentInstructions).toHaveBeenCalledWith({ eventId: "event-a", instructions: "Pay the office.", actorUserId: "user-finance" });
  });

  it("refuses without MANAGE_FINANCE on that event, for every action, before the service", async () => {
    for (const body of bodies) {
      expect((await ledgerPost(request(body), context("event-c"))).status).toBe(403);
      expect((await ledgerPost(request(body), context("event-b"))).status).toBe(403);
    }
    signedIn = readOnly;
    for (const body of bodies) expect((await ledgerPost(request(body), context("event-a"))).status).toBe(403);
    expect(Object.values(mocks.ledger).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("requires a signed-in user and a same-origin request, and a known action", async () => {
    signedIn = null;
    expect((await ledgerPost(request(bodies[2]), context())).status).toBe(401);
    signedIn = financeManager;
    expect((await ledgerPost(request(bodies[2], "https://evil.example.test"), context())).status).toBe(403);
    expect((await ledgerPost(request({ action: "refund", invoiceId: "i1" }), context())).status).toBe(400);
    expect(mocks.ledger.recordInvoicePayment).not.toHaveBeenCalled();
  });

  it("maps refusals: another event's payment or version 404, a bad amount 400, a repeat posting or void 409", async () => {
    mocks.ledger.voidInvoicePayment.mockRejectedValueOnce(new InvoiceError("Not on this event.", "PAYMENT_NOT_FOUND"));
    expect((await ledgerPost(request(bodies[3]), context())).status).toBe(404);
    mocks.ledger.postInvoiceToAr.mockRejectedValueOnce(new InvoiceError("Not on this event.", "VERSION_NOT_FOUND"));
    expect((await ledgerPost(request(bodies[0]), context())).status).toBe(404);
    mocks.ledger.recordInvoicePayment.mockRejectedValueOnce(new InvoiceError("Enter an amount greater than zero.", "INVALID_INPUT"));
    expect((await ledgerPost(request({ ...bodies[2], amount: "0" }), context())).status).toBe(400);
    mocks.ledger.postInvoiceToAr.mockRejectedValueOnce(new InvoiceError("Already posted.", "ALREADY_POSTED"));
    expect((await ledgerPost(request(bodies[0]), context())).status).toBe(409);
    mocks.ledger.voidInvoicePayment.mockRejectedValueOnce(new InvoiceError("Already voided.", "ALREADY_VOIDED"));
    expect((await ledgerPost(request(bodies[3]), context())).status).toBe(409);
  });
});

describe("GET .../invoices/versions/[versionId]/pdf", () => {
  it("serves the stored PDF to MANAGE_FINANCE on the event, privately and without caching", async () => {
    const response = await pdfGet(get(), pdfContext());
    expect(response.status).toBe(200);
    expect(mocks.delivery.getInvoicePdfForDownload).toHaveBeenCalledWith("event-a", "v1");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="Invoice-SC27-0001.pdf"');
    expect(Buffer.from(await response.arrayBuffer()).toString().startsWith("%PDF-")).toBe(true);
  });

  it("is not public: no session is 401, and a member without MANAGE_FINANCE or another event is 403, before any bytes are read", async () => {
    signedIn = null;
    expect((await pdfGet(get(), pdfContext())).status).toBe(401);
    signedIn = financeManager;
    expect((await pdfGet(get(), pdfContext("event-c"))).status).toBe(403);
    expect((await pdfGet(get(), pdfContext("event-b"))).status).toBe(403);
    signedIn = readOnly;
    expect((await pdfGet(get(), pdfContext("event-a"))).status).toBe(403);
    signedIn = outsider;
    expect((await pdfGet(get(), pdfContext("event-a"))).status).toBe(403);
    expect(mocks.delivery.getInvoicePdfForDownload).not.toHaveBeenCalled();
  });

  it("answers 404 for a version that is not on the event in the URL", async () => {
    mocks.delivery.getInvoicePdfForDownload.mockRejectedValueOnce(new InvoiceError("Not on this event.", "VERSION_NOT_FOUND"));
    expect((await pdfGet(get(), pdfContext("event-a", "v-of-event-b"))).status).toBe(404);
  });

  it("no other route or page reads the stored attachment bytes without checking MANAGE_FINANCE", () => {
    const readers: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const source = readFileSync(path, "utf8");
        if (/getInvoicePdfForDownload|readInvoiceDocumentBytes|messageAttachment|MessageAttachment/.test(source)) readers.push(path);
      }
    };
    walk(join(process.cwd(), "app"));
    expect(readers.map((path) => path.replace(process.cwd() + "/", ""))).toEqual(["app/api/events/[eventId]/invoices/versions/[versionId]/pdf/route.ts"]);
    expect(readFileSync(readers[0]!, "utf8")).toContain('requirePermission(await getCurrentSession(), eventId, "MANAGE_FINANCE"');
    // And nothing under public/ holds an invoice.
    const publicFiles: string[] = [];
    const walkPublic = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walkPublic(path);
        else publicFiles.push(entry);
      }
    };
    walkPublic(join(process.cwd(), "public"));
    expect(publicFiles.filter((name) => /^invoice/i.test(name) || name.endsWith(".pdf"))).toEqual([]);
  });
});

describe("GET .../exports/invoices (treasurer CSV)", () => {
  it("exports the event's finalized invoices, formula-safe, to MANAGE_FINANCE only", async () => {
    const response = await csvGet(get(), context());
    expect(response.status).toBe(200);
    expect(mocks.ledger.getTreasurerCsvInvoices).toHaveBeenCalledWith("event-a");
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    expect(text.split("\r\n")[0]).toContain("Invoice number");
    expect(text).toContain(`"'=Church One"`);
    expect(text).toContain('"100.00"');
    expect(text).toContain('"40.00"');
  });

  it("refuses everyone else, before reading any invoice", async () => {
    signedIn = null;
    expect((await csvGet(get(), context())).status).toBe(401);
    signedIn = financeManager;
    expect((await csvGet(get(), context("event-c"))).status).toBe(403);
    expect((await csvGet(get(), context("event-b"))).status).toBe(403);
    signedIn = readOnly;
    expect((await csvGet(get(), context("event-a"))).status).toBe(403);
    expect(mocks.ledger.getTreasurerCsvInvoices).not.toHaveBeenCalled();
  });
});

describe("statement and send pages", () => {
  const deferred = { id: "event-a", name: "Event A", billingMode: "DEFERRED_ORGANIZATION_INVOICE" };
  const statement = {
    eventId: "event-a", eventName: "Event A", partyId: "church-1", partyKind: "ORGANIZATION", name: "Church One",
    totals: { invoiceCount: 1, invoicedCents: 10000, paidCents: 6000, outstandingCents: 4000, overpaidCents: 0 },
    invoices: [{
      invoiceId: "i1", partyKind: "ORGANIZATION", partyId: "church-1", organizationName: "Church One", groupTitle: "Church One", baseNumber: "SC27-0001",
      live: { id: "v2", revision: 1, status: "FINALIZED", number: "SC27-0001-R1", amountDueCents: 10000, registeredCount: 5, billableCount: 4, finalizedAt: "2027-04-12T15:30:00.000Z", supersededAt: null, posting: { id: "a1", postedOn: "2027-04-20", reference: "GL-1", recordedByName: "Fran", createdAt: "2027-04-20T10:00:00.000Z", correctsPostingId: null, reason: null }, postingCount: 1, sendCount: 1, lastSentAt: "2027-04-21T14:00:00.000Z" },
      versions: [
        { id: "v2", revision: 1, status: "FINALIZED", number: "SC27-0001-R1", amountDueCents: 10000, registeredCount: 5, billableCount: 4, finalizedAt: "2027-04-12T15:30:00.000Z", supersededAt: null, posting: null, postingCount: 0, sendCount: 1, lastSentAt: null },
        { id: "v1", revision: 0, status: "SUPERSEDED", number: "SC27-0001", amountDueCents: 10000, registeredCount: 5, billableCount: 4, finalizedAt: "2027-04-10T15:30:00.000Z", supersededAt: "2027-04-12T15:30:00.000Z", posting: null, postingCount: 0, sendCount: 1, lastSentAt: null },
      ],
      payments: [
        { id: "p1", kind: "PAYMENT", amountCents: 6000, checkNumber: "1042", receivedOn: "2027-05-02", note: null, reason: null, reversesPaymentId: null, versionNumber: "SC27-0001", recordedByName: "Fran", createdAt: "2027-05-02T10:00:00.000Z", voided: false },
        { id: "p2", kind: "PAYMENT", amountCents: 1000, checkNumber: null, receivedOn: "2027-05-03", note: null, reason: null, reversesPaymentId: null, versionNumber: "SC27-0001-R1", recordedByName: "Fran", createdAt: "2027-05-03T10:00:00.000Z", voided: true },
        { id: "r1", kind: "REVERSAL", amountCents: 1000, checkNumber: null, receivedOn: "2027-05-04", note: null, reason: "Entered twice", reversesPaymentId: "p2", versionNumber: "SC27-0001-R1", recordedByName: "Fran", createdAt: "2027-05-04T10:00:00.000Z", voided: false },
      ],
      figures: { amountDueCents: 10000, paidCents: 6000, outstandingCents: 4000, overpaidCents: 0 },
      settlement: "PARTIALLY_PAID",
    }],
  };

  it("show the restricted notice and load nothing without MANAGE_FINANCE (unauthorized statement access)", async () => {
    mocks.listEventsForUser.mockResolvedValue([{ ...deferred, id: "event-c", name: "Event C" }]);
    const list = renderToStaticMarkup(await StatementsPage({ searchParams: Promise.resolve({ event: "event-c" }) }));
    expect(list).toContain("Finance is restricted");
    const one = renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ partyId: "church-1" }), searchParams: Promise.resolve({ event: "event-c" }) }));
    expect(one).toContain("Finance is restricted");
    expect(mocks.ledger.listEventStatements).not.toHaveBeenCalled();
    expect(mocks.ledger.getPartyStatement).not.toHaveBeenCalled();
  });

  it("a church's statement is looked up for the event in the URL only, and a church with no invoice there is not found", async () => {
    mocks.listEventsForUser.mockResolvedValue([deferred]);
    mocks.ledger.getPartyStatement.mockResolvedValue(null);
    await expect(StatementPage({ params: Promise.resolve({ partyId: "church-9" }), searchParams: Promise.resolve({ event: "event-a" }) })).rejects.toThrow("not-found");
    expect(mocks.ledger.getPartyStatement).toHaveBeenCalledWith("event-a", "church-9");
  });

  it("the statement shows the live invoice, superseded versions as history, payments with a void struck through, and what is outstanding", async () => {
    mocks.listEventsForUser.mockResolvedValue([deferred]);
    mocks.ledger.getPartyStatement.mockResolvedValue(statement);
    const markup = renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ partyId: "church-1" }), searchParams: Promise.resolve({ event: "event-a" }) }));
    expect(markup).toContain("Church One");
    expect(markup).toContain("SC27-0001-R1");
    expect(markup).toContain("history");
    expect(markup).toContain("Posted to AR 2027-04-20 (GL-1)");
    expect(markup).toContain("check 1042");
    expect(markup).toContain("Voided payment");
    expect(markup).toContain("line-through");
    expect(markup).toContain("Partly paid");
    expect(markup).toContain("$40.00");
  });

  it("the statements list loads the event in the URL", async () => {
    mocks.listEventsForUser.mockResolvedValue([deferred]);
    mocks.ledger.listEventStatements.mockResolvedValue({ eventName: "Event A", parties: [{ partyKind: "ORGANIZATION", partyId: "church-1", name: "Church One", totals: statement.totals, lastSentAt: null }], totals: statement.totals });
    const markup = renderToStaticMarkup(await StatementsPage({ searchParams: Promise.resolve({ event: "event-a" }) }));
    expect(mocks.ledger.listEventStatements).toHaveBeenCalledWith("event-a");
    expect(markup).toContain("Church One");
    expect(markup).toContain("/statements/church-1?event=event-a");
    expect(markup).toContain("not sent yet");
  });

  it("the send page needs MANAGE_FINANCE, and a version that is not on the event or the invoice is not found", async () => {
    mocks.listEventsForUser.mockResolvedValue([{ ...deferred, id: "event-c", name: "Event C" }]);
    expect(renderToStaticMarkup(await SendPage({ params: Promise.resolve({ invoiceId: "i1" }), searchParams: Promise.resolve({ event: "event-c", version: "v1" }) }))).toContain("Finance is restricted");
    expect(mocks.delivery.getInvoiceSendPreview).not.toHaveBeenCalled();
    mocks.listEventsForUser.mockResolvedValue([deferred]);
    mocks.delivery.getInvoiceSendPreview.mockRejectedValueOnce(new InvoiceError("Not on this event.", "VERSION_NOT_FOUND"));
    await expect(SendPage({ params: Promise.resolve({ invoiceId: "i1" }), searchParams: Promise.resolve({ event: "event-a", version: "v-other" }) })).rejects.toThrow("not-found");
    mocks.delivery.getInvoiceSendPreview.mockResolvedValueOnce({ invoiceId: "i-different" });
    await expect(SendPage({ params: Promise.resolve({ invoiceId: "i1" }), searchParams: Promise.resolve({ event: "event-a", version: "v1" }) })).rejects.toThrow("not-found");
    await expect(SendPage({ params: Promise.resolve({ invoiceId: "i1" }), searchParams: Promise.resolve({ event: "event-a" }) })).rejects.toThrow("not-found");
  });

  const preview = (overrides: Record<string, unknown> = {}) => ({
    eventId: "event-a", invoiceId: "i1",
    version: { id: "v1", number: "SC27-0001", status: "FINALIZED", amountDueCents: 10000, organizationName: "Church One", finalizedAt: "2027-04-12T15:30:00.000Z" },
    canSend: true, blockedReason: null, newerVersion: null,
    snapshotContact: { name: "Tina Treasurer", email: "tina@church-one.test", roleLabel: "Treasurer", verified: true },
    currentContact: { name: "Sam Successor", email: "sam@church-one.test", roleLabel: "Treasurer", verified: true },
    contactChanged: true,
    recipients: [
      { key: "billing", kind: "BILLING_CONTACT", name: "Sam Successor", email: "sam@church-one.test", detail: "Billing contact, Treasurer", attendeeAccountId: null, clubIds: [], unverified: false, priorProblem: null },
      { key: "director:a1", kind: "CLUB_DIRECTOR", name: "Dana Director", email: "dana@club.test", detail: "Director, Eagles", attendeeAccountId: "a1", clubIds: ["club-1"], unverified: false, priorProblem: "The last invoice email to this address bounced." },
    ],
    recipientsFingerprint: "fp", subject: "Invoice SC27-0001 for Church One", body: "Hello,\n\nAttached is invoice SC27-0001.",
    sender: { name: "Conference", email: "events@conference.test", replyTo: null }, deliveryMode: "LOCAL_CAPTURE",
    pdf: { filename: "Invoice-SC27-0001.pdf", exists: true, sha256: "c".repeat(64) }, history: [], isResend: false,
    ...overrides,
  });

  it("the send page shows the exact recipients, flags a changed contact and a prior bounce, and names the version", async () => {
    mocks.listEventsForUser.mockResolvedValue([deferred]);
    mocks.delivery.getInvoiceSendPreview.mockResolvedValue(preview());
    const markup = renderToStaticMarkup(await SendPage({ params: Promise.resolve({ invoiceId: "i1" }), searchParams: Promise.resolve({ event: "event-a", version: "v1" }) }));
    expect(mocks.delivery.getInvoiceSendPreview).toHaveBeenCalledWith("event-a", "v1");
    expect(markup).toContain("Send SC27-0001");
    expect(markup).toContain("sam@church-one.test");
    expect(markup).toContain("dana@club.test");
    expect(markup).toContain("The billing contact changed since this invoice was finalized.");
    expect(markup).toContain("Tina Treasurer");
    expect(markup).toContain("The last invoice email to this address bounced.");
    expect(markup).toContain("captures email locally");
    expect(markup).toContain("Invoice-SC27-0001.pdf");
    expect(markup.match(/type="checkbox"/g)?.length).toBeGreaterThanOrEqual(3); // two recipients and the confirmation
  });

  it("a superseded version shows a notice and no send form, pointing at the newer version", async () => {
    mocks.listEventsForUser.mockResolvedValue([deferred]);
    mocks.delivery.getInvoiceSendPreview.mockResolvedValue(preview({ canSend: false, blockedReason: "This version was replaced by SC27-0001-R1. A replaced version cannot be sent; send the newer one.", newerVersion: { id: "v2", number: "SC27-0001-R1" }, version: { id: "v1", number: "SC27-0001", status: "SUPERSEDED", amountDueCents: 10000, organizationName: "Church One", finalizedAt: "2027-04-12T15:30:00.000Z" } }));
    const markup = renderToStaticMarkup(await SendPage({ params: Promise.resolve({ invoiceId: "i1" }), searchParams: Promise.resolve({ event: "event-a", version: "v1" }) }));
    expect(markup).toContain("cannot be sent");
    expect(markup).toContain("SC27-0001-R1");
    expect(markup).toContain("version=v2");
    expect(markup).not.toContain("Send invoice</button>");
    expect(markup).not.toContain('type="checkbox"');
  });
});
