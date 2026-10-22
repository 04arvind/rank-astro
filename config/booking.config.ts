import type { BookingConfig } from "./schema";

/**
 * Scheduled consultations (lib/booking). Provider feeds carry no working
 * hours, so every astrologer uses these defaults; existing bookings are
 * what makes a slot busy.
 */
export const bookingConfig = {
  slotMinutes: 30,
  horizonDays: 7,
  minLeadMinutes: 30,
  utcOffsetMinutes: 330,
  timeZoneLabel: "IST",
  workingHours: { startMinute: 10 * 60, endMinute: 22 * 60 },
  maxUpcomingPerUser: 5,
  instantPickupMinutes: 15,
} satisfies BookingConfig;
