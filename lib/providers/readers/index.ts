import { parse as parseCsv } from "csv-parse/sync";
import { getPath } from "@/lib/utils/parse";
import { readXlsx } from "./xlsx";

export type FeedFormat = "csv" | "xlsx" | "json";

export interface FeedSpec {
  format: FeedFormat;
  /** Worksheet name for xlsx feeds; first sheet when omitted. */
  sheet?: string;
  /** For JSON feeds whose records sit under a key, e.g. "data.astrologers". */
  recordsPath?: string;
  /** Default file, relative to the project root. */
  defaultPath?: string;
  /** Field delimiter for csv feeds; "," when omitted. */
  delimiter?: string;
  /**
   * csv feeds whose every row was exported as one quoted cell
   * (e.g. `"a<TAB>b<TAB>c",,`): each line is unwrapped before parsing and
   * quoting is disabled, so values keep any inner quotes for the adapter.
   */
  wrappedRows?: boolean;
}

const tidyHeader = (h: string) => h.replace(/\s+/g, " ").trim();

/** `"a\tb ""x"" c",,` → `a\tb "x" c` — one line at a time. */
function unwrapRows(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const s = line.replace(/,+\s*$/, "").trim();
      return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s;
    })
    .join("\n");
}

function readCsv(buf: Buffer, spec: FeedSpec): Record<string, string>[] {
  const input = spec.wrappedRows ? unwrapRows(buf.toString("utf8").replace(/^﻿/, "")) : buf;
  return parseCsv(input, {
    columns: (header: string[]) => header.map(tidyHeader),
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    ...(spec.delimiter ? { delimiter: spec.delimiter } : {}),
    ...(spec.wrappedRows ? { quote: false } : {}),
  }) as Record<string, string>[];
}

function readJson(buf: Buffer, recordsPath?: string): unknown[] {
  const data = getPath(JSON.parse(buf.toString("utf8")), recordsPath);
  if (!Array.isArray(data)) throw new Error(`JSON feed has no array at "${recordsPath ?? "<root>"}"`);
  return data;
}

/** xlsx files are ZIP archives ("PK\x03\x04"). */
const isZip = (buf: Buffer) => buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;

/**
 * Turns a raw feed file into an array of records for the provider adapter.
 * Spreadsheet feeds are read by content, not extension: a csv/xlsx feed
 * that is really the other format (e.g. a text export saved as .xlsx)
 * still parses.
 */
export function readFeed(buf: Buffer, spec: FeedSpec): unknown[] {
  if (spec.format === "csv" && isZip(buf)) return readXlsx(buf, spec.sheet);
  if (spec.format === "xlsx" && !isZip(buf)) return readCsv(buf, spec);
  switch (spec.format) {
    case "csv":
      return readCsv(buf, spec);
    case "xlsx":
      return readXlsx(buf, spec.sheet);
    case "json":
      return readJson(buf, spec.recordsPath);
  }
}
