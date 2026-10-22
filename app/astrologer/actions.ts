"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { config } from "@/config";
import { getAstrologerRepository } from "@/lib/astrologer";
import {
  acceptRequest,
  callNow,
  rejectRequest,
  markAllNotificationsRead,
  updatePortalSettings,
  type DayHours,
  type PortalSettings,
} from "@/lib/astrologer-portal";
import { dayStartOf, inputToMinutes } from "@/lib/astrologer-portal/calendar";
import { toPublicError } from "@/lib/errors";
import { MINUTE_MS } from "@/lib/utils/time";
import { ROLE_COOKIE } from "../_lib/role";
import { ASTROLOGER_COOKIE, getSignedInAstrologer } from "../_lib/astrologerSession";

/*
 * Astrologer portal actions. Each acts for the astrologer in the session
 * cookie (never an id from the form) and returns a result the form shows.
 */

export type ActionResult = { ok: boolean; message?: string } | null;

const COOKIE_OPTS = { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 30 } as const;

async function asAstrologer(fn: (astrologerId: string) => Promise<string | void>): Promise<ActionResult> {
  const a = await getSignedInAstrologer();
  if (!a) redirect("/astrologer/login");
  try {
    const message = await fn(a.id);
    revalidatePath("/astrologer");
    return { ok: true, message: message ?? undefined };
  } catch (err) {
    return { ok: false, message: toPublicError(err).message };
  }
}

const fail = (message: string): ActionResult => ({ ok: false, message });

/* ───────────────────────────── session ───────────────────────────── */

export async function loginAstrologer(formData: FormData): Promise<void> {
  const id = String(formData.get("astrologerId") ?? "");
  const [a] = id ? await getAstrologerRepository().getByIds([id]) : [];
  if (!a) redirect("/astrologer/login");
  const jar = await cookies();
  jar.set(ASTROLOGER_COOKIE, a.id, COOKIE_OPTS);
  jar.set(ROLE_COOKIE, "astrologer", COOKIE_OPTS);
  redirect("/astrologer");
}

export async function logoutAstrologer(): Promise<void> {
  (await cookies()).delete(ASTROLOGER_COOKIE);
  redirect("/astrologer/login");
}

/* ───────────────────────────── consultations ───────────────────────────── */

const bookingId = z.string().trim().min(1).max(128);

export async function acceptAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const id = bookingId.safeParse(formData.get("bookingId"));
  if (!id.success) return fail("Unknown booking.");
  return asAstrologer(async (me) => {
    await acceptRequest(me, id.data);
    return "Request accepted.";
  });
}

export async function rejectAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const id = bookingId.safeParse(formData.get("bookingId"));
  if (!id.success) return fail("Unknown booking.");
  return asAstrologer(async (me) => {
    const { reassigned } = await rejectRequest(me, id.data);
    return reassigned ? "Request declined and passed to another astrologer." : "Request declined; the booking is cancelled.";
  });
}

export async function callNowAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const id = bookingId.safeParse(formData.get("bookingId"));
  if (!id.success) return fail("Unknown booking.");
  return asAstrologer(async (me) => {
    await callNow(me, id.data);
    return "Call connected.";
  });
}

export async function markReadAction(): Promise<ActionResult> {
  return asAstrologer(async (me) => {
    await markAllNotificationsRead(me);
  });
}

/* ───────────────────────────── availability ───────────────────────────── */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Start/end time inputs → minutes, or an error message. */
function hoursFrom(start: FormDataEntryValue | null, end: FormDataEntryValue | null): { startMinute: number; endMinute: number } | string {
  const s = inputToMinutes(String(start ?? ""));
  const e = inputToMinutes(String(end ?? ""));
  if (s === null || e === null) return "Enter a valid start and end time.";
  if (e <= s) return "End time must be after the start time.";
  return { startMinute: s, endMinute: e };
}

export async function setStatusAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const status = formData.get("status");
  if (status !== "available" && status !== "unavailable") return fail("Unknown status.");
  return asAstrologer(async (me) => {
    await updatePortalSettings(me, (s) => ({ ...s, status }));
    return status === "available" ? "You're available for consultations." : "You're marked unavailable.";
  });
}

export async function saveWeeklyHoursAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const weekly: DayHours[] = [];
  for (let d = 0; d < 7; d++) {
    const enabled = formData.get(`day${d}_enabled`) === "on";
    const hours = hoursFrom(formData.get(`day${d}_start`), formData.get(`day${d}_end`));
    if (typeof hours === "string") {
      if (enabled) return fail(hours);
      weekly.push({ enabled, ...config.booking.workingHours });
    } else weekly.push({ enabled, ...hours });
  }
  return asAstrologer(async (me) => {
    await updatePortalSettings(me, (s) => ({ ...s, weeklyHours: weekly }));
    return "Working hours saved.";
  });
}

export async function setDayAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const day = date.safeParse(formData.get("date"));
  if (!day.success) return fail("Pick a date.");
  const mode = formData.get("mode");
  let override: PortalSettings["dayOverrides"][string] | null;
  if (mode === "default") override = null;
  else if (mode === "off") override = { off: true };
  else if (mode === "custom") {
    const hours = hoursFrom(formData.get("start"), formData.get("end"));
    if (typeof hours === "string") return fail(hours);
    override = { off: false, ...hours };
  } else return fail("Choose how this day should work.");

  return asAstrologer(async (me) => {
    await updatePortalSettings(me, (s) => {
      const dayOverrides = { ...s.dayOverrides };
      if (override) dayOverrides[day.data] = override;
      else delete dayOverrides[day.data];
      return { ...s, dayOverrides };
    });
    return mode === "default" ? "Day reset to your weekly hours." : mode === "off" ? "Day blocked." : "Hours updated for this day.";
  });
}

export async function addBlockAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const day = date.safeParse(formData.get("date"));
  if (!day.success) return fail("Pick a date.");
  const hours = hoursFrom(formData.get("start"), formData.get("end"));
  if (typeof hours === "string") return fail(hours);
  const note = String(formData.get("note") ?? "").trim().slice(0, 80) || undefined;
  const start = dayStartOf(day.data, config.booking.utcOffsetMinutes);
  const block = { id: crypto.randomUUID(), startAt: start + hours.startMinute * MINUTE_MS, endAt: start + hours.endMinute * MINUTE_MS, note };
  return asAstrologer(async (me) => {
    await updatePortalSettings(me, (s) => ({ ...s, blocks: [...s.blocks, block].sort((x, y) => x.startAt - y.startAt) }));
    return "Time blocked.";
  });
}

export async function removeBlockAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("blockId") ?? "");
  return asAstrologer(async (me) => {
    await updatePortalSettings(me, (s) => ({ ...s, blocks: s.blocks.filter((b) => b.id !== id) }));
    return "Block removed.";
  });
}

/** Calendar slot click: unblocks a blocked slot, blocks an open one. */
export async function toggleSlotAction(_: ActionResult, formData: FormData): Promise<ActionResult> {
  const startAt = Number(formData.get("startAt"));
  const endAt = Number(formData.get("endAt"));
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return fail("Unknown slot.");
  return asAstrologer(async (me) => {
    let blocked = false;
    await updatePortalSettings(me, (s) => {
      const hit = s.blocks.filter((b) => b.startAt < endAt && startAt < b.endAt);
      if (hit.length) {
        // Unblock just this slot, keeping the rest of any longer block.
        const rest = hit.flatMap((b) => [
          ...(b.startAt < startAt ? [{ ...b, id: crypto.randomUUID(), endAt: startAt }] : []),
          ...(b.endAt > endAt ? [{ ...b, id: crypto.randomUUID(), startAt: endAt }] : []),
        ]);
        return { ...s, blocks: [...s.blocks.filter((b) => !hit.includes(b)), ...rest].sort((x, y) => x.startAt - y.startAt) };
      }
      blocked = true;
      return { ...s, blocks: [...s.blocks, { id: crypto.randomUUID(), startAt, endAt }].sort((x, y) => x.startAt - y.startAt) };
    });
    return blocked ? "Slot blocked." : "Slot opened.";
  });
}
