"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { identity } from "@/components/astrologer/identity";
import { api, bookable, OrbitSteps, rupees, ScheduleStep, SectionTitle, useModal, useSlotCalendar, VS, ZodiacWheel } from "@/components/booking/celestial";
import { bookingConfig } from "@/config/booking.config";
import { catalogConfig } from "@/config/catalog.config";
import { formatDay, formatSlot, formatTime } from "@/lib/booking/time";
import type { DurationOffer, OfferAvatar } from "@/lib/consultation/offers";
import type { BookingKind, BookingView, Schedule } from "@/types/booking";

/*
 * Book Now flow for one duration card:
 *   details → when (talk now | schedule for later) → review & pay → booked
 * One booking = one call = one astrologer, assigned by the server from the
 * card's pool (astrologers at the card's price): talk now goes to one
 * who's online and free, a slot to one free then. The pooled calendar
 * (GET /api/bookings/slots?minutes=…) is refreshed when the dialog opens
 * and again right before payment. A user with a call already booked gets
 * that booking instead of the form, with cancel / reschedule; a talk-now
 * call nobody picks up within the pickup window falls back to "choose a
 * slot or get a refund".
 *
 * Pay Now pays first (POST /api/payments, marked paid), then books against
 * that payment (POST /api/bookings with paymentId): the server assigns the
 * astrologer by the First-Out round-robin and files the request on their
 * dashboard. The payment books once, so repeated clicks can't double-book;
 * if booking fails the payment is kept for the next try, and closing the
 * dialog with an unused payment asks for its refund. On success the dialog
 * hands the order to `onBooked` and closes itself. `onRefund` runs after a
 * paid booking is cancelled.
 */

const INSTANT_TEXT = "Our astrologer will call you within 10-15 minutes.";
const MISSED_TEXT = "Sorry, all astrologers are busy. Choose a slot or get a refund.";
/** How often an open dialog re-checks the user's booking (pickup, reassignment). */
const BOOKING_POLL_MS = 30_000;

/** "4:30 PM IST on Wed, 1 Oct" */
const callTime = (t: number) =>
  `${formatTime(t, bookingConfig.utcOffsetMinutes)} ${bookingConfig.timeZoneLabel} on ${formatDay(t, bookingConfig.utcOffsetMinutes)}`;
const scheduledText = (t: number) => `Your astrologer will call you at ${callTime(t)}.`;

export interface BookingOrder {
  bookingId: string;
  astrologerId: string;
  mode: BookingKind;
  startAt: number;
  endAt: number;
  /** Talk now: the astrologer calls by then. */
  pickupBy: number | null;
  /** "Wed, 1 Oct · 4:30 PM IST" */
  label: string;
  minutes: number;
  /** INR */
  amount: number;
  astrologerNotified: boolean;
  subject: string;
  language: string | null;
  customer: { name: string; mobile: string; city: string };
}

interface BookingDialogProps {
  offer: DurationOffer;
  /** Card tag, e.g. "Quick". */
  tag: string;
  /** The card's moon, shown in the header. */
  emblem?: ReactNode;
  onClose: () => void;
  /** Paid and booked: the dialog closes itself right after calling this. */
  onBooked?: (order: BookingOrder) => void;
  /** Refund step for a cancelled booking. */
  onRefund?: (bookingId: string) => Promise<void>;
}

/** Subjects, with the catalog category/specialization they match on astrologer profiles. */
const SUBJECTS = [
  { id: "love", label: "Love & Relationship", glyph: "♀", topic: "love" },
  { id: "career", label: "Career", glyph: "♄", topic: "career" },
  { id: "marriage", label: "Marriage", glyph: "⚭", topic: "marriage" },
  { id: "finance", label: "Finance", glyph: "♃", topic: "finance" },
  { id: "health", label: "Health", glyph: "☉", topic: "health" },
  { id: "family", label: "Family", glyph: "☽", topic: null },
  { id: "kundli", label: "Kundli", glyph: "✴", topic: "vedic" },
  { id: "numerology", label: "Numerology", glyph: "∞", topic: "numerology" },
  { id: "education", label: "Education", glyph: "☿", topic: "education" },
  { id: "vastu", label: "Vastu", glyph: "◈", topic: "vastu" },
  { id: "tarot", label: "Tarot", glyph: "✧", topic: "tarot" },
] as const;

type SubjectId = (typeof SUBJECTS)[number]["id"];

const LANGUAGES = catalogConfig.languages.map((l) => ({ id: l.id, label: l.label }));
const STEPS = [
  { id: "details", label: "Details" },
  { id: "schedule", label: "Schedule" },
  { id: "review", label: "Pay" },
] as const;
type Step = (typeof STEPS)[number]["id"];

interface Details {
  name: string;
  mobile: string;
  city: string;
  subject: SubjectId | null;
  language: string | null;
}
type Errors = Partial<Record<"name" | "mobile" | "city" | "subject", string>>;

const PLACE = /^\p{L}[\p{L} .'-]*$/u;

/** 10-digit Indian mobile, accepting a +91 / 0 prefix and spaces or dashes. */
export function normalizeMobile(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

function validate(d: Details): Errors {
  const e: Errors = {};
  const name = d.name.trim();
  if (!name) e.name = "Please enter your name.";
  else if (name.length < 2 || name.length > 60 || !PLACE.test(name)) e.name = "Use letters only (2–60 characters).";
  if (!d.mobile.trim()) e.mobile = "Please enter your mobile number.";
  else if (!normalizeMobile(d.mobile)) e.mobile = "Enter a valid 10-digit mobile number.";
  const city = d.city.trim();
  if (!city) e.city = "Please enter your city.";
  else if (city.length < 2 || city.length > 60 || !PLACE.test(city)) e.city = "Enter a valid city name.";
  if (!d.subject) e.subject = "Choose what you'd like to ask about.";
  return e;
}

/** Best fit for the subject and language, keeping the offer's own order (online, then rating) as the tie-break. */
function bestMatch(avatars: OfferAvatar[], subject: SubjectId | null, language: string | null): OfferAvatar | undefined {
  const topic = SUBJECTS.find((s) => s.id === subject)?.topic ?? null;
  const score = (a: OfferAvatar) => (topic && a.topics.includes(topic) ? 2 : 0) + (language && a.languages.includes(language) ? 1 : 0);
  return avatars.reduce<OfferAvatar | undefined>((best, a) => (!best || score(a) > score(best) ? a : best), undefined);
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 flex items-center gap-1.5 pl-5 text-xs text-rose-700">
      <span aria-hidden="true">✧</span>
      {message}
    </p>
  );
}

interface PillFieldProps {
  id: string;
  label: string;
  glyph: string;
  value: string;
  error?: string;
  onChange: (v: string) => void;
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
}

/** Pill-shaped input with a small planet on the left. */
export function PillField({ id, label, glyph, value, error, onChange, inputProps }: PillFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block pl-5 text-[11px] font-medium uppercase tracking-[0.18em] text-celestial-800/60">
        {label} <span className="text-gold-600">*</span>
      </label>
      <div
        className={`group flex min-h-12 items-center gap-3 rounded-full bg-white/90 pl-1.5 pr-5 ring-1 transition focus-within:ring-2 ${
          error ? "ring-rose-300 focus-within:ring-rose-400" : "ring-lavender-200 focus-within:ring-celestial-400"
        }`}
      >
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-lavender-100 to-ivory-100 text-sm text-celestial-600">
          {glyph + VS}
        </span>
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="h-12 w-full min-w-0 bg-transparent text-base text-celestial-900 outline-none placeholder:text-celestial-800/35"
          {...inputProps}
        />
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/* ───────────────────────────── dialog ───────────────────────────── */

type PayState = { name: "idle" } | { name: "paying"; stage: "booking" | "payment" } | { name: "done"; order: BookingOrder; paid: boolean };

/** The slot is still bookable in a freshly loaded calendar. */
const stillFree = (schedule: Schedule, startAt: number) =>
  schedule.days.some((d) => d.slots.some((s) => s.startAt === startAt && bookable(s, Date.now())));

const errorCode = (err: unknown) => (err as { code?: string }).code;
/** A call still pending; shown when the user is at the booking limit, so they can cancel or move one. */
/** A call still pending (the same rule the server enforces): the user can't book another until it's done, cancelled or moved. */
const isOpen = (b: BookingView | null | undefined): b is BookingView => !!b && (b.state === "awaiting_call" || b.state === "upcoming");

export default function BookingDialog({ offer, tag, emblem, onClose, onBooked, onRefund }: BookingDialogProps) {
  const uid = useId();
  const [step, setStep] = useState<Step>("details");
  const [details, setDetails] = useState<Details>({ name: "", mobile: "", city: "", subject: null, language: null });
  const [errors, setErrors] = useState<Errors>({});
  const [mode, setMode] = useState<BookingKind>("instant");
  const [pay, setPay] = useState<PayState>({ name: "idle" });
  const [payError, setPayError] = useState<string | null>(null);
  /** The user's booking (checked in the background): undefined until known, null when none. */
  const [current, setCurrent] = useState<BookingView | null | undefined>(undefined);
  const [rescheduling, setRescheduling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [action, setAction] = useState<"cancel" | "reschedule" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const ids = useRef<ReturnType<typeof identity> | null>(null);
  // Set synchronously on Pay, so a double click can't start a second booking before `busy` renders.
  const paying = useRef(false);
  /** One key for this dialog's charge: a retried payment request returns the same payment. */
  const payKey = useRef<string | null>(null);
  /** A paid payment that hasn't booked yet (booking failed): the next try uses it instead of charging again. */
  const unused = useRef<{ paymentId: string; amount: number } | null>(null);
  const who = useCallback(() => (ids.current ??= identity()), []);

  const astrologer = useMemo(
    // Only astrologers at the card's price, so what the user pays is what the card shows.
    () => bestMatch(offer.atPrice, details.subject, details.language),
    [offer.atPrice, details.subject, details.language],
  );
  const amount = astrologer?.total ?? null;

  // The card's pooled calendar, fetched when the card opens and kept fresh while open.
  const cal = useSlotCalendar(`pool:${offer.minutes}`, () => who().userId);
  const { schedule: liveSchedule, loadError, setLoadError, date, setDate, slot, setSlot, now, reload: load } = cal;
  const instantAvailable = liveSchedule?.instant?.available ?? null;
  // Talk now needs someone free right now; otherwise it's schedule only.
  const effectiveMode: BookingKind = instantAvailable === false ? "scheduled" : mode;

  const busy = pay.name === "paying" || action !== null;
  const done = pay.name === "done";
  /** Pay Now found an existing booking: show it (with reschedule / cancel) instead of paying again. */
  const [blocked, setBlocked] = useState(false);
  const blocking = blocked && !done && isOpen(current);

  const set = <K extends keyof Details>(key: K, value: Details[K]) => {
    setDetails((d) => ({ ...d, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const close = useCallback(() => {
    if (busy) return;
    // Paid but never booked: the payment is owed back.
    const left = unused.current;
    if (left) {
      unused.current = null;
      void api("/api/payments", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "refund", paymentId: left.paymentId, userId: who().userId }),
      }).catch(() => {});
    }
    onClose();
  }, [busy, onClose, who]);

  useModal(panelRef, close);

  // The user's booking: blocks a second one, and tracks pickup / reassignment.
  const loadCurrent = useCallback(async () => {
    try {
      const params = new URLSearchParams({ userId: who().userId });
      const { booking } = await api<{ booking: BookingView | null }>(`/api/bookings?${params}`, { cache: "no-store" });
      setCurrent(booking);
      return booking;
    } catch {
      setCurrent((c) => (c === undefined ? null : c));
      return null;
    }
  }, [who]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCurrent();
  }, [loadCurrent]);

  const watchId = current && (current.state === "awaiting_call" || current.state === "upcoming") ? current.bookingId : null;
  const pickupBy = current?.state === "awaiting_call" ? current.pickupBy : null;
  useEffect(() => {
    if (!watchId) return;
    const t = setInterval(() => void loadCurrent(), BOOKING_POLL_MS);
    // Re-check right after the pickup window, so a missed call shows its fallback promptly.
    const due = pickupBy !== null ? setTimeout(() => void loadCurrent(), Math.max(0, pickupBy - Date.now()) + 1000) : undefined;
    return () => {
      clearInterval(t);
      clearTimeout(due);
    };
  }, [watchId, pickupBy, loadCurrent]);

  const goTo = (next: Step) => {
    setStep(next);
    setPayError(null);
    bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const checkDetails = () => {
    const e = validate(details);
    setErrors(e);
    const firstBad = (["name", "mobile", "city"] as const).find((k) => e[k]);
    if (firstBad) document.getElementById(`${uid}-${firstBad}`)?.focus();
    return Object.keys(e).length === 0;
  };

  const whenMissing = () =>
    effectiveMode === "instant"
      ? instantAvailable === null
        ? "Checking who's available right now…"
        : null
      : slot === null
        ? "Choose a date and an open time to continue."
        : null;

  const next = () => {
    if (step === "details" && checkDetails()) goTo("schedule");
    else if (step === "schedule") {
      const missing = whenMissing();
      if (missing) setPayError(missing);
      else goTo("review");
    }
  };

  const payNow = async () => {
    if (busy || paying.current) return;
    paying.current = true;
    try {
      await payOnce();
    } finally {
      paying.current = false;
    }
  };

  const payOnce = async () => {
    if (!checkDetails()) return goTo("details");
    const missing = whenMissing();
    if (missing) {
      goTo("schedule");
      return setPayError(missing);
    }

    setPayError(null);
    setPay({ name: "paying", stage: "booking" });
    // A user may hold several bookings; the server refuses (before charging) once they're at the limit.
    setBlocked(false);
    // Availability can change while the user fills the form: check again before taking payment.
    const schedule = await load();
    if (!schedule) {
      setPay({ name: "idle" });
      return setPayError("We couldn't check availability. Please try again.");
    }
    const bookingMode = effectiveMode;
    if (bookingMode === "instant" && !schedule.instant?.available) {
      setPay({ name: "idle" });
      goTo("schedule");
      return setPayError("No astrologer available right now. Please schedule for later.");
    }
    if (bookingMode === "scheduled" && (slot === null || !stillFree(schedule, slot))) {
      setPay({ name: "idle" });
      setSlot(null);
      goTo("schedule");
      return setPayError("That slot is no longer available. Please pick another time.");
    }

    try {
      const { userId, sessionId } = who();
      // 1. Payment, marked paid; a payment kept from a failed booking is used again instead.
      if (!unused.current) {
        setPay({ name: "paying", stage: "payment" });
        payKey.current ??= crypto.randomUUID();
        const p = await api<{ paymentId: string; amount: number; status: string }>("/api/payments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId, minutes: offer.minutes, payKey: payKey.current }),
        });
        unused.current = { paymentId: p.paymentId, amount: p.amount };
      }
      const payment = unused.current;

      // 2. Booking against it: the server assigns the astrologer (First-Out round-robin) and files their request.
      setPay({ name: "paying", stage: "booking" });
      const b = await api<{
        bookingId: string;
        astrologerId: string;
        mode: BookingKind;
        startAt: number;
        endAt: number;
        pickupBy: number | null;
        astrologerNotified: boolean;
        payment: { paymentId: string; amount: number; status: string } | null;
      }>("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId,
          sessionId,
          minutes: offer.minutes,
          mode: bookingMode,
          ...(bookingMode === "scheduled" ? { slot_time: slot } : {}),
          // The payment books once: a repeated or retried request returns the same booking.
          paymentId: payment.paymentId,
          details: {
            name: details.name.trim(),
            mobile: normalizeMobile(details.mobile),
            city: details.city.trim(),
            topic: SUBJECTS.find((s) => s.id === details.subject)?.label,
            language: LANGUAGES.find((l) => l.id === details.language)?.label,
          },
        }),
      });
      unused.current = null;
      payKey.current = null;
      const order: BookingOrder = {
        bookingId: b.bookingId,
        astrologerId: b.astrologerId,
        mode: b.mode,
        startAt: b.startAt,
        endAt: b.endAt,
        pickupBy: b.pickupBy,
        label: formatSlot(b.startAt, schedule.utcOffsetMinutes, schedule.timeZoneLabel),
        minutes: offer.minutes,
        amount: b.payment?.amount ?? payment.amount,
        astrologerNotified: b.astrologerNotified,
        subject: SUBJECTS.find((s) => s.id === details.subject)!.label,
        language: LANGUAGES.find((l) => l.id === details.language)?.label ?? null,
        customer: { name: details.name.trim(), mobile: normalizeMobile(details.mobile)!, city: details.city.trim() },
      };
      setPay({ name: "done", order, paid: true });
      setCurrent({
        bookingId: order.bookingId,
        mode: order.mode,
        state: order.mode === "instant" ? "awaiting_call" : "upcoming",
        startAt: order.startAt,
        endAt: order.endAt,
        pickupBy: order.pickupBy,
        minutes: order.minutes,
        label: order.label,
        issue: null,
      });
      // Paid and booked: hand over and close, so the user doesn't have to.
      onBooked?.(order);
      onClose();
    } catch (err) {
      setPay({ name: "idle" });
      // Paid, but the booking didn't go through: say the money is safe and reused.
      const kept = unused.current ? ` Your payment of ${rupees(unused.current.amount)} is saved — you won't be charged again.` : "";
      const code = errorCode(err);
      if (code === "ACTIVE_BOOKING_EXISTS") {
        setBlocked(true);
        void loadCurrent();
        return;
      }
      if (code === "SLOT_UNAVAILABLE" || code === "NO_ASTROLOGER_AVAILABLE") {
        setSlot(null);
        goTo("schedule");
        setPayError(
          (code === "SLOT_UNAVAILABLE" ? "That slot was just taken. Please pick another time." : "No astrologer available right now. Please schedule for later.") + kept,
        );
        void load();
        return;
      }
      setPayError((err as Error).message + kept);
    }
  };

  const patchBooking = (body: Record<string, unknown>) =>
    api<{ booking: BookingView }>("/api/bookings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, userId: who().userId }),
    });

  const cancel = async () => {
    if (!current || busy) return;
    if (!confirmCancel) return setConfirmCancel(true);
    setConfirmCancel(false);
    setAction("cancel");
    setPayError(null);
    try {
      const { booking } = await patchBooking({ action: "cancel", bookingId: current.bookingId });
      setCurrent(booking);
      setRescheduling(false);
      setBlocked(false);
      setNotice("Your booking is cancelled.");
      if (pay.name === "done") {
        setPay({ name: "idle" });
        goTo("schedule");
      }
      if (onRefund) {
        try {
          await onRefund(booking.bookingId);
        } catch (err) {
          setPayError(`Your booking is cancelled, but the refund didn't go through: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      setPayError((err as Error).message);
      void loadCurrent();
    } finally {
      setAction(null);
    }
  };

  const startReschedule = () => {
    if (pay.name === "done") {
      setPay({ name: "idle" });
      goTo("schedule");
    }
    setRescheduling(true);
    setConfirmCancel(false);
    setSlot(null);
    setPayError(null);
    void load();
  };

  const confirmReschedule = async () => {
    if (!current || busy) return;
    if (slot === null) return setPayError("Choose a date and an open time to continue.");
    setAction("reschedule");
    setPayError(null);
    try {
      const fresh = await load();
      if (!fresh || !stillFree(fresh, slot)) {
        setSlot(null);
        return setPayError("That slot is no longer available. Please pick another time.");
      }
      const { booking } = await patchBooking({ action: "reschedule", bookingId: current.bookingId, slot_time: slot });
      setCurrent(booking);
      setRescheduling(false);
      setSlot(null);
    } catch (err) {
      const code = errorCode(err);
      if (code === "SLOT_UNAVAILABLE") {
        setSlot(null);
        void load();
        setPayError("That slot was just taken. Please pick another time.");
      } else {
        setPayError((err as Error).message);
        if (code === "BOOKING_NOT_CHANGEABLE" || code === "NOT_FOUND") {
          setRescheduling(false);
          void loadCurrent();
        }
      }
    } finally {
      setAction(null);
    }
  };

  const subjectLabel = SUBJECTS.find((s) => s.id === details.subject)?.label;
  const languageLabel = LANGUAGES.find((l) => l.id === details.language)?.label;

  const title = done
    ? "Your stars are aligned"
    : effectiveMode === "instant"
      ? INSTANT_TEXT
      : slot !== null
        ? scheduledText(slot)
        : "Choose a time for your call.";

  const scheduleStep = (
    <ScheduleStep
      schedule={liveSchedule}
      loadError={loadError}
      date={date}
      slot={slot}
      now={now}
      onDate={(d) => {
        setDate(d);
        setSlot(null);
      }}
      onSlot={(s) => {
        setSlot(s);
        setPayError(null);
      }}
      onRetry={() => {
        setLoadError(null);
        void load();
      }}
      describe={scheduledText}
    />
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-celestial-900/45 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        tabIndex={-1}
        className="relative flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-[44px] bg-gradient-to-b from-ivory-50 via-ivory-50 to-lavender-50 text-left shadow-[0_40px_90px_-30px_rgba(42,26,82,0.75)] outline-none motion-safe:animate-rise sm:max-h-[90dvh] sm:max-w-3xl sm:rounded-[48px]"
      >
        {/* Header: a night-sky dome with the zodiac wheel rising behind it. */}
        <div className="relative shrink-0 overflow-hidden bg-gradient-to-b from-lavender-100 via-lavender-50 to-transparent px-6 pb-4 pt-3 sm:px-10 sm:pt-7">
          <span aria-hidden="true" className="mx-auto mb-3 block h-1.5 w-12 rounded-full bg-celestial-800/15 sm:hidden" />
          <ZodiacWheel className="pointer-events-none absolute -left-24 -top-28 h-72 w-72 text-celestial-400/30 motion-safe:animate-spin [animation-duration:140s]" />
          <span aria-hidden="true" className="absolute right-24 top-6 text-[10px] text-gold-400 motion-safe:animate-twinkle">✦</span>
          <span aria-hidden="true" className="absolute right-40 top-14 text-[7px] text-gold-400 motion-safe:animate-twinkle [animation-delay:2s]">✦</span>
          <span aria-hidden="true" className="absolute left-1/2 top-10 h-0.5 w-0.5 rounded-full bg-celestial-400/60" />

          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Close booking"
            className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/85 text-xl leading-none text-celestial-800 shadow-sm ring-1 ring-lavender-200 transition hover:bg-white hover:text-celestial-900 active:scale-95 disabled:opacity-40 sm:right-6 sm:top-6"
          >
            ×
          </button>

          <div className="relative flex items-center gap-4 pr-12">
            {emblem && <span className="shrink-0">{emblem}</span>}
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.25em] text-gold-600">
                <span aria-hidden="true">✦</span> {tag} consultation
              </p>
              <h2 id={`${uid}-title`} className="font-display text-3xl font-semibold leading-tight tracking-tight text-celestial-900 sm:text-4xl">
                {title}
              </h2>
            </div>
          </div>
          {!done && (
            <div className="relative mt-5">
              <OrbitSteps steps={STEPS} current={STEPS.findIndex((s) => s.id === step)} />
            </div>
          )}
        </div>
        {/* Curved horizon between the header and the form. */}
        <svg viewBox="0 0 400 16" preserveAspectRatio="none" aria-hidden="true" className="-mt-px h-3 w-full shrink-0 text-gold-300/70">
          <path d="M 0 2 Q 200 16 400 2" fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>

        <div ref={bodyRef} className="flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-4 sm:px-10">
          {done ? (
            <Success order={pay.order} paid={pay.paid} booking={current ?? null} />
          ) : step === "details" ? (
            <div className="space-y-7">
              <section>
                <SectionTitle glyph="☉">About you</SectionTitle>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <PillField
                      id={`${uid}-name`}
                      label="Your name"
                      glyph="♀"
                      value={details.name}
                      error={errors.name}
                      onChange={(v) => set("name", v)}
                      inputProps={{ autoComplete: "name", placeholder: "Full name", maxLength: 60 }}
                    />
                  </div>
                  <PillField
                    id={`${uid}-mobile`}
                    label="Mobile number"
                    glyph="☏"
                    value={details.mobile}
                    error={errors.mobile}
                    onChange={(v) => set("mobile", v.replace(/[^\d+\s-]/g, ""))}
                    inputProps={{ type: "tel", inputMode: "tel", autoComplete: "tel", placeholder: "98765 43210", maxLength: 16 }}
                  />
                  <PillField
                    id={`${uid}-city`}
                    label="City"
                    glyph="⌖"
                    value={details.city}
                    error={errors.city}
                    onChange={(v) => set("city", v)}
                    inputProps={{ autoComplete: "address-level2", placeholder: "e.g. Jaipur", maxLength: 60 }}
                  />
                </div>
              </section>

              <section aria-labelledby={`${uid}-subject`}>
                <SectionTitle glyph="✴" hint="Required">
                  <span id={`${uid}-subject`}>What&apos;s on your mind?</span>
                </SectionTitle>
                <div role="radiogroup" aria-labelledby={`${uid}-subject`} aria-describedby={errors.subject ? `${uid}-subject-error` : undefined} className="flex flex-wrap gap-2">
                  {SUBJECTS.map((s) => {
                    const on = details.subject === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => set("subject", s.id)}
                        className={`flex min-h-11 items-center gap-2 rounded-full py-1 pl-1 pr-4 text-sm font-medium transition duration-200 active:scale-95 ${
                          on
                            ? "bg-gradient-to-r from-celestial-700 to-celestial-500 text-white shadow-[0_10px_20px_-12px_rgba(82,51,150,0.9)]"
                            : "bg-white/90 text-celestial-800 ring-1 ring-lavender-200 hover:ring-celestial-400"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-8 w-8 items-center justify-center rounded-full text-sm ${on ? "bg-white/15 text-gold-300" : "bg-lavender-50 text-celestial-600"}`}
                        >
                          {s.glyph + VS}
                        </span>
                        {s.label}
                      </button>
                    );
                  })}
                </div>
                <FieldError id={`${uid}-subject-error`} message={errors.subject} />
              </section>

              <section aria-labelledby={`${uid}-lang`}>
                <SectionTitle glyph="☿" hint="Optional">
                  <span id={`${uid}-lang`}>Preferred language</span>
                </SectionTitle>
                <div role="radiogroup" aria-labelledby={`${uid}-lang`} className="flex flex-wrap gap-2">
                  {[{ id: null, label: "Any" }, ...LANGUAGES].map((l) => {
                    const on = details.language === l.id;
                    return (
                      <button
                        key={l.id ?? "any"}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => set("language", l.id)}
                        className={`min-h-11 rounded-full px-4 text-sm font-medium transition duration-200 active:scale-95 ${
                          on ? "bg-celestial-800 text-white" : "bg-white/90 text-celestial-800 ring-1 ring-lavender-200 hover:ring-celestial-400"
                        }`}
                      >
                        {l.label}
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : step === "schedule" ? (
            <section>
              <SectionTitle glyph="☾">
                Schedule
              </SectionTitle>
              {notice && (
                <p className="mb-4 rounded-[24px] bg-emerald-50 px-4 py-3 text-center text-sm text-emerald-800 ring-1 ring-emerald-200" aria-live="polite">
                  {notice}
                </p>
              )}
              <ModeToggle
                mode={effectiveMode}
                instantAvailable={instantAvailable}
                onChange={(m) => {
                  setMode(m);
                  setPayError(null);
                }}
              />
              {instantAvailable === false && (
                <p className="mt-2 flex items-center justify-center gap-1.5 text-xs font-medium text-amber-700" aria-live="polite">
                  <span aria-hidden="true">{"☾" + VS}</span> No astrologer available right now
                </p>
              )}
              <div className="mt-5">
                {effectiveMode === "instant" ? (
                  instantAvailable === null ? (
                    <div className="flex flex-col items-center py-8 text-center" aria-live="polite">
                      <ZodiacWheel className="h-16 w-16 text-celestial-500 motion-safe:animate-spin [animation-duration:6s]" />
                      <p className="mt-3 text-sm text-celestial-800/70">Checking who&apos;s available right now…</p>
                    </div>
                  ) : (
                    <CallArc label="Talk now">{INSTANT_TEXT}</CallArc>
                  )
                ) : (
                  scheduleStep
                )}
              </div>
            </section>
          ) : (
            <section>
              <SectionTitle glyph="♃">Review &amp; pay</SectionTitle>
              {blocking ? (
                /* An existing booking: manage it here instead of booking a second call. */
                <div className="space-y-5">
                  <ActiveBooking
                    booking={current}
                    busy={busy}
                    action={action}
                    confirmCancel={confirmCancel}
                    rescheduling={rescheduling}
                    onCancel={() => void cancel()}
                    onReschedule={startReschedule}
                  />
                  {rescheduling && (
                    <>
                      {scheduleStep}
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setRescheduling(false);
                            setPayError(null);
                          }}
                          disabled={busy}
                          className="min-h-12 shrink-0 rounded-full px-5 text-sm font-semibold text-celestial-700 ring-1 ring-celestial-400/40 transition hover:bg-lavender-50 active:scale-95 disabled:opacity-40"
                        >
                          Keep current time
                        </button>
                        <button
                          type="button"
                          onClick={() => void confirmReschedule()}
                          disabled={busy || slot === null}
                          aria-busy={action === "reschedule"}
                          className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-celestial-700 to-celestial-500 px-5 text-sm font-semibold text-white shadow-[0_12px_24px_-14px_rgba(82,51,150,0.9)] transition hover:from-celestial-800 hover:to-celestial-600 active:scale-[0.985] disabled:opacity-50"
                        >
                          {action === "reschedule" ? "Moving your call…" : "Confirm new time"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
              <>
              {notice && (
                <p className="mb-4 rounded-[24px] bg-emerald-50 px-4 py-3 text-center text-sm text-emerald-800 ring-1 ring-emerald-200" aria-live="polite">
                  {notice}
                </p>
              )}
              <div className="relative overflow-hidden rounded-[40px] bg-white/90 p-5 ring-1 ring-lavender-200/80 sm:p-7">
                <ZodiacWheel className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 text-lavender-300/60" />
                <dl className="relative grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
                  <Summary label="Name" value={details.name.trim()} onEdit={() => goTo("details")} />
                  <Summary label="Mobile" value={normalizeMobile(details.mobile) ?? details.mobile} onEdit={() => goTo("details")} />
                  <Summary label="City" value={details.city.trim()} onEdit={() => goTo("details")} />
                  <Summary label="Subject" value={subjectLabel ?? "—"} onEdit={() => goTo("details")} />
                  <Summary label="Language" value={languageLabel ?? "Any"} onEdit={() => goTo("details")} />
                  <div className="sm:col-span-2">
                    <Summary
                      label="When"
                      value={
                        effectiveMode === "instant"
                          ? `Talk now · within 10-15 minutes · ${offer.minutes}-min audio call`
                          : slot !== null && liveSchedule
                            ? `${formatSlot(slot, liveSchedule.utcOffsetMinutes, liveSchedule.timeZoneLabel)} · ${offer.minutes}-min audio call`
                            : "—"
                      }
                      onEdit={() => goTo("schedule")}
                    />
                  </div>
                </dl>
                <div className="relative mt-6 flex items-end justify-between gap-4 border-t border-dashed border-lavender-200 pt-5">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-celestial-800/50">Amount payable</p>
                    <p className="font-display text-4xl font-bold leading-none text-celestial-900">{amount !== null ? rupees(amount) : "—"}</p>
                  </div>
                  <p className="max-w-[12rem] text-right text-xs leading-snug text-celestial-800/55">
                    {offer.minutes}-minute audio consultation
                  </p>
                </div>
              </div>
              </>
              )}
            </section>
          )}

          {payError && (
            <p role="alert" className="mt-5 flex items-start gap-2 rounded-[24px] bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200">
              <span aria-hidden="true">☄</span>
              {payError}
            </p>
          )}
        </div>

        {/* Footer actions. */}
        <div className="relative shrink-0 border-t border-lavender-200/70 bg-ivory-50/95 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-10">
          {done ? (
            current?.state === "missed" ? (
              /* Talk now wasn't picked up: move it to a slot or refund it. */
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void cancel()}
                  disabled={busy}
                  className="min-h-13 shrink-0 rounded-full px-5 py-3.5 text-sm font-semibold text-celestial-700 ring-1 ring-celestial-400/40 transition hover:bg-lavender-50 active:scale-95 disabled:opacity-40 sm:px-7"
                >
                  {action === "cancel" ? "Cancelling…" : confirmCancel ? "Confirm refund" : "Get a refund"}
                </button>
                <button
                  type="button"
                  onClick={startReschedule}
                  disabled={busy}
                  className="flex min-h-13 flex-1 items-center justify-center rounded-full bg-gradient-to-r from-celestial-700 to-celestial-500 px-6 py-3.5 text-base font-semibold text-white shadow-[0_14px_28px_-14px_rgba(82,51,150,0.9)] transition hover:from-celestial-800 hover:to-celestial-600 active:scale-[0.985]"
                >
                  Choose a slot
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="flex min-h-13 w-full items-center justify-center rounded-full bg-gradient-to-r from-celestial-700 to-celestial-500 px-6 py-3.5 text-base font-semibold text-white shadow-[0_14px_28px_-14px_rgba(82,51,150,0.9)] transition hover:from-celestial-800 hover:to-celestial-600 active:scale-[0.985]"
              >
                Done
              </button>
            )
          ) : (
            <div className="flex items-center gap-3">
              {step !== "details" && (
                <button
                  type="button"
                  onClick={() => goTo(step === "review" ? "schedule" : "details")}
                  disabled={busy}
                  className="min-h-13 shrink-0 rounded-full px-5 py-3.5 text-sm font-semibold text-celestial-700 ring-1 ring-celestial-400/40 transition hover:bg-lavender-50 active:scale-95 disabled:opacity-40 sm:px-7"
                >
                  ‹ Back
                </button>
              )}
              {step === "review" ? (
                <button
                  type="button"
                  onClick={() => void payNow()}
                  disabled={busy}
                  aria-busy={busy}
                  className="group relative flex min-h-14 flex-1 items-center justify-center gap-3 overflow-hidden rounded-full bg-gradient-to-r from-gold-400 via-gold-300 to-gold-400 px-6 py-4 text-base font-bold tracking-wide text-celestial-900 shadow-[0_16px_32px_-14px_rgba(154,117,53,0.9)] ring-1 ring-gold-600/30 transition hover:brightness-105 active:scale-[0.985] disabled:cursor-wait disabled:opacity-80"
                >
                  {pay.name === "paying" ? (
                    <>
                      <span aria-hidden="true" className="h-5 w-5 rounded-full border-2 border-celestial-900/25 border-t-celestial-900 motion-safe:animate-spin" />
                      {pay.stage === "payment" ? "Processing payment…" : effectiveMode === "instant" ? "Finding your astrologer…" : "Reserving your slot…"}
                    </>
                  ) : (
                    <>
                      Pay Now {amount !== null ? `· ${rupees(amount)}` : ""}
                      <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
                        →
                      </span>
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={next}
                  className="group flex min-h-13 flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-celestial-700 to-celestial-500 px-6 py-3.5 text-base font-semibold text-white shadow-[0_14px_28px_-14px_rgba(82,51,150,0.9)] transition hover:from-celestial-800 hover:to-celestial-600 active:scale-[0.985]"
                >
                  {step === "details" ? "Continue to schedule" : "Review booking"}
                  <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
                    →
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const MODES = [
  { id: "instant", label: "Talk now", glyph: "☉" },
  { id: "scheduled", label: "Schedule for later", glyph: "☾" },
] as const;

/** Two mutually exclusive modes as one pill; talk now is off while nobody is free. */
function ModeToggle({ mode, instantAvailable, onChange }: { mode: BookingKind; instantAvailable: boolean | null; onChange: (m: BookingKind) => void }) {
  return (
    <div role="radiogroup" aria-label="When should we call?" className="grid grid-cols-2 gap-1 rounded-full bg-white/85 p-1 ring-1 ring-lavender-200">
      {MODES.map((m) => {
        const on = mode === m.id;
        const disabled = m.id === "instant" && instantAvailable === false;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(m.id)}
            className={`flex min-h-12 items-center justify-center gap-2 rounded-full px-3 text-sm font-semibold transition duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 ${
              on
                ? "bg-gradient-to-r from-celestial-700 to-celestial-500 text-white shadow-[0_10px_20px_-12px_rgba(82,51,150,0.9)]"
                : "text-celestial-800 enabled:hover:bg-lavender-50"
            }`}
          >
            <span aria-hidden="true" className={on ? "text-gold-300" : "text-celestial-500"}>
              {m.glyph + VS}
            </span>
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

/** The call promise on a celestial arc (same banner as the calendar's "Your moment"). */
function CallArc({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-t-[80px] rounded-b-[32px] bg-gradient-to-br from-celestial-800 to-celestial-600 px-6 pb-5 pt-6 text-center text-white">
      <svg viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-x-0 top-2 h-10 w-full text-gold-300/50">
        <path d="M 20 58 Q 200 -10 380 58" fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 5" vectorEffect="non-scaling-stroke" />
      </svg>
      <span aria-hidden="true" className="absolute left-8 top-5 text-[10px] text-gold-300 motion-safe:animate-twinkle">✦</span>
      <span aria-hidden="true" className="absolute right-10 top-8 text-[8px] text-gold-300 motion-safe:animate-twinkle [animation-delay:1.6s]">✦</span>
      <p className="relative text-[11px] uppercase tracking-[0.22em] text-gold-300">{label}</p>
      <p className="relative mt-1 font-display text-2xl font-semibold" aria-live="polite">
        {children}
      </p>
    </div>
  );
}

/** What happens next with a booked call. */
function callStatus(b: BookingView): string {
  if (b.state === "missed") return MISSED_TEXT;
  if (b.state === "connected") return "Your astrologer is on the call with you.";
  if (b.state === "awaiting_call") return INSTANT_TEXT;
  return scheduledText(b.startAt);
}

/** "You already have a call booked", with Reschedule / Cancel. */
function ActiveBooking({
  booking: b,
  busy,
  action,
  confirmCancel,
  rescheduling,
  onCancel,
  onReschedule,
}: {
  booking: BookingView;
  busy: boolean;
  action: "cancel" | "reschedule" | null;
  confirmCancel: boolean;
  rescheduling: boolean;
  onCancel: () => void;
  onReschedule: () => void;
}) {
  const missed = b.state === "missed";
  // A pending talk-now call can't switch to a slot; a missed one can.
  const canMove = b.state === "upcoming" || missed;
  const canCancel = b.state !== "connected";
  return (
    <div className="relative overflow-hidden rounded-[40px] bg-white/90 p-5 text-center ring-1 ring-lavender-200/80 sm:p-6" aria-live="polite">
      <ZodiacWheel className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 text-lavender-300/60" />
      <p className="relative text-[11px] font-medium uppercase tracking-[0.25em] text-gold-600">You already have a call booked</p>
      <p className="relative mt-2 font-display text-xl font-semibold text-celestial-900">{callStatus(b)}</p>
      {b.issue === "astrologer_unavailable" && (
        <p role="alert" className="relative mx-auto mt-3 max-w-md rounded-[24px] bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          Your astrologer is no longer available for this slot and no one else is free then. Please reschedule or cancel for a refund.
        </p>
      )}
      <p className="relative mt-2 font-mono text-xs text-celestial-800/55">#{b.bookingId.slice(0, 8)}</p>
      {!rescheduling && (canMove || canCancel) && (
        <div className="relative mt-4 flex flex-wrap items-center justify-center gap-2">
          {canCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="min-h-11 rounded-full px-5 text-sm font-semibold text-celestial-700 ring-1 ring-celestial-400/40 transition hover:bg-lavender-50 active:scale-95 disabled:opacity-40"
            >
              {action === "cancel" ? "Cancelling…" : confirmCancel ? (missed ? "Confirm refund" : "Confirm cancel") : missed ? "Get a refund" : "Cancel"}
            </button>
          )}
          {canMove && (
            <button
              type="button"
              onClick={onReschedule}
              disabled={busy}
              className="min-h-11 rounded-full bg-gradient-to-r from-celestial-700 to-celestial-500 px-5 text-sm font-semibold text-white shadow-[0_12px_24px_-14px_rgba(82,51,150,0.9)] transition hover:from-celestial-800 hover:to-celestial-600 active:scale-[0.985] disabled:opacity-50"
            >
              {missed ? "Choose a slot" : "Reschedule"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Summary({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <dt className="text-[11px] uppercase tracking-[0.18em] text-celestial-800/50">{label}</dt>
        <dd className="mt-0.5 break-words font-medium text-celestial-900">{value}</dd>
      </div>
      <button type="button" onClick={onEdit} aria-label={`Edit ${label.toLowerCase()}`} className="-mr-2 -mt-1 flex h-10 min-w-10 items-center justify-center rounded-full px-2 text-xs font-medium text-celestial-600 hover:bg-lavender-50">
        Edit
      </button>
    </div>
  );
}

function Success({ order, paid, booking }: { order: BookingOrder; paid: boolean; booking: BookingView | null }) {
  const missed = booking?.bookingId === order.bookingId && booking.state === "missed";
  return (
    <div className="flex flex-col items-center py-4 text-center" aria-live="polite">
      <div className="relative flex h-36 w-36 items-center justify-center">
        <ZodiacWheel className="absolute inset-0 h-full w-full text-gold-400 motion-safe:animate-spin [animation-duration:60s]" />
        <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-celestial-600 to-celestial-800 text-2xl text-gold-300 shadow-[0_0_0_6px_rgba(209,171,98,0.2),0_16px_30px_-12px_rgba(82,51,150,0.9)]">
          ✓
        </span>
      </div>
      <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.25em] text-gold-600">{paid ? "Payment received · Booked" : "Booked"}</p>
      <p className="mt-2 font-display text-2xl font-semibold text-celestial-900">
        {missed ? MISSED_TEXT : order.mode === "instant" ? INSTANT_TEXT : scheduledText(order.startAt)}
      </p>
      <p className="mt-1 max-w-sm text-sm text-celestial-800/70">
        {order.minutes}-minute audio consultation on {order.subject.toLowerCase()}.
        {order.astrologerNotified ? " Your astrologer has been notified." : ""}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2 text-xs">
        <span className="rounded-full bg-ivory-100 px-3 py-1.5 font-medium text-celestial-700 ring-1 ring-gold-300/50">{rupees(order.amount)}</span>
        <span className="rounded-full bg-lavender-50 px-3 py-1.5 font-mono text-celestial-700 ring-1 ring-lavender-200">#{order.bookingId.slice(0, 8)}</span>
      </div>
    </div>
  );
}
