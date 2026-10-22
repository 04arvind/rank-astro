import { inflateRawSync } from "node:zlib";

/*
 * Minimal .xlsx reader: enough of ZIP + SpreadsheetML to read cell values
 * from provider onboarding sheets. No formulas, styles or dates-as-serials.
 */

type Row = Record<string, string | undefined>;

function unzip(buf: Buffer): Map<string, Buffer> {
  // End of central directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(start, start + compressedSize);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
    return ENTITIES[e] ?? m;
  });
}

/** Concatenated text of all <t> nodes (handles rich-text runs). */
const textOf = (xml: string) => decode([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

function sheetPaths(files: Map<string, Buffer>): Map<string, string> {
  const workbook = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const targets = new Map<string, string>();
  for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
  }
  const out = new Map<string, string>();
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(tag, "name");
    const rid = attr(tag, "r:id");
    const target = rid && targets.get(rid);
    if (name && target) out.set(decode(name), target);
  }
  return out;
}

function readRows(xml: string, shared: string[]): Row[] {
  const rows: Row[] = [];
  for (const [, body] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: Row = {};
    for (const [, open, inner = ""] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = attr(open, "r")?.replace(/\d+$/, "");
      if (!col) continue;
      const type = attr(open, "t");
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      row[col] =
        type === "s" ? shared[Number(v)]
        : type === "inlineStr" ? textOf(inner)
        : v !== undefined ? decode(v)
        : undefined;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Reads one worksheet into header-keyed records. The first non-empty row is
 * the header; columns without a header are dropped, blank rows skipped.
 */
export function readXlsx(buf: Buffer, sheet?: string): Record<string, string | undefined>[] {
  const files = unzip(buf);
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) => textOf(m[1]),
  );
  const paths = sheetPaths(files);
  const target = sheet ? paths.get(sheet) : paths.values().next().value;
  if (!target) throw new Error(`Sheet "${sheet}" not found (have: ${[...paths.keys()].join(", ")})`);

  const rows = readRows(files.get(target)?.toString("utf8") ?? "", shared);
  const headerIndex = rows.findIndex((r) => Object.values(r).some((v) => v?.trim()));
  if (headerIndex < 0) return [];

  const header = Object.entries(rows[headerIndex])
    .map(([col, name]) => [col, name?.replace(/\s+/g, " ").trim()] as const)
    .filter((e): e is readonly [string, string] => Boolean(e[1]));

  return rows
    .slice(headerIndex + 1)
    .map((r) => Object.fromEntries(header.map(([col, name]) => [name, r[col]])))
    .filter((r) => Object.values(r).some((v) => v?.trim()));
}
