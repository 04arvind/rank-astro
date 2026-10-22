import { ValidationError } from "@/lib/errors";
import { readFeed } from "@/lib/providers/readers";
import { readXlsx } from "@/lib/providers/readers/xlsx";
import { detectMapping, isImportField } from "./fields";

/*
 * Any supported file → header-keyed rows. Spreadsheets reuse the provider
 * feed readers; PDFs are rebuilt into a table from text positions.
 */

export type SourceFormat = "xlsx" | "csv" | "json" | "pdf";
export type Row = Record<string, string | undefined>;

export interface ParsedTable {
  format: SourceFormat;
  headers: string[];
  rows: Row[];
}

const unreadable = (message: string) => new ValidationError(message, [{ path: "file", message }]);

export function detectFormat(buf: Buffer, hint = ""): SourceFormat {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return "xlsx";
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xd0cf11e0) {
    throw unreadable("Old .xls files aren't supported — save it as .xlsx or CSV and try again");
  }
  const head = buf.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^<(!doctype|html|\?xml)/i.test(head)) {
    throw unreadable("The link returned a web page, not a file — share it as “Anyone with the link can view”, or upload the file");
  }
  if (/^[[{]/.test(head) || /json/i.test(hint)) return "json";
  return "csv";
}

/** Picks the delimiter that splits the header line most; detects one-cell-per-row exports. */
function csvSpec(buf: Buffer) {
  const first = buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  // `"a<TAB>b<TAB>c",,` — every row wrapped in one quoted cell (see providerC).
  if (/^"[^"]*\t/.test(first.trim())) return { format: "csv" as const, delimiter: "\t", wrappedRows: true };
  const counts = ["\t", ",", ";", "|"].map((d) => [d, first.split(d).length - 1] as const);
  const [delimiter] = counts.reduce((best, c) => (c[1] > best[1] ? c : best));
  return { format: "csv" as const, delimiter };
}

/** First array of objects in a JSON document (root, or under data/astrologers/items…). */
function jsonRecords(buf: Buffer): Row[] {
  let data: unknown;
  try {
    data = JSON.parse(buf.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw unreadable("The file is not valid JSON");
  }
  const queue: unknown[] = [data];
  while (queue.length) {
    const v = queue.shift();
    if (Array.isArray(v) && v.some((x) => x && typeof x === "object" && !Array.isArray(x))) {
      return v
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))
        .map((o) =>
          Object.fromEntries(
            Object.entries(o).map(([k, val]) => [k, val === null || val === undefined ? undefined : Array.isArray(val) ? val.join(", ") : typeof val === "object" ? JSON.stringify(val) : String(val)]),
          ),
        );
    }
    if (v && typeof v === "object") queue.push(...Object.values(v));
  }
  throw unreadable("No list of astrologers found in the JSON");
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

interface Piece {
  x: number;
  end: number;
  y: number;
  text: string;
}
interface Cell {
  x: number;
  end: number;
  text: string;
}

/** Text pieces on one baseline, merged into cells wherever there's a visible gap. */
function toCells(pieces: Piece[]): Cell[] {
  const cells: Cell[] = [];
  for (const p of pieces.sort((a, b) => a.x - b.x)) {
    const last = cells.at(-1);
    if (last && p.x - last.end < 4) {
      last.text += (p.x - last.end > 1 ? " " : "") + p.text;
      last.end = Math.max(last.end, p.end);
    } else {
      cells.push({ x: p.x, end: p.end, text: p.text });
    }
  }
  return cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() })).filter((c) => c.text);
}

async function pdfLines(buf: Buffer): Promise<Cell[][]> {
  const { getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf));
  } catch (err) {
    throw new ValidationError("Could not open the PDF", [{ path: "file", message: "Could not open the PDF" }], { cause: err });
  }
  const lines: Cell[][] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const pieces: Piece[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [, , , , x, y] = item.transform as number[];
      pieces.push({ x, end: x + (item.width ?? 0), y, text: item.str });
    }
    // Group by baseline (top to bottom); a few units of tolerance for sub/superscripts.
    pieces.sort((a, b) => b.y - a.y);
    let current: Piece[] = [];
    let y = Number.NaN;
    for (const p of pieces) {
      if (current.length && Math.abs(p.y - y) > 3) {
        lines.push(toCells(current));
        current = [];
      }
      if (!current.length) y = p.y;
      current.push(p);
    }
    if (current.length) lines.push(toCells(current));
  }
  await pdf.destroy();
  return lines.filter((l) => l.length);
}

/**
 * Rebuilds a table from a PDF: the header is the first line with ≥2 cells
 * that names an astrologer field; later cells go to the column whose header
 * starts at or before them. A line with nothing in the first column
 * continues the previous row (wrapped cell text). Repeated headers on later
 * pages are skipped.
 */
async function pdfTable(buf: Buffer): Promise<{ headers: string[]; rows: Row[] }> {
  const lines = await pdfLines(buf);
  const headerIdx = lines.findIndex((l) => {
    if (l.length < 2) return false;
    const m = detectMapping(l.map((c) => c.text));
    return Object.values(m).some((f) => f === "name") && Object.values(m).filter(isImportField).length >= 2;
  });
  if (headerIdx < 0) throw unreadable("Couldn't find a table with a Name column in this PDF");

  const header = lines[headerIdx];
  const headers = header.map((c) => c.text);
  const signature = headers.join("|");
  const columnOf = (x: number) => {
    let col = 0;
    for (let i = 0; i < header.length; i++) if (x >= header[i].x - 6) col = i;
    return col;
  };

  const rows: Row[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (line.map((c) => c.text).join("|") === signature) continue;
    const values: string[] = new Array(headers.length).fill("");
    for (const c of line) {
      const i = columnOf(c.x);
      values[i] = values[i] ? `${values[i]} ${c.text}` : c.text;
    }
    const prev = rows.at(-1);
    if (prev && !values[0] && values.some(Boolean)) {
      headers.forEach((h, i) => {
        if (values[i]) prev[h] = prev[h] ? `${prev[h]} ${values[i]}` : values[i];
      });
      continue;
    }
    if (values.some(Boolean)) rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] || undefined])));
  }
  return { headers, rows };
}

// ---------------------------------------------------------------------------

function headersOf(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (k.trim()) seen.add(k);
  return [...seen];
}

/** Reads a downloaded or uploaded file into rows. `sheet` selects an xlsx worksheet by name. */
export async function parseTable(buf: Buffer, { hint = "", sheet }: { hint?: string; sheet?: string } = {}): Promise<ParsedTable> {
  if (buf.length === 0) throw unreadable("The file is empty");
  const format = detectFormat(buf, hint);
  let rows: Row[];
  let headers: string[] | undefined;
  try {
    switch (format) {
      case "xlsx":
        rows = readXlsx(buf, sheet || undefined);
        break;
      case "csv":
        rows = readFeed(buf, csvSpec(buf)) as Row[];
        break;
      case "json":
        rows = jsonRecords(buf);
        break;
      case "pdf":
        ({ headers, rows } = await pdfTable(buf));
        break;
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("Could not read the file", [{ path: "file", message: err instanceof Error ? err.message : "Unreadable file" }], { cause: err });
  }
  if (rows.length === 0) throw unreadable("No rows found below the header");
  return { format, headers: headers ?? headersOf(rows), rows };
}
