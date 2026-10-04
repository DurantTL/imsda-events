import { describe, expect, it } from "vitest";

/** #168: the delivery, AR and payment rules, with no database. Synthetic data only. */
import { toCsv } from "@/modules/reporting/csv";
import {
  DEFAULT_PAYMENT_INSTRUCTIONS,
  buildRecipientCandidates,
  correctArSchema,
  defaultInvoiceBody,
  defaultInvoiceSubject,
  deliveryStatusLabel,
  effectivePaymentInstructions,
  invoicePdfFilename,
  isDeliveryProblem,
  neutralizePlaceholders,
  normalizePaymentInstructions,
  outstandingFigures,
  parseDateOnly,
  parseMoneyToCents,
  postToArSchema,
  recipientDeliveryStatus,
  recipientsFingerprint,
  recordPaymentSchema,
  selectRecipients,
  sendMessageSchema,
  settlementStatus,
  treasurerCsvRows,
  voidedPaymentIds,
  voidPaymentSchema,
} from "@/modules/invoices/delivery-domain";

const KEY = "request-key-0123456789abcdef";

describe("payment instruction (a finance setting)", () => {
  it("defaults to the conference check instruction and uses the setting when there is one", () => {
    expect(effectivePaymentInstructions(null)).toBe(DEFAULT_PAYMENT_INSTRUCTIONS);
    expect(effectivePaymentInstructions("   ")).toBe(DEFAULT_PAYMENT_INSTRUCTIONS);
    expect(DEFAULT_PAYMENT_INSTRUCTIONS).toBe("Please remit by check to the Iowa-Missouri Conference.");
    expect(effectivePaymentInstructions("  Mail checks to the office.  ")).toBe("Mail checks to the office.");
  });

  it("normalizes a staff entry: blank clears it, an over-long one is refused", () => {
    expect(normalizePaymentInstructions("")).toEqual({ ok: true, value: null });
    expect(normalizePaymentInstructions(" Pay here\r\nthanks ")).toEqual({ ok: true, value: "Pay here\nthanks" });
    expect(normalizePaymentInstructions("x".repeat(601)).ok).toBe(false);
  });

  it("names the PDF file from the invoice number", () => {
    expect(invoicePdfFilename("SC27-0001-R1")).toBe("Invoice-SC27-0001-R1.pdf");
    expect(invoicePdfFilename('SC27/../0001"')).toBe("Invoice-SC27____0001_.pdf");
  });
});

describe("amounts and dates", () => {
  it("parses a typed dollar amount to cents, and refuses anything else", () => {
    expect(parseMoneyToCents("250")).toBe(25000);
    expect(parseMoneyToCents("$1,250.5")).toBe(125050);
    expect(parseMoneyToCents(" 0.01 ")).toBe(1);
    for (const bad of ["", "abc", "-5", "1e3", "10.999", "1.2.3", "$", "12 34"]) expect(parseMoneyToCents(bad)).toBeNull();
  });

  it("accepts only a real calendar date", () => {
    expect(parseDateOnly("2027-04-12")?.toISOString()).toBe("2027-04-12T00:00:00.000Z");
    for (const bad of ["2027-13-01", "2027-02-30", "04/12/2027", "2027-4-1", "", "yesterday"]) expect(parseDateOnly(bad)).toBeNull();
  });

  it("validates the request bodies", () => {
    expect(recordPaymentSchema.safeParse({ invoiceId: "i1", amount: "10", receivedOn: "2027-05-01", requestKey: KEY }).success).toBe(true);
    expect(recordPaymentSchema.safeParse({ invoiceId: "i1", amount: "10", receivedOn: "soon", requestKey: KEY }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ invoiceId: "i1", amount: "10", receivedOn: "2027-05-01", requestKey: "short" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ invoiceId: "i1", amount: "10", receivedOn: "2027-05-01", requestKey: KEY, checkNumber: "9".repeat(41) }).success).toBe(false);
    expect(postToArSchema.safeParse({ versionId: "v1", postedOn: "2027-05-01", reference: "GL-1" }).success).toBe(true);
    expect(postToArSchema.safeParse({ versionId: "v1", postedOn: "2027-05-01", reference: "x".repeat(81) }).success).toBe(false);
    expect(correctArSchema.safeParse({ versionId: "v1", postedOn: "2027-05-01", reason: "  " }).success).toBe(false);
    expect(voidPaymentSchema.safeParse({ paymentId: "p1", reason: "Entered twice", requestKey: KEY }).success).toBe(true);
    expect(voidPaymentSchema.safeParse({ paymentId: "p1", reason: "", requestKey: KEY }).success).toBe(false);
  });
});

describe("outstanding", () => {
  const payment = (id: string, amountCents: number) => ({ id, kind: "PAYMENT" as const, amountCents, reversesPaymentId: null });
  const reversal = (id: string, of: string, amountCents: number) => ({ id, kind: "REVERSAL" as const, amountCents, reversesPaymentId: of });

  it("shows a partial payment as paid and the rest as outstanding", () => {
    const figures = outstandingFigures(10000, [payment("p1", 6000)]);
    expect(figures).toEqual({ amountDueCents: 10000, paidCents: 6000, outstandingCents: 4000, overpaidCents: 0 });
    expect(settlementStatus(figures)).toBe("PARTIALLY_PAID");
  });

  it("takes a voided payment back out", () => {
    const entries = [payment("p1", 6000), payment("p2", 1000), reversal("r1", "p2", 1000)];
    expect(outstandingFigures(10000, entries).outstandingCents).toBe(4000);
    expect([...voidedPaymentIds(entries)]).toEqual(["p2"]);
  });

  it("carries paid-to-date across a revision: the new total less every payment on the invoice", () => {
    const entries = [payment("p1", 6000)]; // recorded against the original ($100)
    expect(outstandingFigures(9000, entries).outstandingCents).toBe(3000); // revised to $90
    expect(outstandingFigures(5000, entries)).toMatchObject({ outstandingCents: 0, overpaidCents: 1000 }); // revised to $50: overpaid, flagged
  });

  it("never goes below zero and flags an overpayment", () => {
    const figures = outstandingFigures(2500, [payment("p1", 5000)]);
    expect(figures).toMatchObject({ outstandingCents: 0, overpaidCents: 2500 });
    expect(settlementStatus(figures)).toBe("OVERPAID");
  });

  it("calls an untouched invoice unpaid, a settled one paid, and a $0 invoice nothing due", () => {
    expect(settlementStatus(outstandingFigures(10000, []))).toBe("UNPAID");
    expect(settlementStatus(outstandingFigures(10000, [payment("p", 10000)]))).toBe("PAID");
    expect(settlementStatus(outstandingFigures(0, []))).toBe("NOTHING_DUE");
  });
});

describe("recipients", () => {
  const contact = { name: "Tess Treasurer", email: "Tess@Church-One.test", roleLabel: "Treasurer", verified: true };
  const directors = [
    { attendeeAccountId: "acct-2", name: "Dev Director", email: "dev@club.test", clubId: "club-2", clubName: "Hawks" },
    { attendeeAccountId: "acct-1", name: "Dana Director", email: "dana@club.test", clubId: "club-1", clubName: "Eagles" },
    { attendeeAccountId: "acct-1", name: "Dana Director", email: "dana@club.test", clubId: "club-3", clubName: "Owls" },
  ];

  it("lists the billing contact first, then each director once, with the clubs they lead", () => {
    const candidates = buildRecipientCandidates({ billingContact: contact, directors });
    expect(candidates.map((candidate) => `${candidate.key}|${candidate.email}`)).toEqual(["billing|tess@church-one.test", "director:acct-1|dana@club.test", "director:acct-2|dev@club.test"]);
    expect(candidates[1]).toMatchObject({ kind: "CLUB_DIRECTOR", detail: "Director, Eagles, Owls", clubIds: ["club-1", "club-3"] });
    expect(candidates[0]).toMatchObject({ kind: "BILLING_CONTACT", unverified: false });
  });

  it("copies an address once, even when the director is also the billing contact", () => {
    const candidates = buildRecipientCandidates({ billingContact: { ...contact, email: "dana@club.test" }, directors });
    expect(candidates.filter((candidate) => candidate.email === "dana@club.test")).toHaveLength(1);
    expect(candidates[0]!.key).toBe("billing");
  });

  it("leaves out an address that is not a deliverable email, and has no billing recipient without a contact", () => {
    const candidates = buildRecipientCandidates({ billingContact: null, directors: [{ ...directors[0]!, email: "not-an-email" }, directors[1]!] });
    expect(candidates.map((candidate) => candidate.key)).toEqual(["director:acct-1"]);
  });

  it("flags an unverified contact and an address that bounced before", () => {
    const candidates = buildRecipientCandidates({ billingContact: { ...contact, verified: false }, directors: [], problems: new Map([["tess@church-one.test", "The last invoice email to this address bounced."]]) });
    expect(candidates[0]).toMatchObject({ unverified: true, priorProblem: "The last invoice email to this address bounced." });
  });

  it("requires at least one recipient, refuses a key it does not know, and keeps only the ticked ones", () => {
    const candidates = buildRecipientCandidates({ billingContact: contact, directors });
    expect(selectRecipients(candidates, [])).toEqual({ ok: false, issue: "NONE_SELECTED" });
    expect(selectRecipients(candidates, ["billing", "director:someone-else"])).toEqual({ ok: false, issue: "UNKNOWN_RECIPIENT" });
    const ticked = selectRecipients(candidates, ["billing", "director:acct-2", "billing"]);
    expect(ticked.ok && ticked.selected.map((candidate) => candidate.key)).toEqual(["billing", "director:acct-2"]);
  });

  it("changes the fingerprint when anyone is added, removed or re-addressed", () => {
    const base = buildRecipientCandidates({ billingContact: contact, directors });
    const same = buildRecipientCandidates({ billingContact: contact, directors: [...directors].reverse() });
    expect(recipientsFingerprint(same)).toBe(recipientsFingerprint(base));
    expect(recipientsFingerprint(buildRecipientCandidates({ billingContact: { ...contact, email: "new@church-one.test" }, directors }))).not.toBe(recipientsFingerprint(base));
    expect(recipientsFingerprint(buildRecipientCandidates({ billingContact: contact, directors: directors.slice(0, 1) }))).not.toBe(recipientsFingerprint(base));
  });
});

describe("the message", () => {
  it("writes a default subject and body naming the invoice, the amount and the payment text", () => {
    const subject = defaultInvoiceSubject({ number: "SC27-0001", organizationName: "Church One", eventName: "Spring Camporee 2027" });
    expect(subject).toBe("Invoice SC27-0001 for Church One: Spring Camporee 2027");
    const body = defaultInvoiceBody({ number: "SC27-0001-R1", organizationName: "Church One", eventName: "Spring Camporee 2027", amountLabel: "$125.00", filename: "Invoice-SC27-0001-R1.pdf", paymentInstructions: DEFAULT_PAYMENT_INSTRUCTIONS, senderName: "Iowa-Missouri Conference", supersedesNumber: "SC27-0001" });
    expect(body).toContain("invoice SC27-0001-R1 for Church One from Spring Camporee 2027, for $125.00");
    expect(body).toContain("This invoice replaces SC27-0001.");
    expect(body).toContain(DEFAULT_PAYMENT_INSTRUCTIONS);
  });

  it("needs a one-line subject and a body", () => {
    expect(sendMessageSchema.safeParse({ subject: "Invoice", body: "Hello" }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ subject: "Two\nlines", body: "Hello" }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ subject: "", body: "Hello" }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ subject: "Invoice", body: "   " }).success).toBe(false);
  });

  it("breaks up anything that could be read as a delivery placeholder", () => {
    expect(neutralizePlaceholders("see {{manage_link}} now")).toBe("see { {manage_link} } now");
  });
});

describe("delivery status", () => {
  it("lets a bounce, complaint or suppression win over sent, and calls a queued row queued", () => {
    expect(recipientDeliveryStatus({ status: "FAILED", providerDeliveryStatus: "BOUNCED" })).toBe("BOUNCED");
    expect(recipientDeliveryStatus({ status: "SENT", providerDeliveryStatus: "COMPLAINED" })).toBe("COMPLAINED");
    expect(recipientDeliveryStatus({ status: "SUPPRESSED", providerDeliveryStatus: null })).toBe("SUPPRESSED");
    expect(recipientDeliveryStatus({ status: "SENT", providerDeliveryStatus: "DELIVERED" })).toBe("DELIVERED");
    expect(recipientDeliveryStatus({ status: "SENT", providerDeliveryStatus: "ACCEPTED" })).toBe("SENT");
    expect(recipientDeliveryStatus({ status: "CAPTURED", providerDeliveryStatus: null })).toBe("CAPTURED");
    expect(recipientDeliveryStatus({ status: "PENDING", providerDeliveryStatus: null })).toBe("QUEUED");
    expect(recipientDeliveryStatus({ status: "FAILED", providerDeliveryStatus: null })).toBe("FAILED");
  });

  it("marks only the statuses where the address did not get it as problems", () => {
    expect(["BOUNCED", "COMPLAINED", "FAILED", "SUPPRESSED"].every((status) => isDeliveryProblem(status as never))).toBe(true);
    expect(["QUEUED", "CAPTURED", "SENT", "DELIVERED"].some((status) => isDeliveryProblem(status as never))).toBe(false);
    expect(deliveryStatusLabel("BOUNCED")).toBe("Bounced");
  });
});

describe("treasurer CSV", () => {
  const row = {
    number: "SC27-0001-R1", supersedesNumber: "SC27-0001", organizationName: "Church One", eventName: "Spring Camporee 2027", totalCents: 12500,
    postedToArOn: "2027-04-20", arReference: "GL-1001", paidCents: 6000, outstandingCents: 6500, overpaidCents: 0, lastSentAt: "2027-04-21T14:00:00.000Z",
  };

  it("has the columns the treasurer asked for, in dollars and ISO dates", () => {
    const [header, line] = treasurerCsvRows([row]);
    expect(header).toEqual(["Invoice number", "Supersedes", "Church or billed party", "Event", "Total", "Posted to AR on", "AR reference", "Paid", "Outstanding", "Overpaid", "Last sent"]);
    expect(line).toEqual(["SC27-0001-R1", "SC27-0001", "Church One", "Spring Camporee 2027", "125.00", "2027-04-20", "GL-1001", "60.00", "65.00", "0.00", "2027-04-21"]);
  });

  it("leaves unposted and unsent cells blank", () => {
    const [, line] = treasurerCsvRows([{ ...row, supersedesNumber: null, postedToArOn: null, arReference: null, lastSentAt: null }]);
    expect(line!.slice(1, 2)).toEqual([""]);
    expect([line![5], line![6], line![10]]).toEqual(["", "", ""]);
  });

  it("is formula-safe through the shared writer", () => {
    const text = toCsv(treasurerCsvRows([{ ...row, organizationName: "=HYPERLINK(\"http://example.test\")", arReference: "+cmd|' /C calc'!A0", eventName: "@SUM(1+1)" }]));
    expect(text).toContain(`"'=HYPERLINK(""http://example.test"")"`);
    expect(text).toContain(`"'+cmd|' /C calc'!A0"`);
    expect(text).toContain(`"'@SUM(1+1)"`);
    expect(text).not.toMatch(/(^|,)"[=+@-]/m);
  });
});
