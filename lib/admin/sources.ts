import { isIP } from "node:net";
import { ValidationError } from "@/lib/errors";

/*
 * Turns the link an admin pastes (Google Sheet, Drive file, Dropbox, direct
 * .xlsx/.csv/.pdf URL) into a downloadable URL and fetches it with a size
 * cap and timeout.
 */

export const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const bad = (message: string) => new ValidationError(message, [{ path: "url", message }]);

/** Share/edit links → their export/download equivalents. */
export function resolveDownloadUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw bad("Enter a valid http(s) link");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad("Only http(s) links are supported");
  assertPublicHost(url.hostname);

  const host = url.hostname.toLowerCase();

  if (host === "docs.google.com") {
    // Published sheet: /spreadsheets/d/e/<key>/pubhtml → pub?output=csv
    const pub = url.pathname.match(/^\/spreadsheets\/d\/e\/([^/]+)/);
    if (pub) {
      const out = new URL(`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub`);
      out.searchParams.set("output", "csv");
      const gid = url.searchParams.get("gid");
      if (gid) out.searchParams.set("gid", gid);
      return out;
    }
    const sheet = url.pathname.match(/^\/spreadsheets\/d\/([^/]+)/);
    if (sheet) {
      // The tab is in the hash (#gid=123) or query (?gid=123); CSV export reads one tab.
      const gid = url.hash.match(/gid=(\d+)/)?.[1] ?? url.searchParams.get("gid") ?? undefined;
      const out = new URL(`https://docs.google.com/spreadsheets/d/${sheet[1]}/export`);
      out.searchParams.set("format", "csv");
      if (gid) out.searchParams.set("gid", gid);
      return out;
    }
  }

  if (host === "drive.google.com") {
    const id = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? url.searchParams.get("id");
    if (id) {
      const out = new URL("https://drive.google.com/uc");
      out.searchParams.set("export", "download");
      out.searchParams.set("id", id);
      return out;
    }
  }

  if (host === "www.dropbox.com" || host === "dropbox.com") {
    url.searchParams.set("dl", "1");
    return url;
  }

  return url;
}

/** Blocks loopback/private targets so the importer can't be pointed at internal services. */
function assertPublicHost(hostname: string): void {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    throw bad("Links to local addresses are not allowed");
  }
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw bad("Links to private addresses are not allowed");
    }
  } else if (v === 6 && (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80"))) {
    throw bad("Links to private addresses are not allowed");
  }
}

export interface DownloadedSource {
  buffer: Buffer;
  contentType: string;
  /** File name from Content-Disposition or the URL path, when there is one. */
  fileName?: string;
  finalUrl: string;
}

export async function downloadSource(link: string): Promise<DownloadedSource> {
  const url = resolveDownloadUrl(link);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new ValidationError("Could not download the link", [{ path: "url", message: "Download failed or timed out" }], { cause: err });
  }
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 || res.status === 404 ? " — make sure it is shared as “Anyone with the link can view”" : "";
    throw bad(`The link returned HTTP ${res.status}${hint}`);
  }
  if (Number(res.headers.get("content-length") ?? 0) > MAX_SOURCE_BYTES) throw bad("File is larger than 15 MB");

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_SOURCE_BYTES) throw bad("File is larger than 15 MB");

  const disposition = res.headers.get("content-disposition") ?? "";
  const fromHeader = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const fromPath = new URL(res.url || url.toString()).pathname.split("/").filter(Boolean).pop();
  return {
    buffer,
    contentType: res.headers.get("content-type") ?? "",
    fileName: fromHeader ? decodeURIComponent(fromHeader) : fromPath,
    finalUrl: res.url || url.toString(),
  };
}
