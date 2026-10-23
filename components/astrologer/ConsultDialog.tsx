"use client";

import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { display } from "@/app/_components/fonts";
import { api, OrbitSteps, rupees, ScheduleStep, SectionTitle, useModal, useSlotCalendar, VS, ZodiacWheel } from "@/components/booking/celestial";
import { formatSlot } from "@/lib/booking/time";
import type { Astrologer } from "@/types/astrologer";
import { normalizeMobile, PillField } from "@/components/user/BookingDialog";
import { identity } from "./identity";

/*
 * Consult now flow for one astrologer:
 *   choose (cancel / schedule) → schedule → pay → confirmed
 * The calendar is the astrologer's live slot calendar (GET
 * /api/bookings/slots). The fee is the astrologer's per-minute rate times
 * the slot length the calendar offers; Pay Now books the slot through POST
 * /api/bookings, which prices it from the stored profile, then hands the
 * order to `onPay` when a payment step is wired in. A slot taken meanwhile
 * comes back as 409 SLOT_UNAVAILABLE: the calendar is refetched and the
 * user picks again.
 */

export interface ConsultOrder {
  bookingId: string;
  astrologerId: string;
  startAt: number;
  endAt: number;
  /** "Wed, 1 Oct · 4:30 PM IST" */
  label: string;
  durationMinutes: number;
  pricePerMinute: number;
  /** INR: pricePerMinute × durationMinutes, as booked. */
  amount: number;
  astrologerNotified: boolean;
}

interface ConsultDialogProps {
  astrologer: Astrologer;
  /** The topic and language the user was browsing by, passed on to the astrologer's request. */
  context?: { topic?: string; language?: string };
  onClose: () => void;
  /** Payment step for a booked order; the dialog shows its loading and error states. */
  onPay?: (order: ConsultOrder) => Promise<void>;
}

type Step = "choose" | "schedule" | "pay";
const STEPS = [
  { id: "schedule", label: "Schedule" },
  { id: "pay", label: "Pay" },
  { id: "done", label: "Done" },
] as const;

type PayState = { name: "idle" } | { name: "paying"; stage: "booking" | "payment" } | { name: "done"; order: ConsultOrder; paid: boolean };

const perMin = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(1)}/min`;

export default function ConsultDialog({ astrologer: a, context, onClose, onPay }: ConsultDialogProps) {
  const uid = useId();
  const [step, setStep] = useState<Step>("choose");
  const [pay, setPay] = useState<PayState>({ name: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [mobile, setMobile] = useState("");
  const [mobileError, setMobileError] = useState<string | undefined>();

  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Set synchronously on Pay, so a double click can't start a second booking before `busy` renders.
  const paying = useRef(false);
  const ids = useRef<ReturnType<typeof identity> | null>(null);
  const who = () => (ids.current ??= identity());

  // Only fetch the calendar once the user asks to schedule.
  const cal = useSlotCalendar(step === "choose" ? null : a.id, () => who().userId);
  const { schedule, slot } = cal;
  const minutes = schedule?.slotMinutes ?? null;
  const fee = minutes !== null ? a.pricePerMinute * minutes : null;

  const busy = pay.name === "paying";
  const done = pay.name === "done";
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  useModal(panelRef, close);

  const goTo = (next: Step) => {
    setStep(next);
    setError(null);
    bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const toPay = () => {
    if (slot === null) return setError("Choose a date and an open time to continue.");
    goTo("pay");
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
    if (slot === null || !schedule) {
      goTo("schedule");
      return setError("Choose a date and an open time to continue.");
    }
    if (slot <= Date.now()) {
      cal.setSlot(null);
      goTo("schedule");
      void cal.reload();
      return setError("That time has just passed. Please pick another slot.");
    }
    const userMobile = normalizeMobile(mobile);
    if (!userMobile) {
      return setMobileError(mobile.trim() ? "Enter a valid 10-digit mobile number." : "Please enter your mobile number.");
    }

    setError(null);
    setPay({ name: "paying", stage: "booking" });
    let order: ConsultOrder | null = null;
    try {
      const { userId, sessionId } = who();
      const b = await api<Omit<ConsultOrder, "label" | "amount">>("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // One key per Pay attempt: a repeated or retried request returns the same booking.
        body: JSON.stringify({ astrologerId: a.id, userId, sessionId, startAt: slot, requestKey: crypto.randomUUID(), details: { ...context, mobile: userMobile } }),
      });
      order = {
        bookingId: b.bookingId,
        astrologerId: b.astrologerId,
        startAt: b.startAt,
        endAt: b.endAt,
        label: formatSlot(b.startAt, schedule.utcOffsetMinutes, schedule.timeZoneLabel),
        durationMinutes: b.durationMinutes,
        pricePerMinute: b.pricePerMinute,
        amount: b.pricePerMinute * b.durationMinutes,
        astrologerNotified: b.astrologerNotified,
      };
      if (onPay) {
        setPay({ name: "paying", stage: "payment" });
        await onPay(order);
      }
      setPay({ name: "done", order, paid: Boolean(onPay) });
    } catch (err) {
      setPay({ name: "idle" });
      if (order) {
        // The slot is held; only the payment step failed.
        return setError(`Your slot is reserved (booking ${order.bookingId.slice(0, 8)}), but payment didn't go through: ${(err as Error).message}`);
      }
      if ((err as { code?: string }).code === "SLOT_UNAVAILABLE") {
        cal.setSlot(null);
        goTo("schedule");
        setError("That slot was just taken. Please pick another time.");
        void cal.reload();
        return;
      }
      setError((err as Error).message);
    }
  };

  const orbit = done ? STEPS.length : step === "schedule" ? 0 : step === "pay" ? 1 : -1;

  return (
    <div
      className={`${display.variable} fixed inset-0 z-50 flex items-end justify-center bg-celestial-900/45 backdrop-blur-sm sm:items-center sm:p-6`}
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
        className={`relative flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-[44px] bg-gradient-to-b from-ivory-50 via-ivory-50 to-lavender-50 text-left shadow-[0_40px_90px_-30px_rgba(42,26,82,0.75)] outline-none motion-safe:animate-rise sm:max-h-[90dvh] sm:rounded-[48px] ${
          step === "choose" && !done ? "sm:max-w-md" : "sm:max-w-3xl"
        }`}
      >
        {/* Header: a night-sky dome with the zodiac wheel rising behind the astrologer. */}
        <div className="relative shrink-0 overflow-hidden bg-gradient-to-b from-lavender-100 via-lavender-50 to-transparent px-6 pb-4 pt-3 sm:px-10 sm:pt-7">
          <span aria-hidden="true" className="mx-auto mb-3 block h-1.5 w-12 rounded-full bg-celestial-800/15 sm:hidden" />
          <ZodiacWheel className="pointer-events-none absolute -left-24 -top-28 h-72 w-72 text-celestial-400/30 motion-safe:animate-spin [animation-duration:140s]" />
          <span aria-hidden="true" className="absolute right-24 top-6 text-[10px] text-gold-400 motion-safe:animate-twinkle">✦</span>
          <span aria-hidden="true" className="absolute right-40 top-14 text-[7px] text-gold-400 motion-safe:animate-twinkle [animation-delay:2s]">✦</span>

          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Close"
            className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/85 text-xl leading-none text-celestial-800 shadow-sm ring-1 ring-lavender-200 transition hover:bg-white hover:text-celestial-900 active:scale-95 disabled:opacity-40 sm:right-6 sm:top-6"
          >
            ×
          </button>

          <div className="relative flex items-center gap-4 pr-12">
            <Avatar astrologer={a} />
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.25em] text-gold-600">
                <span aria-hidden="true">✦</span> {done ? "Call scheduled" : "Consult"}
              </p>
              <h2 id={`${uid}-title`} className="truncate font-display text-3xl font-semibold leading-tight tracking-tight text-celestial-900">
                {a.name}
              </h2>
              <p className="mt-0.5 text-sm text-celestial-800/70">
                {a.rating !== null && (
                  <>
                    <span className="text-gold-400">★</span> {a.rating.toFixed(1)} ·{" "}
                  </>
                )}
                Audio call · {perMin(a.pricePerMinute)}
              </p>
            </div>
          </div>
          {orbit >= 0 && !done && (
            <div className="relative mt-5">
              <OrbitSteps steps={STEPS} current={orbit} />
            </div>
          )}
        </div>
        {/* Curved horizon between the header and the body. */}
        <svg viewBox="0 0 400 16" preserveAspectRatio="none" aria-hidden="true" className="-mt-px h-3 w-full shrink-0 text-gold-300/70">
          <path d="M 0 2 Q 200 16 400 2" fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>

        <div ref={bodyRef} className="flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-4 sm:px-10">
          {done ? (
            <Confirmed order={pay.order} paid={pay.paid} name={a.name} />
          ) : step === "choose" ? (
            <div className="relative overflow-hidden rounded-t-[80px] rounded-b-[32px] bg-white/85 px-6 pb-6 pt-8 text-center ring-1 ring-lavender-200/80">
              <svg viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-x-0 top-2 h-10 w-full text-gold-400/60">
                <path d="M 20 58 Q 200 -10 380 58" fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 5" vectorEffect="non-scaling-stroke" />
              </svg>
              <p className="relative font-display text-2xl font-semibold text-celestial-900">Schedule a consultation</p>
              <p className="relative mx-auto mt-2 max-w-xs text-sm leading-relaxed text-celestial-800/70">
                Pick a time that suits you, pay the fee and {a.name} will call you then.
              </p>
            </div>
          ) : step === "schedule" ? (
            <section>
              <SectionTitle glyph="☾">Schedule</SectionTitle>
              <ScheduleStep
                schedule={schedule}
                loadError={cal.loadError}
                date={cal.date}
                slot={slot}
                now={cal.now}
                onDate={(d) => {
                  cal.setDate(d);
                  cal.setSlot(null);
                }}
                onSlot={(s) => {
                  cal.setSlot(s);
                  setError(null);
                }}
                onRetry={() => {
                  cal.setLoadError(null);
                  void cal.reload();
                }}
              />
            </section>
          ) : (
            <section>
              <SectionTitle glyph="♃">Payment</SectionTitle>
              <div className="relative overflow-hidden rounded-[40px] bg-white/90 p-5 ring-1 ring-lavender-200/80 sm:p-7">
                <ZodiacWheel className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 text-lavender-300/60" />
                <div className="relative flex items-center gap-4">
                  <Avatar astrologer={a} small />
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-celestial-800/50">Astrologer</p>
                    <p className="truncate font-display text-xl font-semibold text-celestial-900">{a.name}</p>
                    {a.experienceYears !== null && <p className="text-xs text-celestial-800/60">{a.experienceYears}+ yrs experience</p>}
                  </div>
                </div>
                <dl className="relative mt-5 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
                  <Row label="When" value={slot !== null && schedule ? formatSlot(slot, schedule.utcOffsetMinutes, schedule.timeZoneLabel) : "—"} onEdit={() => goTo("schedule")} />
                  <Row label="Consultation" value={minutes !== null ? `${minutes}-min audio call` : "—"} />
                  <Row label="Rate" value={perMin(a.pricePerMinute)} />
                  <Row label="Fee" value={fee !== null && minutes !== null ? `${perMin(a.pricePerMinute)} × ${minutes} min` : "—"} />
                </dl>
                <div className="relative mt-5">
                  <PillField
                    id={`${uid}-mobile`}
                    label="Enter mobile number"
                    glyph="☏"
                    value={mobile}
                    error={mobileError}
                    onChange={(v) => {
                      setMobile(v.replace(/[^\d+\s-]/g, ""));
                      setMobileError(undefined);
                    }}
                    inputProps={{ type: "tel", inputMode: "tel", autoComplete: "tel", placeholder: "98765 43210", maxLength: 16, disabled: busy }}
                  />
                </div>
                <div className="relative mt-6 flex items-end justify-between gap-4 border-t border-dashed border-lavender-200 pt-5">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-celestial-800/50">Amount payable</p>
                    <p className="font-display text-4xl font-bold leading-none text-celestial-900">{fee !== null ? rupees(fee) : "—"}</p>
                  </div>
                  <p className="max-w-[12rem] text-right text-xs leading-snug text-celestial-800/55">{a.name}&apos;s fee for this slot</p>
                </div>
              </div>
            </section>
          )}

          {error && (
            <p role="alert" className="mt-5 flex items-start gap-2 rounded-[24px] bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200">
              <span aria-hidden="true">{"☄" + VS}</span>
              {error}
            </p>
          )}
        </div>

        {/* Footer actions. */}
        <div className="relative shrink-0 border-t border-lavender-200/70 bg-ivory-50/95 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-10">
          {done ? (
            <PrimaryButton onClick={onClose}>Done</PrimaryButton>
          ) : step === "choose" ? (
            <div className="flex items-center gap-3">
              <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
              <PrimaryButton onClick={() => goTo("schedule")}>
                Schedule Call
                <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
                  →
                </span>
              </PrimaryButton>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <SecondaryButton onClick={() => goTo(step === "pay" ? "schedule" : "choose")} disabled={busy}>
                ‹ Back
              </SecondaryButton>
              {step === "schedule" ? (
                <PrimaryButton onClick={toPay}>
                  Continue to payment
                  <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
                    →
                  </span>
                </PrimaryButton>
              ) : (
                <button
                  type="button"
                  onClick={() => void payNow()}
                  disabled={busy || fee === null}
                  aria-busy={busy}
                  className="group relative flex min-h-14 flex-1 items-center justify-center gap-3 overflow-hidden rounded-full bg-gradient-to-r from-gold-400 via-gold-300 to-gold-400 px-6 py-4 text-base font-bold tracking-wide text-celestial-900 shadow-[0_16px_32px_-14px_rgba(154,117,53,0.9)] ring-1 ring-gold-600/30 transition hover:brightness-105 active:scale-[0.985] disabled:cursor-wait disabled:opacity-80"
                >
                  {busy ? (
                    <>
                      <span aria-hidden="true" className="h-5 w-5 rounded-full border-2 border-celestial-900/25 border-t-celestial-900 motion-safe:animate-spin" />
                      {pay.stage === "payment" ? "Processing payment…" : "Reserving your slot…"}
                    </>
                  ) : (
                    <>
                      Pay Now {fee !== null ? `· ${rupees(fee)}` : ""}
                      <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
                        →
                      </span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PrimaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-13 flex-1 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-celestial-700 to-celestial-500 px-6 py-3.5 text-base font-semibold text-white shadow-[0_14px_28px_-14px_rgba(82,51,150,0.9)] transition hover:from-celestial-800 hover:to-celestial-600 active:scale-[0.985]"
    >
      {children}
    </button>
  );
}

function SecondaryButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="min-h-13 shrink-0 rounded-full px-5 py-3.5 text-sm font-semibold text-celestial-700 ring-1 ring-celestial-400/40 transition hover:bg-lavender-50 active:scale-95 disabled:opacity-40 sm:px-7"
    >
      {children}
    </button>
  );
}

function Avatar({ astrologer: a, small }: { astrologer: Astrologer; small?: boolean }) {
  const size = small ? "h-12 w-12 text-xl" : "h-16 w-16 text-2xl";
  return (
    <span className="relative shrink-0 rounded-full bg-gradient-to-br from-gold-300 via-lavender-200 to-celestial-400 p-[2px]">
      {/* Orbit ring. */}
      <span aria-hidden="true" className="absolute -inset-1.5 rounded-full border border-dashed border-gold-400/70" />
      {a.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={a.avatarUrl} alt="" className={`${size} rounded-full border-2 border-white object-cover`} />
      ) : (
        <span className={`${size} flex items-center justify-center rounded-full border-2 border-white bg-lavender-100 font-display font-semibold text-celestial-700`}>
          {a.name.charAt(0)}
        </span>
      )}
    </span>
  );
}

function Row({ label, value, onEdit }: { label: string; value: string; onEdit?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <dt className="text-[11px] uppercase tracking-[0.18em] text-celestial-800/50">{label}</dt>
        <dd className="mt-0.5 break-words font-medium text-celestial-900">{value}</dd>
      </div>
      {onEdit && (
        <button type="button" onClick={onEdit} aria-label={`Edit ${label.toLowerCase()}`} className="-mr-2 -mt-1 flex h-10 min-w-10 items-center justify-center rounded-full px-2 text-xs font-medium text-celestial-600 hover:bg-lavender-50">
          Edit
        </button>
      )}
    </div>
  );
}

function Confirmed({ order, paid, name }: { order: ConsultOrder; paid: boolean; name: string }) {
  return (
    <div className="flex flex-col items-center py-4 text-center" aria-live="polite">
      <div className="relative flex h-36 w-36 items-center justify-center">
        <ZodiacWheel className="absolute inset-0 h-full w-full text-gold-400 motion-safe:animate-spin [animation-duration:60s]" />
        <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-celestial-600 to-celestial-800 text-2xl text-gold-300 shadow-[0_0_0_6px_rgba(209,171,98,0.2),0_16px_30px_-12px_rgba(82,51,150,0.9)]">
          ✓
        </span>
      </div>
      <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.25em] text-gold-600">{paid ? "Payment received · Call scheduled" : "Call scheduled"}</p>
      <p className="mt-2 font-display text-2xl font-semibold text-celestial-900">{order.label}</p>
      <p className="mt-1 max-w-sm text-sm text-celestial-800/70">
        {order.durationMinutes}-minute audio consultation with {name}.{order.astrologerNotified ? ` ${name} has been notified.` : ""}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2 text-xs">
        <span className="rounded-full bg-ivory-100 px-3 py-1.5 font-medium text-celestial-700 ring-1 ring-gold-300/50">{rupees(order.amount)}</span>
        <span className="rounded-full bg-lavender-50 px-3 py-1.5 font-mono text-celestial-700 ring-1 ring-lavender-200">#{order.bookingId.slice(0, 8)}</span>
      </div>
    </div>
  );
}
