import type { NextRequest } from "next/server";
import { z } from "zod";
import { MAX_SOURCE_BYTES, type ColumnMapping } from "@/lib/admin";
import { ApiError, ValidationError } from "@/lib/errors";
import { safeJsonParse } from "@/lib/utils/parse";
import { formatIssues } from "@/lib/utils/validation";
import { prepareImport, previewOf, runImport, type ImportInput } from "../../../_lib/adminImport";
import { requireAdminSession, requireDatabase } from "../../../_lib/adminSession";
import { handle, ok } from "../../../_lib/http";

const fields = z.object({
  action: z.enum(["preview", "import"]),
  providerName: z.string().trim().min(2, "Provider name is required").max(80),
  sourceKind: z.enum(["link", "upload"]),
  url: z.string().trim().max(2048).optional(),
  sheet: z.string().trim().max(100).optional(),
  mode: z.enum(["merge", "replace"]).default("merge"),
  defaultVerified: z.enum(["true", "false"]).default("true"),
  mapping: z.string().max(20_000).optional(),
});

const mappingSchema = z.record(z.string().max(200), z.string().max(40));

/**
 * POST /api/admin/astrologers/import (multipart/form-data)
 *   action=preview → parse + map + validate, nothing written
 *   action=import  → same, then upsert into MongoDB and record the import
 * Source: `url` (Google Sheet / Drive / Excel / CSV / PDF link) or `file`.
 */
export const POST = handle(async (req: NextRequest, { requestId }) => {
  requireAdminSession(req);
  requireDatabase();

  if (Number(req.headers.get("content-length") ?? 0) > MAX_SOURCE_BYTES + 64 * 1024) {
    throw new ApiError("PAYLOAD_TOO_LARGE", "File is larger than 15 MB");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Send the form as multipart/form-data", { cause: err });
  }

  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v : undefined;
  };
  const parsed = fields.safeParse(Object.fromEntries(Object.keys(fields.shape).map((k) => [k, text(k)])));
  if (!parsed.success) throw new ValidationError("Check the form", formatIssues(parsed.error));
  const f = parsed.data;

  let mapping: ColumnMapping | undefined;
  if (f.mapping) {
    const json = safeJsonParse(f.mapping);
    const m = json.ok ? mappingSchema.safeParse(json.value) : null;
    if (!m?.success) throw new ValidationError("Invalid column mapping", [{ path: "mapping", message: "must be a JSON object" }]);
    mapping = m.data as ColumnMapping;
  }

  let file: Buffer | undefined;
  let fileName: string | undefined;
  if (f.sourceKind === "upload") {
    const upload = form.get("file");
    if (!(upload instanceof File) || upload.size === 0) throw new ValidationError("Choose a file to upload", [{ path: "file", message: "File is required" }]);
    if (upload.size > MAX_SOURCE_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE", "File is larger than 15 MB");
    file = Buffer.from(await upload.arrayBuffer());
    fileName = upload.name;
  }

  const input: ImportInput = {
    providerName: f.providerName,
    source: f.sourceKind === "link" ? { kind: "link", url: f.url, sheet: f.sheet } : { kind: "upload", fileName, sheet: f.sheet },
    file,
    mapping,
    mode: f.mode,
    defaultVerified: f.defaultVerified === "true",
  };

  if (f.action === "preview") return ok(previewOf(await prepareImport(input)), { requestId });
  const { preview, record } = await runImport(input);
  return ok({ ...preview, record }, { requestId });
});
