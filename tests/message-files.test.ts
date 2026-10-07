import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(message: string, public readonly status = 403, public readonly code = "PERMISSION_DENIED") {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    findActiveMembership: vi.fn(),
    getPrisma: vi.fn(),
    writeStoredFile: vi.fn(),
    readAsset: vi.fn(),
    deleteAsset: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/events/asset-storage", () => ({
  writeStoredFile: mocks.writeStoredFile,
  readAsset: mocks.readAsset,
  deleteAsset: mocks.deleteAsset,
}));
vi.mock("@/modules/events/asset-response", () => ({
  eventAssetResponse: vi.fn(async (asset: { displayName: string; contentType: string }, disposition: string) => new Response("bytes", {
    headers: { "Content-Type": asset.contentType, "X-Disposition": disposition },
  })),
}));

import { GET as getFile, DELETE as deleteFile } from "@/app/api/events/[eventId]/message-files/[fileId]/route";
import { GET as listImages, POST as upload } from "@/app/api/events/[eventId]/message-files/route";
import { createMessageFile, MessageFileError, readMessageFileBytes } from "@/modules/communications/message-files";
import { MessageFileDeliveryError } from "@/modules/communications/message-file-rules";

const PDF = Buffer.from("%PDF-1.7 synthetic agenda");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

function fakeClient(options: { eventExists?: boolean; existingFiles?: number } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const client = {
    event: { findUnique: vi.fn(async () => (options.eventExists === false ? null : { id: "event-1" })) },
    messageFile: {
      count: vi.fn(async () => options.existingFiles ?? rows.length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `file-${rows.length + 1}`, createdAt: new Date("2026-10-01T00:00:00Z"), ...data };
        rows.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; eventId: string } }) => (
        rows.find((row) => row.id === where.id && row.eventId === where.eventId) ?? null
      )),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn<(args: unknown) => Promise<object>>(async () => ({})) },
  };
  return { client, rows };
}

function upload_(file: File, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", file);
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return new Request("https://events.imsda.test/api/events/event-1/message-files", {
    method: "POST",
    headers: { origin: "https://events.imsda.test" },
    body: form,
  });
}

const eventContext = { params: Promise.resolve({ eventId: "event-1" }) };
const fileContext = { params: Promise.resolve({ eventId: "event-1", fileId: "file-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.deleteAsset.mockResolvedValue(undefined);
  mocks.writeStoredFile.mockImplementation(async (partition: string, extension: string, bytes: Uint8Array) => ({
    storageKey: `${partition}/generated-name.${extension}`,
    byteSize: bytes.byteLength,
    checksum: createHash("sha256").update(bytes).digest("hex"),
  }));
});

describe("createMessageFile (#824)", () => {
  it("stores a PDF under a generated name, with the display name cleaned and only name and size audited", async () => {
    const { client, rows } = fakeClient();
    const record = await createMessageFile("event-1", new File([PDF], "../../Friday Agenda.exe", { type: "application/x-msdownload" }), "staff-1", "attachment", client as never);
    expect(record).toMatchObject({ filename: "Friday Agenda.pdf", contentType: "application/pdf", sizeBytes: PDF.byteLength, isInlineImage: false });
    expect(mocks.writeStoredFile).toHaveBeenCalledWith("message-files/event-1", "pdf", expect.any(Uint8Array));
    expect(String(rows[0].storageKey)).toBe("message-files/event-1/generated-name.pdf");
    expect(String(rows[0].storageKey)).not.toContain("Agenda");
    const audit = client.auditLog.create.mock.calls[0][0] as unknown as { data: { action: string; metadata: unknown; summary: string } };
    expect(audit.data.action).toBe("MESSAGE_FILE_UPLOADED");
    expect(audit.data.metadata).toEqual({ files: [{ filename: "Friday Agenda.pdf", sizeBytes: PDF.byteLength }] });
    expect(JSON.stringify(audit.data)).not.toContain(createHash("sha256").update(PDF).digest("hex"));
    expect(JSON.stringify(audit.data)).not.toContain("generated-name");
  });

  it("decides the type from the bytes, not the claimed type: a script claiming to be a PDF is refused", async () => {
    const { client } = fakeClient();
    await expect(
      createMessageFile("event-1", new File(["#!/bin/sh\nrm -rf /\n"], "agenda.pdf", { type: "application/pdf" }), "staff-1", "attachment", client as never),
    ).rejects.toMatchObject({ code: "FILE_TYPE_NOT_ALLOWED" });
    expect(mocks.writeStoredFile).not.toHaveBeenCalled();
    expect(client.messageFile.create).not.toHaveBeenCalled();
  });

  it("refuses SVG, HTML and plain zip files", async () => {
    const { client } = fakeClient();
    for (const [name, content] of [["logo.svg", "<svg><script>1</script></svg>"], ["page.html", "<html></html>"], ["a.zip", "PK\u0003\u0004zipfile"]] as const) {
      await expect(createMessageFile("event-1", new File([content], name), "staff-1", "attachment", client as never), name).rejects.toBeInstanceOf(MessageFileError);
    }
    expect(mocks.writeStoredFile).not.toHaveBeenCalled();
  });

  it("refuses an attachment over 10 MB before reading it, and an empty file", async () => {
    const { client } = fakeClient();
    const big = { size: 10 * 1024 * 1024 + 1, name: "big.pdf", arrayBuffer: vi.fn() } as unknown as File;
    await expect(createMessageFile("event-1", big, "staff-1", "attachment", client as never)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect((big as unknown as { arrayBuffer: ReturnType<typeof vi.fn> }).arrayBuffer).not.toHaveBeenCalled();
    await expect(createMessageFile("event-1", new File([], "empty.pdf"), "staff-1", "attachment", client as never)).rejects.toMatchObject({ code: "FILE_EMPTY" });
  });

  it("holds an image for a message body to 2 MB and to image types", async () => {
    const { client } = fakeClient();
    const bigImage = { size: 2 * 1024 * 1024 + 1, name: "big.png", arrayBuffer: vi.fn() } as unknown as File;
    await expect(createMessageFile("event-1", bigImage, "staff-1", "inline-image", client as never)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(createMessageFile("event-1", new File([PDF], "doc.pdf"), "staff-1", "inline-image", client as never)).rejects.toMatchObject({ code: "FILE_TYPE_NOT_ALLOWED" });
    const record = await createMessageFile("event-1", new File([PNG], "map.png"), "staff-1", "inline-image", client as never);
    expect(record).toMatchObject({ contentType: "image/png", isInlineImage: true, filename: "map.png" });
  });

  it("removes the stored bytes when the row cannot be written", async () => {
    const { client } = fakeClient();
    client.messageFile.create.mockRejectedValueOnce(new Error("database down"));
    await expect(createMessageFile("event-1", new File([PDF], "a.pdf"), "staff-1", "attachment", client as never)).rejects.toThrow("database down");
    expect(mocks.deleteAsset).toHaveBeenCalledWith("message-files/event-1/generated-name.pdf");
  });
});

describe("createMessageFile limits on the event (#824)", () => {
  it("makes no directory and writes no byte for an event that does not exist", async () => {
    const { client } = fakeClient({ eventExists: false });
    await expect(createMessageFile("no-such-event", new File([PDF], "a.pdf"), "staff-1", "attachment", client as never)).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    expect(mocks.writeStoredFile).not.toHaveBeenCalled();
  });

  it("refuses an upload once the event holds 200 files", async () => {
    const { client } = fakeClient({ existingFiles: 200 });
    await expect(createMessageFile("event-1", new File([PDF], "a.pdf"), "staff-1", "attachment", client as never)).rejects.toMatchObject({ code: "FILE_LIMIT_REACHED" });
    expect(mocks.writeStoredFile).not.toHaveBeenCalled();
  });
});

describe("readMessageFileBytes (#824)", () => {
  const file = { storageKey: "message-files/event-1/secret-dir/x.pdf", sha256: createHash("sha256").update(PDF).digest("hex") };

  it("returns bytes that match their recorded hash", async () => {
    mocks.readAsset.mockResolvedValue(PDF);
    expect(Buffer.from(await readMessageFileBytes(file)).equals(PDF)).toBe(true);
  });

  it("is final, with a generic message and no path, for a missing file or a changed one", async () => {
    mocks.readAsset.mockRejectedValue(Object.assign(new Error("ENOENT: no such file /var/data/secret-dir/x.pdf"), { code: "ENOENT" }));
    const missing = await readMessageFileBytes(file).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(MessageFileDeliveryError);
    expect(missing).toMatchObject({ code: "ATTACHMENT_MISSING", retryable: false });
    expect((missing as Error).message).not.toContain("secret-dir");
    mocks.readAsset.mockResolvedValue(Buffer.from("%PDF-1.7 changed"));
    expect(await readMessageFileBytes(file).catch((error: unknown) => error)).toMatchObject({ code: "ATTACHMENT_CHANGED", retryable: false });
  });

  it("is retryable only for a transient I/O error", async () => {
    for (const [code, retryable] of [["EIO", true], ["EMFILE", true], ["EACCES", false]] as const) {
      mocks.readAsset.mockRejectedValue(Object.assign(new Error(`${code}: /var/data/secret-dir/x.pdf`), { code }));
      const error = await readMessageFileBytes(file).catch((caught: unknown) => caught);
      expect(error, code).toMatchObject({ code: "ATTACHMENT_UNREADABLE", retryable });
      expect((error as Error).message, code).not.toContain("secret-dir");
    }
  });
});

describe("message file routes (#824)", () => {
  it("refuses an upload whose declared size is over 10.5 MB before reading the body", async () => {
    const request = new Request("https://events.imsda.test/api/events/event-1/message-files", {
      method: "POST",
      headers: { origin: "https://events.imsda.test", "content-length": String(11 * 1024 * 1024) },
      body: "x",
    });
    const formData = vi.spyOn(request, "formData");
    const response = await upload(request, eventContext);
    expect(response.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
  });

  it("require MANAGE_COMMUNICATIONS for upload, listing, download and delete", async () => {
    const denied = new mocks.AccessDeniedError("You do not have permission to do that.");
    mocks.requirePermission.mockRejectedValue(denied);
    const { client } = fakeClient();
    mocks.getPrisma.mockReturnValue(client);

    expect((await upload(upload_(new File([PDF], "a.pdf")), eventContext)).status).toBe(403);
    expect((await listImages(new Request("https://events.imsda.test/x"), eventContext)).status).toBe(403);
    expect((await getFile(new Request("https://events.imsda.test/x"), fileContext)).status).toBe(403);
    expect((await deleteFile(new Request("https://events.imsda.test/x", { method: "DELETE" }), fileContext)).status).toBe(403);
    for (const call of mocks.requirePermission.mock.calls) {
      expect(call[1]).toBe("event-1");
      expect(call[2]).toBe("MANAGE_COMMUNICATIONS");
    }
    expect(mocks.requirePermission).toHaveBeenCalledTimes(4);
    expect(mocks.writeStoredFile).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin upload before doing anything", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(Response.json({ error: "CROSS_ORIGIN" }, { status: 403 }));
    const response = await upload(upload_(new File([PDF], "a.pdf")), eventContext);
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).not.toHaveBeenCalled();
  });

  it("uploads for a permitted staff member and answers with the record, never the storage path", async () => {
    const { client } = fakeClient();
    mocks.getPrisma.mockReturnValue(client);
    const response = await upload(upload_(new File([PDF], "Agenda.pdf"), { purpose: "attachment" }), eventContext);
    expect(response.status).toBe(201);
    const json = await response.json() as { file: Record<string, unknown> };
    expect(json.file).toMatchObject({ filename: "Agenda.pdf", url: "/api/events/event-1/message-files/file-1" });
    expect(JSON.stringify(json)).not.toContain("storageKey");
    expect(JSON.stringify(json)).not.toContain("message-files/event-1/generated");
  });

  it("answers an upload of the wrong kind with a plain error", async () => {
    const { client } = fakeClient();
    mocks.getPrisma.mockReturnValue(client);
    const response = await upload(upload_(new File(["MZ"], "a.pdf", { type: "application/pdf" })), eventContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "FILE_TYPE_NOT_ALLOWED" });
    const badPurpose = await upload(upload_(new File([PDF], "a.pdf"), { purpose: "avatar" }), eventContext);
    expect(badPurpose.status).toBe(400);
  });

  it("serves a file only within its own event, by the verified type", async () => {
    const { client, rows } = fakeClient();
    mocks.getPrisma.mockReturnValue(client);
    rows.push({ id: "file-1", eventId: "event-1", filename: "Agenda.pdf", contentType: "application/pdf", storageKey: "message-files/event-1/x.pdf", isInlineImage: false });
    const own = await getFile(new Request("https://events.imsda.test/x"), fileContext);
    expect(own.status).toBe(200);
    expect(own.headers.get("Content-Type")).toBe("application/pdf");
    expect(own.headers.get("X-Disposition")).toBe("attachment");
    const inline = await getFile(new Request("https://events.imsda.test/x?disposition=inline"), fileContext);
    expect(inline.headers.get("X-Disposition")).toBe("inline");
    // Another event's staff, with the same file id, gets nothing.
    const other = await getFile(new Request("https://events.imsda.test/x"), { params: Promise.resolve({ eventId: "event-2", fileId: "file-1" }) });
    expect(other.status).toBe(404);
    expect(client.messageFile.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "file-1", eventId: "event-2" } }));
  });

  it("never deletes a picture a body may refer to", async () => {
    const { client, rows } = fakeClient();
    mocks.getPrisma.mockReturnValue(client);
    rows.push({ id: "file-1", eventId: "event-1", filename: "map.png", contentType: "image/png", storageKey: "k.png", isInlineImage: true });
    const response = await deleteFile(new Request("https://events.imsda.test/x", { method: "DELETE" }), fileContext);
    expect(response.status).toBe(404);
    expect(client.messageFile.deleteMany).not.toHaveBeenCalled();
  });
});
