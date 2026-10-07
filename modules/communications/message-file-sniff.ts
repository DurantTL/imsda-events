import { inflateRawSync } from "node:zlib";
import type { MessageFileType } from "@/modules/communications/message-file-rules";

/**
 * Decides what a staff upload really is, from its bytes alone (#824). Server-side only: it reads ZIP structure with
 * node:zlib, which the editor bundle must never pull in.
 *
 * Word, Excel and PowerPoint files are ZIP packages, so the ZIP signature proves nothing. The package's central
 * directory is parsed and entry names are matched exactly (no substring search over the file's bytes, which a
 * stored text file could satisfy), `[Content_Types].xml` is inflated under a size bound, and a package that declares
 * a macro-enabled type or carries a VBA project is refused.
 */

const MAX_ZIP_ENTRIES = 5000;
const MAX_CONTENT_TYPES_BYTES = 256 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

type ZipEntry = { name: string; method: number; compressedSize: number; localOffset: number };

/** The entries of a ZIP, or null when its directory is missing, inconsistent, ZIP64, or implausibly large. */
function readCentralDirectory(buffer: Buffer): ZipEntry[] | null {
  // The end-of-central-directory record sits in the last 64 KB + 22 bytes.
  const searchFrom = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= searchFrom; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
  if (count > MAX_ZIP_ENTRIES || directoryOffset + directorySize > eocd) return null;

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let entry = 0; entry < count; entry += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > buffer.length) return null;
    entries.push({ name: buffer.toString("utf8", cursor + 46, nameEnd), method, compressedSize, localOffset });
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** The text of one entry, inflated under a bound; null when it cannot be read within it. */
function readEntryText(buffer: Buffer, entry: ZipEntry): string | null {
  if (entry.compressedSize > MAX_CONTENT_TYPES_BYTES) return null;
  const header = entry.localOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) return null;
  const start = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length) return null;
  const data = buffer.subarray(start, end);
  try {
    if (entry.method === 0) return data.toString("utf8");
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_CONTENT_TYPES_BYTES }).toString("utf8");
  } catch {
    return null;
  }
  return null;
}

const OFFICE_MAIN_PARTS: ReadonlyArray<readonly [string, MessageFileType]> = [
  ["word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
];

function sniffOfficePackage(bytes: Uint8Array): MessageFileType | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readCentralDirectory(buffer);
  if (!entries || entries.length === 0) return null;
  const names = new Set<string>();
  for (const { name } of entries) {
    // A package never has an absolute or climbing entry name, and never a VBA project.
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) return null;
    if (/(^|\/)vbaProject\.bin$/i.test(name)) return null;
    names.add(name);
  }
  const contentTypes = entries.find((entry) => entry.name === "[Content_Types].xml");
  if (!contentTypes) return null;
  const declared = readEntryText(buffer, contentTypes);
  if (declared === null || /macroEnabled|vbaProject/i.test(declared)) return null;
  const matches = OFFICE_MAIN_PARTS.filter(([part]) => names.has(part));
  // Exactly one kind of main part: a package claiming to be two things is neither.
  return matches.length === 1 ? matches[0][1] : null;
}

export function sniffMessageFileType(bytes: Uint8Array): MessageFileType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return sniffOfficePackage(bytes);
  return null;
}
