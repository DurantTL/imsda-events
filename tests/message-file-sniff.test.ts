import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { sniffMessageFileType } from "@/modules/communications/message-file-sniff";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type Entry = { name: string; data?: string; deflate?: boolean };

/** A real ZIP: local headers, a central directory and an end record. Enough for the sniffer, not a general writer. */
function zip(entries: Entry[], options: { eocd?: boolean } = {}) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data ?? "", "utf8");
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localBytes = Buffer.concat([local, name, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(localBytes);
    offset += localBytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, ...(options.eocd === false ? [] : [end])]);
}

const contentTypes = (main: string) =>
  `<?xml version="1.0"?><Types><Override PartName="/x" ContentType="application/vnd.openxmlformats-officedocument.${main}.main+xml"/></Types>`;

describe("sniffMessageFileType (#824)", () => {
  it("recognises the simple types from their signatures", () => {
    expect(sniffMessageFileType(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffMessageFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffMessageFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMessageFileType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
  });

  it("recognises each Office package from its central directory, stored or deflated", () => {
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("wordprocessingml.document"), deflate: true }, { name: "word/document.xml" }]))).toBe(DOCX);
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("spreadsheetml.sheet") }, { name: "xl/workbook.xml" }]))).toBe(XLSX);
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("presentationml.presentation") }, { name: "ppt/presentation.xml" }]))).toBe(PPTX);
  });

  it("refuses a plain zip, and a zip that only mentions the part names in its content", () => {
    expect(sniffMessageFileType(zip([{ name: "notes.txt", data: "hi" }, { name: "photo.jpg" }]))).toBeNull();
    // The names appear as text inside a stored file, not as entries.
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("x") }, { name: "readme.txt", data: "word/document.xml xl/workbook.xml" }]))).toBeNull();
    // A near miss is not the part.
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("x") }, { name: "word/document.xml.bak" }]))).toBeNull();
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("x") }, { name: "evil/word/document.xml" }]))).toBeNull();
  });

  it("refuses a package with no [Content_Types].xml, a missing directory, or two kinds of main part", () => {
    expect(sniffMessageFileType(zip([{ name: "word/document.xml" }]))).toBeNull();
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("x") }, { name: "word/document.xml" }], { eocd: false }))).toBeNull();
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("x") }, { name: "word/document.xml" }, { name: "xl/workbook.xml" }]))).toBeNull();
    expect(sniffMessageFileType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBeNull();
  });

  it("refuses a macro-enabled or VBA-carrying package", () => {
    const macroTypes = '<Types><Override PartName="/x" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>';
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: macroTypes }, { name: "word/document.xml" }]))).toBeNull();
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("x") }, { name: "word/document.xml" }, { name: "word/vbaProject.bin" }]))).toBeNull();
  });

  it("refuses entry names that climb out of the package", () => {
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("x") }, { name: "word/document.xml" }, { name: "../evil.exe" }]))).toBeNull();
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: contentTypes("x") }, { name: "word/document.xml" }, { name: "/abs" }]))).toBeNull();
  });

  it("bounds what it inflates: a content-types part that expands past the limit is refused", () => {
    const bomb = "A".repeat(600 * 1024);
    expect(sniffMessageFileType(zip([{ name: "[Content_Types].xml", data: bomb, deflate: true }, { name: "word/document.xml" }]))).toBeNull();
  });

  it("refuses scripts, markup, executables and nothing", () => {
    expect(sniffMessageFileType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WAVEfmt ")]))).toBeNull();
    expect(sniffMessageFileType(Buffer.from("MZ\x90\x00\x03", "latin1"))).toBeNull();
    expect(sniffMessageFileType(Buffer.from("#!/bin/sh\necho hi\n"))).toBeNull();
    expect(sniffMessageFileType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"))).toBeNull();
    expect(sniffMessageFileType(Buffer.alloc(0))).toBeNull();
  });
});
