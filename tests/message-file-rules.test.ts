import { describe, expect, it } from "vitest";
import {
  attachmentSetIssue,
  MAX_MESSAGE_ATTACHMENT_COUNT,
  MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES,
  messageFileIdsInHtml,
  messageFileIdsInMarkdown,
  plainTextFromMessageSource,
  safeMessageFileName,
  sniffMessageFileType,
} from "@/modules/communications/message-file-rules";

const MB = 1024 * 1024;

/** A byte string that begins like the format and carries the entry names a package needs. */
function zipWith(...names: string[]) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(names.join("\0"), "latin1"),
  ]);
}

describe("sniffMessageFileType (#824)", () => {
  it("recognises each allowed type from its bytes", () => {
    expect(sniffMessageFileType(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffMessageFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffMessageFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMessageFileType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
    expect(sniffMessageFileType(zipWith("[Content_Types].xml", "word/document.xml"))).toContain("wordprocessingml.document");
    expect(sniffMessageFileType(zipWith("[Content_Types].xml", "xl/workbook.xml"))).toContain("spreadsheetml.sheet");
    expect(sniffMessageFileType(zipWith("[Content_Types].xml", "ppt/presentation.xml"))).toContain("presentationml.presentation");
  });

  it("refuses everything else, whatever it was called", () => {
    // A RIFF container that is not WebP (a WAV), a plain zip, an executable, a script, text, and nothing.
    expect(sniffMessageFileType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WAVEfmt ")]))).toBeNull();
    expect(sniffMessageFileType(zipWith("notes.txt", "photo.jpg"))).toBeNull();
    expect(sniffMessageFileType(Buffer.from("MZ\x90\x00\x03", "latin1"))).toBeNull();
    expect(sniffMessageFileType(Buffer.from("#!/bin/sh\necho hi\n"))).toBeNull();
    expect(sniffMessageFileType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"))).toBeNull();
    expect(sniffMessageFileType(Buffer.from("<html><script>1</script></html>"))).toBeNull();
    expect(sniffMessageFileType(Buffer.alloc(0))).toBeNull();
  });

  it("refuses an Office package that carries a macro project", () => {
    expect(sniffMessageFileType(zipWith("[Content_Types].xml", "word/document.xml", "word/vbaProject.bin"))).toBeNull();
  });

  it("refuses an Office-looking package with no [Content_Types].xml", () => {
    expect(sniffMessageFileType(zipWith("word/document.xml"))).toBeNull();
  });
});

describe("safeMessageFileName (#824)", () => {
  it("strips path separators, control characters and leading dots, and forces the sniffed extension", () => {
    expect(safeMessageFileName("../../.env", "application/pdf")).toBe("env.pdf");
    expect(safeMessageFileName("C:\\Users\\x\\Agenda.exe", "application/pdf")).toBe("C Users x Agenda.pdf");
    expect(safeMessageFileName('a"b\r\nc.png', "image/png")).toBe("abc.png");
    expect(safeMessageFileName("Agenda.pdf", "application/pdf")).toBe("Agenda.pdf");
    expect(safeMessageFileName("", "image/jpeg")).toBe("attachment.jpg");
    expect(safeMessageFileName("a".repeat(300) + ".pdf", "application/pdf").length).toBeLessThanOrEqual(104);
  });
});

describe("attachmentSetIssue (#824)", () => {
  it("accepts a set within 10 files and 20 MB", () => {
    expect(attachmentSetIssue([{ sizeBytes: 10 * MB }, { sizeBytes: 10 * MB }])).toBeNull();
  });

  it("rejects a set over 20 MB together, even when each file is within 10 MB", () => {
    const issue = attachmentSetIssue([{ sizeBytes: 10 * MB }, { sizeBytes: 10 * MB }, { sizeBytes: 1 }]);
    expect(issue?.code).toBe("TOTAL_TOO_LARGE");
    expect(MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES).toBe(20 * MB);
  });

  it("rejects too many files", () => {
    const files = Array.from({ length: MAX_MESSAGE_ATTACHMENT_COUNT + 1 }, () => ({ sizeBytes: 1 }));
    expect(attachmentSetIssue(files)?.code).toBe("TOO_MANY");
  });
});

describe("message file references (#824)", () => {
  it("finds uploaded images in a body, in order and once", () => {
    const markdown = "![A](msgfile:cm9abc123def456) text ![B](msgfile:cm9zzz987yxw654) ![A](msgfile:cm9abc123def456) ![x](https://example.test/a.png)";
    expect(messageFileIdsInMarkdown(markdown)).toEqual(["cm9abc123def456", "cm9zzz987yxw654"]);
  });

  it("finds uploaded images in rendered HTML only in the exact tag the renderer produces", () => {
    expect(messageFileIdsInHtml('<img src="msgfile:cm9abc123def456" alt="A" style="x" />')).toEqual(["cm9abc123def456"]);
    expect(messageFileIdsInHtml('<a href="msgfile:cm9abc123def456">x</a>')).toEqual([]);
  });

  it("keeps the image and button markers out of the plain-text part", () => {
    const text = plainTextFromMessageSource("Hi.\n\n![Map](msgfile:cm9abc123def456)\n\n[Open](https://example.test){.button}");
    expect(text).toContain("[Image: Map]");
    expect(text).toContain("[Open](https://example.test)");
    expect(text).not.toContain("msgfile:");
    expect(text).not.toContain("{.button}");
  });
});
