import type { NextRequest } from "next/server";
import { z } from "zod";
import { ROLE_COOKIE } from "@/app/_lib/role";
import { ApiError, ValidationError } from "@/lib/errors";
import { getTrainingJob, parseTrainingRows, startTrainingJob } from "@/lib/ranking/ml/trainJob";
import { requireAdmin } from "../../../_lib/auth";
import { handle, ok } from "../../../_lib/http";
import { parseJsonBody } from "../../../_lib/validation";

/*
 * Layer-4 (ML ranking) training (admin only).
 *
 * GET                     the current / last training run
 * POST { from, to }       train on lists served in [from, to) (epoch ms)
 * POST multipart from, to, file
 *                         same, plus the file's training.jsonl rows in that range
 */

const DAY_MS = 86_400_000;
const bodySchema = z
  .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
  .refine((b) => b.from < b.to, { message: "Start must be before end", path: ["to"] })
  .refine((b) => b.to - b.from <= 365 * DAY_MS, { message: "Range can be at most 365 days", path: ["from"] });

/** Admin key (see requireAdmin) and the admin role, like the /admin page itself. */
function requireAdminRole(req: NextRequest) {
  requireAdmin(req);
  if (req.cookies.get(ROLE_COOKIE)?.value !== "admin") throw new ApiError("FORBIDDEN", "Admin only");
}

export const GET = handle(async (req: NextRequest, { requestId }) => {
  requireAdminRole(req);
  return ok({ job: getTrainingJob() }, { requestId });
});

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** Multipart body: from, to and an optional `file` (training.jsonl rows to add to the logged data). */
async function parseMultipart(req: NextRequest) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_IMPORT_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE", "Data file must be at most 25 MB");
  const form = await req.formData().catch(() => {
    throw new ValidationError("Invalid form data");
  });
  const parsed = bodySchema.safeParse({ from: Number(form.get("from")), to: Number(form.get("to")) });
  if (!parsed.success) throw new ValidationError("Request validation failed", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ...parsed.data, imported: undefined };
  if (file.size > MAX_IMPORT_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE", "Data file must be at most 25 MB");
  const { rows, errors } = parseTrainingRows(await file.text());
  if (errors.length) throw new ValidationError(`Data file has invalid rows (${file.name})`, errors);
  if (!rows.length) throw new ValidationError(`Data file has no rows (${file.name})`);
  return { ...parsed.data, imported: { name: file.name, rows } };
}

export const POST = handle(async (req: NextRequest, { requestId }) => {
  requireAdminRole(req);
  const multipart = (req.headers.get("content-type") ?? "").includes("multipart/form-data");
  const body = multipart ? await parseMultipart(req) : { ...(await parseJsonBody(req, bodySchema)), imported: undefined };
  const job = startTrainingJob({ from: body.from, to: Math.min(body.to, Date.now()), imported: body.imported });
  if (!job) throw new ValidationError("A training run is already in progress");
  return ok({ job }, { requestId });
});
